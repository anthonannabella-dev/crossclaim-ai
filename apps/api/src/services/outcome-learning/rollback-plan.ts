/**
 * PHASE 5 U2 —— Rollback Plan Contract（ROLLBACK_PLAN_ONLY）
 * ---------------------------------------------------------------
 * 链路（审计冻结 MSG-20261005-70）：Verified APPROVED Verdict → Rollback Plan → （U3）Controlled Config Proposal。
 * 硬约束：只接受 isVerifiedApprovalVerdict(verdict) === true 且 outcome === APPROVED；REJECTED → fail-closed；
 * rollback 必须指向明确 baseline（禁 ROLLBACK_TO_LATEST / 模糊“恢复默认值”）；本模块只生成计划，
 * **不执行 rollback**、不做任何 Policy / Guard / Router / Action Runtime mutation。
 */

import { createHash } from 'node:crypto';

import { isVerifiedApprovalVerdict, type ApprovalVerdict } from './candidate-approval';

export const ROLLBACK_PLAN_VERSION = 'rollback-plan/v1';

export const ROLLBACK_PLAN_BOUNDARY = {
  mode: 'ROLLBACK_PLAN_ONLY',
  executeRollback: 'FORBIDDEN',
  autoApply: false,
  autoPromotion: 'OFF',
  policyMutation: 'FORBIDDEN',
  guardMutation: 'FORBIDDEN',
  routerMutation: 'FORBIDDEN',
  actionRuntimeMutation: 'FORBIDDEN',
  verdictGate: 'isVerifiedApprovalVerdict(verdict) === true && outcome === APPROVED',
  rejectedVerdict: 'FAIL_CLOSED',
  callerBuiltPlan: 'FORBIDDEN（plan 自身 provenance + fingerprint + deep-freeze）',
  baseline: 'EXPLICIT_FINGERPRINT_REQUIRED；rollbackTargetFingerprint 必须等于 baselineConfigFingerprint；禁 ROLLBACK_TO_LATEST / 模糊默认值',
  binds: [
    'verdictDigest',
    'ticketDigest',
    'candidateDigest',
    'evaluationDigest',
    'evidenceSetDigest',
    'candidateTarget',
    'baselineConfigFingerprint',
    'rollbackTargetFingerprint',
    'rollbackSteps',
    'rollbackTrigger',
    'rollbackPlanDigest',
  ],
  productionWrite: 'HOLD',
} as const;

export const META_CANDIDATE_TARGETS = ['POLICY', 'GUARD', 'ROUTER', 'ACTION_RUNTIME'] as const;
export type MetaCandidateTargetName = (typeof META_CANDIDATE_TARGETS)[number];

export const ROLLBACK_TRIGGERS = [
  'CANARY_REGRESSION',
  'METRIC_THRESHOLD_BREACH',
  'ERROR_RATE_BREACH',
  'MANUAL_JUDGE_ORDER',
] as const;
export type RollbackTrigger = (typeof ROLLBACK_TRIGGERS)[number];

/** 禁止作为 baseline / rollback 目标的模糊值。 */
export const FORBIDDEN_ROLLBACK_TARGETS = ['ROLLBACK_TO_LATEST', 'LATEST', 'RESTORE_DEFAULTS', 'DEFAULTS', 'HEAD'] as const;

export interface RollbackStep {
  order: number;
  action: string;
}

export interface RollbackPlanInput {
  candidateTarget: string;
  baselineConfigFingerprint: string;
  rollbackTargetFingerprint: string;
  rollbackSteps: readonly RollbackStep[];
  rollbackTrigger: string;
}

export interface RollbackPlan {
  kind: 'ROLLBACK_PLAN';
  mode: 'ROLLBACK_PLAN_ONLY';
  planId: string;
  rollbackPlanDigest: string;
  verdictDigest: string;
  ticketDigest: string;
  candidateDigest: string;
  evaluationDigest: string;
  evidenceSetDigest: string;
  candidateTarget: MetaCandidateTargetName;
  baselineConfigFingerprint: string;
  rollbackTargetFingerprint: string;
  rollbackSteps: readonly RollbackStep[];
  rollbackTrigger: RollbackTrigger;
  execution: { executeRollback: 'FORBIDDEN'; autoApply: false; requiresHumanApproval: true };
}

const VERIFIED_ROLLBACK_PLANS = new WeakSet<RollbackPlan>();
const VERIFIED_ROLLBACK_PLAN_FINGERPRINTS = new WeakMap<RollbackPlan, string>();

const requireText = (value: unknown): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '');

const digest = (label: string, parts: readonly string[]): string =>
  label + ':' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

const rollbackPlanFingerprint = (plan: RollbackPlan): string =>
  JSON.stringify({
    kind: plan.kind,
    mode: plan.mode,
    planId: plan.planId,
    rollbackPlanDigest: plan.rollbackPlanDigest,
    verdictDigest: plan.verdictDigest,
    ticketDigest: plan.ticketDigest,
    candidateDigest: plan.candidateDigest,
    evaluationDigest: plan.evaluationDigest,
    evidenceSetDigest: plan.evidenceSetDigest,
    candidateTarget: plan.candidateTarget,
    baselineConfigFingerprint: plan.baselineConfigFingerprint,
    rollbackTargetFingerprint: plan.rollbackTargetFingerprint,
    rollbackSteps: plan.rollbackSteps.map((step) => ({ order: step.order, action: step.action })),
    rollbackTrigger: plan.rollbackTrigger,
    execution: { ...plan.execution },
  });

/** 只读 provenance：只有 createRollbackPlan() 产出的 plan 才为 true。 */
export function isVerifiedRollbackPlan(plan: RollbackPlan | null | undefined): boolean {
  if (plan === null || plan === undefined) return false;
  if (!VERIFIED_ROLLBACK_PLANS.has(plan)) return false;
  const fingerprint = VERIFIED_ROLLBACK_PLAN_FINGERPRINTS.get(plan);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === rollbackPlanFingerprint(plan);
  } catch {
    return false;
  }
}

/**
 * 由 **verified APPROVED verdict** 生成 rollback plan（只生成，不执行）。
 * fail-closed：verdict 未 provenance 登记 / 非 APPROVED / target 非法 / baseline 缺失或模糊 /
 * rollback 目标不等于 baseline / steps 缺失或畸形 / trigger 非法 → 一律 REJECT。
 */
export function createRollbackPlan(
  verdict: ApprovalVerdict | null | undefined,
  input: RollbackPlanInput | null | undefined,
): RollbackPlan {
  if (!isVerifiedApprovalVerdict(verdict)) {
    throw new Error('ROLLBACK_PLAN_VERDICT_NOT_VERIFIED');
  }
  if (verdict?.outcome !== 'APPROVED') {
    throw new Error('ROLLBACK_PLAN_VERDICT_NOT_APPROVED:' + String(verdict?.outcome));
  }
  if (input === null || input === undefined || typeof input !== 'object') {
    throw new Error('ROLLBACK_PLAN_INPUT_REQUIRED');
  }

  const candidateTarget = requireText(input.candidateTarget);
  if (!(META_CANDIDATE_TARGETS as readonly string[]).includes(candidateTarget)) {
    throw new Error('ROLLBACK_PLAN_TARGET_INVALID:' + candidateTarget);
  }
  const baselineConfigFingerprint = requireText(input.baselineConfigFingerprint);
  if (baselineConfigFingerprint === '') throw new Error('ROLLBACK_PLAN_BASELINE_REQUIRED');
  if ((FORBIDDEN_ROLLBACK_TARGETS as readonly string[]).includes(baselineConfigFingerprint.toUpperCase())) {
    throw new Error('ROLLBACK_PLAN_BASELINE_FORBIDDEN:' + baselineConfigFingerprint);
  }
  const rollbackTargetFingerprint = requireText(input.rollbackTargetFingerprint);
  if (rollbackTargetFingerprint === '') throw new Error('ROLLBACK_PLAN_TARGET_FINGERPRINT_REQUIRED');
  if ((FORBIDDEN_ROLLBACK_TARGETS as readonly string[]).includes(rollbackTargetFingerprint.toUpperCase())) {
    throw new Error('ROLLBACK_PLAN_TARGET_FINGERPRINT_FORBIDDEN:' + rollbackTargetFingerprint);
  }
  if (rollbackTargetFingerprint !== baselineConfigFingerprint) {
    throw new Error('ROLLBACK_PLAN_TARGET_MUST_EQUAL_BASELINE');
  }
  const rollbackTrigger = requireText(input.rollbackTrigger) as RollbackTrigger;
  if (!(ROLLBACK_TRIGGERS as readonly string[]).includes(rollbackTrigger)) {
    throw new Error('ROLLBACK_PLAN_TRIGGER_INVALID:' + rollbackTrigger);
  }
  const rawSteps = Array.isArray(input.rollbackSteps) ? input.rollbackSteps : [];
  if (rawSteps.length === 0) throw new Error('ROLLBACK_PLAN_STEPS_REQUIRED');
  const rollbackSteps: RollbackStep[] = [];
  rawSteps.forEach((step, index) => {
    const order = typeof step?.order === 'number' && Number.isInteger(step.order) ? step.order : -1;
    const action = requireText(step?.action);
    if (order !== index + 1 || action === '') {
      throw new Error('ROLLBACK_PLAN_STEPS_MALFORMED:' + String(index));
    }
    rollbackSteps.push({ order, action });
  });

  const rollbackPlanDigest = digest('rollback-plan', [
    ROLLBACK_PLAN_VERSION,
    verdict.verdictDigest,
    verdict.ticketDigest,
    verdict.candidateDigest,
    verdict.evaluationDigest,
    verdict.evidenceSetDigest,
    candidateTarget,
    baselineConfigFingerprint,
    rollbackTargetFingerprint,
    rollbackSteps.map((step) => step.order + ':' + step.action).join('+'),
    rollbackTrigger,
  ]);

  const plan: RollbackPlan = {
    kind: 'ROLLBACK_PLAN',
    mode: 'ROLLBACK_PLAN_ONLY',
    planId: 'rollback-plan:' + rollbackPlanDigest,
    rollbackPlanDigest,
    verdictDigest: verdict.verdictDigest,
    ticketDigest: verdict.ticketDigest,
    candidateDigest: verdict.candidateDigest,
    evaluationDigest: verdict.evaluationDigest,
    evidenceSetDigest: verdict.evidenceSetDigest,
    candidateTarget: candidateTarget as MetaCandidateTargetName,
    baselineConfigFingerprint,
    rollbackTargetFingerprint,
    rollbackSteps,
    rollbackTrigger,
    execution: { executeRollback: 'FORBIDDEN', autoApply: false, requiresHumanApproval: true },
  };
  Object.freeze(plan.execution);
  plan.rollbackSteps.forEach((step) => Object.freeze(step));
  Object.freeze(plan.rollbackSteps);
  Object.freeze(plan);
  VERIFIED_ROLLBACK_PLANS.add(plan);
  VERIFIED_ROLLBACK_PLAN_FINGERPRINTS.set(plan, rollbackPlanFingerprint(plan));
  return plan;
}
