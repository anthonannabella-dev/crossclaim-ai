/**
 * PHASE 5 U4 FINAL2 —— Canary / Shadow（outcome-independent trusted cohort proof）
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
  CANARY_SHADOW_BOUNDARY,
  createCohortRef,
  createVerifiedCohortRun,
  evaluateCanaryShadow,
  isVerifiedCohortRun,
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
const WINDOW = { from: '2026-10-05T22:00:00.000Z', to: '2026-10-05T23:00:00.000Z' };
const TASK_REFS = ['t0', 't1', 't2', 't3'];

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
  nonce: 'u4f2-nonce-' + (nonce += 1),
});

const evaluate = (records: readonly OutcomeRecord[]): Promise<OfflineEvaluationResult> =>
  evaluateVerifiedLearningRecords(trustedLineage(), records, { datasetVersion: DATASET });

const run = (successCount: number, failureCount: number, suffix: string): OutcomeRecord[] => [
  ...Array.from({ length: successCount }, (_, i) => record({ taskType: 'ok-' + suffix + i })),
  ...Array.from({ length: failureCount }, (_, i) =>
    record({ taskType: 'bad-' + suffix + i, finalOutcome: 'FAILURE', evidenceQuality: 'WEAK', rejectionReason: 'r' + i }),
  ),
];

const unresolvedRun = (): OutcomeRecord[] =>
  Array.from({ length: 4 }, (_, i) => record({ taskType: 'u-' + i, finalOutcome: 'UNKNOWN', humanIntervention: null }));

const proposalCtx = async () => {
  let stored: readonly RsiEvidenceRecord[] = [];
  const store: RsiEvidenceLedgerStorePort = {
    read: () => stored,
    commit: (next) => {
      stored = [...next];
    },
  };
  const records = run(1, 3, 'ctx');
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

const cohortRef = (over: Record<string, unknown> = {}) =>
  createCohortRef({
    cohortId: 'cohort-1',
    datasetVersion: DATASET,
    evaluationWindow: WINDOW,
    taskRefs: TASK_REFS,
    ...over,
  });

const safeRun = (ref: unknown, evaluation: unknown, side: 'BASELINE' | 'PROPOSAL') => {
  try {
    return createVerifiedCohortRun(ref as never, evaluation as never, side);
  } catch {
    return null as never;
  }
};

/** U4 FINAL3：所有调用统一经 VerifiedCohortRun 桥接层。 */
const canary = (i: Record<string, unknown>) =>
  evaluateCanaryShadow({
    proposal: i.proposal as never,
    rollbackPlan: i.rollbackPlan as never,
    baselineEvaluation: i.baselineEvaluation as never,
    proposalEvaluation: i.proposalEvaluation as never,
    cohortRef: i.cohortRef as never,
    evaluationWindow: i.evaluationWindow as never,
    baselineRun: safeRun(i.cohortRef, i.baselineEvaluation, 'BASELINE'),
    proposalRun: safeRun(i.cohortRef, i.proposalEvaluation, 'PROPOSAL'),
  });


describe('PHASE 5 U4 FINAL2 —— outcome-independent cohort proof + full digest binding', () => {
  it('P5U4_1 同一 cohort（outcome 无关）+ 不同 outcome/指标 → 允许且指标不被抹平', async () => {
    const { proposal, plan } = await proposalCtx();
    const baselineEvaluation = await evaluate(run(2, 2, 'base'));
    const proposalEvaluation = await evaluate(run(3, 1, 'prop'));
    const result = canary({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation,
      proposalEvaluation,
      cohortRef: cohortRef(),
      evaluationWindow: WINDOW,
    });
    expect(result.baselineMetrics.successRate).toBe(baselineEvaluation.resolved.successRate);
    expect(result.proposalMetrics.successRate).toBe(proposalEvaluation.resolved.successRate);
    expect(result.metricDeltas.successRateDelta).toBeCloseTo(0.25, 10);
    expect(result.triggers).toHaveLength(0);
    expect(result.recommendation).toBe('ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW');
    expect(result.cohortDigest).toBe(cohortRef().cohortRefDigest);
    expect(isVerifiedCanaryShadowEvaluation(result)).toBe(true);
    expect(CANARY_SHADOW_BOUNDARY.sameCohortProof).toContain('OUTCOME_INDEPENDENT_TRUSTED_COHORT_REF');
  });

  it('P5U4_2 metric-delta 回滚重新可达：同 cohort、提案成功率下降 → ROLLBACK_REQUIRED', async () => {
    const { proposal, plan } = await proposalCtx();
    const result = canary({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: await evaluate(run(2, 2, 'base')),
      proposalEvaluation: await evaluate(run(1, 3, 'prop')),
      cohortRef: cohortRef(),
      evaluationWindow: WINDOW,
    });
    expect(result.triggers).toContain('SUCCESS_RATE_DROP');
    expect(result.recommendation).toBe('ROLLBACK_REQUIRED');
    expect(result.rollbackTarget.target).toBe('U2_BASELINE');
    expect(result.rollbackTarget.baselineSnapshotDigest).toBe(plan.baselineSnapshotDigest);
    expect(result.execution.apply).toBe('FORBIDDEN');
    expect(result.execution.requiresControlledAdoptionReview).toBe(true);
  });

  it('P5U4_3 cohort 证明门：未 provenance 的 ref、规模不一致、window 不一致 → REJECT', async () => {
    const { proposal, plan } = await proposalCtx();
    const evaluation = await evaluate(run(2, 2, 'base'));
    const base = {
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: evaluation,
      proposalEvaluation: evaluation,
      evaluationWindow: WINDOW,
    };
    expect(() => canary({ ...base, cohortRef: { ...cohortRef() } as never })).toThrow(
      /CANARY_COHORT_REF_NOT_VERIFIED/,
    );
    expect(() => canary({ ...base, cohortRef: cohortRef({ taskRefs: ['t0', 't1', 't2'] }) })).toThrow(
      /CANARY_COHORT_SIZE_MISMATCH|CANARY_RUN_NOT_VERIFIED/,
    );
    expect(() =>
      canary({
        ...base,
        cohortRef: cohortRef({ evaluationWindow: { from: '2026-10-05T22:30:00.000Z', to: '2026-10-05T23:30:00.000Z' } }),
      }),
    ).toThrow(/CANARY_COHORT_WINDOW_MISMATCH/);
  });

  it('P5U4_4 window / cohort ref 构造 fail-closed：非法日期、缺任务、缺 window → REJECT', async () => {
    expect(() => cohortRef({ evaluationWindow: { from: 'nope', to: 'nope' } })).toThrow(/CANARY_EVALUATION_WINDOW_INVALID/);
    expect(() => cohortRef({ evaluationWindow: null })).toThrow(/CANARY_EVALUATION_WINDOW_INVALID/);
    expect(() => cohortRef({ taskRefs: [] })).toThrow(/CANARY_COHORT_TASKS_REQUIRED/);
    expect(() => cohortRef({ cohortId: '   ' })).toThrow(/CANARY_COHORT_REQUIRED/);
    const { proposal, plan } = await proposalCtx();
    const evaluation = await evaluate(run(2, 2, 'base'));
    expect(() =>
      canary({
        proposal,
        rollbackPlan: plan,
        baselineEvaluation: evaluation,
        proposalEvaluation: evaluation,
        cohortRef: cohortRef(),
        evaluationWindow: { from: '2026-10-05T23:00:00.000Z', to: '2026-10-05T22:00:00.000Z' },
      }),
    ).toThrow(/CANARY_EVALUATION_WINDOW_INVALID/);
  });

  it('P5U4_5 数据不足 → ROLLBACK_REQUIRED + insufficientEvidence（冻结规则）', async () => {
    const { proposal, plan } = await proposalCtx();
    const evaluation = await evaluate(unresolvedRun());
    const result = canary({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: evaluation,
      proposalEvaluation: evaluation,
      cohortRef: cohortRef(),
      evaluationWindow: WINDOW,
    });
    expect(result.insufficientEvidence).toBe(true);
    expect(result.triggers).toContain('INSUFFICIENT_EVIDENCE');
    expect(result.recommendation).toBe('ROLLBACK_REQUIRED');
  });

  it('P5U4_6 evaluationDigest 全字段 + cohort identity 绑定：指标或 cohort 变化 → digest 变化', async () => {
    const { proposal, plan } = await proposalCtx();
    const baselineEvaluation = await evaluate(run(2, 2, 'base'));
    const eligible = canary({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation,
      proposalEvaluation: await evaluate(run(3, 1, 'prop-a')),
      cohortRef: cohortRef(),
      evaluationWindow: WINDOW,
    });
    const differentMetrics = canary({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation,
      proposalEvaluation: await evaluate(run(1, 3, 'prop-b')),
      cohortRef: cohortRef(),
      evaluationWindow: WINDOW,
    });
    expect(eligible.evaluationDigest).not.toBe(differentMetrics.evaluationDigest);
    const otherCohort = cohortRef({ taskRefs: ['x0', 'x1', 'x2', 'x3'] });
    expect(otherCohort.cohortRefDigest).not.toBe(cohortRef().cohortRefDigest);
  });

  it('P5U4_7 provenance / anti-tamper / 无执行面', async () => {
    const { proposal, plan } = await proposalCtx();
    const evaluation = await evaluate(run(2, 2, 'base'));
    const result = canary({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: evaluation,
      proposalEvaluation: evaluation,
      cohortRef: cohortRef(),
      evaluationWindow: WINDOW,
    });
    expect(isVerifiedCanaryShadowEvaluation({ ...result })).toBe(false);
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
    const mod = (await import('../services/outcome-learning/canary-shadow-evaluation')) as unknown as Record<string, unknown>;
    for (const key of ['applyEvaluation', 'promote', 'rollout', 'mutatePolicy', 'executeAdoption', 'autoApply']) {
      expect(mod[key]).toBeUndefined();
    }
    expect(CANARY_SHADOW_BOUNDARY.mode).toBe('SHADOW_ONLY');
    expect(CANARY_SHADOW_BOUNDARY.canaryPassStillCannotDeploy).toBe('CONTROLLED_ADOPTION_REVIEW_REQUIRED');
  });
});

describe('PHASE 5 U4 FINAL3 —— VerifiedCohortRun bridge（member-level input ↔ evaluation binding）', () => {
  it('P5U4F3_1 run 门与绑定：未 provenance 的 run / 侧别不符 / run 与 evaluation 不一致 → REJECT', async () => {
    const { proposal, plan } = await proposalCtx();
    const evaluation = await evaluate(run(2, 2, 'base'));
    const ref = cohortRef();
    const baselineRun = createVerifiedCohortRun(ref, evaluation, 'BASELINE');
    const proposalRun = createVerifiedCohortRun(ref, evaluation, 'PROPOSAL');
    expect(isVerifiedCohortRun(baselineRun)).toBe(true);
    expect(isVerifiedCohortRun({ ...baselineRun })).toBe(false);
    const base = {
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: evaluation,
      proposalEvaluation: evaluation,
      cohortRef: ref,
      evaluationWindow: WINDOW,
      baselineRun,
      proposalRun,
    };
    expect(() => evaluateCanaryShadow({ ...base, baselineRun: { ...baselineRun } as never })).toThrow(
      /CANARY_RUN_NOT_VERIFIED/,
    );
    expect(() => evaluateCanaryShadow({ ...base, baselineRun: proposalRun })).toThrow(/CANARY_RUN_SIDE_MISMATCH/);
    const otherEvaluation = await evaluate(run(3, 1, 'other'));
    const staleRun = createVerifiedCohortRun(ref, otherEvaluation, 'BASELINE') as never;
    expect(() => evaluateCanaryShadow({ ...base, baselineRun: staleRun })).toThrow(
      /CANARY_RUN_EVALUATION_MISMATCH|CANARY_RUN_MEMBER_COUNT_MISMATCH/,
    );
  });

  it('P5U4F3_2 双侧 run 必须共享同一 inputSetDigest：两侧来自不同 cohort → REJECT', async () => {
    const { proposal, plan } = await proposalCtx();
    const evaluation = await evaluate(run(2, 2, 'base'));
    const refA = cohortRef();
    const refB = cohortRef({ taskRefs: ['x0', 'x1', 'x2', 'x3'] });
    const runA = createVerifiedCohortRun(refA, evaluation, 'BASELINE');
    const runB = createVerifiedCohortRun(refB, evaluation, 'PROPOSAL');
    expect(() =>
      evaluateCanaryShadow({
        proposal,
        rollbackPlan: plan,
        baselineEvaluation: evaluation,
        proposalEvaluation: evaluation,
        cohortRef: refA,
        baselineRun: runA,
        proposalRun: runB,
        evaluationWindow: WINDOW,
      }),
    ).toThrow(/CANARY_SAME_COHORT_REQUIRED/);
  });

  it('P5U4F3_3 artifact 绑定两侧 run 与 evaluationDigest（任一变化 → digest 变化）', async () => {
    const { proposal, plan } = await proposalCtx();
    const evaluation = await evaluate(run(2, 2, 'base'));
    const ref = cohortRef();
    const baselineRun = createVerifiedCohortRun(ref, evaluation, 'BASELINE');
    const proposalRun = createVerifiedCohortRun(ref, evaluation, 'PROPOSAL');
    const result = evaluateCanaryShadow({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: evaluation,
      proposalEvaluation: evaluation,
      cohortRef: ref,
      baselineRun,
      proposalRun,
      evaluationWindow: WINDOW,
    });
    expect(result.baselineRunDigest).toBe(baselineRun.runDigest);
    expect(result.proposalRunDigest).toBe(proposalRun.runDigest);
    expect(result.baselineEvaluationDigest).toBe(evaluation.evaluationDigest);
    expect(result.proposalEvaluationDigest).toBe(evaluation.evaluationDigest);
    const otherEvaluation = await evaluate(run(3, 1, 'other'));
    const otherRun = createVerifiedCohortRun(ref, otherEvaluation, 'PROPOSAL');
    const result2 = evaluateCanaryShadow({
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: evaluation,
      proposalEvaluation: otherEvaluation,
      cohortRef: ref,
      baselineRun,
      proposalRun: otherRun,
      evaluationWindow: WINDOW,
    });
    expect(result2.evaluationDigest).not.toBe(result.evaluationDigest);
  });
});
