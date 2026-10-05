/**
 * RSI-P1-03 —— signal → incident → task 自动生成（纯函数，零 IO / 零外写）
 * ---------------------------------------------------------------
 * 补上运行时缺的一环：`rsi:run` 目前的任务队列来自静态 artifact，本模块让**观察到的信号**
 * 能自动变成 incident + task，且同因只建一次。
 *
 * 硬规则：
 *   · 只产出**结构化记录**，不写库、不调 provider、不读凭据；
 *   · 幂等：`dedupeKey` 已存在（历史 incident/task/队列）或本批已出现过 → 只记 duplicates，不重复生成；
 *   · fail-closed：信号摘要若仍含敏感数据（邮箱/电话/长数字/密钥样式）→ 直接 skip，绝不落进任务；
 *   · OWNER 保护：riskClass=HIGH 的信号**不进入自动队列**，只生成 ownerGateRequired 记录等宿主处理；
 *   · 限流：单轮生成上限（默认 3，硬上限 10），超出只记 truncated，不允许一次刷出大量任务；
 *   · id 由 dedupeKey 派生（sha256 前缀），因此**跨重启稳定**，配合唯一约束实现 exactly-once。
 */

import { scanSensitiveData, sha256Hex } from './rsi-adapter-safety';
import type { RsiPriority } from './rsi-continuation-engine';
import type { RsiSignal } from './rsi-observer';

export const RSI_GENERATION_MAX_TASKS_PER_CYCLE = 3;
export const RSI_GENERATION_HARD_CAP_PER_CYCLE = 10;

export interface RsiGeneratedIncident {
  incidentId: string;
  dedupeKey: string;
  kind: string;
  riskClass: RsiSignal['riskClass'];
  summary: string;
  signalRefs: readonly string[];
}

export interface RsiGeneratedTask {
  id: string;
  dedupeKey: string;
  incidentId: string;
  priority: RsiPriority;
  riskClass: RsiSignal['riskClass'];
  ownerGateRequired: boolean;
}

export interface RsiGenerationResult {
  /** 可直接进入自动队列的任务（riskClass != HIGH） */
  tasks: readonly RsiGeneratedTask[];
  /** 需要宿主/OWNER 门禁的任务（riskClass = HIGH），**不自动执行** */
  ownerGatedTasks: readonly RsiGeneratedTask[];
  incidents: readonly RsiGeneratedIncident[];
  duplicates: readonly string[];
  skipped: readonly { dedupeKey: string; reason: 'SENSITIVE_SIGNAL' | 'DUPLICATE_IN_BATCH' }[];
  truncated: boolean;
  knownDedupeKeys: number;
}

const PRIORITY_BY_RISK: Record<RsiSignal['riskClass'], RsiPriority> = {
  HIGH: 'P0',
  MEDIUM: 'P1',
  LOW: 'P2',
};

const stableId = (prefix: string, key: string): string => `${prefix}-${sha256Hex(key).slice(0, 16)}`;

/**
 * 生成 incident + task（纯函数）。
 * `knownDedupeKeys` 应包含历史 incident/task 的 dedupeKey 以及当前队列键（两种前缀都算）。
 */
export function generateRsiWork(input: {
  signals: readonly RsiSignal[];
  knownDedupeKeys?: readonly string[];
  maxTasksPerCycle?: number;
}): RsiGenerationResult {
  const requested = input.maxTasksPerCycle ?? RSI_GENERATION_MAX_TASKS_PER_CYCLE;
  const cap = Math.max(0, Math.min(RSI_GENERATION_HARD_CAP_PER_CYCLE, Math.trunc(requested)));
  const known = new Set(input.knownDedupeKeys ?? []);
  const incidents: RsiGeneratedIncident[] = [];
  const tasks: RsiGeneratedTask[] = [];
  const ownerGatedTasks: RsiGeneratedTask[] = [];
  const duplicates: string[] = [];
  const skipped: RsiGenerationResult['skipped'][number][] = [];
  const seenInBatch = new Set<string>();
  let created = 0;
  let truncated = false;

  const ordered = [...input.signals].sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0));

  for (const signal of ordered) {
    const incidentKey = `incident:${signal.dedupeKey}`;
    const taskKey = `task:${signal.dedupeKey}`;

    if (!scanSensitiveData(signal.summary).clean) {
      skipped.push({ dedupeKey: signal.dedupeKey, reason: 'SENSITIVE_SIGNAL' });
      continue;
    }
    if (seenInBatch.has(signal.dedupeKey)) {
      skipped.push({ dedupeKey: signal.dedupeKey, reason: 'DUPLICATE_IN_BATCH' });
      continue;
    }
    if (known.has(incidentKey) || known.has(taskKey) || known.has(signal.dedupeKey)) {
      duplicates.push(signal.dedupeKey);
      continue;
    }
    if (created >= cap) {
      truncated = true;
      continue;
    }

    seenInBatch.add(signal.dedupeKey);
    created += 1;
    const incidentId = stableId('inc', signal.dedupeKey);
    incidents.push({
      incidentId,
      dedupeKey: incidentKey,
      kind: signal.kind,
      riskClass: signal.riskClass,
      summary: signal.summary,
      signalRefs: signal.refs,
    });
    const task: RsiGeneratedTask = {
      id: stableId('task', signal.dedupeKey),
      dedupeKey: taskKey,
      incidentId,
      priority: PRIORITY_BY_RISK[signal.riskClass],
      riskClass: signal.riskClass,
      ownerGateRequired: signal.riskClass === 'HIGH',
    };
    if (task.ownerGateRequired) ownerGatedTasks.push(task);
    else tasks.push(task);
  }

  return {
    tasks,
    ownerGatedTasks,
    incidents,
    duplicates,
    skipped,
    truncated,
    knownDedupeKeys: known.size,
  };
}

/** 从只读 artifact 解析信号（畸形行丢弃，绝不因为解析失败而编造信号） */
export function parseRsiSignals(raw: string): readonly RsiSignal[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const signals: RsiSignal[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.dedupeKey !== 'string' || row.dedupeKey === '') continue;
      if (typeof row.kind !== 'string' || typeof row.summary !== 'string') continue;
      if (row.riskClass !== 'LOW' && row.riskClass !== 'MEDIUM' && row.riskClass !== 'HIGH') continue;
      const refs = Array.isArray(row.refs) ? row.refs.filter((ref): ref is string => typeof ref === 'string') : [];
      signals.push({
        kind: row.kind as RsiSignal['kind'],
        dedupeKey: row.dedupeKey,
        summary: row.summary,
        refs,
        riskClass: row.riskClass,
      });
    }
    return signals;
  } catch {
    return [];
  }
}

export const RSI_TASK_GENERATOR_BOUNDARY = {
  writesDatabase: false,
  performsNetworkCalls: false,
  readsCredentials: false,
  holdsProviderCredentials: false,
  createsOwnerGatedWork: false,
  ownerGatedSignalsAreRecordedOnly: true,
  dedupeByStableKey: true,
  rejectsSensitiveSignals: true,
  maxTasksPerCycle: RSI_GENERATION_MAX_TASKS_PER_CYCLE,
  hardCapPerCycle: RSI_GENERATION_HARD_CAP_PER_CYCLE,
} as const;
