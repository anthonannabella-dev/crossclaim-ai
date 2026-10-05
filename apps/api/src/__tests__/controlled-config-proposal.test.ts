/**
 * PHASE 5 U3 —— Controlled Config Proposal（PROPOSAL_ONLY）
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
  CONTROLLED_PROPOSAL_BOUNDARY,
  TARGET_DELTA_PATHS,
  TARGET_DELTA_VALUE_SCHEMA,
  isValidDeltaValue,
  createControlledConfigProposal,
  isVerifiedControlledConfigProposal,
} from '../services/outcome-learning/controlled-config-proposal';
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

const store: BaselineConfigStorePort = {
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
  nonce: 'u3-nonce-' + (nonce += 1),
});

const ctx = async (outcome: 'APPROVED' | 'REJECTED' = 'APPROVED') => {
  let stored: readonly RsiEvidenceRecord[] = [];
  const storePort: RsiEvidenceLedgerStorePort = {
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
  const ledger = createAppLearningEvidenceLedgerFromRsi(storePort);
  const appended = await appendVerifiedLearningEvidence(trustedLineage(), ledger, records, DATASET);
  const candidate = proposeMetaImprovementCandidates({ evaluation, evidenceSet: appended.evidenceSet }).candidates[0];
  if (!candidate) throw new Error('expected candidate');
  const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
  const verdict = decideCandidateReview(ticket, {
    approverId: 'judge-1',
    role: 'EXTERNAL_JUDGE',
    outcome,
    decidedAt: '2026-10-05T21:00:00.000Z',
    reason: 'evidence chain verified',
  });
  const baseline = await captureBaselineConfigSnapshot(store, candidate.target);
  return { candidate, verdict, baseline };
};

const planFor = async (verdict: Awaited<ReturnType<typeof ctx>>) =>
  createRollbackPlan(verdict.verdict, verdict.candidate, verdict.baseline, {
    rollbackSteps: [{ order: 1, action: 'restore config to baseline fingerprint' }],
    rollbackTrigger: 'CANARY_REGRESSION',
  });

const delta = (over: Record<string, unknown> = {}) => ({
  target: 'ROUTER',
  path: 'router.escalationThreshold',
  from: '0.50',
  to: '0.60',
  rationale: 'low resolved success rate',
  ...over,
});

describe('PHASE 5 U3 —— controlled config proposal (PROPOSAL_ONLY)', () => {
  it('P5U3_1 verified APPROVED verdict + verified rollback plan → proposal 绑定 10 项且 PROPOSAL_ONLY', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    const proposal = createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta() });
    expect(proposal.kind).toBe('CONTROLLED_CONFIG_PROPOSAL');
    expect(proposal.mode).toBe('PROPOSAL_ONLY');
    expect(proposal.proposalId).toBe('controlled-proposal:' + proposal.proposalDigest);
    expect(proposal.verdictDigest).toBe(c.verdict.verdictDigest);
    expect(proposal.ticketDigest).toBe(c.verdict.ticketDigest);
    expect(proposal.candidateDigest).toBe(c.verdict.candidateDigest);
    expect(proposal.evaluationDigest).toBe(c.verdict.evaluationDigest);
    expect(proposal.evidenceSetDigest).toBe(c.verdict.evidenceSetDigest);
    expect(proposal.baselineConfigFingerprint).toBe(plan.baselineConfigFingerprint);
    expect(proposal.rollbackPlanRef).toBe(plan.planId);
    expect(proposal.rollbackPlanDigest).toBe(plan.rollbackPlanDigest);
    expect(proposal.execution).toEqual({
      apply: 'FORBIDDEN',
      autoPromotion: 'OFF',
      autoRollout: 'FORBIDDEN',
      requiresHumanApproval: true,
    });
    expect(isVerifiedControlledConfigProposal(proposal)).toBe(true);
    expect(CONTROLLED_PROPOSAL_BOUNDARY.binds).toHaveLength(10);
  });

  it('P5U3_2 双门：未 provenance 的 verdict / rollback plan、REJECTED verdict → REJECT', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    expect(() => createControlledConfigProposal({ ...c.verdict } as never, plan, { proposedDelta: delta() })).toThrow(
      /CONTROLLED_PROPOSAL_VERDICT_NOT_VERIFIED/,
    );
    expect(() => createControlledConfigProposal(c.verdict, { ...plan } as never, { proposedDelta: delta() })).toThrow(
      /CONTROLLED_PROPOSAL_ROLLBACK_PLAN_NOT_VERIFIED/,
    );
    const rejected = await ctx('REJECTED');
    expect(() =>
      createControlledConfigProposal(rejected.verdict, plan, { proposedDelta: delta() }),
    ).toThrow(/CONTROLLED_PROPOSAL_VERDICT_NOT_APPROVED:REJECTED/);
    expect(CONTROLLED_PROPOSAL_BOUNDARY.rejectedVerdict).toContain('NEVER_PROPOSES');
  });

  it('P5U3_3 delta 必须限于 candidate target：越界 target / 畸形 delta / 缺失 → REJECT', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    expect(c.candidate.target).toBe('ROUTER');
    expect(() => createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta({ target: 'POLICY' }) })).toThrow(
      /CONTROLLED_PROPOSAL_DELTA_TARGET_NOT_ALLOWED:POLICY/,
    );
    expect(() => createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta({ to: '  ' }) })).toThrow(
      /CONTROLLED_PROPOSAL_DELTA_MALFORMED/,
    );
    expect(() => createControlledConfigProposal(c.verdict, plan, null)).toThrow(/CONTROLLED_PROPOSAL_DELTA_REQUIRED/);
  });

  it('P5U3_4 one verdict → one proposal：同一 verdict 第二次提案 → REJECT', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta() });
    expect(() => createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta({ to: '0.70' }) })).toThrow(
      /CONTROLLED_PROPOSAL_ALREADY_EXISTS/,
    );
  });

  it('P5U3_5 provenance / anti-tamper：clone 与原地篡改不可信', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    const proposal = createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta() });
    expect(isVerifiedControlledConfigProposal({ ...proposal })).toBe(false);
    expect(isVerifiedControlledConfigProposal(null)).toBe(false);
    const attempt = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    expect(attempt(() => { (proposal as unknown as { proposalDigest: string }).proposalDigest = 'forged'; })).toBe(false);
    expect(attempt(() => { (proposal.proposedDelta as unknown as { to: string }).to = '0.99'; })).toBe(false);
    expect(attempt(() => { (proposal.execution as unknown as { apply: string }).apply = 'ALLOWED'; })).toBe(false);
    expect(isVerifiedControlledConfigProposal(proposal)).toBe(true);
  });

  it('P5U3_6 无执行面 + 边界清单', async () => {
    const mod = (await import('../services/outcome-learning/controlled-config-proposal')) as unknown as Record<string, unknown>;
    for (const key of ['applyProposal', 'executeProposal', 'applyDelta', 'rolloutProposal', 'mutatePolicy', 'promote']) {
      expect(mod[key]).toBeUndefined();
    }
    expect(CONTROLLED_PROPOSAL_BOUNDARY.mode).toBe('PROPOSAL_ONLY');
    expect(CONTROLLED_PROPOSAL_BOUNDARY.apply).toBe('FORBIDDEN');
    expect(CONTROLLED_PROPOSAL_BOUNDARY.autoRollout).toBe('FORBIDDEN');
    expect(CONTROLLED_PROPOSAL_BOUNDARY.autoPromotion).toBe('OFF');
    expect(CONTROLLED_PROPOSAL_BOUNDARY.policyMutation).toBe('FORBIDDEN');
    expect(CONTROLLED_PROPOSAL_BOUNDARY.guardMutation).toBe('FORBIDDEN');
    expect(CONTROLLED_PROPOSAL_BOUNDARY.routerMutation).toBe('FORBIDDEN');
    expect(CONTROLLED_PROPOSAL_BOUNDARY.actionRuntimeMutation).toBe('FORBIDDEN');
    expect(CONTROLLED_PROPOSAL_BOUNDARY.deltaTarget).toContain('MUST_EQUAL_CANDIDATE_TARGET');
  });
});

describe('PHASE 5 U3 FINAL —— target-specific delta allowlist + baseline value binding', () => {
  it('P5U3F_1 path 必须在 target allowlist 内：ROUTER candidate 提交 killSwitch.disabled 之类字段 → REJECT', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    expect(() =>
      createControlledConfigProposal(c.verdict, plan, {
        proposedDelta: delta({ path: 'killSwitch.disabled' }),
      }),
    ).toThrow(/CONTROLLED_PROPOSAL_DELTA_PATH_NOT_ALLOWED:ROUTER:killSwitch.disabled/);
    expect(TARGET_DELTA_PATHS.ROUTER).toEqual(['router.escalationThreshold', 'router.modelTierPolicy']);
    expect(TARGET_DELTA_PATHS.POLICY).not.toContain('killSwitch.disabled');
  });

  it('P5U3F_2 delta.from 必须等于 trusted baseline 当前值：自报现状 → REJECT', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    expect(plan.baselineConfigValues['router.escalationThreshold']).toBe('0.50');
    expect(() =>
      createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta({ from: '0.10' }) }),
    ).toThrow(/CONTROLLED_PROPOSAL_DELTA_FROM_NOT_IN_BASELINE/);
    const other = await ctx();
    const otherPlan = await planFor(other);
    expect(() =>
      createControlledConfigProposal(other.verdict, otherPlan, {
        proposedDelta: delta({ path: 'router.modelTierPolicy', from: '0.50' }),
      }),
    ).toThrow(/CONTROLLED_PROPOSAL_DELTA_FROM_NOT_IN_BASELINE/);
  });

  it('P5U3F_3 合法 path + 与 baseline 一致的 from → PASS，并绑定 baseline 当前值来源', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    const proposal = createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta() });
    expect(proposal.proposedDelta.path).toBe('router.escalationThreshold');
    expect(proposal.proposedDelta.from).toBe('0.50');
    expect(isVerifiedControlledConfigProposal(proposal)).toBe(true);
    expect(CONTROLLED_PROPOSAL_BOUNDARY.deltaPath).toContain('TARGET_SPECIFIC_ALLOWLIST');
    expect(CONTROLLED_PROPOSAL_BOUNDARY.deltaFrom).toContain('MUST_EQUAL_BASELINE_SNAPSHOT_VALUE');
  });
});

describe('PHASE 5 U3 FINAL2 —— target-specific delta value schema（类型/范围/枚举）', () => {
  it('P5U3G_1 类型与范围：非数值 / 超范围 / 非整数 → REJECT', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    expect(() => createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta({ to: 'abc' }) })).toThrow(
      /CONTROLLED_PROPOSAL_DELTA_VALUE_INVALID:ROUTER:router.escalationThreshold/,
    );
    expect(() => createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta({ to: '1.50' }) })).toThrow(
      /CONTROLLED_PROPOSAL_DELTA_VALUE_INVALID/,
    );
    expect(() => createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta({ to: '-0.10' }) })).toThrow(
      /CONTROLLED_PROPOSAL_DELTA_VALUE_INVALID/,
    );
    expect(isValidDeltaValue('router.escalationThreshold', '0.75')).toBe(true);
    expect(isValidDeltaValue('router.escalationThreshold', '2')).toBe(false);
    expect(isValidDeltaValue('policy.retryBudget', '2.5')).toBe(false);
  });

  it('P5U3G_2 枚举字段：枚举外取值 → REJECT；合法枚举 → PASS', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    expect(() =>
      createControlledConfigProposal(c.verdict, plan, {
        proposedDelta: delta({ path: 'router.modelTierPolicy', from: 'balanced', to: 'ULTRA' }),
      }),
    ).toThrow(/CONTROLLED_PROPOSAL_DELTA_VALUE_INVALID/);
    expect(isValidDeltaValue('router.modelTierPolicy', 'PREMIUM')).toBe(true);
    expect(isValidDeltaValue('guard.evidenceStrengthRequirement', 'ANYTHING')).toBe(false);
    expect(TARGET_DELTA_VALUE_SCHEMA['router.escalationThreshold']).toEqual({
      kind: 'NUMBER_RANGE',
      min: 0,
      max: 1,
    });
  });

  it('P5U3G_3 合法取值 → PASS，并保留 baseline/allowlist/provenance 全套约束', async () => {
    const c = await ctx();
    const plan = await planFor(c);
    const proposal = createControlledConfigProposal(c.verdict, plan, { proposedDelta: delta({ to: '0.75' }) });
    expect(proposal.proposedDelta.to).toBe('0.75');
    expect(isVerifiedControlledConfigProposal(proposal)).toBe(true);
    expect(CONTROLLED_PROPOSAL_BOUNDARY.deltaValue).toContain('TARGET_SPECIFIC_VALUE_SCHEMA');
  });
});
