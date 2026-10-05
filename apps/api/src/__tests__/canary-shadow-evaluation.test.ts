/**
 * PHASE 5 U4 FINAL4 —— Canary / Shadow（server-owned exact run-member binding）
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
  isVerifiedCanaryShadowEvaluation,
  isVerifiedCohortRun,
  type CohortRunSourcePort,
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
  nonce: 'u4f4-nonce-' + (nonce += 1),
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
  createCohortRef({ cohortId: 'cohort-1', datasetVersion: DATASET, evaluationWindow: WINDOW, taskRefs: TASK_REFS, ...over });

/** server-owned run source：按 index 把记录映射到 taskRefs。 */
const source = (records: readonly OutcomeRecord[], taskRefs: readonly string[] = TASK_REFS): CohortRunSourcePort => ({
  async read() {
    return records.map((outcomeRecord, index) => ({
      taskRef: taskRefs[index] ?? 'unknown-' + index,
      outcomeRecord,
    }));
  },
});

const tryRun = async (ref: unknown, records: readonly OutcomeRecord[], side: 'BASELINE' | 'PROPOSAL', taskRefs = TASK_REFS) => {
  try {
    return await createVerifiedCohortRun(source(records, taskRefs), trustedLineage(), ref as never, side);
  } catch {
    return null as never;
  }
};

const canary = async (i: Record<string, unknown>) => {
  const ref = (i.cohortRef ?? cohortRef()) as never;
  const baselineRecords = (i.baselineRecords ?? []) as readonly OutcomeRecord[];
  const proposalRecords = (i.proposalRecords ?? baselineRecords) as readonly OutcomeRecord[];
  const taskRefs = (i.taskRefs as string[]) ?? TASK_REFS;
  return evaluateCanaryShadow({
    proposal: i.proposal as never,
    rollbackPlan: i.rollbackPlan as never,
    baselineEvaluation: (await evaluate(baselineRecords)) as never,
    proposalEvaluation: (await evaluate(proposalRecords)) as never,
    cohortRef: ref,
    evaluationWindow: (i.evaluationWindow ?? WINDOW) as never,
    baselineRun: (await tryRun(ref, baselineRecords, 'BASELINE', taskRefs)) as never,
    proposalRun: (await tryRun(ref, proposalRecords, 'PROPOSAL', taskRefs)) as never,
  });
};

describe('PHASE 5 U4 FINAL4 —— server-owned exact run-member binding', () => {
  it('P5U4_1 同 cohort 同成员、两侧结果不同 → PASS 且 metric-delta 可见（ELIGIBLE）', async () => {
    const { proposal, plan } = await proposalCtx();
    const result = await canary({
      proposal,
      rollbackPlan: plan,
      baselineRecords: run(2, 2, 'base'),
      proposalRecords: run(3, 1, 'prop'),
    });
    expect(result.metricDeltas.successRateDelta).toBeCloseTo(0.25, 10);
    expect(result.recommendation).toBe('ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW');
    expect(result.cohortDigest).toBe(cohortRef().cohortRefDigest);
    expect(isVerifiedCanaryShadowEvaluation(result)).toBe(true);
    expect(result.baselineEvaluationDigest).not.toBe(result.proposalEvaluationDigest);
  });

  it('P5U4_2 顺序打乱仍 PASS（canonical）；提案回归 → ROLLBACK_REQUIRED', async () => {
    const { proposal, plan } = await proposalCtx();
    const baseRecords = run(2, 2, 'base');
    const shuffled = [baseRecords[3]!, baseRecords[0]!, baseRecords[2]!, baseRecords[1]!];
    const same = await canary({ proposal, rollbackPlan: plan, baselineRecords: shuffled, proposalRecords: baseRecords });
    expect(same.triggers).toHaveLength(0);
    const regressed = await canary({
      proposal,
      rollbackPlan: plan,
      baselineRecords: baseRecords,
      proposalRecords: run(1, 3, 'prop'),
    });
    expect(regressed.triggers).toContain('SUCCESS_RATE_DROP');
    expect(regressed.recommendation).toBe('ROLLBACK_REQUIRED');
    expect(regressed.rollbackTarget.target).toBe('U2_BASELINE');
  });

  it('P5U4_3 成员级绑定：等量不同成员 / 缺失 / 多余 / 重复 → run REJECT', async () => {
    const ref = cohortRef();
    const records = run(2, 2, 'base');
    expect(await tryRun(ref, records, 'BASELINE', ['t0', 't1', 't2', 'X'])).toBe(null);
    expect(await tryRun(ref, records, 'BASELINE', ['e0', 'e1', 'e2', 'e3'])).toBe(null);
    expect(await tryRun(ref, records.slice(0, 3), 'BASELINE', TASK_REFS)).toBe(null);
    const extra = [...records, record({ taskType: 'extra' })];
    expect(await tryRun(ref, extra, 'BASELINE', [...TASK_REFS, 't4'])).toBe(null);
    const dup = [records[0]!, records[0]!, records[2]!, records[3]!];
    expect(await tryRun(ref, dup, 'BASELINE', ['t0', 't0', 't2', 't3'])).toBe(null);
    const { proposal, plan } = await proposalCtx();
    await expect(
      canary({ proposal, rollbackPlan: plan, baselineRecords: records, proposalRecords: records, taskRefs: ['t0', 't1', 't2', 'X'] }),
    ).rejects.toThrow(/CANARY_RUN_NOT_VERIFIED|CANARY_RUN_INPUT_SET_MISMATCH/);
  });

  it('P5U4_4 run provenance：正式 run PASS，clone / 侧别不符 → REJECT', async () => {
    const ref = cohortRef();
    const records = run(2, 2, 'base');
    const baselineRun = await createVerifiedCohortRun(source(records), trustedLineage(), ref, 'BASELINE');
    const proposalRun = await createVerifiedCohortRun(source(records), trustedLineage(), ref, 'PROPOSAL');
    expect(isVerifiedCohortRun(baselineRun)).toBe(true);
    expect(isVerifiedCohortRun({ ...baselineRun })).toBe(false);
    const { proposal, plan } = await proposalCtx();
    const base = {
      proposal,
      rollbackPlan: plan,
      baselineEvaluation: await evaluate(records),
      proposalEvaluation: await evaluate(records),
      cohortRef: ref,
      evaluationWindow: WINDOW,
    };
    expect(() => evaluateCanaryShadow({ ...base, baselineRun: { ...baselineRun } as never, proposalRun })).toThrow(
      /CANARY_RUN_NOT_VERIFIED/,
    );
    expect(() => evaluateCanaryShadow({ ...base, baselineRun: proposalRun, proposalRun })).toThrow(
      /CANARY_RUN_SIDE_MISMATCH|CANARY_RUN_NOT_VERIFIED/,
    );
  });

  it('P5U4_5 非法 window → REJECT；数据不足 → ROLLBACK_REQUIRED + insufficientEvidence', async () => {
    const { proposal, plan } = await proposalCtx();
    await expect(
      canary({
        proposal,
        rollbackPlan: plan,
        baselineRecords: run(2, 2, 'base'),
        proposalRecords: run(2, 2, 'base'),
        evaluationWindow: { from: 'nope', to: 'nope' },
      }),
    ).rejects.toThrow(/CANARY_EVALUATION_WINDOW_INVALID/);
    const insufficient = await canary({
      proposal,
      rollbackPlan: plan,
      baselineRecords: unresolvedRun(),
      proposalRecords: unresolvedRun(),
    });
    expect(insufficient.insufficientEvidence).toBe(true);
    expect(insufficient.recommendation).toBe('ROLLBACK_REQUIRED');
  });

  it('P5U4_6 provenance / anti-tamper / 无执行面 + 边界', async () => {
    const { proposal, plan } = await proposalCtx();
    const result = await canary({
      proposal,
      rollbackPlan: plan,
      baselineRecords: run(2, 2, 'base'),
      proposalRecords: run(2, 2, 'base'),
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
    const mod = (await import('../services/outcome-learning/canary-shadow-evaluation')) as unknown as Record<string, unknown>;
    for (const key of ['applyEvaluation', 'promote', 'rollout', 'mutatePolicy', 'executeAdoption']) {
      expect(mod[key]).toBeUndefined();
    }
    expect(CANARY_SHADOW_BOUNDARY.mode).toBe('SHADOW_ONLY');
    expect(CANARY_SHADOW_BOUNDARY.canaryPassStillCannotDeploy).toBe('CONTROLLED_ADOPTION_REVIEW_REQUIRED');
  });
});
