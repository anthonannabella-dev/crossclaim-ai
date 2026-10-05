/**
 * PHASE 5 U2 —— Rollback Plan Contract（ROLLBACK_PLAN_ONLY）
 */

import { describe, expect, it } from 'vitest';

import {
  APPROVER_SCOPES,
  decideCandidateReview,
  openCandidateReviewTicket,
  type ApproverIdentity,
} from '../services/outcome-learning/candidate-approval';
import {
  ROLLBACK_PLAN_BOUNDARY,
  ROLLBACK_TRIGGERS,
  createRollbackPlan,
  isVerifiedRollbackPlan,
} from '../services/outcome-learning/rollback-plan';
import type { RsiEvidenceRecord } from '../services/autonomy/rsi-evidence-ledger';
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
  if (!res.ok) throw new Error('unexpected reject: ' + res.reason);
  return res.record;
};

const trustedLineage = (): OutcomeLineageLedgerPort =>
  createAppOutcomeLineageLedger({
    actions: {
      async findRef() {
        return { organizationId: 'org-1', taskId: 'task-1' };
      },
    },
    proposals: {
      async findRef() {
        return { organizationId: 'org-1', taskId: 'task-1', actionRef: 'action:1', evidenceRef: 'evidence:1' };
      },
    },
    evidence: {
      async findRef() {
        return { organizationId: 'org-1', taskId: 'task-1' };
      },
    },
  });

const makeCandidate = async () => {
  let stored: readonly RsiEvidenceRecord[] = [];
  const store: RsiEvidenceLedgerStorePort = {
    read: () => stored,
    commit: (next) => {
      stored = [...next];
    },
  };
  const records: OutcomeRecord[] = [
    record({ finalOutcome: 'SUCCESS' }),
    record({ finalOutcome: 'FAILURE', evidenceQuality: 'WEAK', rejectionReason: 'provider_declined' }),
    record({ finalOutcome: 'FAILURE', rejectionReason: 'provider_declined_2' }),
    record({ finalOutcome: 'UNKNOWN', humanIntervention: null }),
    record({ finalOutcome: 'UNKNOWN', humanIntervention: null, taskType: 'recovery-b' }),
    record({ finalOutcome: 'PARTIAL', humanIntervention: null }),
  ];
  const evaluation = await evaluateVerifiedLearningRecords(trustedLineage(), records, { datasetVersion: DATASET });
  const ledger = createAppLearningEvidenceLedgerFromRsi(store);
  const appended = await appendVerifiedLearningEvidence(trustedLineage(), ledger, records, DATASET);
  const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet: appended.evidenceSet });
  const candidate = result.candidates[0];
  if (!candidate) throw new Error('expected at least one candidate');
  return candidate;
};

const approver = (): ApproverIdentity => ({
  approverId: 'judge-1',
  role: 'EXTERNAL_JUDGE',
  scope: [APPROVER_SCOPES[0]],
});

let nonce = 0;
const schedule = () => ({
  requestedAt: '2026-10-05T20:00:00.000Z',
  expiresAt: '2026-10-06T20:00:00.000Z',
  nonce: 'rollback-nonce-' + (nonce += 1),
});

const approvedVerdict = async () => {
  const candidate = await makeCandidate();
  const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
  return decideCandidateReview(ticket, {
    approverId: 'judge-1',
    role: 'EXTERNAL_JUDGE',
    outcome: 'APPROVED',
    decidedAt: '2026-10-05T21:00:00.000Z',
    reason: 'evidence chain verified',
  });
};

const input = (over: Record<string, unknown> = {}) => ({
  candidateTarget: 'ROUTER',
  baselineConfigFingerprint: 'config:baseline-v1',
  rollbackTargetFingerprint: 'config:baseline-v1',
  rollbackSteps: [
    { order: 1, action: 'restore router config to baseline fingerprint' },
    { order: 2, action: 're-run canary shadow comparison' },
  ],
  rollbackTrigger: 'CANARY_REGRESSION',
  ...over,
});

describe('PHASE 5 U2 —— rollback plan contract', () => {
  it('P5U2_1 verified APPROVED verdict → plan 生成并绑定 11 项；ROLLBACK_PLAN_ONLY；不执行', async () => {
    const verdict = await approvedVerdict();
    const plan = createRollbackPlan(verdict, input());
    expect(plan.kind).toBe('ROLLBACK_PLAN');
    expect(plan.mode).toBe('ROLLBACK_PLAN_ONLY');
    expect(plan.planId).toBe('rollback-plan:' + plan.rollbackPlanDigest);
    expect(plan.verdictDigest).toBe(verdict.verdictDigest);
    expect(plan.ticketDigest).toBe(verdict.ticketDigest);
    expect(plan.candidateDigest).toBe(verdict.candidateDigest);
    expect(plan.evaluationDigest).toBe(verdict.evaluationDigest);
    expect(plan.evidenceSetDigest).toBe(verdict.evidenceSetDigest);
    expect(plan.candidateTarget).toBe('ROUTER');
    expect(plan.baselineConfigFingerprint).toBe('config:baseline-v1');
    expect(plan.rollbackTargetFingerprint).toBe(plan.baselineConfigFingerprint);
    expect(plan.rollbackSteps).toHaveLength(2);
    expect(plan.rollbackTrigger).toBe('CANARY_REGRESSION');
    expect(plan.execution).toEqual({ executeRollback: 'FORBIDDEN', autoApply: false, requiresHumanApproval: true });
    expect(isVerifiedRollbackPlan(plan)).toBe(true);
    expect(ROLLBACK_PLAN_BOUNDARY.binds).toHaveLength(11);
  });

  it('P5U2_2 verdict 门：未 provenance / clone / 手造 APPROVED verdict → REJECT', async () => {
    const verdict = await approvedVerdict();
    expect(() => createRollbackPlan({ ...verdict } as never, input())).toThrow(/ROLLBACK_PLAN_VERDICT_NOT_VERIFIED/);
    expect(() =>
      createRollbackPlan(
        {
          kind: 'APPROVAL_VERDICT',
          verdictDigest: 'forged',
          ticketDigest: 'forged',
          candidateDigest: 'forged',
          evaluationDigest: 'forged',
          evidenceSetDigest: 'forged',
          outcome: 'APPROVED',
        } as never,
        input(),
      ),
    ).toThrow(/ROLLBACK_PLAN_VERDICT_NOT_VERIFIED/);
  });

  it('P5U2_3 REJECTED verdict → fail-closed（绝不生成 rollback plan）', async () => {
    const candidate = await makeCandidate();
    const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
    const rejected = decideCandidateReview(ticket, {
      approverId: 'judge-1',
      role: 'EXTERNAL_JUDGE',
      outcome: 'REJECTED',
      decidedAt: '2026-10-05T21:00:00.000Z',
      reason: 'insufficient evidence',
    });
    expect(() => createRollbackPlan(rejected, input())).toThrow(/ROLLBACK_PLAN_VERDICT_NOT_APPROVED:REJECTED/);
  });

  it('P5U2_4 baseline / rollback 目标：缺失、模糊值、不等于 baseline → REJECT', async () => {
    const verdict = await approvedVerdict();
    expect(() => createRollbackPlan(verdict, input({ baselineConfigFingerprint: '' }))).toThrow(
      /ROLLBACK_PLAN_BASELINE_REQUIRED/,
    );
    expect(() => createRollbackPlan(verdict, input({ baselineConfigFingerprint: 'ROLLBACK_TO_LATEST' }))).toThrow(
      /ROLLBACK_PLAN_BASELINE_FORBIDDEN/,
    );
    expect(() => createRollbackPlan(verdict, input({ rollbackTargetFingerprint: 'LATEST' }))).toThrow(
      /ROLLBACK_PLAN_TARGET_FINGERPRINT_FORBIDDEN/,
    );
    expect(() =>
      createRollbackPlan(verdict, input({ rollbackTargetFingerprint: 'config:other' })),
    ).toThrow(/ROLLBACK_PLAN_TARGET_MUST_EQUAL_BASELINE/);
    expect(() => createRollbackPlan(verdict, input({ rollbackTargetFingerprint: '' }))).toThrow(
      /ROLLBACK_PLAN_TARGET_FINGERPRINT_REQUIRED/,
    );
  });

  it('P5U2_5 steps / trigger / target 校验：空 steps、乱序、空 action、非法 trigger、非法 target → REJECT', async () => {
    const verdict = await approvedVerdict();
    expect(() => createRollbackPlan(verdict, input({ rollbackSteps: [] }))).toThrow(/ROLLBACK_PLAN_STEPS_REQUIRED/);
    expect(() => createRollbackPlan(verdict, input({ rollbackSteps: [{ order: 2, action: 'x' }] }))).toThrow(
      /ROLLBACK_PLAN_STEPS_MALFORMED/,
    );
    expect(() => createRollbackPlan(verdict, input({ rollbackSteps: [{ order: 1, action: '   ' }] }))).toThrow(
      /ROLLBACK_PLAN_STEPS_MALFORMED/,
    );
    expect(() => createRollbackPlan(verdict, input({ rollbackTrigger: 'WHATEVER' }))).toThrow(
      /ROLLBACK_PLAN_TRIGGER_INVALID/,
    );
    expect(() => createRollbackPlan(verdict, input({ candidateTarget: 'BANANA' }))).toThrow(
      /ROLLBACK_PLAN_TARGET_INVALID/,
    );
    expect(ROLLBACK_TRIGGERS).toContain('CANARY_REGRESSION');
  });

  it('P5U2_6 plan provenance / anti-tamper：clone 与手造 plan 不可信；原地篡改被冻结拒绝', async () => {
    const verdict = await approvedVerdict();
    const plan = createRollbackPlan(verdict, input());
    expect(isVerifiedRollbackPlan({ ...plan })).toBe(false);
    expect(isVerifiedRollbackPlan(null)).toBe(false);
    const handmade = { ...plan, rollbackPlanDigest: 'forged' } as never;
    expect(isVerifiedRollbackPlan(handmade)).toBe(false);
    const attempt = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    expect(
      attempt(() => {
        (plan as unknown as { rollbackTrigger: string }).rollbackTrigger = 'MANUAL_JUDGE_ORDER';
      }),
    ).toBe(false);
    expect(
      attempt(() => {
        (plan.execution as unknown as { executeRollback: string }).executeRollback = 'ALLOWED';
      }),
    ).toBe(false);
    expect(isVerifiedRollbackPlan(plan)).toBe(true);
  });

  it('P5U2_7 无执行面：不导出任何 apply / execute / rollback 执行入口；边界清单为 HOLD/FORBIDDEN', async () => {
    const mod = (await import('../services/outcome-learning/rollback-plan')) as unknown as Record<string, unknown>;
    for (const key of ['executeRollback', 'applyRollback', 'runRollback', 'applyPlan', 'mutatePolicy', 'promote']) {
      expect(mod[key]).toBeUndefined();
    }
    expect(ROLLBACK_PLAN_BOUNDARY.mode).toBe('ROLLBACK_PLAN_ONLY');
    expect(ROLLBACK_PLAN_BOUNDARY.executeRollback).toBe('FORBIDDEN');
    expect(ROLLBACK_PLAN_BOUNDARY.autoApply).toBe(false);
    expect(ROLLBACK_PLAN_BOUNDARY.autoPromotion).toBe('OFF');
    expect(ROLLBACK_PLAN_BOUNDARY.policyMutation).toBe('FORBIDDEN');
    expect(ROLLBACK_PLAN_BOUNDARY.guardMutation).toBe('FORBIDDEN');
    expect(ROLLBACK_PLAN_BOUNDARY.routerMutation).toBe('FORBIDDEN');
    expect(ROLLBACK_PLAN_BOUNDARY.actionRuntimeMutation).toBe('FORBIDDEN');
    expect(ROLLBACK_PLAN_BOUNDARY.rejectedVerdict).toBe('FAIL_CLOSED');
    expect(ROLLBACK_PLAN_BOUNDARY.baseline).toContain('EXPLICIT_FINGERPRINT_REQUIRED');
  });
});
