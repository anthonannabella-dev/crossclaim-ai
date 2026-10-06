/**
 * PHASE 6 U2 —— Controlled Adoption Execution Gate（EXECUTION_AUTHORIZATION_ONLY）
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
import { createControlledAdoptionPlan } from '../services/outcome-learning/controlled-adoption-plan';
import {
  CONTROLLED_EXECUTION_APPROVED_SEMANTICS,
  CONTROLLED_EXECUTION_GATE_BOUNDARY,
  CONTROLLED_EXECUTION_GATE_SCOPE,
  assertControlledExecutionPreparationAuthorized,
  decideControlledExecutionAuthorization,
  isVerifiedControlledExecutionAuthorizationTicket,
  isVerifiedControlledExecutionAuthorizationVerdict,
  openControlledExecutionAuthorizationTicket,
  revokeControlledExecutionAuthorization,
  type ControlledCurrentConfigStorePort,
} from '../services/outcome-learning/controlled-execution-gate';
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
import {
  captureBaselineConfigSnapshot,
  createRollbackPlan,
  type BaselineConfigStorePort,
} from '../services/outcome-learning/rollback-plan';

const DATASET = 'learning-dataset/v1';
const WINDOW = { from: '2026-10-05T22:00:00.000Z', to: '2026-10-05T23:00:00.000Z' };
const TASK_REFS = ['t0', 't1', 't2', 't3'];
const BASELINE_FINGERPRINT = 'config:baseline-v1';

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
      configFingerprint: BASELINE_FINGERPRINT,
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
  nonce: 'p6u2-cand-' + (nonceCounter += 1),
});
const reviewSchedule = () => ({
  requestedAt: '2026-10-05T23:30:00.000Z',
  expiresAt: '2026-10-06T23:30:00.000Z',
  nonce: 'p6u2-review-' + (nonceCounter += 1),
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

const PLAN_WINDOW = { createdAt: '2026-10-06T00:30:00.000Z', expiresAt: '2026-10-06T06:30:00.000Z' };
const GATE_WINDOW = () =>
  ({ requestedAt: '2026-10-06T01:00:00.000Z', expiresAt: '2026-10-06T03:00:00.000Z', nonce: 'p6u2-gate-' + (nonceCounter += 1) });

let storeReads = 0;
const liveStore = (over: Partial<{ configFingerprint: string; configValues: Record<string, string>; capturedAt: string; version: string }> = {}) =>
  ({
    async read() {
      storeReads += 1;
      return {
        configFingerprint: BASELINE_FINGERPRINT,
        configValues: { 'router.escalationThreshold': '0.50', 'router.modelTierPolicy': 'balanced' },
        capturedAt: '2026-10-06T00:55:00.000Z',
        version: 'cfg-1',
        ...over,
      };
    },
  }) as ControlledCurrentConfigStorePort;

const planFixture = async () => {
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
  const rollbackPlan = createRollbackPlan(approval, candidate, baseline, {
    rollbackSteps: [{ order: 1, action: 'restore config to baseline fingerprint' }],
    rollbackTrigger: 'CANARY_REGRESSION',
  });
  const proposal = createControlledConfigProposal(approval, rollbackPlan, {
    proposedDelta: {
      target: candidate.target,
      path: 'router.escalationThreshold',
      from: '0.50',
      to: '0.75',
      rationale: 'low resolved success rate',
    },
  });
  const ref = createCohortRef({ cohortId: 'cohort-1', datasetVersion: DATASET, evaluationWindow: WINDOW, taskRefs: TASK_REFS });
  const canary = evaluateCanaryShadow({
    proposal,
    rollbackPlan,
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
    rollbackPlan,
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
  const plan = createControlledAdoptionPlan({
    verdict: reviewVerdict,
    canary,
    proposal,
    rollbackPlan,
    ...PLAN_WINDOW,
  });
  return { plan, proposal, rollbackPlan, canary, reviewVerdict };
};

const openTicket = async (over: Record<string, unknown> = {}) => {
  const f = await planFixture();
  return openControlledExecutionAuthorizationTicket({
    plan: f.plan,
    configStore: liveStore(),
    reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE,
    ...GATE_WINDOW(),
    ...over,
  });
};

describe('PHASE 6 U2 —— controlled adoption execution gate (EXECUTION_AUTHORIZATION_ONLY)', () => {
  it('P6U2_1 verified plan + server-owned live config → 授权 ticket；APPROVED 语义 = AUTHORIZED_FOR_CONTROLLED_EXECUTION_PREPARATION', async () => {
    const f = await planFixture();
    const ticket = await openControlledExecutionAuthorizationTicket({
      plan: f.plan,
      configStore: liveStore(),
      reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE,
      ...GATE_WINDOW(),
    });
    expect(ticket.kind).toBe('CONTROLLED_EXECUTION_AUTHORIZATION_TICKET');
    expect(ticket.mode).toBe('EXECUTION_AUTHORIZATION_ONLY');
    expect(ticket.planDigest).toBe(f.plan.planDigest);
    expect(ticket.reviewVerdictDigest).toBe(f.plan.reviewVerdictDigest);
    expect(ticket.proposalDigest).toBe(f.plan.proposalDigest);
    expect(ticket.canaryEvaluationDigest).toBe(f.plan.canaryEvaluationDigest);
    expect(ticket.rollbackPlanDigest).toBe(f.plan.rollbackPlanDigest);
    expect(ticket.target).toBe(f.plan.target);
    expect(ticket.path).toBe(f.plan.path);
    expect(ticket.from).toBe(f.plan.from);
    expect(ticket.to).toBe(f.plan.to);
    expect(ticket.liveConfigFingerprint).toBe(f.plan.expectedBaselineConfigFingerprint);
    expect(ticket.livePathValue).toBe(f.plan.from);
    expect(ticket.scope).toBe(CONTROLLED_EXECUTION_GATE_SCOPE);
    expect(isVerifiedControlledExecutionAuthorizationTicket(ticket)).toBe(true);

    const verdict = decideControlledExecutionAuthorization(ticket, {
      reviewerId: 'judge-1',
      role: 'EXTERNAL_JUDGE',
      outcome: 'APPROVED',
      decidedAt: '2026-10-06T01:05:00.000Z',
      reason: 'plan fresh, rollback anchored',
    });
    expect(verdict.semantics).toBe(CONTROLLED_EXECUTION_APPROVED_SEMANTICS);
    expect(verdict.execution.apply).toBe('FORBIDDEN');
    expect(verdict.execution.execute).toBe('FORBIDDEN');
    expect(verdict.execution.configMutation).toBe('FORBIDDEN');
    expect(verdict.execution.productionRollout).toBe('FORBIDDEN');
    expect(isVerifiedControlledExecutionAuthorizationVerdict(verdict)).toBe(true);
    expect(assertControlledExecutionPreparationAuthorized(verdict).planDigest).toBe(f.plan.planDigest);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.binds).toHaveLength(15);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.mode).toBe('EXECUTION_AUTHORIZATION_ONLY');
  });

  it('P6U2_2 live config 只能来自 server-owned store：caller 自报 fingerprint 不可能通过', async () => {
    const f = await planFixture();
    // caller 试图把 fingerprint 当作入参塞进 configStore 位置 → 无 read() → 拒绝
    await expect(
      openControlledExecutionAuthorizationTicket({
        plan: f.plan,
        configStore: { configFingerprint: f.plan.expectedBaselineConfigFingerprint } as never,
        reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE,
        ...GATE_WINDOW(),
      }),
    ).rejects.toThrow(/EXECUTION_GATE_CONFIG_STORE_REQUIRED/);
    await expect(
      openControlledExecutionAuthorizationTicket({
        plan: f.plan,
        configStore: null,
        reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE,
        ...GATE_WINDOW(),
      }),
    ).rejects.toThrow(/EXECUTION_GATE_CONFIG_STORE_REQUIRED/);

    const before = storeReads;
    await openTicket();
    expect(storeReads).toBe(before + 1);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.liveConfigSource).toContain('SERVER_OWNED');
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.liveConfigReadShape).toContain('configFingerprint');
  });

  it('P6U2_3 plan trust gate fail-closed：clone / 未验证 plan → REJECT', async () => {
    const f = await planFixture();
    const base = {
      configStore: liveStore(),
      reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE,
      ...GATE_WINDOW(),
    };
    await expect(
      openControlledExecutionAuthorizationTicket({ ...base, plan: { ...f.plan } as never }),
    ).rejects.toThrow(/EXECUTION_GATE_PLAN_NOT_VERIFIED/);
    await expect(openControlledExecutionAuthorizationTicket({ ...base, plan: null })).rejects.toThrow(
      /EXECUTION_GATE_PLAN_NOT_VERIFIED/,
    );
    await expect(openControlledExecutionAuthorizationTicket(null)).rejects.toThrow(/EXECUTION_GATE_INPUT_REQUIRED/);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.planTrustGate).toContain('READY_FOR_CONTROLLED_EXECUTION_GATE_REVIEW');
  });

  it('P6U2_4 授权时间窗：requestedAt 必须落在 plan 有效期内，过期 → EXECUTION_GATE_PLAN_EXPIRED', async () => {
    const f = await planFixture();
    const base = { plan: f.plan, configStore: liveStore(), reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE };
    await expect(
      openControlledExecutionAuthorizationTicket({
        ...base,
        requestedAt: '2026-10-06T00:00:00.000Z',
        expiresAt: '2026-10-06T03:00:00.000Z',
        nonce: 'p6u2-early',
      }),
    ).rejects.toThrow(/EXECUTION_GATE_REQUESTED_BEFORE_PLAN_CREATED/);
    await expect(
      openControlledExecutionAuthorizationTicket({
        ...base,
        requestedAt: '2026-10-06T07:00:00.000Z',
        expiresAt: '2026-10-06T09:00:00.000Z',
        nonce: 'p6u2-late',
      }),
    ).rejects.toThrow(/EXECUTION_GATE_PLAN_EXPIRED/);
    await expect(
      openControlledExecutionAuthorizationTicket({
        ...base,
        requestedAt: '2026-10-06T02:00:00.000Z',
        expiresAt: '2026-10-06T02:00:00.000Z',
        nonce: 'p6u2-bad-expiry',
      }),
    ).rejects.toThrow(/EXECUTION_GATE_EXPIRY_INVALID/);
    await expect(
      openControlledExecutionAuthorizationTicket({
        ...base,
        requestedAt: 'not-a-date',
        expiresAt: '2026-10-06T03:00:00.000Z',
        nonce: 'p6u2-bad-date',
      }),
    ).rejects.toThrow(/EXECUTION_GATE_SCHEDULE_INVALID/);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.authorizationWindow).toContain('EXECUTION_GATE_PLAN_EXPIRED');
  });

  it('P6U2_5 双重 stale guard：fingerprint 漂移 或 path 值漂移 → STALE_BASELINE', async () => {
    const f = await planFixture();
    const base = { plan: f.plan, reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE, ...GATE_WINDOW() };
    await expect(
      openControlledExecutionAuthorizationTicket({ ...base, configStore: liveStore({ configFingerprint: 'config:drifted' }) }),
    ).rejects.toThrow(/STALE_BASELINE:fingerprint/);
    await expect(
      openControlledExecutionAuthorizationTicket({
        ...base,
        configStore: liveStore({ configValues: { 'router.escalationThreshold': '0.90', 'router.modelTierPolicy': 'balanced' } }),
      }),
    ).rejects.toThrow(/STALE_BASELINE:path-value/);
    // fingerprint 一致但 path value 缺失 → 一样 fail-closed
    await expect(
      openControlledExecutionAuthorizationTicket({ ...base, configStore: liveStore({ configValues: {} }) }),
    ).rejects.toThrow(/STALE_BASELINE:path-value/);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.staleGuard).toContain('double');
  });

  it('P6U2_6 reviewer gate：scope 精确 + role 白名单 + expiry + revoke + replay', async () => {
    const f = await planFixture();
    const base = { plan: f.plan, configStore: liveStore() };
    await expect(
      openControlledExecutionAuthorizationTicket({ ...base, reviewerScope: 'CONTROLLED_ADOPTION_REVIEW', ...GATE_WINDOW() }),
    ).rejects.toThrow(/EXECUTION_GATE_SCOPE_NOT_ALLOWED/);
    await expect(
      openControlledExecutionAuthorizationTicket({ ...base, reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE, requestedAt: '2026-10-06T01:00:00.000Z', expiresAt: '2026-10-06T03:00:00.000Z', nonce: '   ' }),
    ).rejects.toThrow(/EXECUTION_GATE_NONCE_REQUIRED/);

    const ticket = await openTicket();
    expect(() =>
      decideControlledExecutionAuthorization(ticket, {
        reviewerId: 'judge-1',
        role: 'SELF_APPROVER' as never,
        outcome: 'APPROVED',
        decidedAt: '2026-10-06T01:05:00.000Z',
      }),
    ).toThrow(/EXECUTION_GATE_ROLE_NOT_ALLOWED/);
    expect(() =>
      decideControlledExecutionAuthorization(ticket, {
        reviewerId: 'judge-1',
        role: 'EXTERNAL_JUDGE',
        outcome: 'APPROVED',
        decidedAt: '2026-10-06T05:00:00.000Z',
      }),
    ).toThrow(/EXECUTION_GATE_VERDICT_TICKET_EXPIRED/);

    const replayTicket = await openTicket();
    decideControlledExecutionAuthorization(replayTicket, {
      reviewerId: 'judge-1',
      role: 'EXTERNAL_JUDGE',
      outcome: 'APPROVED',
      decidedAt: '2026-10-06T01:05:00.000Z',
    });
    expect(() =>
      decideControlledExecutionAuthorization(replayTicket, {
        reviewerId: 'judge-1',
        role: 'EXTERNAL_JUDGE',
        outcome: 'REJECTED',
        decidedAt: '2026-10-06T01:10:00.000Z',
      }),
    ).toThrow(/EXECUTION_GATE_VERDICT_REPLAY_BLOCKED/);

    const revokedTicket = await openTicket();
    revokeControlledExecutionAuthorization(revokedTicket, { revokedBy: 'judge-1', revokedAt: '2026-10-06T01:02:00.000Z' });
    expect(() =>
      decideControlledExecutionAuthorization(revokedTicket, {
        reviewerId: 'judge-1',
        role: 'EXTERNAL_JUDGE',
        outcome: 'APPROVED',
        decidedAt: '2026-10-06T01:05:00.000Z',
      }),
    ).toThrow(/EXECUTION_GATE_VERDICT_TICKET_REVOKED/);
    expect(() =>
      revokeControlledExecutionAuthorization(revokedTicket, { revokedBy: 'judge-1', revokedAt: '2026-10-06T01:06:00.000Z' }),
    ).toThrow(/EXECUTION_GATE_TICKET_ALREADY_REVOKED/);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.scope).toBe(CONTROLLED_EXECUTION_GATE_SCOPE);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.roles).toEqual(['EXTERNAL_JUDGE', 'HUMAN_OPERATOR']);
  });

  it('P6U2_7 provenance / anti-tamper / REJECTED 语义 / 无执行入口', async () => {
    const ticket = await openTicket();
    const verdict = decideControlledExecutionAuthorization(ticket, {
      reviewerId: 'judge-1',
      role: 'EXTERNAL_JUDGE',
      outcome: 'REJECTED',
      decidedAt: '2026-10-06T01:05:00.000Z',
      reason: 'operator withheld',
    });
    expect(verdict.semantics).toBe('REJECTED_NO_CONTROLLED_EXECUTION');
    expect(verdict.execution.apply).toBe('FORBIDDEN');
    expect(() => assertControlledExecutionPreparationAuthorized(verdict)).toThrow(/EXECUTION_AUTHORIZATION_NOT_APPROVED/);
    expect(() => assertControlledExecutionPreparationAuthorized(null)).toThrow(/EXECUTION_AUTHORIZATION_NOT_VERIFIED/);
    expect(isVerifiedControlledExecutionAuthorizationVerdict({ ...verdict })).toBe(false);
    expect(isVerifiedControlledExecutionAuthorizationTicket({ ...ticket })).toBe(false);

    const attempt = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    expect(attempt(() => { (verdict as unknown as { to: string }).to = '0.99'; })).toBe(false);
    expect(attempt(() => { (verdict.execution as unknown as { apply: string }).apply = 'ALLOWED'; })).toBe(false);

    const mod = (await import('../services/outcome-learning/controlled-execution-gate')) as unknown as Record<string, unknown>;
    for (const key of ['applyConfig', 'executeAdoption', 'mutateConfig', 'promoteConfig', 'rolloutConfig', 'writeConfig']) {
      expect(mod[key]).toBeUndefined();
    }
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.productionWrite).toContain('HOLD');
  });

  it('P6U2_8 rollback anchor 固定 U2_BASELINE；live config 形状不合法 → UNREADABLE', async () => {
    const f = await planFixture();
    const base = { plan: f.plan, reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE, ...GATE_WINDOW() };
    expect(f.plan.rollbackTarget.target).toBe('U2_BASELINE');
    expect(f.plan.rollbackTarget.baselineConfigFingerprint).toBe(f.plan.expectedBaselineConfigFingerprint);
    await expect(
      openControlledExecutionAuthorizationTicket({ ...base, configStore: liveStore({ version: '   ' }) }),
    ).rejects.toThrow(/EXECUTION_GATE_LIVE_CONFIG_UNREADABLE/);
    await expect(
      openControlledExecutionAuthorizationTicket({ ...base, configStore: liveStore({ capturedAt: 'nope' }) }),
    ).rejects.toThrow(/EXECUTION_GATE_LIVE_CONFIG_UNREADABLE/);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.forbiddenRollbackLabels).toEqual(['LATEST', 'DEFAULT', 'CURRENT', 'HEAD']);
    expect(CONTROLLED_EXECUTION_GATE_BOUNDARY.rollbackAnchor).toContain('U2_BASELINE');
  });
});
