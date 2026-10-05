/**
 * PHASE 5 U4 —— Canary / Shadow Evaluation（SHADOW_ONLY）
 * ---------------------------------------------------------------
 * 链路（审计冻结 MSG-20261005-75）：Verified Controlled Config Proposal + Verified Rollback Plan +
 * Verified Baseline Snapshot + 两套 Phase 4 verified offline evaluation → CANARY_SHADOW_EVALUATION。
 * 硬约束：只做 baseline / proposal 双轨比较，不写入真实 config SSOT；externalWrite=0 / payment=0 /
 * realClaimSubmission=0 / ACTION_RUNTIME 仅模拟；核心指标**复用 Phase 4 口径**（不新造第二套）；
 * recommendation 仅三态；强制回滚条件命中即 ROLLBACK_REQUIRED，且回滚必须钉在 U2 baseline；
 * 本模块不导出任何 apply / promote / rollout / mutate 入口。
 */

import { createHash } from 'node:crypto';

import {
  isVerifiedControlledConfigProposal,
  type ControlledConfigProposal,
} from './controlled-config-proposal';
import { isVerifiedOfflineEvaluation, type OfflineEvaluationResult } from './offline-evaluation';
import { isVerifiedRollbackPlan, type RollbackPlan } from './rollback-plan';

export const CANARY_SHADOW_VERSION = 'canary-shadow-evaluation/v1';

export const CANARY_SHADOW_BOUNDARY = {
  mode: 'SHADOW_ONLY',
  dualTrack: 'BASELINE + PROPOSAL_OVERLAY',
  productionConfigMutation: 'FORBIDDEN',
  externalWrite: 0,
  payment: 0,
  realClaimSubmission: 0,
  actionRuntime: 'SIMULATE_ONLY',
  metricsSource: 'REUSE_PHASE_4_OFFLINE_EVALUATION_SEMANTICS（resolved denominator / successRate / failure·non-success / rejectedRate / unresolved share / human intervention / evidence quality）',
  secondMetricSystem: 'FORBIDDEN',
  sameCohortProof: 'OUTCOME_INDEPENDENT_TRUSTED_COHORT_REF（两侧必须共享同一个 createCohortRef 产物；cohortSize/datasetVersion/window 必须与两侧 evaluation 一致；不再要求 outcome digest 相同）',
  recommendation: ['ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW', 'ROLLBACK_REQUIRED', 'INSUFFICIENT_EVIDENCE'],
  autoApply: 'FORBIDDEN',
  autoPromote: 'FORBIDDEN',
  autoRollout: 'FORBIDDEN',
  rollbackTarget: 'U2_BASELINE（baselineSnapshotDigest + baselineConfigFingerprint）',
  forbiddenRollbackTargets: ['LATEST', 'DEFAULT', 'CURRENT', 'HEAD'],
  binds: [
    'proposalDigest',
    'verdictDigest',
    'candidateDigest',
    'rollbackPlanDigest',
    'baselineSnapshotDigest',
    'baselineConfigFingerprint',
    'datasetVersion',
    'cohortDigest',
    'evaluationWindow',
    'baselineMetrics',
    'proposalMetrics',
    'metricDeltas',
    'recommendation',
    'evaluationDigest',
  ],
  artifactProvenance: 'PROVENANCE_REGISTERED + fingerprint + deep-freeze',
  canaryPassStillCannotDeploy: 'CONTROLLED_ADOPTION_REVIEW_REQUIRED',
} as const;

export const CANARY_SHADOW_THRESHOLDS = {
  minimumResolvedDenominator: 1,
  maxSuccessRateDrop: 0.05,
  maxUnresolvedShareRise: 0.05,
  maxRejectedRateRise: 0.05,
  maxHumanInterventionRise: 0,
} as const;

export const CANARY_RECOMMENDATIONS = [
  'ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW',
  'ROLLBACK_REQUIRED',
  'INSUFFICIENT_EVIDENCE',
] as const;
export type CanaryRecommendation = (typeof CANARY_RECOMMENDATIONS)[number];

/** 与 outcome 无关的可信 cohort 标识（server-owned composition）。 */
export interface CohortRef {
  kind: 'COHORT_REF';
  cohortRefId: string;
  cohortRefDigest: string;
  cohortId: string;
  datasetVersion: string;
  evaluationWindow: { from: string; to: string };
  cohortSize: number;
  taskRefs: readonly string[];
  provenance: { source: 'SERVER_OWNED_COHORT_COMPOSITION' };
}

const VERIFIED_COHORT_REFS = new WeakSet<CohortRef>();
const VERIFIED_COHORT_REF_FINGERPRINTS = new WeakMap<CohortRef, string>();

const cohortRefFingerprint = (ref: CohortRef): string =>
  JSON.stringify({
    kind: ref.kind,
    cohortRefId: ref.cohortRefId,
    cohortRefDigest: ref.cohortRefDigest,
    cohortId: ref.cohortId,
    datasetVersion: ref.datasetVersion,
    evaluationWindow: { ...ref.evaluationWindow },
    cohortSize: ref.cohortSize,
    taskRefs: [...ref.taskRefs],
  });

export function isVerifiedCohortRef(ref: CohortRef | null | undefined): boolean {
  if (ref === null || ref === undefined) return false;
  if (!VERIFIED_COHORT_REFS.has(ref)) return false;
  const fingerprint = VERIFIED_COHORT_REF_FINGERPRINTS.get(ref);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === cohortRefFingerprint(ref);
  } catch {
    return false;
  }
}

/** 由 server-owned composition 生成“与 outcome 无关”的 cohort 标识。 */
export function createCohortRef(input: {
  cohortId: string;
  datasetVersion: string;
  evaluationWindow: { from: string; to: string } | null | undefined;
  taskRefs: readonly string[] | null | undefined;
}): CohortRef {
  const cohortId = requireText(input?.cohortId);
  if (cohortId === '') throw new Error('CANARY_COHORT_REQUIRED');
  const datasetVersion = requireText(input?.datasetVersion);
  if (datasetVersion === '') throw new Error('CANARY_COHORT_DATASET_REQUIRED');
  const window = input?.evaluationWindow;
  const fromMs = window ? Date.parse(window.from) : Number.NaN;
  const toMs = window ? Date.parse(window.to) : Number.NaN;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error('CANARY_EVALUATION_WINDOW_INVALID');
  }
  const taskRefs = (Array.isArray(input?.taskRefs) ? input.taskRefs : []).map((item) => requireText(item)).filter((item) => item !== '');
  if (taskRefs.length === 0) throw new Error('CANARY_COHORT_TASKS_REQUIRED');
  const sorted = [...new Set(taskRefs)].sort();
  const cohortRefDigest = digest('cohort-ref', [
    CANARY_SHADOW_VERSION,
    cohortId,
    datasetVersion,
    window!.from + '~' + window!.to,
    String(sorted.length),
    sorted.join('+'),
  ]);
  const ref: CohortRef = {
    kind: 'COHORT_REF',
    cohortRefId: 'cohort-ref:' + cohortRefDigest,
    cohortRefDigest,
    cohortId,
    datasetVersion,
    evaluationWindow: { from: window!.from, to: window!.to },
    cohortSize: sorted.length,
    taskRefs: sorted,
    provenance: { source: 'SERVER_OWNED_COHORT_COMPOSITION' },
  };
  Object.freeze(ref.taskRefs);
  Object.freeze(ref.evaluationWindow);
  Object.freeze(ref.provenance);
  Object.freeze(ref);
  VERIFIED_COHORT_REFS.add(ref);
  VERIFIED_COHORT_REF_FINGERPRINTS.set(ref, cohortRefFingerprint(ref));
  return ref;
}

export interface CanaryMetricSnapshot {
  resolvedDenominator: number;
  successRate: number | null;
  nonSuccessRate: number | null;
  rejectedRate: number | null;
  unresolvedShareOfAllRecords: number | null;
  humanInterventionCount: number;
  byEvidenceQuality: Readonly<Record<string, number>>;
  insufficientData: boolean;
}

export interface CanaryMetricDeltas {
  successRateDelta: number | null;
  nonSuccessRateDelta: number | null;
  rejectedRateDelta: number | null;
  unresolvedShareDelta: number | null;
  humanInterventionDelta: number;
}

export interface CanaryShadowEvaluation {
  kind: 'CANARY_SHADOW_EVALUATION';
  mode: 'SHADOW_ONLY';
  evaluationId: string;
  evaluationDigest: string;
  proposalDigest: string;
  verdictDigest: string;
  candidateDigest: string;
  rollbackPlanDigest: string;
  baselineSnapshotDigest: string;
  baselineConfigFingerprint: string;
  datasetVersion: string;
  cohortId: string;
  cohortDigest: string;
  evaluationWindow: { from: string; to: string };
  baselineMetrics: CanaryMetricSnapshot;
  proposalMetrics: CanaryMetricSnapshot;
  metricDeltas: CanaryMetricDeltas;
  triggers: readonly string[];
  insufficientEvidence: boolean;
  recommendation: CanaryRecommendation;
  rollbackTarget: { baselineSnapshotDigest: string; baselineConfigFingerprint: string; target: 'U2_BASELINE' };
  execution: {
    apply: 'FORBIDDEN';
    promote: 'FORBIDDEN';
    rollout: 'FORBIDDEN';
    productionConfigMutation: 'FORBIDDEN';
    requiresControlledAdoptionReview: true;
  };
}

const VERIFIED_CANARY_EVALUATIONS = new WeakSet<CanaryShadowEvaluation>();
const VERIFIED_CANARY_EVALUATION_FINGERPRINTS = new WeakMap<CanaryShadowEvaluation, string>();

const requireText = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');

const digest = (label: string, parts: readonly string[]): string =>
  label + ':' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

const snapshotOf = (evaluation: OfflineEvaluationResult): CanaryMetricSnapshot => ({
  resolvedDenominator: evaluation.resolved.denominator,
  successRate: evaluation.resolved.successRate,
  nonSuccessRate: evaluation.resolved.failureRate,
  rejectedRate: evaluation.resolved.rejectedRate,
  unresolvedShareOfAllRecords: evaluation.unresolvedShareOfAllRecords,
  humanInterventionCount: evaluation.context.humanInterventionCount,
  byEvidenceQuality: { ...evaluation.context.byEvidenceQuality },
  insufficientData: evaluation.insufficientData,
});

const delta = (proposal: number | null, baseline: number | null): number | null =>
  proposal === null || baseline === null ? null : proposal - baseline;

const canaryFingerprint = (evaluation: CanaryShadowEvaluation): string =>
  JSON.stringify({
    kind: evaluation.kind,
    mode: evaluation.mode,
    evaluationId: evaluation.evaluationId,
    evaluationDigest: evaluation.evaluationDigest,
    proposalDigest: evaluation.proposalDigest,
    verdictDigest: evaluation.verdictDigest,
    candidateDigest: evaluation.candidateDigest,
    rollbackPlanDigest: evaluation.rollbackPlanDigest,
    baselineSnapshotDigest: evaluation.baselineSnapshotDigest,
    baselineConfigFingerprint: evaluation.baselineConfigFingerprint,
    datasetVersion: evaluation.datasetVersion,
    cohortDigest: evaluation.cohortDigest,
    evaluationWindow: { ...evaluation.evaluationWindow },
    baselineMetrics: { ...evaluation.baselineMetrics, byEvidenceQuality: { ...evaluation.baselineMetrics.byEvidenceQuality } },
    proposalMetrics: { ...evaluation.proposalMetrics, byEvidenceQuality: { ...evaluation.proposalMetrics.byEvidenceQuality } },
    metricDeltas: { ...evaluation.metricDeltas },
    triggers: [...evaluation.triggers],
    insufficientEvidence: evaluation.insufficientEvidence,
    recommendation: evaluation.recommendation,
    rollbackTarget: { ...evaluation.rollbackTarget },
    execution: { ...evaluation.execution },
  });

/** 只读 provenance：只有 evaluateCanaryShadow() 产出的 artifact 才为 true。 */
export function isVerifiedCanaryShadowEvaluation(
  evaluation: CanaryShadowEvaluation | null | undefined,
): boolean {
  if (evaluation === null || evaluation === undefined) return false;
  if (!VERIFIED_CANARY_EVALUATIONS.has(evaluation)) return false;
  const fingerprint = VERIFIED_CANARY_EVALUATION_FINGERPRINTS.get(evaluation);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === canaryFingerprint(evaluation);
  } catch {
    return false;
  }
}

/**
 * baseline / proposal 双轨比较（只比较，不写入、不应用）。
 * fail-closed：proposal / rollback plan / 两套 evaluation 未 provenance 登记、互绑不一致、
 * datasetVersion 或 evaluation window 不一致、cohortDigest 缺失 → REJECT。
 */
export function evaluateCanaryShadow(input: {
  proposal: ControlledConfigProposal | null | undefined;
  rollbackPlan: RollbackPlan | null | undefined;
  baselineEvaluation: OfflineEvaluationResult | null | undefined;
  proposalEvaluation: OfflineEvaluationResult | null | undefined;
  cohortRef: CohortRef | null | undefined;
  evaluationWindow: { from: string; to: string } | null | undefined;
}): CanaryShadowEvaluation {
  if (!isVerifiedControlledConfigProposal(input?.proposal)) {
    throw new Error('CANARY_PROPOSAL_NOT_VERIFIED');
  }
  if (!isVerifiedRollbackPlan(input?.rollbackPlan)) {
    throw new Error('CANARY_ROLLBACK_PLAN_NOT_VERIFIED');
  }
  const plan = input.rollbackPlan as RollbackPlan;
  const proposal = input.proposal as ControlledConfigProposal;
  if (plan.rollbackPlanDigest !== proposal.rollbackPlanDigest) {
    throw new Error('CANARY_ROLLBACK_PLAN_PROPOSAL_MISMATCH');
  }
  if (!isVerifiedOfflineEvaluation(input?.baselineEvaluation) || !isVerifiedOfflineEvaluation(input?.proposalEvaluation)) {
    throw new Error('CANARY_EVALUATION_NOT_VERIFIED');
  }
  const baseline = input.baselineEvaluation as OfflineEvaluationResult;
  const proposed = input.proposalEvaluation as OfflineEvaluationResult;
  if (baseline.datasetVersion !== proposed.datasetVersion) {
    throw new Error('CANARY_DATASET_VERSION_MISMATCH');
  }
  const window = input.evaluationWindow;
  if (window === null || window === undefined || requireText(window.from) === '' || requireText(window.to) === '') {
    throw new Error('CANARY_EVALUATION_WINDOW_REQUIRED');
  }
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error('CANARY_EVALUATION_WINDOW_INVALID');
  }
  // SAME_COHORT_PROOF（outcome-independent）：两侧共享同一个 trusted CohortRef，且与两侧 evaluation 一致
  if (!isVerifiedCohortRef(input?.cohortRef)) throw new Error('CANARY_COHORT_REF_NOT_VERIFIED');
  const cohortRef = input.cohortRef as CohortRef;
  if (cohortRef.datasetVersion !== baseline.datasetVersion) throw new Error('CANARY_COHORT_DATASET_MISMATCH');
  if (cohortRef.evaluationWindow.from !== window.from || cohortRef.evaluationWindow.to !== window.to) {
    throw new Error('CANARY_COHORT_WINDOW_MISMATCH');
  }
  if (cohortRef.cohortSize !== baseline.totalRecords || cohortRef.cohortSize !== proposed.totalRecords) {
    throw new Error('CANARY_COHORT_SIZE_MISMATCH');
  }
  const cohortId = cohortRef.cohortId;
  const cohortDigest = cohortRef.cohortRefDigest;

  const baselineMetrics = snapshotOf(baseline);
  const proposalMetrics = snapshotOf(proposed);
  const metricDeltas: CanaryMetricDeltas = {
    successRateDelta: delta(proposalMetrics.successRate, baselineMetrics.successRate),
    nonSuccessRateDelta: delta(proposalMetrics.nonSuccessRate, baselineMetrics.nonSuccessRate),
    rejectedRateDelta: delta(proposalMetrics.rejectedRate, baselineMetrics.rejectedRate),
    unresolvedShareDelta: delta(
      proposalMetrics.unresolvedShareOfAllRecords,
      baselineMetrics.unresolvedShareOfAllRecords,
    ),
    humanInterventionDelta: proposalMetrics.humanInterventionCount - baselineMetrics.humanInterventionCount,
  };

  const t = CANARY_SHADOW_THRESHOLDS;
  const triggers: string[] = [];
  if (
    baselineMetrics.insufficientData ||
    proposalMetrics.insufficientData ||
    proposalMetrics.resolvedDenominator < t.minimumResolvedDenominator ||
    baselineMetrics.resolvedDenominator < t.minimumResolvedDenominator
  ) {
    triggers.push('INSUFFICIENT_EVIDENCE');
  } else {
    if ((metricDeltas.successRateDelta ?? 0) < -t.maxSuccessRateDrop) triggers.push('SUCCESS_RATE_DROP');
    if ((metricDeltas.unresolvedShareDelta ?? 0) > t.maxUnresolvedShareRise) triggers.push('UNRESOLVED_SHARE_RISE');
    if ((metricDeltas.rejectedRateDelta ?? 0) > t.maxRejectedRateRise) triggers.push('REJECTED_RATE_RISE');
    if (metricDeltas.humanInterventionDelta > t.maxHumanInterventionRise) {
      triggers.push('HUMAN_INTERVENTION_RISE');
    }
  }

  const insufficientEvidence = triggers.includes('INSUFFICIENT_EVIDENCE');
  // 冻结规则：数据不足属于强制回滚条件 → 一律 ROLLBACK_REQUIRED（同时以 insufficientEvidence 标注）
  const recommendation: CanaryRecommendation = triggers.length > 0 ? 'ROLLBACK_REQUIRED' : 'ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW';

  const evaluationDigest = digest('canary-shadow', [
    CANARY_SHADOW_VERSION,
    proposal.proposalDigest,
    proposal.verdictDigest,
    proposal.candidateDigest,
    plan.rollbackPlanDigest,
    plan.baselineSnapshotDigest,
    plan.baselineConfigFingerprint,
    baseline.datasetVersion,
    cohortId,
    cohortDigest,
    cohortRef.taskRefs.join('+'),
    JSON.stringify({ ...baselineMetrics, byEvidenceQuality: baselineMetrics.byEvidenceQuality }),
    JSON.stringify({ ...proposalMetrics, byEvidenceQuality: proposalMetrics.byEvidenceQuality }),
    JSON.stringify(metricDeltas),
    window.from + '~' + window.to,
    String(baselineMetrics.resolvedDenominator),
    String(proposalMetrics.resolvedDenominator),
    String(metricDeltas.successRateDelta),
    String(metricDeltas.unresolvedShareDelta),
    triggers.join('+'),
    recommendation,
  ]);

  const evaluation: CanaryShadowEvaluation = {
    kind: 'CANARY_SHADOW_EVALUATION',
    mode: 'SHADOW_ONLY',
    evaluationId: 'canary-shadow:' + evaluationDigest,
    evaluationDigest,
    proposalDigest: proposal.proposalDigest,
    verdictDigest: proposal.verdictDigest,
    candidateDigest: proposal.candidateDigest,
    rollbackPlanDigest: plan.rollbackPlanDigest,
    baselineSnapshotDigest: plan.baselineSnapshotDigest,
    baselineConfigFingerprint: plan.baselineConfigFingerprint,
    datasetVersion: baseline.datasetVersion,
    cohortId,
    cohortDigest,
    evaluationWindow: { from: window.from, to: window.to },
    baselineMetrics,
    proposalMetrics,
    metricDeltas,
    triggers,
    insufficientEvidence,
    recommendation,
    rollbackTarget: {
      baselineSnapshotDigest: plan.baselineSnapshotDigest,
      baselineConfigFingerprint: plan.baselineConfigFingerprint,
      target: 'U2_BASELINE',
    },
    execution: {
      apply: 'FORBIDDEN',
      promote: 'FORBIDDEN',
      rollout: 'FORBIDDEN',
      productionConfigMutation: 'FORBIDDEN',
      requiresControlledAdoptionReview: true,
    },
  };
  Object.freeze(evaluation.baselineMetrics.byEvidenceQuality);
  Object.freeze(evaluation.baselineMetrics);
  Object.freeze(evaluation.proposalMetrics.byEvidenceQuality);
  Object.freeze(evaluation.proposalMetrics);
  Object.freeze(evaluation.metricDeltas);
  Object.freeze(evaluation.triggers);
  Object.freeze(evaluation.evaluationWindow);
  Object.freeze(evaluation.rollbackTarget);
  Object.freeze(evaluation.execution);
  Object.freeze(evaluation);
  VERIFIED_CANARY_EVALUATIONS.add(evaluation);
  VERIFIED_CANARY_EVALUATION_FINGERPRINTS.set(evaluation, canaryFingerprint(evaluation));
  return evaluation;
}
