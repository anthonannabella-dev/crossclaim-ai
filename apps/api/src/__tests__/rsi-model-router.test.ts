/** RSI Model Router 适配层验收：规则零调用、低成本优先、预算拒绝不触 provider、记录脱敏。 */

import { describe, expect, it } from 'vitest';

import { RSI_MODEL_ROUTER_BOUNDARY, createRsiModelRouter, type RsiModelProviderAdapter } from '../services/autonomy/rsi-model-router';
import type { RsiCostUsage, RsiModelCallRecord } from '../services/autonomy/rsi-cost-policy';

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

const adapter = (tier: 'LOW_COST' | 'STRONG', succeeded: boolean, calls: { n: number }): RsiModelProviderAdapter => ({
  providerName: tier === 'LOW_COST' ? 'provider-lowcost' : 'provider-strong',
  tier,
  async invoke() {
    calls.n += 1;
    return {
      model: tier === 'LOW_COST' ? 'lowcost-model' : 'strong-model',
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: tier === 'LOW_COST' ? 0.001 : 0.05,
      latencyMs: 120,
      retryCount: 0,
      succeeded,
    };
  },
});

const request = (capability: 'NONE' | 'SEMANTIC_UNDERSTANDING' | 'COMPLEX_CODE_FIX') =>
  ({
    taskType: 'RUNTIME_ANOMALY',
    complexity: 'LOW' as const,
    maxCost: 0.05,
    latencyRequirementMs: 5_000,
    requiredCapability: capability,
    incidentId: 'inc-1',
    taskId: 'task-1',
  });

describe('RSI Model Router', () => {
  it('RSI_ROUTER_RULE_LEVEL_NEVER_CALLS_PROVIDER：规则等级不触发任何 provider 调用', async () => {
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

  it('RSI_ROUTER_LOW_COST_FIRST_THEN_ESCALATE：简单语义只用低成本；复杂问题才升级强模型', async () => {
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

    // 低成本失败 → 升级强模型
    const failing = createRsiModelRouter({
      lowCost: adapter('LOW_COST', false, { n: 0 }),
      strong: adapter('STRONG', true, strongCalls),
      usage: () => usage(),
    });
    const complex = await failing.outcomeOf({
      ...request('COMPLEX_CODE_FIX'),
      taskType: 'COMPLEX_FIX',
    });
    expect(complex.escalatedToStrong).toBe(true);
    expect(complex.record?.provider).toBe('provider-strong');
  });

  it('RSI_ROUTER_BUDGET_BLOCKS_WITHOUT_CALLING_PROVIDER：预算/熔断被拒时不触碰 provider', async () => {
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

  it('RSI_ROUTER_RECORDS_CALL_EVIDENCE：每次调用产出脱敏记录，且 Router 不持有凭据', async () => {
    const records: RsiModelCallRecord[] = [];
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, { n: 0 }),
      usage: () => usage(),
      onCall: (record) => records.push(record),
    });
    await router.outcomeOf(request('SEMANTIC_UNDERSTANDING'));

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({
      incidentId: 'inc-1',
      taskId: 'task-1',
      provider: 'provider-lowcost',
      model: 'lowcost-model',
      inputTokens: 100,
      outputTokens: 50,
      retryCount: 0,
    });
    const keys = Object.keys(record);
    for (const forbidden of ['apiKey', 'credential', 'secret', 'token']) expect(keys).not.toContain(forbidden);

    expect(RSI_MODEL_ROUTER_BOUNDARY.holdsProviderCredentials).toBe(false);
    expect(RSI_MODEL_ROUTER_BOUNDARY.readsEnvironmentSecrets).toBe(false);
  });
});
