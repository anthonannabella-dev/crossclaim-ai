/**
 * PHASE 6 U1 —— Controlled Adoption Plan（PLAN_ONLY）
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
  createCohortRef,
  createVerifiedCohortRun,
  evaluateCanaryShadow,
  type CohortRunSourcePort,
} from '../services/outcome-learning/canary-shadow-evaluation';
import {
  CONTROLLED_ADOPTION_REVIEW_SCOPE,
  decideControlledAdoptionReview,
  openControlledAdoptionReviewTicket,
} from '../services/outcome-learning/controlled-adoption-review';
import {
  CONTROLLED_ADOPTION_PLAN_BOUNDARY,
  CONTROLLED_ADOPTION_PLAN_SEMANTICS,
  assertAdoptionPlanBaselineFresh,
  createControlledAdoptionPlan,
  isVerifiedControlledAdoptionPlan,
} from '../services/outcome-learning/controlled-adoption-plan';
import { createControlledConfigProposal } from '../services/outcome-learning/controlled-config-proposal';
import {
  appendVerifiedLearningEvidence,
  createAppLearningEvidenceLedgerFromRsi,
  type RsiEvidenceLedgerStorePort,
} from '../services/outcome-learning/learning-evidence';
import { proposeMetaImprovementCandidates } from '../services/outcome-learning/meta-improvement-candidate';
import { evaluateVerifiedLearningRecords } from '../services/outcome-learning/offline-evaluation';
import {
  createAppOutcomeLineageLedger,
  type OutcomeLineageLedgerPort,
} from '../services/outcome-learning/outcome-lineage';
import { buildOutcomeRecord, type OutcomeRecord } from '../services/outcome-learning/outcome-record';
import { captureBaselineConfigSnapshot, createRollbackPlan, type BaselineConfigStorePort } from '../services/outcome-learning/rollback-plan';

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
let nonceCounter = 0;
const schedule = () => ({
  requestedAt: '2026-10-05T20:00:00.000Z',
  expiresAt: '2026-10-06T20:00:00.000Z',
  nonce: 'p6-' + (nonceCounter += 1),
});
const reviewSchedule = () => ({
  requestedAt: '2026-10-05T23:30:00.000Z',
  expiresAt: '2026-10-06T23:30:00.000Z',
  nonce: 'p6-review-' + (nonceCounter += 1),
});

const evaluate = (records: readonly OutcomeRecord[]) =>
  evaluateVerifiedLearningRecords(trustedLineage(), records, { datasetVersion: DATASET });

const run = (s: number, f: number, suffix: string): OutcomeRecord[] => [
  ...Array.from({ length: s }, (_, i) => record({ taskType: 'ok-' + suffix + i })),
  ...Array.from({ length: f }, (_, i) =>
    record({ taskType: 'bad-' + suffix + i, finalOutcome: 'FAILURE', evidenceQuality: 'WEAK', rejectionReason: 'r' + i }),
  ),
];

const source = (records: readonly OutcomeRecord[]): CohortRunSourcePort => ({
  async read() {
    return records.map((outcomeRecord, index) => ({ taskRef: TASK_REFS[index] ?? 'x' + index, outcomeRecord }));
  },
});

const ctx = async () => {
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
  const approval = decideCandidateReview(ticket, {
    approverId: 'judge-1',
    role: 'EXTERNAL_JUDGE',
    outcome: 'APPROVED',
    decidedAt: '2026-10-05T21:00:00.000Z',
  });
  const baseline = await captureBaselineConfigSnapshot(baselineStore, candidate.target);
  const plan = createRollbackPlan(approval, candidate, baseline, {
    rollbackSteps: [{ order: 1, action: 'restore config to baseline fingerprint' }],
    rollbackTrigger: 'CANARY_REGRESSION',
  });
  const proposal = createControlledConfigProposal(approval, plan, {
    proposedDelta: { target: candidate.target, path: 'router.escalationThreshold', from: '0.50', to: '0.75', rationale: 'low resolved success rate' },
  });
  const ref = createCohortRef({ cohortId: 'cohort-1', datasetVersion: DATASET, evaluationWindow: WINDOW, taskRefs: TASK_REFS });
  const canary = evaluateCanaryShadow({
    proposal,
    rollbackPlan: plan,
    baselineEvaluation: await evaluate(records),
    proposalEvaluation: await evaluate(run(3, 1, 'prop')),
    cohortRef: ref,
    baselineRun: await createVerifiedCohortRun(source(records), trustedLineage(), ref, 'BASELINE'),
    proposalRun: await createVerifiedCohortRun(source(run(3, 1, 'prop')), trustedLineage(), ref, 'PROPOSAL'),
    evaluationWindow: WINDOW,
  });
  const reviewTicket = openControlledAdoptionReviewTicket({
    canary,
    proposal,
    rollbackPlan: plan,
    reviewerScope: CONTROLLED_ADOPTION_REVIEW_SCOPE,
    ...reviewSchedule(),
  });
  const reviewVerdict = decideControlledAdoptionReview(reviewTicket, {
    reviewerId: 'judge-1',
    role: 'EXTERNAL_JUDGE',
    outcome: 'APPROVED',
    decidedAt: '2026-10-06T00:00:00.000Z',
    reason: 'canary eligible, rollback anchored',
  });
  return { proposal, plan, canary, reviewVerdict, records, ref };
};

const window6 = { createdAt: '2026-10-06T00:30:00.000Z', expiresAt: '2026-10-06T06:30:00.000Z' };
const planInput = (c: Awaited<ReturnType<typeof ctx>>) => ({
  verdict: c.reviewVerdict,
  canary: c.canary,
  proposal: c.proposal,
  rollbackPlan: c.plan,
  ...window6,
});

describe('PHASE 6 U1 —— controlled adoption plan (PLAN_ONLY)', () => {
  it('P6U1_1 verified APPROVED review verdict → plan 绑定 14 项；语义 = READY_FOR_CONTROLLED_EXECUTION_GATE_REVIEW', async () => {
    const c = await ctx();
    const plan = createControlledAdoptionPlan(planInput(c));
    expect(plan.kind).toBe('CONTROLLED_ADOPTION_PLAN');
    expect(plan.mode).toBe('PLAN_ONLY');
    expect(plan.semantics).toBe(CONTROLLED_ADOPTION_PLAN_SEMANTICS);
    expect(plan.reviewVerdictDigest).toBe(c.reviewVerdict.verdictDigest);
    expect(plan.canaryEvaluationDigest).toBe(c.canary.evaluationDigest);
    expect(plan.proposalDigest).toBe(c.proposal.proposalDigest);
    expect(plan.rollbackPlanDigest).toBe(c.plan.rollbackPlanDigest);
    expect(plan.expectedBaselineSnapshotDigest).toBe(c.plan.baselineSnapshotDigest);
    expect(plan.expectedBaselineConfigFingerprint).toBe(c.plan.baselineConfigFingerprint);
    expect(plan.rollbackTarget.target).toBe('U2_BASELINE');
    expect(plan.execution.apply).toBe('FORBIDDEN');
    expect(plan.execution.execute).toBe('FORBIDDEN');
    expect(plan.execution.promote).toBe('FORBIDDEN');
    expect(plan.execution.rollout).toBe('FORBIDDEN');
    expect(plan.execution.configMutation).toBe('FORBIDDEN');
    expect(plan.execution.requiresControlledExecutionGateReview).toBe(true);
    expect(CONTROLLED_ADOPTION_PLAN_BOUNDARY.binds).toHaveLength(14);
    expect(isVerifiedControlledAdoptionPlan(plan)).toBe(true);
  });

  it('P6U1_2 入口门 fail-closed：clone verdict / REJECTED / 错误 semantics / 链上摘要不一致 → REJECT', async () => {
    const c = await ctx();
    expect(() => createControlledAdoptionPlan({ ...planInput(c), verdict: { ...c.reviewVerdict } as never })).toThrow(
      /ADOPTION_PLAN_VERDICT_NOT_VERIFIED/,
    );
    expect(() => createControlledAdoptionPlan({ ...planInput(c), canary: { ...c.canary } as never })).toThrow(
      /ADOPTION_PLAN_CANARY_NOT_VERIFIED/,
    );
    expect(() => createControlledAdoptionPlan({ ...planInput(c), proposal: { ...c.proposal } as never })).toThrow(
      /ADOPTION_PLAN_PROPOSAL_NOT_VERIFIED/,
    );
    expect(() => createControlledAdoptionPlan({ ...planInput(c), rollbackPlan: { ...c.plan } as never })).toThrow(
      /ADOPTION_PLAN_ROLLBACK_PLAN_NOT_VERIFIED/,
    );
    expect(CONTROLLED_ADOPTION_PLAN_BOUNDARY.entryGate).toContain('APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING');
    expect(CONTROLLED_ADOPTION_PLAN_BOUNDARY.forbiddenStates).toEqual(['APPLIED', 'DEPLOYED', 'ACTIVE']);
  });

  it('P6U1_3 stale-baseline 门：live fingerprint 必须等于计划期望值，否则 STALE_BASELINE', async () => {
    const c = await ctx();
    const plan = createControlledAdoptionPlan(planInput(c));
    expect(assertAdoptionPlanBaselineFresh(plan, c.plan.baselineConfigFingerprint).ok).toBe(true);
    expect(() => assertAdoptionPlanBaselineFresh(plan, 'config:changed')).toThrow(/STALE_BASELINE/);
    expect(() => assertAdoptionPlanBaselineFresh(null, 'config:changed')).toThrow(/ADOPTION_PLAN_NOT_VERIFIED/);
    expect(() => assertAdoptionPlanBaselineFresh(plan, '   ')).toThrow(/STALE_BASELINE/);
    expect(CONTROLLED_ADOPTION_PLAN_BOUNDARY.staleBaseline).toContain('STALE_BASELINE');
  });

  it('P6U1_3b 时间顺序：createdAt 必须 >= review verdict 的 decidedAt → REJECT', async () => {
    const c = await ctx();
    expect(() =>
      createControlledAdoptionPlan({ ...planInput(c), createdAt: '2026-10-05T23:00:00.000Z' }),
    ).toThrow(/ADOPTION_PLAN_CREATED_BEFORE_VERDICT/);
    expect(c.reviewVerdict.decidedAt).toBe('2026-10-06T00:00:00.000Z');
    const ok = createControlledAdoptionPlan({ ...planInput(c), createdAt: c.reviewVerdict.decidedAt, expiresAt: '2026-10-06T06:30:00.000Z' });
    expect(isVerifiedControlledAdoptionPlan(ok)).toBe(true);
    expect(CONTROLLED_ADOPTION_PLAN_BOUNDARY.temporalOrdering).toContain('createdAt >= reviewVerdict.decidedAt');
  });

  it('P6U1_4 provenance / anti-tamper / 无执行入口', async () => {
    const c = await ctx();
    const plan = createControlledAdoptionPlan(planInput(c));
    expect(isVerifiedControlledAdoptionPlan({ ...plan })).toBe(false);
    const attempt = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    expect(attempt(() => { (plan as unknown as { to: string }).to = '0.99'; })).toBe(false);
    expect(attempt(() => { (plan.execution as unknown as { apply: string }).apply = 'ALLOWED'; })).toBe(false);
    expect(isVerifiedControlledAdoptionPlan(plan)).toBe(true);
    const mod = (await import('../services/outcome-learning/controlled-adoption-plan')) as unknown as Record<string, unknown>;
    for (const key of ['applyPlan', 'executePlan', 'promote', 'rollout', 'mutateConfig', 'applyAdoption']) {
      expect(mod[key]).toBeUndefined();
    }
  });
});
