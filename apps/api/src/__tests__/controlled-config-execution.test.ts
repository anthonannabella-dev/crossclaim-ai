/**
 * PHASE 6 U3 —— Controlled Config Execution（SANDBOX / NON_PRODUCTION_CONFIG_WRITE_ONLY）
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
  CONTROLLED_EXECUTION_GATE_SCOPE,
  decideControlledExecutionAuthorization,
  openControlledExecutionAuthorizationTicket,
} from '../services/outcome-learning/controlled-execution-gate';
import { createControlledConfigProposal } from '../services/outcome-learning/controlled-config-proposal';
import {
  CONTROLLED_CONFIG_EXECUTION_BOUNDARY,
  CONTROLLED_CONFIG_EXECUTION_SEMANTICS,
  CONTROLLED_CONFIG_EXECUTION_STATUS_SEMANTICS,
  createSandboxConfigExecutionLedger,
  executeControlledConfigMutation,
  isVerifiedControlledConfigExecutionResult,
  type ControlledConfigExecutionStorePort,
  type ControlledExecutionGateSwitches,
} from '../services/outcome-learning/controlled-config-execution';
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
const PATH = 'router.escalationThreshold';
const BASELINE_FINGERPRINT = 'config:baseline-v1';
const POST_FINGERPRINT = 'config:baseline-v2';
const BASELINE_VERSION = 'cfg-1';
const POST_VERSION = 'cfg-2';

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
      configValues: { [PATH]: '0.50', 'router.modelTierPolicy': 'balanced' },
    };
  },
};

const approver = (): ApproverIdentity => ({ approverId: 'judge-1', role: 'EXTERNAL_JUDGE', scope: [APPROVER_SCOPES[0]] });
let nonceCounter = 0;
const schedule = () => ({
  requestedAt: '2026-10-05T20:00:00.000Z',
  expiresAt: '2026-10-06T20:00:00.000Z',
  nonce: 'p6u3-cand-' + (nonceCounter += 1),
});
const reviewSchedule = () => ({
  requestedAt: '2026-10-05T23:30:00.000Z',
  expiresAt: '2026-10-06T23:30:00.000Z',
  nonce: 'p6u3-review-' + (nonceCounter += 1),
});
const gateSchedule = () => ({
  requestedAt: '2026-10-06T01:00:00.000Z',
  expiresAt: '2026-10-06T03:00:00.000Z',
  nonce: 'p6u3-gate-' + (nonceCounter += 1),
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

const liveGateStore = () =>
  ({
    async read() {
      return {
        configFingerprint: BASELINE_FINGERPRINT,
        configValues: { [PATH]: '0.50', 'router.modelTierPolicy': 'balanced' },
        capturedAt: '2026-10-06T00:55:00.000Z',
        version: BASELINE_VERSION,
      };
    },
  });

const chain = async () => {
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
      path: PATH,
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
  const plan = createControlledAdoptionPlan({ verdict: reviewVerdict, canary, proposal, rollbackPlan, ...PLAN_WINDOW });
  const authorizationTicket = await openControlledExecutionAuthorizationTicket({
    plan,
    configStore: liveGateStore(),
    reviewerScope: CONTROLLED_EXECUTION_GATE_SCOPE,
    ...gateSchedule(),
  });
  const authorizationVerdict = decideControlledExecutionAuthorization(authorizationTicket, {
    reviewerId: 'judge-1',
    role: 'EXTERNAL_JUDGE',
    outcome: 'APPROVED',
    decidedAt: '2026-10-06T01:05:00.000Z',
    reason: 'plan fresh, rollback anchored',
  });
  return { plan, authorizationTicket, authorizationVerdict };
};

const EXECUTED_AT = '2026-10-06T01:30:00.000Z';
const switches = (over: Partial<ControlledExecutionGateSwitches> = {}): ControlledExecutionGateSwitches => ({
  environment: 'SANDBOX',
  globalDisabled: false,
  productionGate: false,
  executionEnabled: true,
  ...over,
});

interface StoreState {
  value: string;
  fingerprint: string;
  version: string;
  readBackValue?: string;
  readBackVersion?: string;
  readBackThrow?: boolean;
  readBackMalformed?: boolean;
  cas?: 'OK' | 'VERSION_CONFLICT' | 'PATH_VALUE_CONFLICT';
  casThrow?: boolean;
}

const executionStore = (state: StoreState) => {
  const counters = { casCalls: 0, reads: 0 };
  let value = state.value;
  let fingerprint = state.fingerprint;
  let version = state.version;
  const store: ControlledConfigExecutionStorePort = {
    async read() {
      counters.reads += 1;
      const afterCas = counters.casCalls > 0;
      if (afterCas && state.readBackThrow === true) throw new Error('SIMULATED_READ_BACK_FAILURE');
      if (afterCas && state.readBackMalformed === true) {
        const malformedValues: Record<string, string> = {};
        return { configFingerprint: '', configValues: malformedValues, capturedAt: 'nope', version: '' };
      }
      return {
        configFingerprint: afterCas ? state.readBackVersion !== undefined ? POST_FINGERPRINT : fingerprint : fingerprint,
        configValues: { [PATH]: afterCas ? (state.readBackValue ?? value) : value, 'router.modelTierPolicy': 'balanced' },
        capturedAt: '2026-10-06T01:20:00.000Z',
        version: afterCas ? (state.readBackVersion ?? version) : version,
      };
    },
    async compareAndSwap() {
      counters.casCalls += 1;
      if (state.casThrow === true) throw new Error('SIMULATED_CAS_TIMEOUT');
      if (state.cas === 'VERSION_CONFLICT') return { ok: false, reason: 'VERSION_CONFLICT' };
      if (state.cas === 'PATH_VALUE_CONFLICT') return { ok: false, reason: 'PATH_VALUE_CONFLICT' };
      value = '0.75';
      version = POST_VERSION;
      fingerprint = POST_FINGERPRINT;
      return {
        ok: true,
        version,
        configFingerprint: fingerprint,
        configValues: { [PATH]: value, 'router.modelTierPolicy': 'balanced' },
        capturedAt: '2026-10-06T01:25:00.000Z',
      };
    },
  };
  return {
    store,
    counters,
    state: () => ({ value, fingerprint, version }),
  };
};

const runExecution = async (over: {
  storeState?: StoreState;
  gate?: ControlledExecutionGateSwitches;
  executedAt?: string;
  idempotencyKey?: string;
  chainOverride?: Awaited<ReturnType<typeof chain>>;
} = {}) => {
  const c = over.chainOverride ?? (await chain());
  const io = executionStore(over.storeState ?? { value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION });
  const ledger = createSandboxConfigExecutionLedger();
  const result = await executeControlledConfigMutation({
    plan: c.plan,
    ticket: c.authorizationTicket,
    verdict: c.authorizationVerdict,
    configStore: io.store,
    ledger,
    gate: over.gate ?? switches(),
    executedAt: over.executedAt ?? EXECUTED_AT,
    idempotencyKey: over.idempotencyKey ?? 'idem-p6u3-1',
  });
  return { c, io, ledger, result };
};

describe('PHASE 6 U3 —— controlled config execution (SANDBOX ONLY)', () => {
  it('P6U3_1 sandbox CAS 写入成功 → COMMITTED 结果绑定 16 项 + provenance + durable persistence', async () => {
    const { c, io, result } = await runExecution();
    expect(result.kind).toBe('CONTROLLED_CONFIG_EXECUTION_RESULT');
    expect(result.mode).toBe('SANDBOX_WRITE_ONLY');
    expect(result.semantics).toBe(CONTROLLED_CONFIG_EXECUTION_SEMANTICS);
    expect(result.status).toBe('COMMITTED');
    expect(result.planDigest).toBe(c.plan.planDigest);
    expect(result.authorizationTicketDigest).toBe(c.authorizationTicket.ticketDigest);
    expect(result.authorizationVerdictDigest).toBe(c.authorizationVerdict.verdictDigest);
    expect(result.rollbackPlanDigest).toBe(c.plan.rollbackPlanDigest);
    expect(result.target).toBe(c.plan.target);
    expect(result.path).toBe(PATH);
    expect(result.from).toBe('0.50');
    expect(result.to).toBe('0.75');
    expect(result.preConfigFingerprint).toBe(BASELINE_FINGERPRINT);
    expect(result.preConfigVersion).toBe(BASELINE_VERSION);
    expect(result.postConfigFingerprint).toBe(POST_FINGERPRINT);
    expect(result.postConfigVersion).toBe(POST_VERSION);
    expect(result.rollbackTarget.target).toBe('U2_BASELINE');
    expect(result.execution.environment).toBe('SANDBOX');
    expect(result.execution.productionMutation).toBe('FORBIDDEN');
    expect(result.execution.autoRollback).toBe('FORBIDDEN');
    expect(isVerifiedControlledConfigExecutionResult(result)).toBe(true);
    expect(io.counters.casCalls).toBe(1);
    expect(io.state().value).toBe('0.75');
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.binds).toHaveLength(16);
  });

  it('P6U3_2 三重可信入口 fail-closed：clone / mismatch / REJECTED 语义', async () => {
    const c = await chain();
    const io = executionStore({ value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION });
    const base = {
      configStore: io.store,
      ledger: createSandboxConfigExecutionLedger(),
      gate: switches(),
      executedAt: EXECUTED_AT,
      idempotencyKey: 'idem-triple',
    };
    await expect(
      executeControlledConfigMutation({ ...base, plan: { ...c.plan } as never, ticket: c.authorizationTicket, verdict: c.authorizationVerdict }),
    ).rejects.toThrow(/CONFIG_EXECUTION_PLAN_NOT_VERIFIED/);
    await expect(
      executeControlledConfigMutation({ ...base, plan: c.plan, ticket: { ...c.authorizationTicket } as never, verdict: c.authorizationVerdict }),
    ).rejects.toThrow(/CONFIG_EXECUTION_TICKET_NOT_VERIFIED/);
    await expect(
      executeControlledConfigMutation({ ...base, plan: c.plan, ticket: c.authorizationTicket, verdict: { ...c.authorizationVerdict } as never }),
    ).rejects.toThrow(/CONFIG_EXECUTION_VERDICT_NOT_VERIFIED/);
    // digest 不闭合：混用另一条链的 artifact
    const other = await chain();
    await expect(
      executeControlledConfigMutation({
        ...base,
        plan: other.plan,
        ticket: other.authorizationTicket,
        verdict: c.authorizationVerdict,
      }),
    ).rejects.toThrow(/CONFIG_EXECUTION_VERDICT_TICKET_MISMATCH/);
    await expect(
      executeControlledConfigMutation({
        ...base,
        plan: other.plan,
        ticket: c.authorizationTicket,
        verdict: c.authorizationVerdict,
      }),
    ).rejects.toThrow(/CONFIG_EXECUTION_VERDICT_PLAN_MISMATCH/);
    expect(io.counters.casCalls).toBe(0);
  });

  it('P6U3_3 执行时间门：早于授权 / 越过授权窗口', async () => {
    await expect(runExecution({ executedAt: '2026-10-06T01:00:00.000Z' })).rejects.toThrow(
      /CONFIG_EXECUTION_BEFORE_AUTHORIZATION/,
    );
    await expect(runExecution({ executedAt: '2026-10-06T04:00:00.000Z' })).rejects.toThrow(
      /CONFIG_EXECUTION_AUTHORIZATION_EXPIRED/,
    );
    await expect(runExecution({ executedAt: 'not-a-date' })).rejects.toThrow(/CONFIG_EXECUTION_TIME_INVALID/);
  });

  it('P6U3_4 kill switch / control plane：非 SANDBOX、全局停用、未启用一律 fail-closed', async () => {
    await expect(runExecution({ gate: switches({ environment: 'PRODUCTION' }) })).rejects.toThrow(
      /CONFIG_EXECUTION_PRODUCTION_FORBIDDEN/,
    );
    await expect(runExecution({ gate: switches({ globalDisabled: true }) })).rejects.toThrow(
      /CONFIG_EXECUTION_KILL_SWITCH_ENGAGED/,
    );
    await expect(runExecution({ gate: switches({ executionEnabled: false }) })).rejects.toThrow(
      /CONFIG_EXECUTION_NOT_ENABLED/,
    );
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.environment).toBe('SANDBOX');
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.productionMutation).toBe('FORBIDDEN');
  });

  it('P6U3_5 执行瞬间重读：fingerprint / path value / version 任一漂移 → STALE_EXECUTION_BASELINE（零写）', async () => {
    await expect(
      runExecution({ storeState: { value: '0.50', fingerprint: 'config:drifted', version: BASELINE_VERSION } }),
    ).rejects.toThrow(/STALE_EXECUTION_BASELINE:fingerprint/);
    await expect(
      runExecution({ storeState: { value: '0.90', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION } }),
    ).rejects.toThrow(/STALE_EXECUTION_BASELINE:path-value/);
    await expect(
      runExecution({ storeState: { value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: 'cfg-9' } }),
    ).rejects.toThrow(/STALE_EXECUTION_BASELINE:version/);
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.liveConfigReread).toContain('STALE_EXECUTION_BASELINE');
  });

  it('P6U3_6 原子 CAS 是硬门：冲突 → CONFIG_EXECUTION_CONFLICT，零副作用', async () => {
    const versionConflict = await runExecution({
      storeState: { value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION, cas: 'VERSION_CONFLICT' },
    });
    expect(versionConflict.result.status).toBe('CONFLICT');
    expect(versionConflict.io.counters.casCalls).toBe(1);
    expect(versionConflict.io.state().value).toBe('0.50');
    const io = executionStore({ value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION, cas: 'PATH_VALUE_CONFLICT' });
    const c = await chain();
    const pathConflict = await executeControlledConfigMutation({
      plan: c.plan,
      ticket: c.authorizationTicket,
      verdict: c.authorizationVerdict,
      configStore: io.store,
      ledger: createSandboxConfigExecutionLedger(),
      gate: switches(),
      executedAt: EXECUTED_AT,
      idempotencyKey: 'idem-conflict',
    });
    expect(pathConflict.status).toBe('CONFLICT');
    expect(io.state().value).toBe('0.50');
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.atomicCas).toContain('CONFIG_EXECUTION_CONFLICT');
  });

  it('P6U3_7 一次授权最多一次 mutation + idempotency：同键返回既有结果，异键冲突', async () => {
    const c = await chain();
    const io = executionStore({ value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION });
    const ledger = createSandboxConfigExecutionLedger();
    const call = (idempotencyKey: string) =>
      executeControlledConfigMutation({
        plan: c.plan,
        ticket: c.authorizationTicket,
        verdict: c.authorizationVerdict,
        configStore: io.store,
        ledger,
        gate: switches(),
        executedAt: EXECUTED_AT,
        idempotencyKey,
      });
    const first = await call('idem-once');
    expect(first.status).toBe('COMMITTED');
    const second = await call('idem-once');
    expect(second.executionId).toBe(first.executionId);
    expect(second.resultDigest).toBe(first.resultDigest);
    expect(io.counters.casCalls).toBe(1);
    await expect(call('idem-other')).rejects.toThrow(/IDEMPOTENCY_KEY_CONFLICT/);
    expect(io.counters.casCalls).toBe(1);
    await expect(
      executeControlledConfigMutation({
        plan: c.plan,
        ticket: c.authorizationTicket,
        verdict: c.authorizationVerdict,
        configStore: io.store,
        ledger,
        gate: switches(),
        executedAt: EXECUTED_AT,
        idempotencyKey: '   ',
      }),
    ).rejects.toThrow(/CONFIG_EXECUTION_IDEMPOTENCY_KEY_REQUIRED/);
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.oneMutationPerAuthorization).toContain('最多一次');
  });

  it('P6U3_8 写后 read-back 不一致 → NEEDS_RECONCILIATION（绝不标记 COMMITTED）', async () => {
    const { result } = await runExecution({
      storeState: {
        value: '0.50',
        fingerprint: BASELINE_FINGERPRINT,
        version: BASELINE_VERSION,
        readBackValue: '0.50',
      },
    });
    expect(result.status).toBe('NEEDS_RECONCILIATION');
    expect(isVerifiedControlledConfigExecutionResult(result)).toBe(true);
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.readBack).toContain('NEEDS_RECONCILIATION');
  });

  it('P6U3_9 目标值已生效 → NOOP_ALREADY_APPLIED（零写）', async () => {
    const { io, result } = await runExecution({
      storeState: { value: '0.75', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION },
    });
    expect(result.status).toBe('NOOP_ALREADY_APPLIED');
    expect(io.counters.casCalls).toBe(0);
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.successSemantics).toBe('SANDBOX_CONFIG_MUTATION_COMMITTED');
  });

  it('P6U3_10 边界与无越权入口：productionMutation FORBIDDEN、无 rollout/promote 导出', async () => {
    const mod = (await import('../services/outcome-learning/controlled-config-execution')) as unknown as Record<string, unknown>;
    for (const key of ['rollout', 'promoteConfig', 'applyToProduction', 'productionApply', 'deployConfig']) {
      expect(mod[key]).toBeUndefined();
    }
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.scope).toContain('SANDBOX');
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.forbiddenStates).toEqual(['PRODUCTION_APPLIED', 'DEPLOYED', 'ROLLED_OUT']);
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.forbidden).toContain('production config store');
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.rollbackAnchor).toContain('首版不自动 rollback');
    const attempt = (fn: () => void): boolean => {
      try {
        fn();
        return true;
      } catch {
        return false;
      }
    };
    const { result } = await runExecution();
    expect(attempt(() => { (result as unknown as { to: string }).to = '0.99'; })).toBe(false);
  });

  it('P6U3F_1 LIVE_VERSION_NOOP_GATE：version 漂移但值已等于 to → STALE_EXECUTION_BASELINE（不得 NOOP）', async () => {
    await expect(
      runExecution({ storeState: { value: '0.75', fingerprint: BASELINE_FINGERPRINT, version: 'cfg-9' } }),
    ).rejects.toThrow(/STALE_EXECUTION_BASELINE:version/);
  });

  it('P6U3F_2 RESERVATION_TERMINALIZATION：preflight stale 失败不留 orphan reservation（同授权可重试成功）', async () => {
    const c = await chain();
    const ledger = createSandboxConfigExecutionLedger();
    const stale = executionStore({ value: '0.90', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION });
    await expect(
      executeControlledConfigMutation({
        plan: c.plan,
        ticket: c.authorizationTicket,
        verdict: c.authorizationVerdict,
        configStore: stale.store,
        ledger,
        gate: switches(),
        executedAt: EXECUTED_AT,
        idempotencyKey: 'idem-preflight',
      }),
    ).rejects.toThrow(/STALE_EXECUTION_BASELINE:path-value/);
    expect(stale.counters.casCalls).toBe(0);
    // 同 authorization + 同 ledger 重试（配置已恢复）→ 必须能真正执行，证明未被 orphan reservation 占位
    const healthy = executionStore({ value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION });
    const retry = await executeControlledConfigMutation({
      plan: c.plan,
      ticket: c.authorizationTicket,
      verdict: c.authorizationVerdict,
      configStore: healthy.store,
      ledger,
      gate: switches(),
      executedAt: EXECUTED_AT,
      idempotencyKey: 'idem-preflight',
    });
    expect(retry.status).toBe('COMMITTED');
    expect(healthy.counters.casCalls).toBe(1);
  });

  it('P6U3F_3 POST_WRITE_RECONCILIATION_DURABILITY：CAS 冲突 -> durable CONFLICT 且重试返回同一结果、不再 CAS', async () => {
    const c = await chain();
    const ledger = createSandboxConfigExecutionLedger();
    const io = executionStore({ value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION, cas: 'VERSION_CONFLICT' });
    const call = () =>
      executeControlledConfigMutation({
        plan: c.plan,
        ticket: c.authorizationTicket,
        verdict: c.authorizationVerdict,
        configStore: io.store,
        ledger,
        gate: switches(),
        executedAt: EXECUTED_AT,
        idempotencyKey: 'idem-conflict-durable',
      });
    const first = await call();
    expect(first.status).toBe('CONFLICT');
    expect(isVerifiedControlledConfigExecutionResult(first)).toBe(true);
    const second = await call();
    expect(second.status).toBe('CONFLICT');
    expect(second.resultDigest).toBe(first.resultDigest);
    expect(io.counters.casCalls).toBe(1);
  });

  it('P6U3F_4 CAS 成功但 read-back 抛错 / malformed → durable NEEDS_RECONCILIATION，且重试不再 CAS', async () => {
    for (const mode of [{ readBackThrow: true }, { readBackMalformed: true }] as const) {
      const c = await chain();
      const ledger = createSandboxConfigExecutionLedger();
      const io = executionStore({
        value: '0.50',
        fingerprint: BASELINE_FINGERPRINT,
        version: BASELINE_VERSION,
        ...mode,
      });
      const call = () =>
        executeControlledConfigMutation({
          plan: c.plan,
          ticket: c.authorizationTicket,
          verdict: c.authorizationVerdict,
          configStore: io.store,
          ledger,
          gate: switches(),
          executedAt: EXECUTED_AT,
          idempotencyKey: 'idem-unknown-outcome',
        });
      const first = await call();
      expect(first.status).toBe('NEEDS_RECONCILIATION');
      expect(isVerifiedControlledConfigExecutionResult(first)).toBe(true);
      const second = await call();
      expect(second.resultDigest).toBe(first.resultDigest);
      expect(io.counters.casCalls).toBe(1);
    }
  });

  it('P6U3F2_1 CAS_EXCEPTION_TERMINALIZATION：compareAndSwap 抛异常 → durable NEEDS_RECONCILIATION（非 CONFLICT），重试同结果且不再 CAS', async () => {
    const c = await chain();
    const ledger = createSandboxConfigExecutionLedger();
    const io = executionStore({
      value: '0.50',
      fingerprint: BASELINE_FINGERPRINT,
      version: BASELINE_VERSION,
      casThrow: true,
    });
    const call = () =>
      executeControlledConfigMutation({
        plan: c.plan,
        ticket: c.authorizationTicket,
        verdict: c.authorizationVerdict,
        configStore: io.store,
        ledger,
        gate: switches(),
        executedAt: EXECUTED_AT,
        idempotencyKey: 'idem-cas-throw',
      });
    const first = await call();
    expect(first.status).toBe('NEEDS_RECONCILIATION');
    expect(first.semantics).toBe('SANDBOX_CONFIG_MUTATION_NEEDS_RECONCILIATION');
    expect(isVerifiedControlledConfigExecutionResult(first)).toBe(true);
    const second = await call();
    expect(second.resultDigest).toBe(first.resultDigest);
    expect(io.counters.casCalls).toBe(1);
  });

  it('P6U3F2_2 EXECUTION_RESULT_SEMANTICS：semantics 随 status 取值且进入 resultDigest', async () => {
    expect(CONTROLLED_CONFIG_EXECUTION_STATUS_SEMANTICS).toEqual({
      COMMITTED: 'SANDBOX_CONFIG_MUTATION_COMMITTED',
      NOOP_ALREADY_APPLIED: 'SANDBOX_CONFIG_ALREADY_APPLIED_NO_WRITE',
      CONFLICT: 'SANDBOX_CONFIG_MUTATION_CONFLICT_NO_WRITE',
      NEEDS_RECONCILIATION: 'SANDBOX_CONFIG_MUTATION_NEEDS_RECONCILIATION',
      FAILED_ZERO_WRITE: 'SANDBOX_CONFIG_MUTATION_FAILED_ZERO_WRITE',
    });
    const committed = await runExecution();
    expect(committed.result.status).toBe('COMMITTED');
    expect(committed.result.semantics).toBe('SANDBOX_CONFIG_MUTATION_COMMITTED');
    const noop = await runExecution({
      storeState: { value: '0.75', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION },
    });
    expect(noop.result.status).toBe('NOOP_ALREADY_APPLIED');
    expect(noop.result.semantics).toBe('SANDBOX_CONFIG_ALREADY_APPLIED_NO_WRITE');
    const conflict = await runExecution({
      storeState: { value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION, cas: 'VERSION_CONFLICT' },
    });
    expect(conflict.result.status).toBe('CONFLICT');
    expect(conflict.result.semantics).toBe('SANDBOX_CONFIG_MUTATION_CONFLICT_NO_WRITE');
    const reconcile = await runExecution({
      storeState: { value: '0.50', fingerprint: BASELINE_FINGERPRINT, version: BASELINE_VERSION, readBackValue: '0.50' },
    });
    expect(reconcile.result.status).toBe('NEEDS_RECONCILIATION');
    expect(reconcile.result.semantics).toBe('SANDBOX_CONFIG_MUTATION_NEEDS_RECONCILIATION');
    // digest 绑定 status/semantics：不同 status 的 resultDigest 必不相同
    const digests = new Set([
      committed.result.resultDigest,
      noop.result.resultDigest,
      conflict.result.resultDigest,
      reconcile.result.resultDigest,
    ]);
    expect(digests.size).toBe(4);
    expect(CONTROLLED_CONFIG_EXECUTION_BOUNDARY.semanticsByStatus.COMMITTED).toBe('SANDBOX_CONFIG_MUTATION_COMMITTED');
  });
});
