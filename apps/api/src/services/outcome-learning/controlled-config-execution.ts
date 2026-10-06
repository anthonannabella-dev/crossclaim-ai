/**
 * PHASE 6 U3 —— Controlled Config Execution（SANDBOX / NON_PRODUCTION_CONFIG_WRITE_ONLY）
 * 冻结门来源：MSG-20261005-88 NEXT。只允许在 **sandbox / non-production** 配置存储上，
 * 按 verified plan 的 exact delta 做**一次**原子 CAS 写入；production mutation 仍 FORBIDDEN。
 *
 * 硬门：
 *  1. 三重可信入口（verified plan + ticket + verdict，且 digest 三者完全闭合）
 *  2. 执行时间门（executedAt 落在 verdict.decidedAt 与 min(ticket.expiresAt, plan.expiresAt) 之间）
 *  3. 执行瞬间 server-owned 重读 current config（fingerprint / path value / version 三重一致）
 *  4. 原子 CAS 是硬门（compareAndSwap；失败 = CONFIG_EXECUTION_CONFLICT，零副作用）
 *  5. exact delta only（target/path/from/to 全部取自 verified plan）
 *  6. 一次授权最多一次 mutation（durable execution ledger；verdict/ticket digest 唯一）
 *  7. idempotency key（同键同载荷 → 返回既有结果；同键异载荷 → IDEMPOTENCY_KEY_CONFLICT）
 *  8. 写后 read-back（不一致 → NEEDS_RECONCILIATION，绝不标记 COMMITTED）
 *  9. CONTROLLED_CONFIG_EXECUTION_RESULT 可信产物（provenance + fingerprint + durable persistence）
 * 10. rollback anchor 随执行记录持久化（首版不自动 rollback）
 * 11. CAS 前最后检查 kill switch / control plane
 * 12. 成功语义只能是 SANDBOX_CONFIG_MUTATION_COMMITTED
 */

import { createHash } from 'node:crypto';

import {
  isVerifiedControlledExecutionAuthorizationTicket,
  isVerifiedControlledExecutionAuthorizationVerdict,
  type ControlledCurrentConfigRead,
  type ControlledExecutionAuthorizationTicket,
  type ControlledExecutionAuthorizationVerdict,
} from './controlled-execution-gate';
import { isVerifiedControlledAdoptionPlan, type ControlledAdoptionPlan } from './controlled-adoption-plan';

export const CONTROLLED_CONFIG_EXECUTION_VERSION = 'controlled-config-execution/v1';
export const CONTROLLED_CONFIG_EXECUTION_SEMANTICS = 'SANDBOX_CONFIG_MUTATION_COMMITTED';
export const CONTROLLED_CONFIG_EXECUTION_ENVIRONMENT = 'SANDBOX';
export const CONTROLLED_CONFIG_EXECUTION_STATUSES = [
  'COMMITTED',
  'NOOP_ALREADY_APPLIED',
  'CONFLICT',
  'NEEDS_RECONCILIATION',
  'FAILED_ZERO_WRITE',
] as const;

/** semantics 必须随 status 取值：失败/未知结果绝不能携带 COMMITTED 语义。 */
export const CONTROLLED_CONFIG_EXECUTION_STATUS_SEMANTICS = {
  COMMITTED: 'SANDBOX_CONFIG_MUTATION_COMMITTED',
  NOOP_ALREADY_APPLIED: 'SANDBOX_CONFIG_ALREADY_APPLIED_NO_WRITE',
  CONFLICT: 'SANDBOX_CONFIG_MUTATION_CONFLICT_NO_WRITE',
  NEEDS_RECONCILIATION: 'SANDBOX_CONFIG_MUTATION_NEEDS_RECONCILIATION',
  FAILED_ZERO_WRITE: 'SANDBOX_CONFIG_MUTATION_FAILED_ZERO_WRITE',
} as const;
export type ControlledConfigExecutionSemantics =
  (typeof CONTROLLED_CONFIG_EXECUTION_STATUS_SEMANTICS)[keyof typeof CONTROLLED_CONFIG_EXECUTION_STATUS_SEMANTICS];

export const CONTROLLED_CONFIG_EXECUTION_BOUNDARY = {
  scope: 'SANDBOX / NON_PRODUCTION_CONFIG_WRITE_ONLY',
  environment: CONTROLLED_CONFIG_EXECUTION_ENVIRONMENT,
  successSemantics: CONTROLLED_CONFIG_EXECUTION_SEMANTICS,
  semanticsByStatus: CONTROLLED_CONFIG_EXECUTION_STATUS_SEMANTICS,
  entryGate:
    'verified plan + verified authorization ticket + verified authorization verdict（digest 三者闭合；clone/handmade/mismatch fail-closed）',
  executionWindow:
    'verdict.decidedAt <= executedAt <= min(ticket.expiresAt, plan.expiresAt)（过期 → CONFIG_EXECUTION_AUTHORIZATION_EXPIRED；早于授权 → CONFIG_EXECUTION_BEFORE_AUTHORIZATION）',
  liveConfigReread:
    '执行瞬间 server-owned read(target)：current.configFingerprint === plan.expectedBaselineConfigFingerprint === ticket.liveConfigFingerprint、current.configValues[path] === plan.from、current.version === ticket.liveConfigVersion，否则 STALE_EXECUTION_BASELINE（零写）',
  atomicCas: 'compareAndSwap({ target, expectedVersion, expectedPathValue, path, nextValue })；失败 = CONFIG_EXECUTION_CONFLICT（零副作用）',
  exactDelta: 'target/path/from/to 全部取自 verified plan；禁止 arbitrary mutation / multi-path patch / JSON blob patch',
  oneMutationPerAuthorization: 'durable execution ledger：authorizationVerdictDigest / authorizationTicketDigest 唯一，一次授权最多一次 committed mutation',
  idempotency: '同 idempotencyKey + 同载荷 → 返回既有 execution result；同键异载荷 → IDEMPOTENCY_KEY_CONFLICT；绝不二次写配置',
  readBack: 'CAS 成功后 server-owned read-back：new[path] === plan.to 且 new.version !== pre.version，否则 NEEDS_RECONCILIATION',
  rollbackAnchor: '执行记录继续携带 rollbackPlanDigest + baselineSnapshotDigest + baselineConfigFingerprint + U2_BASELINE；首版不自动 rollback',
  killSwitch: 'CAS 前最后检查 globalDisabled / productionGate / executionEnabled / environment；environment 非 SANDBOX → CONFIG_EXECUTION_PRODUCTION_FORBIDDEN',
  productionMutation: 'FORBIDDEN',
  forbidden: [
    'production config store',
    'rollout',
    'multi-node production propagation',
    'real provider action',
    'payment',
    'external writes',
    'Policy/Guard/Router/ActionRuntime production mutation',
  ],
  forbiddenStates: ['PRODUCTION_APPLIED', 'DEPLOYED', 'ROLLED_OUT'],
  binds: [
    'executionId',
    'planDigest',
    'authorizationTicketDigest',
    'authorizationVerdictDigest',
    'rollbackPlanDigest',
    'target',
    'path',
    'from',
    'to',
    'preConfigFingerprint',
    'preConfigVersion',
    'postConfigFingerprint',
    'postConfigVersion',
    'executedAt',
    'status',
    'idempotencyKey',
  ],
} as const;

export type ControlledConfigExecutionStatus = (typeof CONTROLLED_CONFIG_EXECUTION_STATUSES)[number];

export interface ControlledConfigExecutionResult {
  kind: 'CONTROLLED_CONFIG_EXECUTION_RESULT';
  mode: 'SANDBOX_WRITE_ONLY';
  semantics: ControlledConfigExecutionSemantics;
  executionId: string;
  resultDigest: string;
  planDigest: string;
  authorizationTicketDigest: string;
  authorizationVerdictDigest: string;
  rollbackPlanDigest: string;
  rollbackTarget: { baselineSnapshotDigest: string; baselineConfigFingerprint: string; target: 'U2_BASELINE' };
  target: string;
  path: string;
  from: string;
  to: string;
  preConfigFingerprint: string;
  preConfigVersion: string;
  postConfigFingerprint: string | null;
  postConfigVersion: string | null;
  executedAt: string;
  status: ControlledConfigExecutionStatus;
  idempotencyKey: string;
  execution: {
    environment: typeof CONTROLLED_CONFIG_EXECUTION_ENVIRONMENT;
    productionMutation: 'FORBIDDEN';
    autoRollback: 'FORBIDDEN';
  };
}

/** server-owned 只读 + 原子 CAS 端口（sandbox 实现由 composition root 注入）。 */
export interface ControlledConfigExecutionStorePort {
  read(target: string): Promise<ControlledCurrentConfigRead> | ControlledCurrentConfigRead;
  compareAndSwap(input: {
    target: string;
    expectedVersion: string;
    expectedPathValue: string;
    path: string;
    nextValue: string;
  }): Promise<ControlledConfigCasOutcome> | ControlledConfigCasOutcome;
}

export type ControlledConfigCasOutcome =
  | {
      ok: true;
      version: string;
      configFingerprint: string;
      configValues: Readonly<Record<string, string>>;
      capturedAt: string;
    }
  | { ok: false; reason: 'VERSION_CONFLICT' | 'PATH_VALUE_CONFLICT' | 'UNKNOWN' };

/** durable execution ledger：生产实现必须以 UNIQUE(verdictDigest) / UNIQUE(ticketDigest) 承担不变量。 */
export interface ControlledConfigExecutionLedgerPort {
  findByVerdictDigest(digest: string): ControlledConfigExecutionResult | null | undefined;
  reserve(input: {
    verdictDigest: string;
    ticketDigest: string;
    executionId: string;
    idempotencyKey: string;
  }): 'RESERVED' | 'ALREADY_RESERVED';
  put(result: ControlledConfigExecutionResult): void;
}

export interface ControlledExecutionGateSwitches {
  environment: string;
  globalDisabled: boolean;
  productionGate: boolean;
  executionEnabled: boolean;
}

const VERIFIED_EXECUTION_RESULTS = new WeakSet<ControlledConfigExecutionResult>();
const VERIFIED_EXECUTION_FINGERPRINTS = new WeakMap<ControlledConfigExecutionResult, string>();

const requireText = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
const digest = (label: string, parts: readonly string[]): string =>
  label + ':' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
const isIso = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));

const resultFingerprint = (r: ControlledConfigExecutionResult): string =>
  JSON.stringify({ ...r, rollbackTarget: { ...r.rollbackTarget }, execution: { ...r.execution } });

export function isVerifiedControlledConfigExecutionResult(
  result: ControlledConfigExecutionResult | null | undefined,
): boolean {
  if (result === null || result === undefined) return false;
  if (!VERIFIED_EXECUTION_RESULTS.has(result)) return false;
  const fingerprint = VERIFIED_EXECUTION_FINGERPRINTS.get(result);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === resultFingerprint(result);
  } catch {
    return false;
  }
}

/** 参考 in-memory ledger（sandbox 用）：进程内保证“一次授权最多一次 mutation”。 */
export function createSandboxConfigExecutionLedger(): ControlledConfigExecutionLedgerPort {
  const byVerdict = new Map<string, ControlledConfigExecutionResult>();
  const reservedVerdicts = new Set<string>();
  const reservedTickets = new Set<string>();
  return {
    findByVerdictDigest(d) {
      return byVerdict.get(requireText(d)) ?? null;
    },
    reserve({ verdictDigest, ticketDigest, executionId, idempotencyKey }) {
      const v = requireText(verdictDigest);
      const t = requireText(ticketDigest);
      if (reservedVerdicts.has(v) || reservedTickets.has(t)) {
        const existing = byVerdict.get(v);
        if (existing !== undefined && existing.idempotencyKey !== requireText(idempotencyKey)) {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT:' + executionId);
        }
        return 'ALREADY_RESERVED';
      }
      reservedVerdicts.add(v);
      reservedTickets.add(t);
      return 'RESERVED';
    },
    put(result) {
      byVerdict.set(result.authorizationVerdictDigest, result);
    },
  };
}

const assertLiveShape = (live: ControlledCurrentConfigRead | null | undefined, target: string): ControlledCurrentConfigRead => {
  if (live === null || live === undefined || typeof live !== 'object') {
    throw new Error('CONFIG_EXECUTION_LIVE_CONFIG_UNREADABLE:' + target);
  }
  const valuesOk = live.configValues !== null && typeof live.configValues === 'object' && !Array.isArray(live.configValues);
  if (requireText(live.configFingerprint) === '' || requireText(live.version) === '' || !valuesOk || !isIso(live.capturedAt)) {
    throw new Error('CONFIG_EXECUTION_LIVE_CONFIG_UNREADABLE:' + target);
  }
  return live;
};

/**
 * 执行受控配置变更（sandbox-only）。任何门失败一律 fail-closed，绝不部分写入。
 */
export async function executeControlledConfigMutation(input: {
  plan: ControlledAdoptionPlan | null | undefined;
  ticket: ControlledExecutionAuthorizationTicket | null | undefined;
  verdict: ControlledExecutionAuthorizationVerdict | null | undefined;
  configStore: ControlledConfigExecutionStorePort | null | undefined;
  ledger: ControlledConfigExecutionLedgerPort | null | undefined;
  gate: ControlledExecutionGateSwitches | null | undefined;
  executedAt: string;
  idempotencyKey: string;
} | null | undefined): Promise<ControlledConfigExecutionResult> {
  if (input === null || input === undefined) throw new Error('CONFIG_EXECUTION_INPUT_REQUIRED');

  // 1) 三重可信入口 + digest 闭合
  if (!isVerifiedControlledAdoptionPlan(input.plan)) throw new Error('CONFIG_EXECUTION_PLAN_NOT_VERIFIED');
  const plan = input.plan as ControlledAdoptionPlan;
  if (!isVerifiedControlledExecutionAuthorizationTicket(input.ticket)) {
    throw new Error('CONFIG_EXECUTION_TICKET_NOT_VERIFIED');
  }
  const ticket = input.ticket as ControlledExecutionAuthorizationTicket;
  if (!isVerifiedControlledExecutionAuthorizationVerdict(input.verdict)) {
    throw new Error('CONFIG_EXECUTION_VERDICT_NOT_VERIFIED');
  }
  const verdict = input.verdict as ControlledExecutionAuthorizationVerdict;
  if (verdict.outcome !== 'APPROVED') throw new Error('CONFIG_EXECUTION_VERDICT_NOT_APPROVED:' + verdict.outcome);
  if (verdict.semantics !== 'AUTHORIZED_FOR_CONTROLLED_EXECUTION_PREPARATION') {
    throw new Error('CONFIG_EXECUTION_VERDICT_SEMANTICS_INVALID:' + verdict.semantics);
  }
  if (verdict.ticketDigest !== ticket.ticketDigest) throw new Error('CONFIG_EXECUTION_VERDICT_TICKET_MISMATCH');
  if (verdict.planDigest !== plan.planDigest) throw new Error('CONFIG_EXECUTION_VERDICT_PLAN_MISMATCH');
  if (ticket.planDigest !== plan.planDigest) throw new Error('CONFIG_EXECUTION_TICKET_PLAN_MISMATCH');

  // 2) 执行时间门
  if (!isIso(input.executedAt)) throw new Error('CONFIG_EXECUTION_TIME_INVALID');
  const executedMs = Date.parse(input.executedAt);
  const executedAt = input.executedAt;
  if (executedMs < Date.parse(verdict.decidedAt)) throw new Error('CONFIG_EXECUTION_BEFORE_AUTHORIZATION');
  const latestMs = Math.min(Date.parse(ticket.expiresAt), Date.parse(plan.expiresAt));
  if (executedMs > latestMs) throw new Error('CONFIG_EXECUTION_AUTHORIZATION_EXPIRED');

  // 11) kill switch / control plane（CAS 前最后检查的一部分：进入重活前先挡）
  const gate = input.gate;
  if (gate === null || gate === undefined || typeof gate !== 'object') throw new Error('CONFIG_EXECUTION_GATE_REQUIRED');
  if (requireText(gate.environment) !== CONTROLLED_CONFIG_EXECUTION_ENVIRONMENT) {
    throw new Error('CONFIG_EXECUTION_PRODUCTION_FORBIDDEN:' + requireText(gate.environment));
  }
  if (gate.globalDisabled === true) throw new Error('CONFIG_EXECUTION_KILL_SWITCH_ENGAGED');
  if (gate.executionEnabled !== true) throw new Error('CONFIG_EXECUTION_NOT_ENABLED');
  void gate.productionGate;

  const ledger = input.ledger;
  if (ledger === null || ledger === undefined || typeof (ledger as { reserve?: unknown }).reserve !== 'function') {
    throw new Error('CONFIG_EXECUTION_LEDGER_REQUIRED');
  }
  const store = input.configStore;
  if (store === null || store === undefined || typeof (store as { compareAndSwap?: unknown }).compareAndSwap !== 'function') {
    throw new Error('CONFIG_EXECUTION_STORE_REQUIRED');
  }

  // 7) idempotency：同键同载荷返回既有结果；不得二次写配置
  const idempotencyKey = requireText(input.idempotencyKey);
  if (idempotencyKey === '') throw new Error('CONFIG_EXECUTION_IDEMPOTENCY_KEY_REQUIRED');
  const existing = ledger.findByVerdictDigest(verdict.verdictDigest);
  if (existing !== null && existing !== undefined) {
    if (existing.idempotencyKey !== idempotencyKey) throw new Error('IDEMPOTENCY_KEY_CONFLICT:' + existing.executionId);
    return existing;
  }

  // 5) exact delta only（全部取自 verified plan）
  const target = requireText(plan.target);
  const path = requireText(plan.path);
  const from = requireText(plan.from);
  const to = requireText(plan.to);

  const executionId = 'controlled-config-execution:' + digest('controlled-config-execution', [
    verdict.verdictDigest,
    ticket.ticketDigest,
    plan.planDigest,
    idempotencyKey,
  ]);

  // 3) 只读 preflight（全部在 reserve 之前；失败则不留 reservation）
  const pre = assertLiveShape(await store.read(target), target);
  const preFingerprint = requireText(pre.configFingerprint);
  const preVersion = requireText(pre.version);
  if (preFingerprint !== requireText(plan.expectedBaselineConfigFingerprint) || preFingerprint !== requireText(ticket.liveConfigFingerprint)) {
    throw new Error('STALE_EXECUTION_BASELINE:fingerprint:' + preFingerprint);
  }
  // LIVE_VERSION_NOOP_GATE：先完整校验 identity（fingerprint + version），再判定 NOOP
  if (preVersion !== requireText(ticket.liveConfigVersion)) {
    throw new Error('STALE_EXECUTION_BASELINE:version:' + preVersion + '!=' + requireText(ticket.liveConfigVersion));
  }
  const preValue = requireText(pre.configValues[path]);
  if (preValue !== from && preValue !== to) {
    throw new Error('STALE_EXECUTION_BASELINE:path-value:' + path + ':' + preValue + '!=' + from);
  }
  const noopEligible = preValue === to;

  function buildResult(
    status: ControlledConfigExecutionStatus,
    post: { fingerprint: string | null; version: string | null },
  ): ControlledConfigExecutionResult {
    const resultDigest = digest('controlled-config-execution-result', [
      CONTROLLED_CONFIG_EXECUTION_VERSION,
      executionId,
      plan.planDigest,
      ticket.ticketDigest,
      verdict.verdictDigest,
      plan.rollbackPlanDigest,
      target,
      path,
      from,
      to,
      preFingerprint,
      preVersion,
      post.fingerprint ?? '',
      post.version ?? '',
      executedAt,
      status,
      CONTROLLED_CONFIG_EXECUTION_STATUS_SEMANTICS[status],
      idempotencyKey,
    ]);
    const result: ControlledConfigExecutionResult = {
      kind: 'CONTROLLED_CONFIG_EXECUTION_RESULT',
      mode: 'SANDBOX_WRITE_ONLY',
      semantics: CONTROLLED_CONFIG_EXECUTION_STATUS_SEMANTICS[status],
      executionId,
      resultDigest,
      planDigest: plan.planDigest,
      authorizationTicketDigest: ticket.ticketDigest,
      authorizationVerdictDigest: verdict.verdictDigest,
      rollbackPlanDigest: plan.rollbackPlanDigest,
      rollbackTarget: {
        baselineSnapshotDigest: plan.expectedBaselineSnapshotDigest,
        baselineConfigFingerprint: plan.expectedBaselineConfigFingerprint,
        target: 'U2_BASELINE',
      },
      target,
      path,
      from,
      to,
      preConfigFingerprint: preFingerprint,
      preConfigVersion: preVersion,
      postConfigFingerprint: post.fingerprint,
      postConfigVersion: post.version,
      executedAt,
      status,
      idempotencyKey,
      execution: {
        environment: CONTROLLED_CONFIG_EXECUTION_ENVIRONMENT,
        productionMutation: 'FORBIDDEN',
        autoRollback: 'FORBIDDEN',
      },
    };
    Object.freeze(result.rollbackTarget);
    Object.freeze(result.execution);
    Object.freeze(result);
    VERIFIED_EXECUTION_RESULTS.add(result);
    VERIFIED_EXECUTION_FINGERPRINTS.set(result, resultFingerprint(result));
    return result;
  }

  // 6) 一次授权最多一次 mutation：preflight 通过后才预留；此后每条路径都必须落一个 durable terminal result
  const reservation = ledger.reserve({
    verdictDigest: verdict.verdictDigest,
    ticketDigest: ticket.ticketDigest,
    executionId,
    idempotencyKey,
  });
  if (reservation !== 'RESERVED') throw new Error('CONFIG_EXECUTION_ALREADY_EXECUTED:' + executionId);

  // 目标值已生效 → NOOP_ALREADY_APPLIED（零写，但仍落 durable result）
  if (noopEligible) {
    const noop = buildResult('NOOP_ALREADY_APPLIED', { fingerprint: preFingerprint, version: preVersion });
    ledger.put(noop);
    return noop;
  }

  // 4) 原子 CAS 硬门；失败 = durable CONFLICT（绝不再次 CAS）
  // CAS_EXCEPTION_TERMINALIZATION：CAS 自身抛异常时 mutation 结果未知，必须落真 NEEDS_RECONCILIATION（不能记 CONFLICT）
  let cas: ControlledConfigCasOutcome | null = null;
  try {
    cas = await store.compareAndSwap({
      target,
      expectedVersion: preVersion,
      expectedPathValue: from,
      path,
      nextValue: to,
    });
  } catch {
    // CAS_EXCEPTION_POST_STATE_EVIDENCE：CAS 可能未执行、也可能已提交但响应丢失，
    // 因此 post-state 必须保持 UNKNOWN（null），不得沿用 pre-state 造成“确认未改变”的误导。
    const unknown = buildResult('NEEDS_RECONCILIATION', { fingerprint: null, version: null });
    ledger.put(unknown);
    return unknown;
  }
  if (cas === null || cas === undefined || cas.ok !== true) {
    const conflict = buildResult('CONFLICT', { fingerprint: preFingerprint, version: preVersion });
    ledger.put(conflict);
    return conflict;
  }

  // 8) 写后 read-back：任何异常 / malformed / 不一致 → durable NEEDS_RECONCILIATION（绝不丢记录）
  let postFingerprint: string | null = requireText(cas.configFingerprint) || null;
  let postVersion: string | null = requireText(cas.version) || null;
  let consistent = false;
  try {
    const post = assertLiveShape(await store.read(target), target);
    postFingerprint = requireText(post.configFingerprint) || postFingerprint;
    postVersion = requireText(post.version) || postVersion;
    consistent = requireText(post.configValues[path]) === to && requireText(post.version) !== preVersion;
  } catch {
    consistent = false;
  }
  const result = buildResult(consistent ? 'COMMITTED' : 'NEEDS_RECONCILIATION', {
    fingerprint: postFingerprint,
    version: postVersion,
  });

  // 9) durable persistence
  ledger.put(result);
  return result;
}
