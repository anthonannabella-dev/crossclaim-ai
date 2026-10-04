import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * /admin/autonomy 只读快照读取（与 SEO projection 同模式）。
 *
 * 边界（C-0008-A）：web **不读 RSI 数据库、不调模型**，只读由 apps/api / RSI Controller
 * 生成的内部快照 artifact；文件缺失或非法 → fail-closed（页面显示不可用，不编造数据）。
 */

export const RSI_ADMIN_SNAPSHOT_SCHEMA = 'rsi-admin-snapshot-v1' as const;

export interface RsiAdminSnapshot {
  schema: typeof RSI_ADMIN_SNAPSHOT_SCHEMA;
  generatedAt: string;
  health: {
    health: 'STARTING' | 'HEALTHY' | 'DEGRADED' | 'PAUSED' | 'BLOCKED' | 'FAILED';
    openIncidents: number;
    activeTasks: number;
    failedTasks: number;
    pendingOwnerApprovals: number;
    lastScanAt: string | null;
  };
  cost: {
    costSafeMode: boolean;
    today: {
      events: number;
      incidents: number;
      ruleResolved: number;
      lowCostCalls: number;
      strongCalls: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
      budgetRemaining: number;
    };
    month: {
      events: number;
      incidents: number;
      ruleResolved: number;
      lowCostCalls: number;
      strongCalls: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
      budgetRemaining: number;
    };
  };
}

export type RsiAdminSnapshotLoad =
  | { ok: true; snapshot: RsiAdminSnapshot }
  | { ok: false; reason: 'MISSING' | 'MALFORMED' | 'UNKNOWN_SCHEMA' };

export function snapshotPath(): string {
  return process.env.RSI_ADMIN_SNAPSHOT_PATH ?? path.join(process.cwd(), '.generated', 'rsi-admin-snapshot.json');
}

export function loadRsiAdminSnapshot(filePath: string = snapshotPath()): RsiAdminSnapshotLoad {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'MISSING' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'MALFORMED' };
  const candidate = parsed as Partial<RsiAdminSnapshot>;
  if (candidate.schema !== RSI_ADMIN_SNAPSHOT_SCHEMA) return { ok: false, reason: 'UNKNOWN_SCHEMA' };
  if (candidate.health === undefined || candidate.cost === undefined) return { ok: false, reason: 'MALFORMED' };
  return { ok: true, snapshot: candidate as RsiAdminSnapshot };
}
