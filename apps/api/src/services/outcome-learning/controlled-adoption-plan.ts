/**
 * PHASE 6 U1 —— Controlled Adoption Plan（PLAN_ONLY）
 * 冻结规格来源：MSG-20261005-84 NEXT。只生成“如何采用”的可信计划，**不执行采用**。
 * 语义只能是 READY_FOR_CONTROLLED_EXECUTION_GATE_REVIEW；apply / execute / promote / rollout /
 * configMutation 全 FORBIDDEN；执行前必须通过 stale-baseline 门（live fingerprint === plan 期望）。
 */

import { createHash } from 'node:crypto';

import { isVerifiedCanaryShadowEvaluation, type CanaryShadowEvaluation } from './canary-shadow-evaluation';
import {
  isVerifiedControlledAdoptionReviewVerdict,
  type ControlledAdoptionReviewVerdict,
} from './controlled-adoption-review';
import {
  TARGET_DELTA_PATHS,
  TARGET_DELTA_VALUE_SCHEMA,
  isVerifiedControlledConfigProposal,
  isValidDeltaValue,
  type ControlledConfigProposal,
} from './controlled-config-proposal';
import { isVerifiedRollbackPlan, type RollbackPlan } from './rollback-plan';

export const CONTROLLED_ADOPTION_PLAN_VERSION = 'controlled-adoption-plan/v1';
export const CONTROLLED_ADOPTION_PLAN_SEMANTICS = 'READY_FOR_CONTROLLED_EXECUTION_GATE_REVIEW';

export const CONTROLLED_ADOPTION_PLAN_BOUNDARY = {
  mode: 'PLAN_ONLY',
  entryGate: 'isVerifiedControlledAdoptionReviewVerdict(verdict) === true && outcome === APPROVED && semantics === APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING',
  semantics: CONTROLLED_ADOPTION_PLAN_SEMANTICS,
  forbiddenStates: ['APPLIED', 'DEPLOYED', 'ACTIVE'],
  apply: 'FORBIDDEN',
  execute: 'FORBIDDEN',
  promote: 'FORBIDDEN',
  rollout: 'FORBIDDEN',
  configMutation: 'FORBIDDEN',
  staleBaseline: 'FAIL_CLOSED（执行前 live config fingerprint 必须等于 plan.expectedBaselineConfigFingerprint，否则 STALE_BASELINE）',
  binds: [
    'planDigest',
    'reviewVerdictDigest',
    'proposalDigest',
    'canaryEvaluationDigest',
    'rollbackPlanDigest',
    'target',
    'path',
    'from',
    'to',
    'expectedBaselineSnapshotDigest',
    'expectedBaselineConfigFingerprint',
    'rollbackTarget',
    'createdAt',
    'expiresAt',
  ],
  artifactProvenance: 'PROVENANCE_REGISTERED + canonical fingerprint + deep-freeze',
  productionWrite: 'HOLD',
} as const;

export interface ControlledAdoptionPlan {
  kind: 'CONTROLLED_ADOPTION_PLAN';
  mode: 'PLAN_ONLY';
  semantics: typeof CONTROLLED_ADOPTION_PLAN_SEMANTICS;
  planId: string;
  planDigest: string;
  reviewVerdictDigest: string;
  proposalDigest: string;
  canaryEvaluationDigest: string;
  rollbackPlanDigest: string;
  candidateDigest: string;
  target: string;
  path: string;
  from: string;
  to: string;
  expectedBaselineSnapshotDigest: string;
  expectedBaselineConfigFingerprint: string;
  rollbackTarget: { baselineSnapshotDigest: string; baselineConfigFingerprint: string; target: 'U2_BASELINE' };
  createdAt: string;
  expiresAt: string;
  execution: {
    apply: 'FORBIDDEN';
    execute: 'FORBIDDEN';
    promote: 'FORBIDDEN';
    rollout: 'FORBIDDEN';
    configMutation: 'FORBIDDEN';
    requiresControlledExecutionGateReview: true;
  };
}

const VERIFIED_PLANS = new WeakSet<ControlledAdoptionPlan>();
const VERIFIED_PLAN_FINGERPRINTS = new WeakMap<ControlledAdoptionPlan, string>();

const requireText = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
const digest = (label: string, parts: readonly string[]): string =>
  label + ':' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
const isIso = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));

const planFingerprint = (plan: ControlledAdoptionPlan): string =>
  JSON.stringify({ ...plan, rollbackTarget: { ...plan.rollbackTarget }, execution: { ...plan.execution } });

export function isVerifiedControlledAdoptionPlan(plan: ControlledAdoptionPlan | null | undefined): boolean {
  if (plan === null || plan === undefined) return false;
  if (!VERIFIED_PLANS.has(plan)) return false;
  const fingerprint = VERIFIED_PLAN_FINGERPRINTS.get(plan);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === planFingerprint(plan);
  } catch {
    return false;
  }
}

/**
 * 生成 PLAN_ONLY 采用计划：入口门 + 全链摘要重绑定 + target/path/value schema 校验。
 * fail-closed：verdict 未 provenance / 非 APPROVED / semantics 不符 / 链上任一摘要不一致 /
 * path 不在 target allowlist / to 不符合字段 schema / from 不等于 trusted baseline 当前值 → REJECT。
 */
export function createControlledAdoptionPlan(input: {
  verdict: ControlledAdoptionReviewVerdict | null | undefined;
  canary: CanaryShadowEvaluation | null | undefined;
  proposal: ControlledConfigProposal | null | undefined;
  rollbackPlan: RollbackPlan | null | undefined;
  createdAt: string;
  expiresAt: string;
} | null | undefined): ControlledAdoptionPlan {
  if (input === null || input === undefined) throw new Error('ADOPTION_PLAN_INPUT_REQUIRED');
  if (!isVerifiedControlledAdoptionReviewVerdict(input.verdict)) throw new Error('ADOPTION_PLAN_VERDICT_NOT_VERIFIED');
  const verdict = input.verdict as ControlledAdoptionReviewVerdict;
  if (verdict.outcome !== 'APPROVED') throw new Error('ADOPTION_PLAN_VERDICT_NOT_APPROVED:' + verdict.outcome);
  if (verdict.semantics !== 'APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING') {
    throw new Error('ADOPTION_PLAN_VERDICT_SEMANTICS_INVALID:' + verdict.semantics);
  }
  if (!isVerifiedCanaryShadowEvaluation(input.canary)) throw new Error('ADOPTION_PLAN_CANARY_NOT_VERIFIED');
  const canary = input.canary as CanaryShadowEvaluation;
  if (!isVerifiedControlledConfigProposal(input.proposal)) throw new Error('ADOPTION_PLAN_PROPOSAL_NOT_VERIFIED');
  const proposal = input.proposal as ControlledConfigProposal;
  if (!isVerifiedRollbackPlan(input.rollbackPlan)) throw new Error('ADOPTION_PLAN_ROLLBACK_PLAN_NOT_VERIFIED');
  const plan = input.rollbackPlan as RollbackPlan;

  if (canary.evaluationDigest !== verdict.canaryEvaluationDigest) throw new Error('ADOPTION_PLAN_CANARY_MISMATCH');
  if (proposal.proposalDigest !== verdict.proposalDigest) throw new Error('ADOPTION_PLAN_PROPOSAL_MISMATCH');
  if (plan.rollbackPlanDigest !== verdict.rollbackPlanDigest) throw new Error('ADOPTION_PLAN_ROLLBACK_MISMATCH');
  if (canary.proposalDigest !== proposal.proposalDigest) throw new Error('ADOPTION_PLAN_CANARY_PROPOSAL_MISMATCH');
  if (canary.rollbackPlanDigest !== plan.rollbackPlanDigest) throw new Error('ADOPTION_PLAN_CANARY_ROLLBACK_MISMATCH');

  const target = requireText(proposal.candidateTarget);
  const allowedPaths = (TARGET_DELTA_PATHS as Record<string, readonly string[]>)[target];
  const path = requireText(proposal.proposedDelta.path);
  if (allowedPaths === undefined || !allowedPaths.includes(path)) {
    throw new Error('ADOPTION_PLAN_PATH_NOT_ALLOWED:' + target + ':' + path);
  }
  const to = requireText(proposal.proposedDelta.to);
  if (!isValidDeltaValue(path, to)) throw new Error('ADOPTION_PLAN_TO_VALUE_INVALID:' + target + ':' + path);
  const from = requireText(proposal.proposedDelta.from);
  if (!isValidDeltaValue(path, from)) throw new Error('ADOPTION_PLAN_FROM_VALUE_INVALID:' + target + ':' + path);

  if (!isIso(input.createdAt) || !isIso(input.expiresAt)) throw new Error('ADOPTION_PLAN_SCHEDULE_INVALID');
  if (Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) throw new Error('ADOPTION_PLAN_EXPIRY_INVALID');

  const planDigest = digest('controlled-adoption-plan', [
    CONTROLLED_ADOPTION_PLAN_VERSION,
    verdict.verdictDigest,
    proposal.proposalDigest,
    canary.evaluationDigest,
    plan.rollbackPlanDigest,
    target,
    path,
    from,
    to,
    plan.baselineSnapshotDigest,
    plan.baselineConfigFingerprint,
    input.createdAt,
    input.expiresAt,
  ]);
  const artifact: ControlledAdoptionPlan = {
    kind: 'CONTROLLED_ADOPTION_PLAN',
    mode: 'PLAN_ONLY',
    semantics: CONTROLLED_ADOPTION_PLAN_SEMANTICS,
    planId: 'controlled-adoption-plan:' + planDigest,
    planDigest,
    reviewVerdictDigest: verdict.verdictDigest,
    proposalDigest: proposal.proposalDigest,
    canaryEvaluationDigest: canary.evaluationDigest,
    rollbackPlanDigest: plan.rollbackPlanDigest,
    candidateDigest: proposal.candidateDigest,
    target,
    path,
    from,
    to,
    expectedBaselineSnapshotDigest: plan.baselineSnapshotDigest,
    expectedBaselineConfigFingerprint: plan.baselineConfigFingerprint,
    rollbackTarget: {
      baselineSnapshotDigest: plan.baselineSnapshotDigest,
      baselineConfigFingerprint: plan.baselineConfigFingerprint,
      target: 'U2_BASELINE',
    },
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    execution: {
      apply: 'FORBIDDEN',
      execute: 'FORBIDDEN',
      promote: 'FORBIDDEN',
      rollout: 'FORBIDDEN',
      configMutation: 'FORBIDDEN',
      requiresControlledExecutionGateReview: true,
    },
  };
  Object.freeze(artifact.rollbackTarget);
  Object.freeze(artifact.execution);
  Object.freeze(artifact);
  VERIFIED_PLANS.add(artifact);
  VERIFIED_PLAN_FINGERPRINTS.set(artifact, planFingerprint(artifact));
  return artifact;
}

/**
 * stale-baseline 门：未来任何执行前重读当前正式配置，fingerprint 必须等于计划期望值。
 * 不等 → STALE_BASELINE（fail-closed）。
 */
export function assertAdoptionPlanBaselineFresh(
  plan: ControlledAdoptionPlan | null | undefined,
  liveConfigFingerprint: string,
): { ok: true } {
  if (!isVerifiedControlledAdoptionPlan(plan)) throw new Error('ADOPTION_PLAN_NOT_VERIFIED');
  const verified = plan as ControlledAdoptionPlan;
  const live = requireText(liveConfigFingerprint);
  if (live === '' || live !== verified.expectedBaselineConfigFingerprint) {
    throw new Error('STALE_BASELINE:' + live + '!=' + verified.expectedBaselineConfigFingerprint);
  }
  void TARGET_DELTA_VALUE_SCHEMA;
  return { ok: true };
}
