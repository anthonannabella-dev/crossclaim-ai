/**
 * PHASE 5 U4 —— Canary / Shadow Evaluation（SHADOW_ONLY）
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
import { evaluateVerifiedLearningRecords, type OfflineEvaluationResult } from '../services/outcome-learning/offline-evaluation';
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

const dataset = (successCount: number, failureCount: number): OutcomeRecord[] => [
  ...Array.from({ length: successCount }, (_, i) => record({ taskType: 'ok-' + i })),
  ...Array.from({ length: failureCount }, (_, i) =>
    record({ taskType: 'bad-' + i, finalOutcome: 'FAILURE', evidenceQuality: 'WEAK', rejectionReason: 'r' + i }),
  ),
];

const proposalCtx = async () => {
  let stored: readonly RsiEvidenceRecord[] = [];
  const store: RsiEvidenceLedgerStorePort = {
    read: () => stored,
    commit: (next) => {
      stored = [...next];
    },
  };
  const records = dataset(1, 3);
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

describe('PHASE 5 U4 —— canary / shadow evaluation（SHADOW_ONLY）', () => {
  it('P5U4_1 双轨比较：同 cohort/datasetVersion/window，绑定 14 项，推荐三态之一', async () => {
    const { proposal, plan } = await proposalCtx();
    const result = evaluateCanaryShadow({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: await evaluate(dataset(2, 2)),
      proposalEvaluation: await evaluate(dataset(3, 1)),
      cohortDigest: 'cohort:v1',
      evaluationWindow: window_(),
    });
    expect(result.kind).toBe('CANARY_SHADOW_EVALUATION');
    expect(result.mode).toBe('SHADOW_ONLY');
    expect(CANARY_SHADOW_BOUNDARY.binds).toHaveLength(14);
    expect(result.proposalDigest).toBe(proposal.proposalDigest);
    expect(result.verdictDigest).toBe(proposal.verdictDigest);
    expect(result.rollbackPlanDigest).toBe(plan.rollbackPlanDigest);
    expect(result.baselineSnapshotDigest).toBe(plan.baselineSnapshotDigest);
    expect(result.datasetVersion).toBe(DATASET);
    expect(result.cohortDigest).toBe('cohort:v1');
    expect(CANARY_RECOMMENDATIONS).toContain(result.recommendation);
    expect(result.recommendation).toBe('ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW');
    expect(result.triggers).toHaveLength(0);
    expect(isVerifiedCanaryShadowEvaluation(result)).toBe(true);
  });

  it('P5U4_2 指标复用 Phase 4 口径（不新造第二套）：metrics 直接取自 verified offline evaluation', async () => {
    const { proposal, plan } = await proposalCtx();
    const baselineEvaluation = await evaluate(dataset(2, 2));
    const proposalEvaluation = await evaluate(dataset(1, 3));
    const result = evaluateCanaryShadow({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation,
      proposalEvaluation,
      cohortDigest: 'cohort:v1',
      evaluationWindow: window_(),
    });
    expect(result.baselineMetrics.successRate).toBe(baselineEvaluation.resolved.successRate);
    expect(result.proposalMetrics.successRate).toBe(proposalEvaluation.resolved.successRate);
    expect(result.proposalMetrics.nonSuccessRate).toBe(proposalEvaluation.resolved.failureRate);
    expect(result.proposalMetrics.rejectedRate).toBe(proposalEvaluation.resolved.rejectedRate);
    expect(result.proposalMetrics.unresolvedShareOfAllRecords).toBe(
      proposalEvaluation.unresolvedShareOfAllRecords,
    );
    expect(CANARY_SHADOW_BOUNDARY.secondMetricSystem).toBe('FORBIDDEN');
  });

  it('P5U4_3 强制回滚条件：successRate 下降超阈值 → ROLLBACK_REQUIRED，且回滚钉在 U2 baseline', async () => {
    const { proposal, plan } = await proposalCtx();
    const result = evaluateCanaryShadow({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: await evaluate(dataset(2, 2)),
      proposalEvaluation: await evaluate(dataset(1, 3)),
      cohortDigest: 'cohort:v1',
      evaluationWindow: window_(),
    });
    expect(result.triggers).toContain('SUCCESS_RATE_DROP');
    expect(result.recommendation).toBe('ROLLBACK_REQUIRED');
    expect(result.rollbackTarget).toEqual({
      baselineSnapshotDigest: plan.baselineSnapshotDigest,
      baselineConfigFingerprint: plan.baselineConfigFingerprint,
      target: 'U2_BASELINE',
    });
    expect(CANARY_SHADOW_BOUNDARY.forbiddenRollbackTargets).toEqual(['LATEST', 'DEFAULT', 'CURRENT', 'HEAD']);
    expect(result.execution).toEqual({
      apply: 'FORBIDDEN',
      promote: 'FORBIDDEN',
      rollout: 'FORBIDDEN',
      productionConfigMutation: 'FORBIDDEN',
      requiresControlledAdoptionReview: true,
    });
  });

  it('P5U4_4 数据不足 → INSUFFICIENT_EVIDENCE（不产生 ELIGIBLE）', async () => {
    const { proposal, plan } = await proposalCtx();
    const insufficient = await evaluate([record({ finalOutcome: 'UNKNOWN' }), record({ finalOutcome: 'MANUAL_REVIEW' })]);
    const result = evaluateCanaryShadow({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: await evaluate(dataset(2, 2)),
      proposalEvaluation: insufficient,
      cohortDigest: 'cohort:v1',
      evaluationWindow: window_(),
    });
    expect(result.recommendation).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.triggers).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('P5U4_5 双门与一致性：clone proposal/plan/evaluation、datasetVersion/window/cohort 不一致 → REJECT', async () => {
    const { proposal, plan } = await proposalCtx();
    const baselineEvaluation = await evaluate(dataset(2, 2));
    const proposalEvaluation = await evaluate(dataset(3, 1));
    expect(() =>
      evaluateCanaryShadow({
        proposal: { ...proposal } as never,
        rollbackPlan: plan,
        baselineEvaluation,
        proposalEvaluation,
        cohortDigest: 'cohort:v1',
        evaluationWindow: window_(),
      }),
    ).toThrow(/CANARY_PROPOSAL_NOT_VERIFIED/);
    expect(() =>
      evaluateCanaryShadow({
        proposal,
        rollbackPlan: { ...plan } as never,
        baselineEvaluation,
        proposalEvaluation,
        cohortDigest: 'cohort:v1',
        evaluationWindow: window_(),
      }),
    ).toThrow(/CANARY_ROLLBACK_PLAN_NOT_VERIFIED/);
    expect(() =>
      evaluateCanaryShadow({
        proposal,
        rollbackPlan: plan,
        baselineEvaluation: { ...baselineEvaluation } as never,
        proposalEvaluation,
        cohortDigest: 'cohort:v1',
        evaluationWindow: window_(),
      }),
    ).toThrow(/CANARY_EVALUATION_NOT_VERIFIED/);
    expect(() =>
      evaluateCanaryShadow({
        proposal,
        rollbackPlan: plan,
        baselineEvaluation,
        proposalEvaluation,
        cohortDigest: '   ',
        evaluationWindow: window_(),
      }),
    ).toThrow(/CANARY_COHORT_REQUIRED/);
    expect(() =>
      evaluateCanaryShadow({
        proposal,
        rollbackPlan: plan,
        baselineEvaluation,
        proposalEvaluation,
        cohortDigest: 'cohort:v1',
        evaluationWindow: { from: '2026-10-05T23:00:00.000Z', to: '2026-10-05T22:00:00.000Z' },
      }),
    ).toThrow(/CANARY_EVALUATION_WINDOW_INVALID/);
  });

  it('P5U4_6 provenance / anti-tamper：clone 不可信；原地篡改被冻结拒绝', async () => {
    const { proposal, plan } = await proposalCtx();
    const result = evaluateCanaryShadow({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: await evaluate(dataset(2, 2)),
      proposalEvaluation: await evaluate(dataset(3, 1)),
      cohortDigest: 'cohort:v1',
      evaluationWindow: window_(),
    });
    expect(isVerifiedCanaryShadowEvaluation({ ...result })).toBe(false);
    expect(isVerifiedCanaryShadowEvaluation(null)).toBe(false);
    const attempt = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    expect(attempt(() => { (result as unknown as { recommendation: string }).recommendation = 'ROLLBACK_REQUIRED'; })).toBe(false);
    expect(attempt(() => { (result.execution as unknown as { apply: string }).apply = 'ALLOWED'; })).toBe(false);
    expect(isVerifiedCanaryShadowEvaluation(result)).toBe(true);
  });

  it('P5U4_7 无执行面：不导出任何 apply / promote / rollout / mutate 入口，且 Canary PASS 也不能上线', async () => {
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
    expect(CANARY_RECOMMENDATIONS).toEqual([
      'ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW',
      'ROLLBACK_REQUIRED',
      'INSUFFICIENT_EVIDENCE',
    ]);
  });
});
