/**
 * PHASE 4 U5 —— Meta-improvement Candidate Proposal Only
 * ---------------------------------------------------------------
 * 依据审计 U4 FINAL 裁决（MSG-20261005-63）：
 *   最低要求：verified learning/outcome evidence → `isVerifiedOfflineEvaluation(evaluation) === true`
 *   → candidate proposal；candidate 至少绑定 evaluationDigest / evaluationVersion / datasetVersion /
 *   source evidence refs+digests / candidateDigest，并明确 candidateStatus = PROPOSAL_ONLY。
 *
 * 严禁（硬边界，且本模块不提供任何执行入口）：
 *   candidate → Policy mutation / Guard mutation / Router mutation / Action Runtime mutation / automatic promotion。
 *   任何真正采用 candidate 的动作必须重新经过**外部 Judge / 人工批准**边界。
 *
 * 口径：
 *   - 纯离线、确定性、无网络、无真实模型调用、只读（不修改 evaluation / 不写任何存储）；
 *   - 输入不足（resolved 分母为 0 / insufficientData）→ 不生成任何 candidate（显式 insufficient 语义）；
 *   - 信任门直接复用 U4 的 `isVerifiedOfflineEvaluation()`，不重新实现一套评估信任判断。
 */

import { createHash } from 'node:crypto';

import { isVerifiedLearningEvidenceSet, type VerifiedLearningEvidenceSet } from './learning-evidence';
import { isVerifiedOfflineEvaluation, type OfflineEvaluationResult } from './offline-evaluation';

export const META_CANDIDATE_VERSION = 'meta-candidate/v1';
export const META_CANDIDATE_STATUS = 'PROPOSAL_ONLY';

export const META_CANDIDATE_BOUNDARY = {
  mode: 'PROPOSAL_ONLY',
  candidateStatus: 'PROPOSAL_ONLY',
  inputChain: 'verified learning evidence → verified offline evaluation → candidate proposal',
  trustGate: 'isVerifiedOfflineEvaluation(evaluation) === true',
  rawCallerMetrics: 'FORBIDDEN',
  autoPromotion: 'OFF',
  autoApply: false,
  policyMutation: 'FORBIDDEN',
  guardMutation: 'FORBIDDEN',
  routerMutation: 'FORBIDDEN',
  actionRuntimeMutation: 'FORBIDDEN',
  adoption: 'EXTERNAL_JUDGE_OR_HUMAN_APPROVAL_REQUIRED',
  binds: [
    'evaluationDigest',
    'evaluationVersion',
    'datasetVersion',
    'sourceEvidenceRefs',
    'sourceEvidenceDigests',
    'evidenceSetDigest',
    'candidateDigest',
  ],
  evidenceBinding: 'EXACT_SET_EQUALITY_WITH_EVALUATION_VERIFIED_OUTCOME_DIGESTS',
  evidenceSetBinding: 'sorted evidence outcomeDigests === sorted evaluation verifiedOutcomeDigests',
  evidenceManifest: 'VerifiedLearningEvidenceSet（provenance-registered，只能由 immutable ledger append 成功路径产生）',
  evidenceRefSource: 'RSI_IMMUTABLE_LEDGER_APPEND_RETURNED_REF',
  callerBuiltEvidence: 'FORBIDDEN（caller 自造 LearningEvidenceEntry / manifest 展开副本 → REJECT）',
  insufficientData: 'NO_CANDIDATE（分母为 0 不得生成 proposal）',
  observationOnly: true,
  secondMetaEvidenceStore: 'FORBIDDEN',
  productionWrite: 'HOLD',
} as const;

/** 规则表（确定性、阈值公开、只产出 proposal）。 */
export const META_CANDIDATE_RULES = [
  {
    key: 'LOW_RESOLVED_SUCCESS_RATE',
    target: 'ROUTER',
    kind: 'ESCALATE_REVIEW_TIER',
    threshold: 0.5,
    comparison: 'resolved.successRate < 0.5',
    rationale: 'resolved 成功率低于阈值：建议评估升级/复核档位（仅提案，不自动改 Router）。',
  },
  {
    key: 'HIGH_UNRESOLVED_SHARE',
    target: 'POLICY',
    kind: 'TIGHTEN_OUTCOME_RESOLUTION',
    threshold: 0.3,
    comparison: 'unresolvedShareOfAllRecords > 0.3',
    rationale: '未判定占比过高（PARTIAL / MANUAL_REVIEW / UNKNOWN）：建议收紧结果判定口径（仅提案，不自动改 Policy）。',
  },
  {
    key: 'WEAK_OR_MISSING_EVIDENCE_PRESENT',
    target: 'GUARD',
    kind: 'REQUIRE_STRONGER_EVIDENCE',
    threshold: 1,
    comparison: 'byEvidenceQuality.WEAK + byEvidenceQuality.MISSING >= 1',
    rationale: '存在 WEAK / MISSING 证据：建议提高证据强度要求（仅提案，不自动改 Guard）。',
  },
] as const;

export type MetaCandidateTarget = 'POLICY' | 'GUARD' | 'ROUTER' | 'ACTION_RUNTIME';

export interface MetaCandidateSourceEvidence {
  evidenceRefs: readonly string[];
  evidenceDigests: readonly string[];
  outcomeDigests: readonly string[];
  count: number;
}

export interface MetaCandidateMetricsSnapshot {
  totalRecords: number;
  resolvedDenominator: number;
  successRate: number | null;
  failureRate: number | null;
  rejectedRate: number | null;
  unresolvedCount: number;
  unresolvedShareOfAllRecords: number | null;
}

export interface MetaImprovementCandidate {
  candidateId: string;
  candidateStatus: 'PROPOSAL_ONLY';
  rule: string;
  target: 'POLICY' | 'GUARD' | 'ROUTER';
  kind: string;
  rationale: string;
  threshold: number;
  comparison: string;
  observed: number;
  evaluationDigest: string;
  evaluationVersion: string;
  datasetVersion: string;
  evidenceSetDigest: string;
  sourceEvidence: MetaCandidateSourceEvidence;
  metricsSnapshot: MetaCandidateMetricsSnapshot;
  candidateDigest: string;
  requiresApproval: true;
  autoApply: false;
  adoption: 'EXTERNAL_JUDGE_OR_HUMAN_APPROVAL_REQUIRED';
  mutation: {
    policy: 'FORBIDDEN';
    guard: 'FORBIDDEN';
    router: 'FORBIDDEN';
    actionRuntime: 'FORBIDDEN';
  };
}

export interface MetaCandidateProposalInput {
  evaluation: OfflineEvaluationResult;
  /** U3 产出的 provenance-bearing manifest（不得用 caller 自造对象替代）。 */
  evidenceSet: VerifiedLearningEvidenceSet;
}

export interface MetaCandidateProposalResult {
  candidateStatus: 'PROPOSAL_ONLY';
  candidates: readonly MetaImprovementCandidate[];
  insufficientData: boolean;
  reason: string | null;
  evaluationDigest: string;
  datasetVersion: string;
}

const sortAscending = (values: readonly string[]): string[] =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const requireText = (value: unknown): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '');

/** 只读快照：只复制需要的汇总指标，不保留 evaluation 引用。 */
const snapshotMetrics = (evaluation: OfflineEvaluationResult): MetaCandidateMetricsSnapshot => ({
  totalRecords: evaluation.totalRecords,
  resolvedDenominator: evaluation.resolved.denominator,
  successRate: evaluation.resolved.successRate,
  failureRate: evaluation.resolved.failureRate,
  rejectedRate: evaluation.resolved.rejectedRate,
  unresolvedCount: evaluation.unresolved.count,
  unresolvedShareOfAllRecords: evaluation.unresolvedShareOfAllRecords,
});

/**
 * 由**verified**离线评估 + U3 learning evidence 生成 meta-improvement candidates（仅提案）。
 * 不修改输入；不写任何存储；不提供任何执行/晋升入口。
 */
export function proposeMetaImprovementCandidates(
  input: MetaCandidateProposalInput | null | undefined,
): MetaCandidateProposalResult {
  if (input === null || input === undefined || typeof input !== 'object') {
    throw new Error('META_CANDIDATE_INPUT_REQUIRED');
  }
  const evaluation = input.evaluation;
  if (!isVerifiedOfflineEvaluation(evaluation)) {
    // 复用 U4 信任门：caller 构造 / 展开副本 / 未验证评估一律拒绝
    throw new Error('META_CANDIDATE_EVALUATION_NOT_VERIFIED');
  }
  const evidenceSet = input.evidenceSet;
  if (evidenceSet === null || evidenceSet === undefined) {
    throw new Error('META_CANDIDATE_EVIDENCE_REQUIRED');
  }
  if (!isVerifiedLearningEvidenceSet(evidenceSet)) {
    // caller 自造 manifest / 展开副本 / 未落账的 evidence entry 一律拒绝
    throw new Error('META_CANDIDATE_EVIDENCE_SET_NOT_VERIFIED');
  }
  if (requireText(evidenceSet.datasetVersion) !== evaluation.datasetVersion) {
    throw new Error('META_CANDIDATE_DATASET_VERSION_MISMATCH');
  }
  if (
    requireText(evidenceSet.evidenceSetDigest) === '' ||
    !Array.isArray(evidenceSet.outcomeDigests) ||
    !Array.isArray(evidenceSet.learningEvidenceRefs) ||
    !Array.isArray(evidenceSet.evidenceDigests) ||
    evidenceSet.outcomeDigests.length !== evidenceSet.learningEvidenceRefs.length ||
    evidenceSet.outcomeDigests.length !== evidenceSet.evidenceDigests.length
  ) {
    throw new Error('META_CANDIDATE_EVIDENCE_SET_MALFORMED');
  }
  const evaluationDigests = sortAscending(evaluation.verifiedOutcomeDigests.map((d) => String(d)));
  const evidenceOutcomeDigests = sortAscending(evidenceSet.outcomeDigests.map((d) => String(d)));
  if (
    evaluationDigests.length !== evidenceOutcomeDigests.length ||
    evaluationDigests.some((digest, index) => digest !== evidenceOutcomeDigests[index])
  ) {
    throw new Error('META_CANDIDATE_EVIDENCE_SET_MISMATCH');
  }

  const sourceEvidence: MetaCandidateSourceEvidence = {
    evidenceRefs: sortAscending(evidenceSet.learningEvidenceRefs.map((ref) => String(ref))),
    evidenceDigests: sortAscending(evidenceSet.evidenceDigests.map((digest) => String(digest))),
    outcomeDigests: sortAscending(evidenceSet.outcomeDigests.map((digest) => String(digest))),
    count: evidenceSet.outcomeDigests.length,
  };

  if (evaluation.insufficientData) {
    return {
      candidateStatus: META_CANDIDATE_STATUS,
      candidates: [],
      insufficientData: true,
      reason: 'META_CANDIDATE_INSUFFICIENT_DATA',
      evaluationDigest: evaluation.evaluationDigest,
      datasetVersion: evaluation.datasetVersion,
    };
  }

  const metricsSnapshot = snapshotMetrics(evaluation);
  const weakOrMissing =
    (evaluation.context.byEvidenceQuality['WEAK'] ?? 0) + (evaluation.context.byEvidenceQuality['MISSING'] ?? 0);

  const observedByRule: Record<string, number> = {
    LOW_RESOLVED_SUCCESS_RATE: evaluation.resolved.successRate ?? -1,
    HIGH_UNRESOLVED_SHARE: evaluation.unresolvedShareOfAllRecords ?? -1,
    WEAK_OR_MISSING_EVIDENCE_PRESENT: weakOrMissing,
  };
  const triggers: Record<string, boolean> = {
    LOW_RESOLVED_SUCCESS_RATE:
      evaluation.resolved.successRate !== null && evaluation.resolved.successRate < 0.5,
    HIGH_UNRESOLVED_SHARE:
      evaluation.unresolvedShareOfAllRecords !== null && evaluation.unresolvedShareOfAllRecords > 0.3,
    WEAK_OR_MISSING_EVIDENCE_PRESENT: weakOrMissing >= 1,
  };

  const candidates: MetaImprovementCandidate[] = [];
  for (const rule of META_CANDIDATE_RULES) {
    if (!triggers[rule.key]) continue;
    const observed = observedByRule[rule.key] ?? -1;
    const candidateDigest =
      'meta-candidate:' +
      createHash('sha256')
        .update(
          [
            META_CANDIDATE_VERSION,
            rule.key,
            rule.target,
            rule.kind,
            evaluation.evaluationDigest,
            evaluation.datasetVersion,
            evidenceSet.evidenceSetDigest,
            sourceEvidence.evidenceDigests.join('+'),
            sourceEvidence.outcomeDigests.join('+'),
            String(observed),
          ].join('|'),
        )
        .digest('hex')
        .slice(0, 16);
    candidates.push({
      candidateId: candidateDigest,
      candidateStatus: META_CANDIDATE_STATUS,
      rule: rule.key,
      target: rule.target,
      kind: rule.kind,
      rationale: rule.rationale,
      threshold: rule.threshold,
      comparison: rule.comparison,
      observed,
      evaluationDigest: evaluation.evaluationDigest,
      evaluationVersion: evaluation.evaluationVersion,
      datasetVersion: evaluation.datasetVersion,
      evidenceSetDigest: evidenceSet.evidenceSetDigest,
      sourceEvidence,
      metricsSnapshot,
      candidateDigest,
      requiresApproval: true,
      autoApply: false,
      adoption: 'EXTERNAL_JUDGE_OR_HUMAN_APPROVAL_REQUIRED',
      mutation: {
        policy: 'FORBIDDEN',
        guard: 'FORBIDDEN',
        router: 'FORBIDDEN',
        actionRuntime: 'FORBIDDEN',
      },
    });
  }

  return {
    candidateStatus: META_CANDIDATE_STATUS,
    candidates,
    insufficientData: false,
    reason: null,
    evaluationDigest: evaluation.evaluationDigest,
    datasetVersion: evaluation.datasetVersion,
  };
}
