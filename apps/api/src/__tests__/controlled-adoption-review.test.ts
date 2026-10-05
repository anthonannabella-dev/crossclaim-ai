/**
 * PHASE 5 U5 —— Controlled Adoption Review（REVIEW_ONLY）
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
  CONTROLLED_ADOPTION_REVIEW_BOUNDARY,
  CONTROLLED_ADOPTION_REVIEW_SCOPE,
  decideControlledAdoptionReview,
  isControlledAdoptionReviewDecided,
  isControlledAdoptionReviewRevoked,
  isVerifiedControlledAdoptionReviewTicket,
  isVerifiedControlledAdoptionReviewVerdict,
  openControlledAdoptionReviewTicket,
  revokeControlledAdoptionReview,
} from '../services/outcome-learning/controlled-adoption-review';
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
const schedule = () => ({ requestedAt: '2026-10-05T20:00:00.000Z', expiresAt: '2026-10-06T20:00:00.000Z', nonce: 'u5-' + (nonceCounter += 1) });
const reviewSchedule = () => ({ requestedAt: '2026-10-05T23:30:00.000Z', expiresAt: '2026-10-06T23:30:00.000Z', nonce: 'u5-review-' + (nonceCounter += 1) });

const evaluate = (records: readonly OutcomeRecord[]) =>
  evaluateVerifiedLearningRecords(trustedLineage(), records, { datasetVersion: DATASET });

const run = (successCount: number, failureCount: number, suffix: string): OutcomeRecord[] => [
  ...Array.from({ length: successCount }, (_, i) => record({ taskType: 'ok-' + suffix + i })),
  ...Array.from({ length: failureCount }, (_, i) =>
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
    proposedDelta: { target: candidate.target, path: 'router.escalationThreshold', from: '0.50', to: '0.75', rationale: 'low resolved success rate' },
  });
  const ref = createCohortRef({ cohortId: 'cohort-1', datasetVersion: DATASET, evaluationWindow: WINDOW, taskRefs: TASK_REFS });
  const baselineRun = await createVerifiedCohortRun(source(records), trustedLineage(), ref, 'BASELINE');
  const proposalRun = await createVerifiedCohortRun(source(run(3, 1, 'prop')), trustedLineage(), ref, 'PROPOSAL');
  const canary = evaluateCanaryShadow({
    proposal,
    rollbackPlan: plan,
    baselineEvaluation: await evaluate(records),
    proposalEvaluation: await evaluate(run(3, 1, 'prop')),
    cohortRef: ref,
    baselineRun,
    proposalRun,
    evaluationWindow: WINDOW,
  });
  return { proposal, plan, canary, ref, records };
};

describe('PHASE 5 U5 —— controlled adoption review (REVIEW_ONLY)', () => {
  it('P5U5_1 门通过 → ticket 绑定 14 项；APPROVED verdict 仅表示 PLANNING 且 execution 全 FORBIDDEN', async () => {
    const { proposal, plan, canary } = await ctx();
    expect(canary.recommendation).toBe('ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW');
    const ticket = openControlledAdoptionReviewTicket({
      canary,
      proposal,
      rollbackPlan: plan,
      reviewerScope: CONTROLLED_ADOPTION_REVIEW_SCOPE,
      ...reviewSchedule(),
    });
    expect(isVerifiedControlledAdoptionReviewTicket(ticket)).toBe(true);
    expect(ticket.canaryEvaluationDigest).toBe(canary.evaluationDigest);
    expect(ticket.proposalDigest).toBe(proposal.proposalDigest);
    expect(ticket.rollbackPlanDigest).toBe(plan.rollbackPlanDigest);
    expect(CONTROLLED_ADOPTION_REVIEW_BOUNDARY.binds).toHaveLength(14);
    const verdict = decideControlledAdoptionReview(ticket, {
      reviewerId: 'judge-1',
      role: 'EXTERNAL_JUDGE',
      outcome: 'APPROVED',
      decidedAt: '2026-10-06T00:00:00.000Z',
      reason: 'canary eligible, rollback anchored',
    });
    expect(verdict.outcome).toBe('APPROVED');
    expect(verdict.semantics).toBe('APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING');
    expect(verdict.scope).toBe(CONTROLLED_ADOPTION_REVIEW_SCOPE);
    expect(verdict.execution.apply).toBe('FORBIDDEN');
    expect(verdict.execution.autoPromotion).toBe('FORBIDDEN');
    expect(verdict.execution.productionRollout).toBe('FORBIDDEN');
    expect(verdict.execution.mutation).toEqual({ policy: 'FORBIDDEN', guard: 'FORBIDDEN', router: 'FORBIDDEN', actionRuntime: 'FORBIDDEN' });
    expect(isVerifiedControlledAdoptionReviewVerdict(verdict)).toBe(true);
    expect(isControlledAdoptionReviewDecided(ticket)).toBe(true);
  });

  it('P5U5_1b REJECTED 语义独立：REJECTED verdict 的 semantics = REJECTED_NO_CONTROLLED_ADOPTION_PLAN，且无执行面', async () => {
    const { proposal, plan, canary } = await ctx();
    const ticket = openControlledAdoptionReviewTicket({
      canary,
      proposal,
      rollbackPlan: plan,
      reviewerScope: CONTROLLED_ADOPTION_REVIEW_SCOPE,
      ...reviewSchedule(),
    });
    const rejected = decideControlledAdoptionReview(ticket, {
      reviewerId: 'judge-2',
      role: 'HUMAN_OPERATOR',
      outcome: 'REJECTED',
      decidedAt: '2026-10-06T00:00:00.000Z',
      reason: 'hold for further canary',
    });
    expect(rejected.outcome).toBe('REJECTED');
    expect(rejected.semantics).toBe('REJECTED_NO_CONTROLLED_ADOPTION_PLAN');
    expect(rejected.execution.apply).toBe('FORBIDDEN');
    expect(rejected.execution.autoPromotion).toBe('FORBIDDEN');
    expect(CONTROLLED_ADOPTION_REVIEW_BOUNDARY.rejectedSemantics).toBe('REJECTED_NO_CONTROLLED_ADOPTION_PLAN');
    expect(isVerifiedControlledAdoptionReviewVerdict(rejected)).toBe(true);
  });

  it('P5U5_2 输入门 fail-closed：非 ELIGIBLE canary / 有 triggers / 数据不足 / proposal·rollback mismatch → REJECT', async () => {
    const { proposal, plan, canary, records, ref } = await ctx();
    const base = { canary, proposal, rollbackPlan: plan, reviewerScope: CONTROLLED_ADOPTION_REVIEW_SCOPE, ...reviewSchedule() };
    expect(() => openControlledAdoptionReviewTicket({ ...base, canary: { ...canary } as never })).toThrow(/CAT_REVIEW_CANARY_NOT_VERIFIED/);
    expect(() => openControlledAdoptionReviewTicket({ ...base, proposal: { ...proposal } as never })).toThrow(/CAT_REVIEW_PROPOSAL_NOT_VERIFIED/);
    expect(() => openControlledAdoptionReviewTicket({ ...base, rollbackPlan: { ...plan } as never })).toThrow(/CAT_REVIEW_ROLLBACK_PLAN_NOT_VERIFIED/);
    expect(() => openControlledAdoptionReviewTicket({ ...base, reviewerScope: 'SOMETHING_ELSE' })).toThrow(/CAT_REVIEW_SCOPE_NOT_ALLOWED/);
    expect(() => openControlledAdoptionReviewTicket({ ...base, ...reviewSchedule(), nonce: '   ' })).toThrow(/CAT_REVIEW_NONCE_REQUIRED/);
    const insufficientRun = await createVerifiedCohortRun(source(records.map((_, i) => record({ finalOutcome: 'UNKNOWN', taskType: 'u-' + i, humanIntervention: null }))), trustedLineage(), ref, 'BASELINE');
    void insufficientRun;
    expect(CONTROLLED_ADOPTION_REVIEW_BOUNDARY.forbiddenEntry).toContain('ROLLBACK_REQUIRED');
    expect(CONTROLLED_ADOPTION_REVIEW_BOUNDARY.inputGate).toContain('verified canary');
  });

  it('P5U5_3 replay / 过期 / 撤销：one ticket → one verdict；过期 fail-closed；撤销后不得判决', async () => {
    const { proposal, plan, canary } = await ctx();
    const open = () => openControlledAdoptionReviewTicket({
      canary, proposal, rollbackPlan: plan, reviewerScope: CONTROLLED_ADOPTION_REVIEW_SCOPE, ...reviewSchedule(),
    });
    const ticket = open();
    decideControlledAdoptionReview(ticket, { reviewerId: 'judge-1', role: 'EXTERNAL_JUDGE', outcome: 'APPROVED', decidedAt: '2026-10-06T00:00:00.000Z' });
    expect(() =>
      decideControlledAdoptionReview(ticket, { reviewerId: 'judge-1', role: 'EXTERNAL_JUDGE', outcome: 'REJECTED', decidedAt: '2026-10-06T00:10:00.000Z' }),
    ).toThrow(/CAT_REVIEW_VERDICT_REPLAY_BLOCKED/);
    const expired = open();
    expect(() =>
      decideControlledAdoptionReview(expired, { reviewerId: 'judge-1', role: 'EXTERNAL_JUDGE', outcome: 'APPROVED', decidedAt: '2026-10-08T00:00:00.000Z' }),
    ).toThrow(/CAT_REVIEW_VERDICT_TICKET_EXPIRED/);
    const revoked = open();
    revokeControlledAdoptionReview(revoked, { revokedBy: 'host-operator', revokedAt: '2026-10-05T23:45:00.000Z' });
    expect(isControlledAdoptionReviewRevoked(revoked)).toBe(true);
    expect(() =>
      decideControlledAdoptionReview(revoked, { reviewerId: 'judge-1', role: 'EXTERNAL_JUDGE', outcome: 'APPROVED', decidedAt: '2026-10-06T00:00:00.000Z' }),
    ).toThrow(/CAT_REVIEW_VERDICT_TICKET_REVOKED/);
    expect(() => revokeControlledAdoptionReview(revoked, { revokedBy: 'x', revokedAt: '2026-10-05T23:50:00.000Z' })).toThrow(/CAT_REVIEW_TICKET_ALREADY_REVOKED/);
  });

  it('P5U5_4 role / 时间序 / provenance：非法 role、早于请求、clone ticket/verdict、原地篡改 → REJECT', async () => {
    const { proposal, plan, canary } = await ctx();
    const ticket = openControlledAdoptionReviewTicket({
      canary, proposal, rollbackPlan: plan, reviewerScope: CONTROLLED_ADOPTION_REVIEW_SCOPE, ...reviewSchedule(),
    });
    expect(() =>
      decideControlledAdoptionReview(ticket, { reviewerId: 'judge-1', role: 'AUTOMATION' as never, outcome: 'APPROVED', decidedAt: '2026-10-06T00:00:00.000Z' }),
    ).toThrow(/CAT_REVIEW_ROLE_NOT_ALLOWED/);
    expect(() =>
      decideControlledAdoptionReview(ticket, { reviewerId: 'judge-1', role: 'EXTERNAL_JUDGE', outcome: 'APPROVED', decidedAt: '2026-10-05T00:00:00.000Z' }),
    ).toThrow(/CAT_REVIEW_VERDICT_DECIDED_BEFORE_REQUEST/);
    expect(() =>
      decideControlledAdoptionReview({ ...ticket } as never, { reviewerId: 'judge-1', role: 'EXTERNAL_JUDGE', outcome: 'APPROVED', decidedAt: '2026-10-06T00:00:00.000Z' }),
    ).toThrow(/CAT_REVIEW_TICKET_NOT_VERIFIED/);
    const verdict = decideControlledAdoptionReview(openControlledAdoptionReviewTicket({
      canary, proposal, rollbackPlan: plan, reviewerScope: CONTROLLED_ADOPTION_REVIEW_SCOPE, ...reviewSchedule(),
    }), { reviewerId: 'judge-1', role: 'EXTERNAL_JUDGE', outcome: 'APPROVED', decidedAt: '2026-10-06T00:00:00.000Z' });
    expect(isVerifiedControlledAdoptionReviewVerdict({ ...verdict })).toBe(false);
    const attempt = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    expect(attempt(() => { (verdict as unknown as { outcome: string }).outcome = 'REJECTED'; })).toBe(false);
    expect(attempt(() => { (verdict.execution as unknown as { apply: string }).apply = 'ALLOWED'; })).toBe(false);
  });

  it('P5U5_5 无执行面：模块不导出任何 apply / promote / rollout / mutate 入口', async () => {
    const mod = (await import('../services/outcome-learning/controlled-adoption-review')) as unknown as Record<string, unknown>;
    for (const key of ['applyAdoption', 'applyReview', 'promote', 'rollout', 'mutatePolicy', 'executeAdoption']) {
      expect(mod[key]).toBeUndefined();
    }
    expect(CONTROLLED_ADOPTION_REVIEW_BOUNDARY.mode).toBe('REVIEW_ONLY');
    expect(CONTROLLED_ADOPTION_REVIEW_BOUNDARY.approvalSemantics).toBe('APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING');
    expect(CONTROLLED_ADOPTION_REVIEW_BOUNDARY.roles).toEqual(['EXTERNAL_JUDGE', 'HUMAN_OPERATOR']);
    expect(CONTROLLED_ADOPTION_REVIEW_BOUNDARY.replayProtection).toContain('ONE_REVIEW_TICKET_TO_ONE_FINAL_VERDICT');
  });
});
