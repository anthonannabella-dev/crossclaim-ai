/**
 * Recovery SI Phase 2 —— P2-A + P2-B 验收（MSG-20261005-13 授权 + MSG-20261005-14 REVISE）
 * P2-A：匿名·聚合·能力级 Outcome Signal（A1 unique cohort / A2 domain-bound samples / 输出封套）
 * P2-B：只读 Tool 实接（10 条最小证据 + B1 入口内重新 verify + B2 actor/output 身份绑定）
 */

import fs from 'node:fs';
import path from 'node:path';

import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  buildCustomerRecoveryState,
  type CapabilitySlice,
  type CustomerRecoveryState,
  type OpportunitySlice,
} from '../services/intelligence/customer-recovery-state';
import { planRecovery, type RecoveryPlan } from '../services/intelligence/recovery-planner';
import { prioritizeOpportunities } from '../services/intelligence/recovery-prioritizer';
import { superviseRecovery } from '../services/intelligence/recovery-supervisor';
import { verifyRecoveryPlan } from '../services/intelligence/recovery-verifier';
import {
  RECOVERY_OUTCOME_MIN_COHORT,
  RECOVERY_OUTCOME_SIGNAL_BOUNDARY,
  RECOVERY_OUTCOME_TO_RSI,
  buildRecoveryOutcomeSignals,
  publishRecoveryOutcomeSignals,
  scanRecoveryOutcomeSignal,
  type RecoveryOutcomeSignal,
} from '../services/intelligence/recovery-outcome-signal';
import {
  RECOVERY_READ_TOOL,
  RECOVERY_READ_TOOL_SAFETY,
  RECOVERY_READ_TOOLS_BOUNDARY,
  createRecoveryReadToolRegistry,
  runRecoveryReadTools,
  type RecoveryReadPorts,
  type RecoveryReadToolSafetyProof,
} from '../services/intelligence/recovery-read-tools';
import { createPrismaRecoveryReadPorts } from '../services/intelligence/recovery-read-tool-adapters';
import { createRecoveryToolRegistry, type RecoveryToolRegistry } from '../services/intelligence/recovery-tool-registry';

const NOW = '2026-10-05T04:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ORG = 'org-p2';
const MAX_AGE_MS = 15 * 60 * 1000;

const opportunity = (over: Partial<OpportunitySlice> = {}): OpportunitySlice => ({
  opportunityRef: 'opp-1',
  domain: 'CARRIER',
  organizationId: ORG,
  recoverable: { amount: 680, currency: 'USD', source: 'CANONICAL_FACT' },
  eligibility: 'ELIGIBLE',
  evidenceComplete: true,
  missingEvidence: [],
  authorizationReady: true,
  deadline: '2026-11-01T00:00:00.000Z',
  providerCostUsd: 0,
  expectedOperationalCostUsd: 0,
  riskClass: 'LOW',
  observedAt: NOW,
  ...over,
});

const capability = (over: Partial<CapabilitySlice> = {}): CapabilitySlice => ({
  domain: 'CARRIER',
  readOnlyTools: ['recovery.opportunity.read'],
  providerApproval: 'READY',
  ...over,
});

const buildState = (
  opportunities: readonly OpportunitySlice[],
  capabilities: readonly CapabilitySlice[],
): CustomerRecoveryState => {
  const result = buildCustomerRecoveryState({
    organizationId: ORG,
    observedAt: NOW,
    opportunities,
    capability: capabilities,
  });
  if (!result.ok) throw new Error(`fixture tenant mismatch: ${result.offendingRef}`);
  return result.state;
};

const instrumentedPorts = (over: Partial<RecoveryReadPorts> = {}) => {
  const calls: string[] = [];
  const ports: RecoveryReadPorts = {
    opportunityRead: async (input) => {
      calls.push(`${RECOVERY_READ_TOOL.OPPORTUNITY}:${input.opportunityRef}`);
      return {
        opportunityRef: input.opportunityRef,
        status: 'QUALIFIED',
        currency: 'USD',
        hasRecoverableAmount: true,
        hasRuleEvaluation: true,
      };
    },
    evidenceRead: async (input) => {
      calls.push(`${RECOVERY_READ_TOOL.EVIDENCE}:${input.opportunityRef}`);
      return { opportunityRef: input.opportunityRef, caseRef: 'case-1', evidenceCount: 2, kinds: ['BOL', 'INVOICE'] };
    },
    customsAuthorizationReadinessRead: async (input) => {
      calls.push(`${RECOVERY_READ_TOOL.CUSTOMS_AUTHORIZATION_READINESS}:${input.opportunityRef}`);
      return {
        opportunityRef: input.opportunityRef,
        route: 'BROKER_FILED',
        readyToFile: false,
        blockerCodes: ['BROKER_POA_REQUIRED'],
      };
    },
    ...over,
  };
  return { ports, calls };
};

/** CUSTOMS cohort ≥ 最小 cohort：3 缺授权 + 2 缺证据 + 1 完整 */
const customsCohortState = (): CustomerRecoveryState =>
  buildState(
    [
      opportunity({ opportunityRef: 'opp-c1', domain: 'CUSTOMS', authorizationReady: false }),
      opportunity({ opportunityRef: 'opp-c2', domain: 'CUSTOMS', authorizationReady: false }),
      opportunity({ opportunityRef: 'opp-c3', domain: 'CUSTOMS', authorizationReady: false }),
      opportunity({
        opportunityRef: 'opp-c4',
        domain: 'CUSTOMS',
        evidenceComplete: false,
        missingEvidence: ['BILL_OF_LADING'],
      }),
      opportunity({
        opportunityRef: 'opp-c5',
        domain: 'CUSTOMS',
        evidenceComplete: false,
        missingEvidence: ['ENTRY_SUMMARY'],
      }),
      opportunity({ opportunityRef: 'opp-c6', domain: 'CUSTOMS' }),
    ],
    [capability({ domain: 'CUSTOMS' })],
  );

/** 小型混合 fixture：CARRIER + CUSTOMS（P2-B 精确断言用） */
const mixedState = (over: { customsObservedAt?: string } = {}): CustomerRecoveryState =>
  buildState(
    [
      opportunity({ opportunityRef: 'opp-carrier', domain: 'CARRIER' }),
      opportunity({
        opportunityRef: 'opp-customs',
        domain: 'CUSTOMS',
        ...(over.customsObservedAt === undefined ? {} : { observedAt: over.customsObservedAt }),
      }),
    ],
    [capability({ domain: 'CARRIER' }), capability({ domain: 'CUSTOMS' })],
  );

/** 两个 domain 各 5 个机会（P2-A A2 域隔离断言用） */
const twoDomainState = (): CustomerRecoveryState =>
  buildState(
    [
      ...['c1', 'c2', 'c3', 'c4', 'c5'].map((suffix) =>
        opportunity({ opportunityRef: `opp-cu-${suffix}`, domain: 'CUSTOMS' }),
      ),
      ...['r1', 'r2', 'r3', 'r4', 'r5'].map((suffix) =>
        opportunity({ opportunityRef: `opp-ca-${suffix}`, domain: 'CARRIER' }),
      ),
    ],
    [capability({ domain: 'CUSTOMS' }), capability({ domain: 'CARRIER' })],
  );

const planAndVerify = (state: CustomerRecoveryState, registry: RecoveryToolRegistry) => {
  const priority = prioritizeOpportunities(state);
  const plan = planRecovery({ state, ranked: priority.ranked, registry, generatedAt: NOW });
  const verification = verifyRecoveryPlan({
    plan,
    state,
    registry,
    priority,
    nowMs: NOW_MS,
    maxSnapshotAgeMs: MAX_AGE_MS,
  });
  return { priority, plan, verification };
};

const driftSamples = [
  { predicted: 115, actual: 100 },
  { predicted: 88, actual: 100 },
  { predicted: 112, actual: 100 },
  { predicted: 90, actual: 100 },
  { predicted: 110, actual: 100 },
];

describe('Recovery SI Phase 2 · P2-A 匿名聚合能力信号', () => {
  it('P2A-01 只产出聚合能力级信号：cohort = unique opportunityRef，无客户事实字段', () => {
    const { ports } = instrumentedPorts();
    const { registry } = createRecoveryReadToolRegistry(ports);
    const supervision = superviseRecovery({ state: customsCohortState(), registry, nowMs: NOW_MS });

    const build = buildRecoveryOutcomeSignals({
      supervision,
      algorithmVersion: 'v2',
      ruleVersionRefs: ['rule-version:v3'],
    });

    expect(build.violations).toEqual([]);
    expect(build.signals).toHaveLength(1);
    const signal = build.signals[0]!;
    expect(signal.domain).toBe('CUSTOMS');
    // 6 个 CUSTOMS 机会（只读 registry 下第 6 个为 HOLD）→ unique cohort = 6
    expect(signal.cohortSize).toBe(6);
    expect(scanRecoveryOutcomeSignal(signal)).toEqual([]);
    expect(Object.keys(signal.metrics).sort()).toEqual(['authorization_block_rate', 'evidence_missing_rate']);
    expect(signal.metrics.authorization_block_rate).toBeCloseTo(3 / 6, 4);
    expect(signal.metrics.evidence_missing_rate).toBeCloseTo(2 / 6, 4);
    expect(RECOVERY_OUTCOME_TO_RSI).toBe('AGGREGATED_ANONYMIZED_CAPABILITY_SIGNAL_ONLY');
    expect(RECOVERY_OUTCOME_SIGNAL_BOUNDARY.cohortUnit).toBe('UNIQUE_OPPORTUNITY_REF');
    expect(RECOVERY_OUTCOME_SIGNAL_BOUNDARY.outcomeSamplesPerDomain).toBe(true);
    expect(signal.reasonCodes).toContain('ESTIMATE_ERROR_NOT_MEASURABLE');
    expect(signal.reasonCodes).toContain('TIME_TO_READY_NOT_MEASURABLE');
    const serialized = JSON.stringify(signal);
    expect(serialized).not.toContain(ORG);
    expect(serialized).not.toContain('opp-');
  });

  it('P2A-02 cohort 小于最小规模 → 不产生信号（防反匿名化）', () => {
    const { ports } = instrumentedPorts();
    const { registry } = createRecoveryReadToolRegistry(ports);
    const supervision = superviseRecovery({ state: mixedState(), registry, nowMs: NOW_MS });

    const build = buildRecoveryOutcomeSignals({ supervision, algorithmVersion: 'v2' });
    expect(build.signals).toEqual([]);
    expect(build.skipped.every((entry) => entry.reason === 'COHORT_TOO_SMALL')).toBe(true);
  });

  it('P2A-03 domain 绑定样本 → 分档漂移信号（refs 只含版本引用）', () => {
    const { ports } = instrumentedPorts();
    const { registry } = createRecoveryReadToolRegistry(ports);
    const supervision = superviseRecovery({ state: customsCohortState(), registry, nowMs: NOW_MS });

    const build = buildRecoveryOutcomeSignals({
      supervision,
      algorithmVersion: 'v2',
      ruleVersionRefs: ['rule-version:v3'],
      estimateErrorSamplesByDomain: { CUSTOMS: driftSamples },
      timeToReadySamplesMsByDomain: { CUSTOMS: [3_600_000, 7_200_000, 1_800_000, 5_400_000, 2_700_000] },
    });

    const signal = build.signals[0]!;
    expect(signal.signal).toBe('CUSTOMS_ESTIMATE_CALIBRATION_DRIFT');
    expect(signal.metrics.estimate_error_bucket).toBe('10-20%');
    expect(signal.metrics.median_time_to_ready).toBe(3_600_000);
    expect(signal.refs).toEqual(['algorithm-version:v2', 'rule-version:v3']);
    expect(signal.riskClass).toBe('MEDIUM');
    expect(scanRecoveryOutcomeSignal(signal)).toEqual([]);
  });

  it('P2A-04 客户事实/标识符泄漏 → 逐条违规（fail-closed，绝不脱敏后重发）', () => {
    const leaked = {
      signal: 'CUSTOMS_ESTIMATE_CALIBRATION_DRIFT',
      domain: 'CUSTOMS',
      metrics: { authorization_block_rate: 0.32, customer_recovered_amount: 18_500 },
      refs: ['evidence:ev-123'],
      cohortSize: 3,
      riskClass: 'MEDIUM',
      dedupeKey: 'x',
      summary: '客户 A 的 $18,500 案件出了问题',
      reasonCodes: [],
      organizationId: 'org-x',
      opportunityRef: 'opp-1',
    };

    const reasons = scanRecoveryOutcomeSignal(leaked).map((violation) => violation.reason);
    expect(reasons).toContain('FORBIDDEN_FIELD');
    expect(reasons).toContain('METRIC_NOT_ALLOWED');
    expect(reasons).toContain('REF_NOT_ALLOWED');
    expect(reasons).toContain('COHORT_TOO_SMALL');
    expect(reasons).toContain('DEDUPE_KEY_NOT_ALLOWED');
    expect(reasons).toContain('SUMMARY_LEAKS_IDENTIFIER');
    const summaryOnly = scanRecoveryOutcomeSignal({
      ...leaked,
      metrics: { authorization_block_rate: 0.32 },
    }).map((violation) => violation.reason);
    expect(summaryOnly).toContain('SUMMARY_LEAKS_IDENTIFIER');
  });

  it('P2A-05 投递 fail-closed：无 RSI sink 不写入；违规信号被整体拒绝', async () => {
    const emitted: RecoveryOutcomeSignal[] = [];
    const clean = {
      signal: 'CUSTOMS_RECOVERY_CAPABILITY_SIGNAL',
      domain: 'CUSTOMS',
      metrics: { authorization_block_rate: 0.4 },
      refs: ['algorithm-version:v2'],
      cohortSize: RECOVERY_OUTCOME_MIN_COHORT,
      riskClass: 'LOW',
      dedupeKey:
        'CUSTOMS_RECOVERY_CAPABILITY_SIGNAL:cohort>=5:authorization_block_rate',
      summary:
        'Recovery capability signal for CUSTOMS: authorization_block_rate (aggregated 5 opportunities)',
      reasonCodes: ['AGGREGATED_ONLY'],
    } as RecoveryOutcomeSignal;

    const noSink = await publishRecoveryOutcomeSignals([clean]);
    expect(noSink.published).toBe(false);
    if (noSink.published) throw new Error('unreachable');
    expect(noSink.reason).toBe('RSI_SINK_NOT_WIRED_IN_P2_A');

    const sink = {
      emit: (signal: RecoveryOutcomeSignal): void => {
        emitted.push(signal);
      },
    };
    const rejected = await publishRecoveryOutcomeSignals(
      [{ ...clean, organizationId: ORG } as unknown as RecoveryOutcomeSignal],
      sink,
    );
    expect(rejected.published).toBe(false);
    if (rejected.published) throw new Error('unreachable');
    expect(rejected.reason).toBe('SIGNAL_REJECTED');
    expect(emitted).toEqual([]);

    const published = await publishRecoveryOutcomeSignals([clean], sink);
    expect(published).toEqual({ published: true, count: 1 });
    expect(emitted).toHaveLength(1);
  });
});

describe('Recovery SI Phase 2 · P2-B 只读 Tool 实接', () => {
  it('P2B-01/02/03 真实 Opportunity / Evidence / Customs readiness READ tool 均可调用', async () => {
    const { ports, calls } = instrumentedPorts();
    const bundle = createRecoveryReadToolRegistry(ports);
    const state = mixedState();
    const { plan } = planAndVerify(state, bundle.registry);

    const run = await runRecoveryReadTools({ state, plan, registry: bundle.registry, nowMs: NOW_MS });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unexpected halt');

    const tools = run.invocations
      .filter((entry) => entry.opportunityRef === 'opp-customs')
      .map((entry) => entry.tool)
      .sort();
    expect(tools).toEqual([
      RECOVERY_READ_TOOL.CUSTOMS_AUTHORIZATION_READINESS,
      RECOVERY_READ_TOOL.EVIDENCE,
      RECOVERY_READ_TOOL.OPPORTUNITY,
    ]);
    expect(run.invocations.every((entry) => entry.ok)).toBe(true);
    const opportunityOutput = run.invocations.find(
      (entry) => entry.tool === RECOVERY_READ_TOOL.OPPORTUNITY && entry.opportunityRef === 'opp-carrier',
    )?.output as { status: string; currency: string };
    expect(opportunityOutput.status).toBe('QUALIFIED');
    expect(opportunityOutput.currency).toBe('USD');
    const customsOutput = run.invocations.find(
      (entry) => entry.tool === RECOVERY_READ_TOOL.CUSTOMS_AUTHORIZATION_READINESS,
    )?.output as { route: string; blockerCodes: readonly string[] };
    expect(customsOutput.route).toBe('BROKER_FILED');
    expect(customsOutput.blockerCodes).toEqual(['BROKER_POA_REQUIRED']);
    expect(calls).toHaveLength(run.invocations.length);
  });

  it('P2B-04 跨租户 → 拒绝且零调用', async () => {
    const { ports, calls } = instrumentedPorts();
    const bundle = createRecoveryReadToolRegistry(ports);
    const state = mixedState();
    const { plan } = planAndVerify(state, bundle.registry);
    const forged: CustomerRecoveryState = {
      ...state,
      opportunities: state.opportunities.map((slice) =>
        slice.opportunityRef === 'opp-customs' ? { ...slice, organizationId: 'org-other' } : slice,
      ),
    };

    const run = await runRecoveryReadTools({ state: forged, plan, registry: bundle.registry, nowMs: NOW_MS });
    expect(run.ok).toBe(false);
    if (run.ok) throw new Error('unreachable');
    expect(run.reason).toBe('TENANT_MISMATCH');
    expect(run.invocations).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('P2B-05 stale decision → 工具不调用', async () => {
    const { ports, calls } = instrumentedPorts();
    const bundle = createRecoveryReadToolRegistry(ports);
    const state = mixedState({ customsObservedAt: '2026-10-05T02:00:00.000Z' });
    const { plan, verification } = planAndVerify(state, bundle.registry);
    expect(verification.ok).toBe(true);
    if (!verification.ok) throw new Error('unreachable');
    expect(verification.rejected.some((entry) => entry.opportunityRef === 'opp-customs')).toBe(true);

    const run = await runRecoveryReadTools({ state, plan, registry: bundle.registry, nowMs: NOW_MS });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.invocations.some((entry) => entry.opportunityRef === 'opp-customs')).toBe(false);
    expect(calls.some((entry) => entry.endsWith('opp-customs'))).toBe(false);
    expect(
      run.skipped.some((entry) => entry.opportunityRef === 'opp-customs' && entry.reason === 'PLAN_NOT_VERIFIED'),
    ).toBe(true);
  });

  it('P2B-06 未登记工具 → 不调用（fail-closed）', async () => {
    const { ports, calls } = instrumentedPorts();
    const bundle = createRecoveryReadToolRegistry(ports);
    const partial: RecoveryToolRegistry = {
      list: () => bundle.registry.list().filter((entry) => entry.name !== RECOVERY_READ_TOOL.EVIDENCE),
      has: (name) => name !== RECOVERY_READ_TOOL.EVIDENCE && bundle.registry.has(name),
      invoke: (name, input, ctx) => bundle.registry.invoke(name, input, ctx),
    };
    const state = mixedState();
    const { plan } = planAndVerify(state, bundle.registry);

    const run = await runRecoveryReadTools({ state, plan, registry: partial, nowMs: NOW_MS });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.invocations.some((entry) => entry.tool === RECOVERY_READ_TOOL.EVIDENCE)).toBe(false);
    expect(run.skipped.filter((entry) => entry.reason === 'TOOL_NOT_REGISTERED').length).toBeGreaterThan(0);
    expect(calls.some((entry) => entry.startsWith(RECOVERY_READ_TOOL.EVIDENCE))).toBe(false);
  });

  it('P2B-07 tool 抛错 / 输出不合 schema / 敏感输出 → fail-closed，且安全证明被篡改的工具不注册', async () => {
    const healthyEvidence = async (input: { opportunityRef: string }) => ({
      opportunityRef: input.opportunityRef,
      caseRef: null,
      evidenceCount: 0,
      kinds: [] as readonly string[],
    });
    const healthyCustoms = async (input: { opportunityRef: string }) => ({
      opportunityRef: input.opportunityRef,
      route: 'UNAVAILABLE',
      readyToFile: false,
      blockerCodes: [] as readonly string[],
    });

    const throwing: RecoveryReadPorts = {
      opportunityRead: async () => {
        throw new Error('read service down');
      },
      evidenceRead: healthyEvidence,
      customsAuthorizationReadinessRead: healthyCustoms,
    };
    const malformed: RecoveryReadPorts = {
      opportunityRead: async (input) =>
        ({ opportunityRef: input.opportunityRef, status: 'QUALIFIED' }) as unknown as {
          opportunityRef: string;
          status: string;
          currency: string;
          hasRecoverableAmount: boolean;
          hasRuleEvaluation: boolean;
        },
      evidenceRead: healthyEvidence,
      customsAuthorizationReadinessRead: healthyCustoms,
    };
    const secretLeaking: RecoveryReadPorts = {
      opportunityRead: async (input) =>
        ({
          opportunityRef: input.opportunityRef,
          status: 'QUALIFIED',
          currency: 'USD',
          hasRecoverableAmount: true,
          hasRuleEvaluation: true,
          signedDownloadUrl: 'https://files.example.com/x?token=abc',
        }) as unknown as {
          opportunityRef: string;
          status: string;
          currency: string;
          hasRecoverableAmount: boolean;
          hasRuleEvaluation: boolean;
        },
      evidenceRead: healthyEvidence,
      customsAuthorizationReadinessRead: healthyCustoms,
    };

    const cases: readonly (readonly [string, RecoveryReadPorts, string])[] = [
      ['throws', throwing, 'read service down'],
      ['malformed', malformed, 'OUTPUT_SCHEMA_REJECTED'],
      ['sensitive', secretLeaking, 'SENSITIVE_OUTPUT_REJECTED'],
    ];
    for (const [label, ports, expectedDetail] of cases) {
      const bundle = createRecoveryReadToolRegistry(ports);
      const state = mixedState();
      const { plan } = planAndVerify(state, bundle.registry);
      const run = await runRecoveryReadTools({ state, plan, registry: bundle.registry, nowMs: NOW_MS });
      expect(run.ok).toBe(true);
      if (!run.ok) throw new Error('unreachable');
      const failed = run.invocations.filter((entry) => !entry.ok && entry.tool === RECOVERY_READ_TOOL.OPPORTUNITY);
      expect(failed.length, `${label} 必须 fail-closed`).toBeGreaterThan(0);
      expect(failed.every((entry) => entry.reason === 'TOOL_THREW')).toBe(true);
      expect(failed.every((entry) => (entry.detail ?? '').includes(expectedDetail))).toBe(true);
      expect(failed.every((entry) => entry.output === null)).toBe(true);
    }

    const safety = RECOVERY_READ_TOOL_SAFETY as Record<string, RecoveryReadToolSafetyProof>;
    const original = safety[RECOVERY_READ_TOOL.EVIDENCE]!;
    try {
      safety[RECOVERY_READ_TOOL.EVIDENCE] = { ...original, DB_WRITE: true as unknown as false };
      const { ports } = instrumentedPorts();
      const tamperedSafety = createRecoveryReadToolRegistry(ports);
      expect(tamperedSafety.registry.has(RECOVERY_READ_TOOL.EVIDENCE)).toBe(false);
      expect(tamperedSafety.registrationErrors.some((entry) => entry.reason.includes('SAFETY_PROOF_MISMATCH'))).toBe(true);
    } finally {
      safety[RECOVERY_READ_TOOL.EVIDENCE] = original;
    }
  });

  it('P2B-08 invoke counter 证明只调用被验证的 READ action', async () => {
    const { ports, calls } = instrumentedPorts();
    const bundle = createRecoveryReadToolRegistry(ports);
    const state = mixedState();
    const { plan } = planAndVerify(state, bundle.registry);

    const run = await runRecoveryReadTools({ state, plan, registry: bundle.registry, nowMs: NOW_MS });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.invocations.length).toBeGreaterThan(0);
    expect(run.invocations.every((entry) => entry.tool.startsWith('recovery.'))).toBe(true);
    const counted = Object.values(bundle.invokeCounts).reduce((total, value) => total + value, 0);
    expect(counted).toBe(run.invocations.length);
    expect(calls).toHaveLength(run.invocations.length);
    expect(bundle.registry.list().every((entry) => entry.access === 'READ')).toBe(true);
    expect(RECOVERY_READ_TOOLS_BOUNDARY.phase2ToolAccess).toBe('READ_ONLY');
    expect(RECOVERY_READ_TOOLS_BOUNDARY.prepareToolsAuthorized).toBe(false);
  });

  it('P2B-09 走真实只读服务：DB before/after 无任何业务写入', async () => {
    const harness = createFakePrisma();
    const ports = createPrismaRecoveryReadPorts(harness.prisma, { organizationId: ORG, role: 'OWNER' });
    const bundle = createRecoveryReadToolRegistry(ports);
    const state = mixedState();
    const { plan } = planAndVerify(state, bundle.registry);
    const run = await runRecoveryReadTools({ state, plan, registry: bundle.registry, nowMs: NOW_MS });

    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    const opportunityOutput = run.invocations.find((entry) => entry.tool === RECOVERY_READ_TOOL.OPPORTUNITY);
    expect(opportunityOutput?.ok).toBe(true);
    expect((opportunityOutput?.output as { hasRecoverableAmount: boolean }).hasRecoverableAmount).toBe(true);
    expect((opportunityOutput?.output as { hasRuleEvaluation: boolean }).hasRuleEvaluation).toBe(false);
    const evidenceOutput = run.invocations.find((entry) => entry.tool === RECOVERY_READ_TOOL.EVIDENCE)?.output as {
      caseRef: string | null;
      evidenceCount: number;
      kinds: readonly string[];
    };
    expect(evidenceOutput.caseRef).toBe('case-1');
    expect(evidenceOutput.evidenceCount).toBe(1);
    expect(evidenceOutput.kinds).toEqual(['INVOICE']);
    const customsOutput = run.invocations.find(
      (entry) => entry.tool === RECOVERY_READ_TOOL.CUSTOMS_AUTHORIZATION_READINESS,
    )?.output as { route: string; blockerCodes: readonly string[] };
    expect(customsOutput.route).toBe('UNAVAILABLE');
    expect(customsOutput.blockerCodes).toEqual(['AUTHORIZATION_CONTEXT_UNAVAILABLE']);
    expect(harness.writeCalls).toEqual([]);
    expect(harness.readCalls.length).toBeGreaterThan(0);
  });

  it('P2B-10 网络/provider 调用计数 = 0（静态证据：零 fetch/http/provider 调用）', () => {
    const readDir = path.resolve(__dirname, '../services/intelligence');
    const sources = ['recovery-read-tools.ts', 'recovery-read-tool-adapters.ts'].map((name) => ({
      name,
      source: fs.readFileSync(path.join(readDir, name), 'utf8'),
    }));

    for (const { name, source } of sources) {
      expect(source, `${name} 不得有 fetch(`).not.toMatch(/\bfetch\s*\(/);
      expect(source, `${name} 不得有 http/https 客户端`).not.toMatch(
        /node:https|node:http|from 'https'|require\('https'\)|\baxios\b/,
      );
      expect(source, `${name} 不得有 provider 传输`).not.toMatch(/\btransport\s*[:=(]/i);
      expect(source, `${name} 不得有 prisma 写操作`).not.toMatch(
        /prisma\.[A-Za-z]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
      );
      expect(source, `${name} 不得有裸 SQL 执行`).not.toMatch(/\$executeRaw|\$queryRaw|\$executeRawUnsafe/);
    }
    for (const name of Object.values(RECOVERY_READ_TOOL)) {
      expect(RECOVERY_READ_TOOL_SAFETY[name]).toEqual({
        READ_ONLY: true,
        DB_WRITE: false,
        NETWORK: false,
        CREDENTIAL_READ: false,
        TENANT_SCOPED: true,
      });
    }
    expect(RECOVERY_READ_TOOLS_BOUNDARY.networkCalls).toBe(0);
    expect(RECOVERY_READ_TOOLS_BOUNDARY.databaseWrites).toBe(0);
    expect(RECOVERY_READ_TOOLS_BOUNDARY.credentialReads).toBe(0);
    expect(RECOVERY_READ_TOOLS_BOUNDARY.runtimeWiring).toBe('NONE');
  });
});

describe('Recovery SI Phase 2 A/B FINAL-2 · MSG-20261005-14 REVISE 负例', () => {
  it('F2-01 3 opportunities × 2 actions → unique cohort = 3 → COHORT_TOO_SMALL → 无信号', () => {
    const fixtureRegistry = createRecoveryToolRegistry([
      {
        name: 'customs.prepare_package',
        domain: 'CUSTOMS',
        access: 'PREPARE',
        description: 'fixture PREPARE tool (plan fixture only; never invoked)',
        invoke: async () => ({ prepared: true }),
      },
    ]);
    const state = buildState(
      ['x1', 'x2', 'x3'].map((suffix) => opportunity({ opportunityRef: `opp-${suffix}`, domain: 'CUSTOMS' })),
      [capability({ domain: 'CUSTOMS' })],
    );
    const supervision = superviseRecovery({ state, registry: fixtureRegistry, nowMs: NOW_MS });
    // 每个机会产生 PREPARE_PACKAGE + READY_FOR_EXECUTION → 6 个 action，但只有 3 个 unique opportunity
    expect(supervision.plan?.actions.length).toBe(6);

    const build = buildRecoveryOutcomeSignals({
      supervision,
      algorithmVersion: 'v2',
      estimateErrorSamplesByDomain: { CUSTOMS: driftSamples },
      timeToReadySamplesMsByDomain: { CUSTOMS: [1_000, 2_000, 3_000, 4_000, 5_000] },
    });
    expect(build.signals).toEqual([]);
    expect(build.skipped).toEqual([{ domain: 'CUSTOMS', reason: 'COHORT_TOO_SMALL' }]);
  });

  it('F2-02 CUSTOMS + CARRIER 同时存在 → 各自只用自己 domain 的 samples（不得跨域复用）', () => {
    const { ports } = instrumentedPorts();
    const { registry } = createRecoveryReadToolRegistry(ports);
    const supervision = superviseRecovery({ state: twoDomainState(), registry, nowMs: NOW_MS });

    const build = buildRecoveryOutcomeSignals({
      supervision,
      algorithmVersion: 'v2',
      estimateErrorSamplesByDomain: { CUSTOMS: driftSamples },
    });
    expect(build.signals).toHaveLength(2);
    const customs = build.signals.find((signal) => signal.domain === 'CUSTOMS')!;
    const carrier = build.signals.find((signal) => signal.domain === 'CARRIER')!;
    expect(customs.signal).toBe('CUSTOMS_ESTIMATE_CALIBRATION_DRIFT');
    expect(customs.metrics.estimate_error_bucket).toBe('10-20%');
    expect(carrier.signal).toBe('CARRIER_RECOVERY_CAPABILITY_SIGNAL');
    expect(carrier.metrics.estimate_error_bucket).toBeUndefined();
    expect(carrier.reasonCodes).toContain('ESTIMATE_ERROR_NOT_MEASURABLE');
    expect(carrier.reasonCodes).toContain('TIME_TO_READY_NOT_MEASURABLE');
  });

  it('F2-03 ref / dedupeKey / reasonCode 尝试编码 org-/case-/opp- → signal rejected', async () => {
    const base: RecoveryOutcomeSignal = {
      signal: 'CUSTOMS_RECOVERY_CAPABILITY_SIGNAL',
      domain: 'CUSTOMS',
      metrics: { authorization_block_rate: 0.4 },
      refs: ['algorithm-version:v2'],
      cohortSize: RECOVERY_OUTCOME_MIN_COHORT,
      riskClass: 'LOW',
      dedupeKey: 'CUSTOMS_RECOVERY_CAPABILITY_SIGNAL:cohort>=5:authorization_block_rate',
      summary: 'Recovery capability signal for CUSTOMS: authorization_block_rate (aggregated 5 opportunities)',
      reasonCodes: ['AGGREGATED_ONLY'],
    };
    expect(scanRecoveryOutcomeSignal(base)).toEqual([]);

    const cases: readonly (readonly [Partial<RecoveryOutcomeSignal>, string])[] = [
      [{ refs: ['org-1'] }, 'REF_NOT_ALLOWED'],
      [{ refs: ['capability:tool-registry'] }, 'REF_NOT_ALLOWED'],
      [{ dedupeKey: 'CUSTOMS_RECOVERY_CAPABILITY_SIGNAL:cohort>=5:opp-1' }, 'DEDUPE_KEY_NOT_ALLOWED'],
      [{ signal: 'CUSTOMS_OPP_1_SIGNAL' }, 'SIGNAL_NOT_ALLOWED'],
      [{ reasonCodes: ['OPP_1'] }, 'REASON_CODE_NOT_ALLOWED'],
      [{ summary: 'customer A recovered 18500' }, 'SUMMARY_LEAKS_IDENTIFIER'],
      [
        { summary: 'Recovery capability signal for CUSTOMS: everything is fine' },
        'SUMMARY_NOT_ALLOWED_PATTERN',
      ],
    ];
    for (const [patch, expected] of cases) {
      const reasons = scanRecoveryOutcomeSignal({ ...base, ...patch }).map((violation) => violation.reason);
      expect(reasons, `expected ${expected} for ${JSON.stringify(patch)}`).toContain(expected);
    }

    const emitted: RecoveryOutcomeSignal[] = [];
    const skipped = await publishRecoveryOutcomeSignals(
      [{ ...base, refs: ['org-1'] }],
      { emit: (signal) => void emitted.push(signal) },
    );
    expect(skipped.published).toBe(false);
    if (skipped.published) throw new Error('unreachable');
    expect(skipped.reason).toBe('SIGNAL_REJECTED');
    expect(emitted).toEqual([]);
  });

  it('F2-04 先 verify Plan A 再修改当前 plan → 执行入口不得调用任何受影响 tool（B1）', async () => {
    const { ports, calls } = instrumentedPorts();
    const bundle = createRecoveryReadToolRegistry(ports);
    const state = mixedState();
    const { priority, plan, verification } = planAndVerify(state, bundle.registry);
    expect(verification.ok).toBe(true); // Plan A 在篡改前是通过 verification 的

    const tampered: RecoveryPlan = {
      ...plan,
      actions: plan.actions.map((action) =>
        action.opportunityRef === 'opp-customs' && action.expectedRecovery !== null
          ? { ...action, expectedRecovery: { ...action.expectedRecovery, amount: action.expectedRecovery.amount + 1 } }
          : action,
      ),
    };
    // 旧 verification 快照仍然声称 Plan A 有效 —— 但入口不再接受它
    const staleVerification = verifyRecoveryPlan({
      plan,
      state,
      registry: bundle.registry,
      priority,
      nowMs: NOW_MS,
      maxSnapshotAgeMs: MAX_AGE_MS,
    });
    expect(staleVerification.ok).toBe(true);
    expect(RECOVERY_READ_TOOLS_BOUNDARY.acceptsExternalVerification).toBe(false);
    expect(RECOVERY_READ_TOOLS_BOUNDARY.verifyAtInvocationBoundary).toBe(true);

    const run = await runRecoveryReadTools({ state, plan: tampered, registry: bundle.registry, nowMs: NOW_MS });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.invocations.some((entry) => entry.opportunityRef === 'opp-customs')).toBe(false);
    expect(calls.some((entry) => entry.endsWith('opp-customs'))).toBe(false);
  });

  it('F2-05 actor.organizationId != input.organizationId → fail-closed / DB read count = 0（B2）', async () => {
    const harness = createFakePrisma();
    const ports = createPrismaRecoveryReadPorts(harness.prisma, { organizationId: 'org-other', role: 'OWNER' });
    const bundle = createRecoveryReadToolRegistry(ports);
    const state = mixedState();
    const { plan } = planAndVerify(state, bundle.registry);

    const run = await runRecoveryReadTools({ state, plan, registry: bundle.registry, nowMs: NOW_MS });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    expect(run.invocations.length).toBeGreaterThan(0);
    expect(run.invocations.every((entry) => !entry.ok)).toBe(true);
    expect(run.invocations.every((entry) => entry.reason === 'TOOL_THREW')).toBe(true);
    expect(run.invocations.every((entry) => (entry.detail ?? '').includes('TENANT_MISMATCH'))).toBe(true);
    expect(harness.readCalls).toEqual([]);
    expect(harness.writeCalls).toEqual([]);
  });

  it('F2-06 adapter 返回 output.opportunityRef != requested ref → OUTPUT_IDENTITY_REJECTED（B2）', async () => {
    const { ports } = instrumentedPorts({
      opportunityRead: async () => ({
        opportunityRef: 'opp-someone-else',
        status: 'QUALIFIED',
        currency: 'USD',
        hasRecoverableAmount: true,
        hasRuleEvaluation: true,
      }),
    });
    const bundle = createRecoveryReadToolRegistry(ports);
    const state = mixedState();
    const { plan } = planAndVerify(state, bundle.registry);

    const run = await runRecoveryReadTools({ state, plan, registry: bundle.registry, nowMs: NOW_MS });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('unreachable');
    const failed = run.invocations.filter((entry) => entry.tool === RECOVERY_READ_TOOL.OPPORTUNITY && !entry.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((entry) => (entry.detail ?? '').includes('OUTPUT_IDENTITY_REJECTED'))).toBe(true);
    expect(failed.every((entry) => entry.output === null)).toBe(true);
  });
});

interface FakePrismaHarness {
  prisma: PrismaClient;
  writeCalls: string[];
  readCalls: string[];
}

function createFakePrisma(): FakePrismaHarness {
  const writeCalls: string[] = [];
  const readCalls: string[] = [];
  const WRITE_VERBS = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'] as const;

  const model = (name: string, reads: Record<string, () => unknown>) => {
    const stub: Record<string, unknown> = {};
    for (const [verb, impl] of Object.entries(reads)) {
      stub[verb] = async (...args: unknown[]) => {
        readCalls.push(`${name}.${verb}`);
        return (impl as (arg?: unknown) => unknown)(args[0]);
      };
    }
    for (const verb of WRITE_VERBS) {
      stub[verb] = (..._args: unknown[]) => {
        writeCalls.push(`${name}.${verb}`);
        throw new Error(`WRITE_FORBIDDEN_IN_P2B:${name}.${verb}`);
      };
    }
    return stub;
  };

  const opportunityRow = {
    id: 'opp-real',
    title: 'entry overpayment',
    status: 'QUALIFIED',
    opportunityType: 'ENTRY',
    currency: 'USD',
    amountExpected: new Prisma.Decimal('1200.0000'),
    amountActual: new Prisma.Decimal('900.0000'),
    recoverableAmount: new Prisma.Decimal('300.0000'),
    evaluations: [],
  };
  const evidenceRow = {
    role: 'PRIMARY',
    addedAt: new Date(NOW),
    evidence: {
      id: 'ev-1',
      kind: 'INVOICE',
      title: 'commercial invoice',
      description: null,
      reliability: 'HIGH',
      capturedAt: new Date(NOW),
      fileAssetId: 'asset-1',
    },
  };

  const prisma = {
    // 回显请求的 id：模拟真实 opportunity 读取（tenant-scoped 命中同一条记录）
    recoveryOpportunity: model('recoveryOpportunity', {
      findFirst: (arg?: unknown) => {
        const id = (arg as { where?: { id?: string } } | undefined)?.where?.id;
        return { ...opportunityRow, id: typeof id === 'string' ? id : opportunityRow.id };
      },
    }),
    case: model('case', { findFirst: () => ({ id: 'case-1' }) }),
    caseEvidence: model('caseEvidence', { findMany: () => [evidenceRow] }),
    recoveryRoute: model('recoveryRoute', { findFirst: () => ({ target: 'CUSTOMS_BROKER' }) }),
    customsRightLineageFact: model('customsRightLineageFact', { findFirst: () => null }),
    $executeRaw: async (..._args: unknown[]) => {
      writeCalls.push('$executeRaw');
      throw new Error('WRITE_FORBIDDEN_IN_P2B:$executeRaw');
    },
    $transaction: async (..._args: unknown[]) => {
      writeCalls.push('$transaction');
      throw new Error('WRITE_FORBIDDEN_IN_P2B:$transaction');
    },
  } as unknown as PrismaClient;

  return { prisma, writeCalls, readCalls };
}
