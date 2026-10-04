/**
 * RSI Phase-1 —— 自治生命周期契约与状态机（纯函数，零副作用）
 * ---------------------------------------------------------------
 * 依据 docs/releases/RSI-CONTROL-PLANE-PHASE1.md：
 *   · 只定义事实与合法跃迁，不执行任何 IO（不写库、不调 provider、不读凭据）；
 *   · 非法跃迁一律 fail-closed（返回原因，不抛异常给上层猜测）；
 *   · Builder 与 Judge 必须逻辑隔离：同一 actorRef 不得既 patch 又 judge；
 *   · 永久 OWNER / Policy Gate 的动作，RSI **永远不能自我授权**；
 *   · L4 自动 promote 默认 OFF。
 */

export const RSI_INCIDENT_STATES = ['OPEN', 'DIAGNOSED', 'TASKED', 'CLOSED', 'REJECTED'] as const;
export const RSI_TASK_STATES = [
  'READY',
  'IN_PROGRESS',
  'CANDIDATE_READY',
  'VALIDATED',
  'JUDGED',
  'PROMOTED',
  'REJECTED',
  'BLOCKED',
] as const;
export const RSI_CANDIDATE_STATES = [
  'CREATED',
  'PATCHED',
  'SANDBOXED',
  'REPLAYED',
  'TESTED',
  'BENCHMARKED',
  'POLICY_CHECKED',
  'JUDGED',
  'PROMOTED',
  'REJECTED',
] as const;

export type RsiIncidentState = (typeof RSI_INCIDENT_STATES)[number];
export type RsiTaskState = (typeof RSI_TASK_STATES)[number];
export type RsiCandidateState = (typeof RSI_CANDIDATE_STATES)[number];

export type RsiWorkflow = 'INCIDENT' | 'TASK' | 'CANDIDATE';

/** 合法跃迁表：只有列出的目标状态可达，其余一律 ILLEGAL_TRANSITION。 */
export const RSI_ALLOWED_TRANSITIONS: Record<RsiWorkflow, Record<string, readonly string[]>> = {
  INCIDENT: {
    OPEN: ['DIAGNOSED', 'CLOSED', 'REJECTED'],
    DIAGNOSED: ['TASKED', 'CLOSED', 'REJECTED'],
    TASKED: ['CLOSED'],
    CLOSED: [],
    REJECTED: [],
  },
  TASK: {
    READY: ['IN_PROGRESS', 'BLOCKED', 'REJECTED'],
    IN_PROGRESS: ['CANDIDATE_READY', 'BLOCKED', 'REJECTED'],
    CANDIDATE_READY: ['VALIDATED', 'REJECTED', 'BLOCKED'],
    VALIDATED: ['JUDGED', 'REJECTED'],
    JUDGED: ['PROMOTED', 'REJECTED'],
    BLOCKED: ['IN_PROGRESS', 'REJECTED'],
    PROMOTED: [],
    REJECTED: [],
  },
  CANDIDATE: {
    CREATED: ['PATCHED', 'REJECTED'],
    PATCHED: ['SANDBOXED', 'REJECTED'],
    SANDBOXED: ['REPLAYED', 'REJECTED'],
    REPLAYED: ['TESTED', 'REJECTED'],
    TESTED: ['BENCHMARKED', 'REJECTED'],
    BENCHMARKED: ['POLICY_CHECKED', 'REJECTED'],
    POLICY_CHECKED: ['JUDGED', 'REJECTED'],
    JUDGED: ['PROMOTED', 'REJECTED'],
    PROMOTED: [],
    REJECTED: [],
  },
};

export type RsiTransitionResult =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: 'ILLEGAL_TRANSITION' | 'UNKNOWN_STATE'; from: string; to: string };

export function transition(workflow: RsiWorkflow, from: string, to: string): RsiTransitionResult {
  const table = RSI_ALLOWED_TRANSITIONS[workflow];
  if (!(from in table)) return { ok: false, reason: 'UNKNOWN_STATE', from, to };
  const allowed = table[from] ?? [];
  if (!allowed.includes(to)) return { ok: false, reason: 'ILLEGAL_TRANSITION', from, to };
  return { ok: true, from, to };
}

/** Builder / Judge 必须逻辑隔离：同一 actor 不得既写 patch 又做裁决。 */
export function assertBuilderJudgeSeparation(
  builderRef: string,
  judgeRef: string,
): { ok: true } | { ok: false; reason: 'SELF_JUDGE_FORBIDDEN' } {
  if (builderRef.trim() === '' || judgeRef.trim() === '') return { ok: false, reason: 'SELF_JUDGE_FORBIDDEN' };
  if (builderRef === judgeRef) return { ok: false, reason: 'SELF_JUDGE_FORBIDDEN' };
  return { ok: true };
}

/** 永久 OWNER / Policy Gate：RSI **永远**不能自我授权这些动作。 */
export const RSI_OWNER_GATED_ACTIONS = [
  'EXTERNAL_WRITE',
  'PRODUCTION_CREDENTIALS',
  'PAYMENT',
  'COMMISSION_CAPTURE',
  'REAL_CLAIM_SUBMIT',
  'REAL_APPEAL_SUBMIT',
  'CUSTOMS_FILING',
  'BROKER_PRIVILEGED_EXECUTION',
  'PRODUCTION_PROVIDER_CREDENTIAL',
  'SECURITY_POLICY_DOWNGRADE',
  'PERMISSION_EXPANSION',
  'DESTRUCTIVE_MIGRATION',
  'CUSTOMER_DATA_DELETION',
  'KILL_SWITCH_DISABLE',
] as const;
export type RsiOwnerGatedAction = (typeof RSI_OWNER_GATED_ACTIONS)[number];

export function requiresOwnerApproval(action: string): boolean {
  return (RSI_OWNER_GATED_ACTIONS as readonly string[]).includes(action);
}

/** 无论验证结果如何，RSI 都不能自我授权 OWNER-gated 动作。 */
export function canRsiSelfAuthorize(action: string): boolean {
  return !requiresOwnerApproval(action);
}

/** L4 自动 promote：默认 OFF；即使显式开启，也只允许 LOW 风险。 */
export const RSI_AUTO_PROMOTE_DEFAULT = false;
export function canAutoPromote(
  riskClass: 'LOW' | 'MEDIUM' | 'HIGH',
  options: { autoPromoteEnabled?: boolean } = {},
): boolean {
  if (!(options.autoPromoteEnabled ?? RSI_AUTO_PROMOTE_DEFAULT)) return false;
  return riskClass === 'LOW';
}

/** 不可变评估证据：同一 evidenceId 不得被改写（只允许追加）。 */
export interface RsiEvidence {
  evidenceId: string;
  kind: string;
  digest: string;
  recordedAt: string;
}

export function appendEvidence(
  existing: readonly RsiEvidence[],
  next: RsiEvidence,
): { ok: true; evidence: readonly RsiEvidence[] } | { ok: false; reason: 'EVIDENCE_IMMUTABLE' } {
  if (existing.some((item) => item.evidenceId === next.evidenceId)) {
    return { ok: false, reason: 'EVIDENCE_IMMUTABLE' };
  }
  return { ok: true, evidence: [...existing, next] };
}
