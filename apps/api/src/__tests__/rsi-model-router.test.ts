/** RSI Model Router 契约验收：优先级 / 低成本优先 / 调用前预算熔断 / 记录证据 / 凭据隔离 */

import { describe, expect, it } from 'vitest';

import {
  RSI_MODEL_ROUTER_BOUNDARY,
  checkRsiCallBudget,
  createRsiModelRouter,
  estimateWorstCaseCost,
  type RsiModelInvocation,
  type RsiModelProviderAdapter,
  type RsiProviderPricing,
} from '../services/autonomy/rsi-model-router';
import type { RsiBudgetLimits, RsiCostUsage, RsiModelCallRecord } from '../services/autonomy/rsi-cost-policy';

const TEST_LIMITS: RsiBudgetLimits = {
  dailyBudget: 5,
  monthlyBudget: 50,
  maxCostPerIncident: 0.5,
  maxStrongModelCallsPerTask: 2,
  maxAttemptsPerIncident: 3,
  maxCandidatesPerIncident: 3,
  maxLlmCallsPerIncident: 6,
  maxTokensPerIncident: 200_000,
  maxWallClockMinutesPerIncident: 30,
};

const usage = (over: Partial<RsiCostUsage> = {}): RsiCostUsage => ({
  spentToday: 0,
  spentThisMonth: 0,
  incidentSpent: 0,
  incidentAttempts: 0,
  incidentCandidates: 0,
  incidentLlmCalls: 0,
  incidentTokens: 0,
  incidentElapsedMinutes: 0,
  strongCallsForTask: 0,
  ...over,
});

const PRICING: RsiProviderPricing = {
  inputUsdPerToken: 0.000_001,
  outputUsdPerToken: 0.000_001,
  maxInputTokens: 1_000,
};

const UNENFORCEABLE_PRICING: RsiProviderPricing = {
  inputUsdPerToken: 0.000_001,
  outputUsdPerToken: 0.001,
  maxInputTokens: 1_000,
};

const adapter = (
  tier: 'LOW_COST' | 'STRONG',
  succeeded: boolean,
  calls: { n: number },
  over: { pricing?: RsiProviderPricing | null; seen?: RsiModelInvocation[] } = {},
): RsiModelProviderAdapter => {
  const pricing = over.pricing === undefined ? PRICING : over.pricing;
  return {
    providerName: tier === 'LOW_COST' ? 'provider-lowcost' : 'provider-strong',
    tier,
    ...(pricing === null ? {} : { pricing }),
    async invoke(invocation) {
      calls.n += 1;
      over.seen?.push(invocation);
      const base = {
        inputTokens: 100,
        outputTokens: 50,
        estimatedCost: tier === 'LOW_COST' ? 0.001 : 0.05,
      };
      return succeeded
        ? {
            ok: true as const,
            modelId: tier === 'LOW_COST' ? 'lowcost-model' : 'strong-model',
            outputRef: 'sim:0123456789abcdef',
            outputDigest: 'a'.repeat(64),
            usage: base,
            latencyMs: 120,
          }
        : { ok: false as const, reason: 'PROVIDER_FAILED' as const, usage: base, latencyMs: 120 };
    },
  };
};

const request = (
  capability: 'NONE' | 'SEMANTIC_UNDERSTANDING' | 'COMPLEX_CODE_FIX',
  over: Partial<{ maxCost: number; promptRef: string; promptDigest: string; maxOutputTokens: number; timeoutMs: number }> = {},
) => ({
  taskType: 'RUNTIME_ANOMALY',
  complexity: 'LOW' as const,
  maxCost: 0.05,
  latencyRequirementMs: 5_000,
  requiredCapability: capability,
  incidentId: 'inc-1',
  taskId: 'task-1',
  // C1：确定性证据（caller 能力声明不构成模型调用权）
  necessity:
    capability === 'NONE'
      ? { outcome: 'RULE_SOLVABLE' as const, ruleVersion: 'rule/v1', schemaVersion: 'schema/v1', inputDigest: 'a'.repeat(64) }
      : { outcome: 'SEMANTIC_REQUIRED' as const, ruleVersion: 'rule/v1', schemaVersion: 'schema/v1', inputDigest: 'b'.repeat(64) },
  promptRef: 'prompt:task-1',
  promptDigest: 'f'.repeat(64),
  maxOutputTokens: 200,
  timeoutMs: 5_000,
  ...over,
});

describe('RSI Model Router', () => {
  it('RSI_ROUTER_RULE_LEVEL_NEVER_CALLS_PROVIDER：规则级信号不产生任何 provider 调用', async () => {
    const lowCalls = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, lowCalls),
      usage: () => usage(),
    });
    const outcome = await router.outcomeOf(request('NONE'));
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('RULE_ENGINE');
    expect(lowCalls.n).toBe(0);
  });

  it('RSI_ROUTER_LOW_COST_FIRST_THEN_ESCALATE：简单语义只用低成本，失败后才升级强模型', async () => {
    const lowCalls = { n: 0 };
    const strongCalls = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, lowCalls),
      strong: adapter('STRONG', true, strongCalls),
      usage: () => usage(),
    });

    const simple = await router.outcomeOf(request('SEMANTIC_UNDERSTANDING'));
    expect(simple.record?.provider).toBe('provider-lowcost');
    expect(strongCalls.n).toBe(0);

    const failing = createRsiModelRouter({
      lowCost: adapter('LOW_COST', false, { n: 0 }),
      strong: adapter('STRONG', true, strongCalls),
      usage: () => usage(),
    });
    // C1：strong 只能经有界升级合同（LOW_COST 先跑并失败 → quality FAIL → 一次受控升级）
    const complexRequest = { ...request('COMPLEX_CODE_FIX'), taskType: 'COMPLEX_FIX' };
    const cheap = await failing.outcomeOf(complexRequest);
    expect(cheap.called).toBe(true);
    expect(cheap.record?.provider).toBe('provider-lowcost');
    const complex = await failing.outcomeOf({
      ...complexRequest,
      escalation: { quality: 'FAIL' as const, state: { attempts: 1, escalations: 0 } },
    });
    expect(complex.escalatedToStrong).toBe(true);
    expect(complex.record?.provider).toBe('provider-strong');
  });

  it('RSI_ROUTER_BUDGET_BLOCKS_WITHOUT_CALLING_PROVIDER：预算/熔断拒绝时不调用 provider', async () => {
    const lowCalls = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, lowCalls),
      usage: () => usage({ spentToday: 999 }),
    });
    const outcome = await router.outcomeOf(request('SEMANTIC_UNDERSTANDING'));
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('COST_SAFE_MODE');
    expect(lowCalls.n).toBe(0);
  });

  it('RSI_ROUTER_WORST_CASE_GUARD：最坏费用超过剩余预算 → BUDGET_EXCEEDED 且不调用', async () => {
    const lowCalls = { n: 0 };
    const records: RsiModelCallRecord[] = [];
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, lowCalls, { pricing: UNENFORCEABLE_PRICING }),
      usage: () => usage(),
      onCall: (record) => records.push(record),
    });
    const outcome = await router.outcomeOf(request('SEMANTIC_UNDERSTANDING'));
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('BUDGET_EXCEEDED');
    expect(outcome.worstCaseCostUsd).toBeGreaterThan(0.05);
    expect(lowCalls.n).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.result).toBe('REJECTED');
    expect(records[0]?.estimatedCost).toBe(0);
  });

  it('RSI_ROUTER_UNENFORCEABLE_BUDGET_FAILS_CLOSED：无法证明最坏费用 → BUDGET_GUARD_UNENFORCEABLE', async () => {
    const lowCalls = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, lowCalls, { pricing: null }),
      usage: () => usage(),
    });
    const outcome = await router.outcomeOf(request('SEMANTIC_UNDERSTANDING'));
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('BUDGET_GUARD_UNENFORCEABLE');
    expect(outcome.record?.result).toBe('REJECTED');
    expect(lowCalls.n).toBe(0);
    expect(estimateWorstCaseCost(adapter('LOW_COST', true, { n: 0 }, { pricing: null }), 200)).toBeNull();
  });

  it('RSI_ROUTER_INVOCATION_FIELDS_REQUIRED：缺 promptDigest 等必填字段 → 不调用 adapter', async () => {
    const lowCalls = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, lowCalls),
      usage: () => usage(),
    });
    const missing = { ...request('SEMANTIC_UNDERSTANDING'), promptDigest: '' };
    const outcome = await router.outcomeOf(missing);
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('INVOCATION_INVALID');
    expect(outcome.record?.result).toBe('REJECTED');
    expect(lowCalls.n).toBe(0);
    await expect(router.route(missing)).rejects.toThrow('MODEL_CALL_REJECTED:INVOCATION_INVALID');
  });

  it('RSI_ROUTER_INVOCATION_CONTRACT：adapter 收到显式 timeoutMs / maxOutputTokens / budget / promptDigest', async () => {
    const seen: RsiModelInvocation[] = [];
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, { n: 0 }, { seen }),
      usage: () => usage(),
    });
    const outcome = await router.outcomeOf(request('SEMANTIC_UNDERSTANDING'));
    expect(outcome.called).toBe(true);
    expect(seen).toHaveLength(1);
    const invocation = seen[0]!;
    expect(invocation.taskKind).toBe('RUNTIME_ANOMALY');
    expect(invocation.promptRef).toBe('prompt:task-1');
    expect(invocation.promptDigest).toBe('f'.repeat(64));
    expect(invocation.tier).toBe('LOW_COST');
    expect(invocation.timeoutMs).toBe(5_000);
    expect(invocation.maxOutputTokens).toBe(200);
    expect(invocation.budget.maxUsdThisCall).toBe(0.05);
    expect(invocation.budget.remainingUsd).toBe(0.05);
    expect(invocation.callId).not.toBe('');

    const routed = await router.route(request('SEMANTIC_UNDERSTANDING'));
    expect(routed.provider).toBe('provider-lowcost');
    expect(routed.retryCount).toBe(0);
  });

  it('RSI_ROUTER_RECORDS_CALL_EVIDENCE：成功与失败用量都进记录，且不含任何凭据字段', async () => {
    const records: RsiModelCallRecord[] = [];
    const ok = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, { n: 0 }),
      usage: () => usage(),
      onCall: (record) => records.push(record),
    });
    await ok.outcomeOf(request('SEMANTIC_UNDERSTANDING'));

    const failing = createRsiModelRouter({
      lowCost: adapter('LOW_COST', false, { n: 0 }),
      usage: () => usage(),
      onCall: (record) => records.push(record),
    });
    await failing.outcomeOf(request('SEMANTIC_UNDERSTANDING'));

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      incidentId: 'inc-1',
      taskId: 'task-1',
      provider: 'provider-lowcost',
      model: 'lowcost-model',
      inputTokens: 100,
      outputTokens: 50,
      result: 'SUCCESS',
      retryCount: 0,
    });
    expect(records[1]?.result).toBe('FAILED');
    expect(records[1]?.estimatedCost).toBe(0.001);
    for (const record of records) {
      const keys = Object.keys(record);
      for (const forbidden of ['apiKey', 'credential', 'secret', 'token']) expect(keys).not.toContain(forbidden);
    }

    expect(RSI_MODEL_ROUTER_BOUNDARY.holdsProviderCredentials).toBe(false);
    expect(RSI_MODEL_ROUTER_BOUNDARY.readsEnvironmentSecrets).toBe(false);
    expect(RSI_MODEL_ROUTER_BOUNDARY.budgetGuardBeforeCall).toBe(true);
    expect(RSI_MODEL_ROUTER_BOUNDARY.adapterInternalRetry).toBe(false);
    expect(RSI_MODEL_ROUTER_BOUNDARY.realProviderNetwork).toBe('HOLD');
    expect(RSI_MODEL_ROUTER_BOUNDARY.paidModelCalls).toBe('HOLD');
  });

  it('RSI_ROUTER_BUDGET_GUARD_UNIT：checkRsiCallBudget 逐项证明 日/月/incident/本次上限', () => {
    const target = adapter('LOW_COST', true, { n: 0 });
    expect(estimateWorstCaseCost(target, 200)).toBeCloseTo(0.0012, 6);
    expect(
      checkRsiCallBudget({ adapter: target, maxOutputTokens: 200, maxCostThisCall: 0.05, usage: usage(), limits: TEST_LIMITS }).ok,
    ).toBe(true);
    expect(
      checkRsiCallBudget({
        adapter: target,
        maxOutputTokens: 200,
        maxCostThisCall: 0.05,
        usage: usage({ spentToday: 4.999 }),
        limits: TEST_LIMITS,
      }).ok,
    ).toBe(false);
    expect(
      checkRsiCallBudget({
        adapter: target,
        maxOutputTokens: 200,
        maxCostThisCall: 0.05,
        usage: usage({ incidentSpent: 0.499 }),
        limits: TEST_LIMITS,
      }).reason,
    ).toBe('BUDGET_EXCEEDED');
    expect(
      checkRsiCallBudget({
        adapter: target,
        maxOutputTokens: 200,
        maxCostThisCall: 0.05,
        usage: usage({ spentThisMonth: 49.999 }),
        limits: TEST_LIMITS,
      }).reason,
    ).toBe('BUDGET_EXCEEDED');
  });
});
