/**
 * PHASE 5 U4 / U4 FINAL —— Canary / Shadow Evaluation（SHADOW_ONLY）
 */

import { describe, expect, it } from 'vitest';

import type { RsiEvidenceRecord } from '../services/autonomy/rsi-evidence-ledger';
import {
  APPROVER_SCOPES,
  decideCandidateReview,
  openCandidateReviewTicket,
  type ApproverIdentity,
} from '../services/outcome-learning/candidate-approval';
import {
  CANARY_RECOMMENDATIONS,
  CANARY_SHADOW_BOUNDARY,
  evaluateCanaryShadow,
  isVerifiedCanaryShadowEvaluation,
} from '../services/outcome-learning/canary-shadow-evaluation';
import { createControlledConfigProposal } from '../services/outcome-learning/controlled-config-proposal';
import {
  appendVerifiedLearningEvidence,
  createAppLearningEvidenceLedgerFromRsi,
  type RsiEvidenceLedgerStorePort,
} from '../services/outcome-learning/learning-evidence';
import { proposeMetaImprovementCandidates } from '../services/outcome-learning/meta-improvement-candidate';
import {
  evaluateVerifiedLearningRecords,
  type OfflineEvaluationResult,
} from '../services/outcome-learning/offline-evaluation';
import {
  createAppOutcomeLineageLedger,
  type OutcomeLineageLedgerPort,
} from '../services/outcome-learning/outcome-lineage';
import { buildOutcomeRecord, type OutcomeRecord } from '../services/outcome-learning/outcome-record';
import {
  captureBaselineConfigSnapshot,
  createRollbackPlan,
  type BaselineConfigStorePort,
} from '../services/outcome-learning/rollback-plan';

const DATASET = 'learning-dataset/v1';

const record = (over: Record<string, unknown> = {}): OutcomeRecord => {
  const res = buildOutcomeRecord({
    organizationId: 'org-1',
    taskId: 'task-1',
    taskType: 'recovery',
    domain: 'PLATFORM',
    provider: 'amazon',
    latencyMs: 1200,
    evidenceQuality: 'STRONG',
    recoveryAmount: 10,
    humanIntervention: false,
    retryReconcile: 'NONE',
    finalOutcome: 'SUCCESS',
    actionRef: 'action:1',
    proposalRef: 'proposal:1',
    evidenceRef: 'evidence:1',
    ...over,
  });
  if (!res.ok) throw new Error('reject: ' + res.reason);
  return res.record;
};

const trustedLineage = (): OutcomeLineageLedgerPort =>
  createAppOutcomeLineageLedger({
    actions: { async findRef() { return { organizationId: 'org-1', taskId: 'task-1' }; } },
    proposals: {
      async findRef() {
        return { organizationId: 'org-1', taskId: 'task-1', actionRef: 'action:1', evidenceRef: 'evidence:1' };
      },
    },
    evidence: { async findRef() { return { organizationId: 'org-1', taskId: 'task-1' }; } },
  });

const baselineStore: BaselineConfigStorePort = {
  async read() {
    return {
      configFingerprint: 'config:baseline-v1',
      capturedAt: '2026-10-05T20:10:00.000Z',
      configValues: { 'router.escalationThreshold': '0.50', 'router.modelTierPolicy': 'balanced' },
    };
  },
};

const approver = (): ApproverIdentity => ({ approverId: 'judge-1', role: 'EXTERNAL_JUDGE', scope: [APPROVER_SCOPES[0]] });

let nonce = 0;
const schedule = () => ({
  requestedAt: '2026-10-05T20:00:00.000Z',
  expiresAt: '2026-10-06T20:00:00.000Z',
  nonce: 'u4-nonce-' + (nonce += 1),
});

const evaluate = (records: readonly OutcomeRecord[]): Promise<OfflineEvaluationResult> =>
  evaluateVerifiedLearningRecords(trustedLineage(), records, { datasetVersion: DATASET });

/** 同一 cohort 的确定性记录集（两侧必须消费同一批）。 */
const cohort = (): OutcomeRecord[] => [
  record({ taskType: 'ok-0' }),
  record({ taskType: 'bad-0', finalOutcome: 'FAILURE', evidenceQuality: 'WEAK', rejectionReason: 'r0' }),
  record({ taskType: 'bad-1', finalOutcome: 'FAILURE', evidenceQuality: 'WEAK', rejectionReason: 'r1' }),
  record({ taskType: 'bad-2', finalOutcome: 'FAILURE', evidenceQuality: 'WEAK', rejectionReason: 'r2' }),
];

const unresolvedCohort = (): OutcomeRecord[] => [
  record({ taskType: 'u-0', finalOutcome: 'UNKNOWN', humanIntervention: null }),
  record({ taskType: 'u-1', finalOutcome: 'MANUAL_REVIEW', humanIntervention: null }),
];

const proposalCtx = async () => {
  let stored: readonly RsiEvidenceRecord[] = [];
  const store: RsiEvidenceLedgerStorePort = {
    read: () => stored,
    commit: (next) => {
      stored = [...next];
    },
  };
  const records = cohort();
  const evaluation = await evaluate(records);
  const ledger = createAppLearningEvidenceLedgerFromRsi(store);
  const appended = await appendVerifiedLearningEvidence(trustedLineage(), ledger, records, DATASET);
  const candidate = proposeMetaImprovementCandidates({ evaluation, evidenceSet: appended.evidenceSet }).candidates[0];
  if (!candidate) throw new Error('candidate');
  const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
  const verdict = decideCandidateReview(ticket, {
    approverId: 'judge-1',
    role: 'EXTERNAL_JUDGE',
    outcome: 'APPROVED',
    decidedAt: '2026-10-05T21:00:00.000Z',
  });
  const baseline = await captureBaselineConfigSnapshot(baselineStore, candidate.target);
  const plan = createRollbackPlan(verdict, candidate, baseline, {
    rollbackSteps: [{ order: 1, action: 'restore config to baseline fingerprint' }],
    rollbackTrigger: 'CANARY_REGRESSION',
  });
  const proposal = createControlledConfigProposal(verdict, plan, {
    proposedDelta: {
      target: candidate.target,
      path: 'router.escalationThreshold',
      from: '0.50',
      to: '0.75',
      rationale: 'low resolved success rate',
    },
  });
  return { proposal, plan };
};

const window_ = () => ({ from: '2026-10-05T22:00:00.000Z', to: '2026-10-05T23:00:00.000Z' });

const runOn = async (records: readonly OutcomeRecord[], over: Record<string, unknown> = {}) => {
  const { proposal, plan } = await proposalCtx();
  const baselineEvaluation = await evaluate(records);
  const proposalEvaluation = await evaluate(records);
  return evaluateCanaryShadow({
    proposal,
    rollbackPlan: plan,
    baselineEvaluation,
    proposalEvaluation,
    cohortId: 'cohort-1',
    cohortDigest: baselineEvaluation.verifiedOutcomeSetDigest,
    evaluationWindow: window_(),
    ...over,
  });
};

describe('PHASE 5 U4 FINAL —— canary / shadow evaluation（same cohort + full digest + strict window）', () => {
  it('P5U4_1 同一 cohort 双轨 → ELIGIBLE，绑定 14 项且指标复用 Phase 4 semantics', async () => {
    const records = cohort();
    const result = await runOn(records);
    const evaluation = await evaluate(records);
    expect(result.kind).toBe('CANARY_SHADOW_EVALUATION');
    expect(CANARY_SHADOW_BOUNDARY.binds).toHaveLength(14);
    expect(result.datasetVersion).toBe(DATASET);
    expect(result.cohortId).toBe('cohort-1');
    expect(result.cohortDigest).toBe(evaluation.verifiedOutcomeSetDigest);
    expect(result.baselineMetrics.successRate).toBe(evaluation.resolved.successRate);
    expect(result.proposalMetrics.successRate).toBe(evaluation.resolved.successRate);
    expect(CANARY_SHADOW_BOUNDARY.secondMetricSystem).toBe('FORBIDDEN');
    expect(result.triggers).toHaveLength(0);
    expect(result.insufficientEvidence).toBe(false);
    expect(result.recommendation).toBe('ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW');
    expect(isVerifiedCanaryShadowEvaluation(result)).toBe(true);
  });

  it('P5U4_2 SAME_COHORT_PROOF：两侧 verified outcome 集合不同 / cohortDigest 不是 trusted identity → REJECT', async () => {
    const { proposal, plan } = await proposalCtx();
    const cohortEvaluation = await evaluate(cohort());
    const otherEvaluation = await evaluate(unresolvedCohort());
    expect(() =>
      evaluateCanaryShadow({
        proposal,
        rollbackPlan: plan,
        baselineEvaluation: cohortEvaluation,
        proposalEvaluation: otherEvaluation,
        cohortId: 'cohort-1',
        cohortDigest: cohortEvaluation.verifiedOutcomeSetDigest,
        evaluationWindow: window_(),
      }),
    ).toThrow(/CANARY_SAME_COHORT_REQUIRED/);
    expect(() =>
      evaluateCanaryShadow({
        proposal,
        rollbackPlan: plan,
        baselineEvaluation: cohortEvaluation,
        proposalEvaluation: cohortEvaluation,
        cohortId: 'cohort-1',
        cohortDigest: 'cohort:caller-declared-fake',
        evaluationWindow: window_(),
      }),
    ).toThrow(/CANARY_COHORT_DIGEST_MISMATCH/);
    expect(CANARY_SHADOW_BOUNDARY.sameCohortProof).toContain('SAME_VERIFIED_OUTCOME_SET');
  });

  it('P5U4_3 EVALUATION_WINDOW_VALIDATION：非法日期字符串 / from >= to / 缺 window → REJECT', async () => {
    const { proposal, plan } = await proposalCtx();
    const evaluation = await evaluate(cohort());
    const base = {
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: evaluation,
      proposalEvaluation: evaluation,
      cohortId: 'cohort-1',
      cohortDigest: evaluation.verifiedOutcomeSetDigest,
    };
    expect(() => evaluateCanaryShadow({ ...base, evaluationWindow: { from: 'nope', to: 'nope' } })).toThrow(
      /CANARY_EVALUATION_WINDOW_INVALID/,
    );
    expect(() =>
      evaluateCanaryShadow({ ...base, evaluationWindow: { from: '2026-10-05T23:00:00.000Z', to: '2026-10-05T22:00:00.000Z' } }),
    ).toThrow(/CANARY_EVALUATION_WINDOW_INVALID/);
    expect(() => evaluateCanaryShadow({ ...base, evaluationWindow: null })).toThrow(/CANARY_EVALUATION_WINDOW_REQUIRED/);
  });

  it('P5U4_4 数据不足属于强制回滚条件：同 cohort 全未判定 → ROLLBACK_REQUIRED + insufficientEvidence', async () => {
    const result = await runOn(unresolvedCohort());
    expect(result.insufficientEvidence).toBe(true);
    expect(result.triggers).toContain('INSUFFICIENT_EVIDENCE');
    expect(result.recommendation).toBe('ROLLBACK_REQUIRED');
  });

  it('P5U4_5 回滚锚点固定 U2 + 无自动采用：ROLLBACK/ELIGIBLE 都不含 AUTO_APPLY 语义', async () => {
    const result = await runOn(unresolvedCohort());
    expect(result.rollbackTarget.baselineSnapshotDigest.startsWith('baseline-snapshot:')).toBe(true);
    expect(result.rollbackTarget.target).toBe('U2_BASELINE');
    expect(CANARY_SHADOW_BOUNDARY.forbiddenRollbackTargets).toEqual(['LATEST', 'DEFAULT', 'CURRENT', 'HEAD']);
    expect(result.execution).toEqual({
      apply: 'FORBIDDEN',
      promote: 'FORBIDDEN',
      rollout: 'FORBIDDEN',
      productionConfigMutation: 'FORBIDDEN',
      requiresControlledAdoptionReview: true,
    });
    expect(CANARY_RECOMMENDATIONS).toEqual([
      'ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW',
      'ROLLBACK_REQUIRED',
      'INSUFFICIENT_EVIDENCE',
    ]);
  });

  it('P5U4_6 门与 provenance：clone proposal/plan/evaluation → REJECT；clone artifact / 原地篡改 → 不可信', async () => {
    const { proposal, plan } = await proposalCtx();
    const evaluation = await evaluate(cohort());
    const base = {
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: evaluation,
      proposalEvaluation: evaluation,
      cohortId: 'cohort-1',
      cohortDigest: evaluation.verifiedOutcomeSetDigest,
      evaluationWindow: window_(),
    };
    expect(() => evaluateCanaryShadow({ ...base, proposal: { ...proposal } as never })).toThrow(/CANARY_PROPOSAL_NOT_VERIFIED/);
    expect(() => evaluateCanaryShadow({ ...base, rollbackPlan: { ...plan } as never })).toThrow(
      /CANARY_ROLLBACK_PLAN_NOT_VERIFIED/,
    );
    expect(() => evaluateCanaryShadow({ ...base, baselineEvaluation: { ...evaluation } as never })).toThrow(
      /CANARY_EVALUATION_NOT_VERIFIED/,
    );
    const result = evaluateCanaryShadow(base);
    expect(isVerifiedCanaryShadowEvaluation({ ...result })).toBe(false);
    const attempt = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    expect(attempt(() => { (result as unknown as { recommendation: string }).recommendation = 'ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW'; })).toBe(false);
    expect(attempt(() => { (result.execution as unknown as { apply: string }).apply = 'ALLOWED'; })).toBe(false);
    expect(isVerifiedCanaryShadowEvaluation(result)).toBe(true);
  });

  it('P5U4_7 无执行面：不导出 apply / promote / rollout / mutate 入口，Canary PASS 也不能上线', async () => {
    const mod = (await import('../services/outcome-learning/canary-shadow-evaluation')) as unknown as Record<string, unknown>;
    for (const key of ['applyEvaluation', 'promote', 'rollout', 'mutatePolicy', 'executeAdoption', 'autoApply']) {
      expect(mod[key]).toBeUndefined();
    }
    expect(CANARY_SHADOW_BOUNDARY.mode).toBe('SHADOW_ONLY');
    expect(CANARY_SHADOW_BOUNDARY.productionConfigMutation).toBe('FORBIDDEN');
    expect(CANARY_SHADOW_BOUNDARY.externalWrite).toBe(0);
    expect(CANARY_SHADOW_BOUNDARY.payment).toBe(0);
    expect(CANARY_SHADOW_BOUNDARY.realClaimSubmission).toBe(0);
    expect(CANARY_SHADOW_BOUNDARY.actionRuntime).toBe('SIMULATE_ONLY');
    expect(CANARY_SHADOW_BOUNDARY.autoPromote).toBe('FORBIDDEN');
    expect(CANARY_SHADOW_BOUNDARY.autoRollout).toBe('FORBIDDEN');
    expect(CANARY_SHADOW_BOUNDARY.canaryPassStillCannotDeploy).toBe('CONTROLLED_ADOPTION_REVIEW_REQUIRED');
  });
});
