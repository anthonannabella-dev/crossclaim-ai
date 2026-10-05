/**
 * PHASE 5 U2 / U2 FINAL —— Rollback Plan Contract（trusted target binding + trusted baseline snapshot）
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
import {
  ROLLBACK_PLAN_BOUNDARY,
  ROLLBACK_TRIGGERS,
  captureBaselineConfigSnapshot,
  createRollbackPlan,
  isVerifiedBaselineConfigSnapshot,
  isVerifiedRollbackPlan,
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
  if (!res.ok) throw new Error('unexpected reject: ' + res.reason);
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
  const candidate = proposeMetaImprovementCandidates({ evaluation, evidenceSet: appended.evidenceSet }).candidates[0];
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

const baselineStore = (fingerprint = 'config:baseline-v1'): BaselineConfigStorePort => ({
  async read() {
    return { configFingerprint: fingerprint, capturedAt: '2026-10-05T20:10:00.000Z' };
  },
});

const ctx = async (outcome: 'APPROVED' | 'REJECTED' = 'APPROVED') => {
  const candidate = await makeCandidate();
  const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
  const verdict = decideCandidateReview(ticket, {
    approverId: 'judge-1',
    role: 'EXTERNAL_JUDGE',
    outcome,
    decidedAt: '2026-10-05T21:00:00.000Z',
    reason: 'evidence chain verified',
  });
  const baseline = await captureBaselineConfigSnapshot(baselineStore(), candidate.target);
  return { candidate, verdict, baseline };
};

const input = (over: Record<string, unknown> = {}) => ({
  rollbackSteps: [
    { order: 1, action: 'restore config to baseline fingerprint' },
    { order: 2, action: 're-run canary shadow comparison' },
  ],
  rollbackTrigger: 'CANARY_REGRESSION',
  ...over,
});

describe('PHASE 5 U2 FINAL —— trusted target binding + trusted baseline snapshot', () => {
  it('P5U2_1 verified APPROVED verdict + verified candidate + verified baseline → plan 绑定 12 项、目标与 baseline 均由可信上游派生', async () => {
    const { candidate, verdict, baseline } = await ctx();
    const plan = createRollbackPlan(verdict, candidate, baseline, input());
    expect(plan.kind).toBe('ROLLBACK_PLAN');
    expect(plan.mode).toBe('ROLLBACK_PLAN_ONLY');
    expect(plan.verdictDigest).toBe(verdict.verdictDigest);
    expect(plan.ticketDigest).toBe(verdict.ticketDigest);
    expect(plan.candidateDigest).toBe(verdict.candidateDigest);
    expect(plan.evaluationDigest).toBe(verdict.evaluationDigest);
    expect(plan.evidenceSetDigest).toBe(verdict.evidenceSetDigest);
    expect(plan.candidateTarget).toBe(candidate.target);
    expect(plan.baselineConfigFingerprint).toBe(baseline.configFingerprint);
    expect(plan.rollbackTargetFingerprint).toBe(baseline.configFingerprint);
    expect(plan.baselineSnapshotDigest).toBe(baseline.snapshotDigest);
    expect(plan.execution).toEqual({ executeRollback: 'FORBIDDEN', autoApply: false, requiresHumanApproval: true });
    expect(isVerifiedRollbackPlan(plan)).toBe(true);
    expect(ROLLBACK_PLAN_BOUNDARY.binds).toHaveLength(12);
    expect(ROLLBACK_PLAN_BOUNDARY.binds).toContain('baselineSnapshotDigest');
  });

  it('P5U2_2 verdict 门：clone / 手造 APPROVED verdict → REJECT；REJECTED → fail-closed', async () => {
    const { candidate, verdict, baseline } = await ctx();
    expect(() => createRollbackPlan({ ...verdict } as never, candidate, baseline, input())).toThrow(
      /ROLLBACK_PLAN_VERDICT_NOT_VERIFIED/,
    );
    expect(() =>
      createRollbackPlan({ kind: 'APPROVAL_VERDICT', verdictDigest: 'forged', outcome: 'APPROVED' } as never, candidate, baseline, input()),
    ).toThrow(/ROLLBACK_PLAN_VERDICT_NOT_VERIFIED/);
    const rejected = await ctx('REJECTED');
    expect(() => createRollbackPlan(rejected.verdict, rejected.candidate, rejected.baseline, input())).toThrow(
      /ROLLBACK_PLAN_VERDICT_NOT_APPROVED:REJECTED/,
    );
  });

  it('P5U2_3 candidate 绑定：未 provenance / 缺失 / 与 verdict 不匹配 → REJECT', async () => {
    const { candidate, verdict, baseline } = await ctx();
    expect(() => createRollbackPlan(verdict, { ...candidate } as never, baseline, input())).toThrow(
      /ROLLBACK_PLAN_CANDIDATE_NOT_VERIFIED/,
    );
    expect(() => createRollbackPlan(verdict, null, baseline, input())).toThrow(/ROLLBACK_PLAN_CANDIDATE_NOT_VERIFIED/);
  });

  it('P5U2_4 target 必须来自可信 candidate：真实 ROUTER candidate + POLICY baseline → REJECT（caller 不能改 target）', async () => {
    const { candidate, verdict, baseline } = await ctx();
    expect(candidate.target).toBe('ROUTER');
    const policyBaseline = await captureBaselineConfigSnapshot(baselineStore(), 'POLICY');
    expect(() => createRollbackPlan(verdict, candidate, policyBaseline, input())).toThrow(
      /ROLLBACK_PLAN_BASELINE_TARGET_MISMATCH/,
    );
    expect(() => createRollbackPlan(verdict, candidate, baseline, input({ candidateTarget: 'POLICY' }))).not.toThrow();
  });

  it('P5U2_5 baseline 权威：caller 自造 / clone snapshot → REJECT；store 缺失 / 读不到 / 目标非法 → REJECT', async () => {
    const { candidate, verdict, baseline } = await ctx();
    expect(isVerifiedBaselineConfigSnapshot(baseline)).toBe(true);
    expect(isVerifiedBaselineConfigSnapshot({ ...baseline })).toBe(false);
    const handmade = { ...baseline, snapshotDigest: 'baseline-snapshot:forged' } as never;
    expect(() => createRollbackPlan(verdict, candidate, handmade, input())).toThrow(/ROLLBACK_PLAN_BASELINE_NOT_VERIFIED/);
    expect(() => createRollbackPlan(verdict, candidate, { ...baseline } as never, input())).toThrow(
      /ROLLBACK_PLAN_BASELINE_NOT_VERIFIED/,
    );
    const emptyStore: BaselineConfigStorePort = { async read() { return null; } };
    await expect(captureBaselineConfigSnapshot(emptyStore, 'ROUTER')).rejects.toThrow(/ROLLBACK_PLAN_BASELINE_NOT_FOUND/);
    await expect(captureBaselineConfigSnapshot(null, 'ROUTER')).rejects.toThrow(/ROLLBACK_PLAN_BASELINE_STORE_REQUIRED/);
    await expect(captureBaselineConfigSnapshot(baselineStore(), 'BANANA')).rejects.toThrow(/ROLLBACK_PLAN_TARGET_INVALID/);
    await expect(captureBaselineConfigSnapshot(baselineStore('   '), 'ROUTER')).rejects.toThrow(
      /ROLLBACK_PLAN_BASELINE_MALFORMED/,
    );
    await expect(captureBaselineConfigSnapshot(baselineStore('ROLLBACK_TO_LATEST'), 'ROUTER')).rejects.toThrow(
      /ROLLBACK_PLAN_BASELINE_FORBIDDEN/,
    );
  });

  it('P5U2_6 steps / trigger 校验：空、乱序、空 action、非法 trigger → REJECT', async () => {
    const { candidate, verdict, baseline } = await ctx();
    expect(() => createRollbackPlan(verdict, candidate, baseline, input({ rollbackSteps: [] }))).toThrow(
      /ROLLBACK_PLAN_STEPS_REQUIRED/,
    );
    expect(() => createRollbackPlan(verdict, candidate, baseline, input({ rollbackSteps: [{ order: 2, action: 'x' }] }))).toThrow(
      /ROLLBACK_PLAN_STEPS_MALFORMED/,
    );
    expect(() =>
      createRollbackPlan(verdict, candidate, baseline, input({ rollbackSteps: [{ order: 1, action: '  ' }] })),
    ).toThrow(/ROLLBACK_PLAN_STEPS_MALFORMED/);
    expect(() => createRollbackPlan(verdict, candidate, baseline, input({ rollbackTrigger: 'WHATEVER' }))).toThrow(
      /ROLLBACK_PLAN_TRIGGER_INVALID/,
    );
    expect(ROLLBACK_TRIGGERS).toContain('CANARY_REGRESSION');
  });

  it('P5U2_7 plan provenance / anti-tamper：clone 不可信；原地篡改被冻结拒绝', async () => {
    const { candidate, verdict, baseline } = await ctx();
    const plan = createRollbackPlan(verdict, candidate, baseline, input());
    expect(isVerifiedRollbackPlan({ ...plan })).toBe(false);
    expect(isVerifiedRollbackPlan(null)).toBe(false);
    const attempt = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    expect(attempt(() => { (plan as unknown as { rollbackTrigger: string }).rollbackTrigger = 'MANUAL_JUDGE_ORDER'; })).toBe(false);
    expect(attempt(() => { (plan.execution as unknown as { executeRollback: string }).executeRollback = 'ALLOWED'; })).toBe(false);
    expect(isVerifiedRollbackPlan(plan)).toBe(true);
  });

  it('P5U2_8 无执行面 + 边界清单（HOLD/FORBIDDEN/可信来源声明）', async () => {
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
    expect(ROLLBACK_PLAN_BOUNDARY.baseline).toContain('TRUSTED_SNAPSHOT_REQUIRED');
    expect(ROLLBACK_PLAN_BOUNDARY.candidateTargetBinding).toContain('FROM_VERIFIED_APPROVED_CANDIDATE');
  });
});
