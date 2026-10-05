/**
 * RSI 成本控制 E2E（OWNER：AI Model Invocation / Cost Control Layer）测试 A–F
 * 组合：cost policy + model router + provider adapter（本地仿真契约）+ ledger，不接触真实密钥
 *
 *   A 规则可解 → LLM calls = 0
 *   B 简单语义 → 只用低成本模型，不升级强模型
 *   C 复杂修复 → 低成本不足 → 升级强模型
 *   D 超预算 → COST_SAFE_MODE → 普通 AI 停止，规则引擎仍可跑
 *   E 同一 Incident 反复失败 → 达到上限 → 不再递归烧 token
 *   F 最坏费用超过剩余预算 → BUDGET_EXCEEDED，且 REJECTED 进台账
 */

import { describe, expect, it } from 'vitest';

import { createRsiCostLedger } from '../services/autonomy/rsi-cost-ledger';
import {
  createRsiModelRouter,
  type RsiModelInvocationRequest,
  type RsiModelProviderAdapter,
  type RsiProviderPricing,
} from '../services/autonomy/rsi-model-router';
import type { RsiCostUsage, RsiModelCallRecord, RsiModelCallRequest } from '../services/autonomy/rsi-cost-policy';

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

const E2E_PRICING: RsiProviderPricing = {
  inputUsdPerToken: 0.000_001,
  outputUsdPerToken: 0.000_001,
  maxInputTokens: 1_000,
};

const OVER_BUDGET_PRICING: RsiProviderPricing = {
  inputUsdPerToken: 0.000_001,
  outputUsdPerToken: 0.001,
  maxInputTokens: 1_000,
};

const adapter = (
  tier: 'LOW_COST' | 'STRONG',
  opts: { succeeded: boolean; cost: number; pricing?: RsiProviderPricing },
  counter: { n: number },
): RsiModelProviderAdapter => ({
  providerName: tier === 'LOW_COST' ? 'provider-lowcost' : 'provider-strong',
  tier,
  pricing: opts.pricing ?? E2E_PRICING,
  async invoke() {
    counter.n += 1;
    const base = { inputTokens: 120, outputTokens: 60, estimatedCost: opts.cost };
    return opts.succeeded
      ? {
          ok: true as const,
          modelId: tier === 'LOW_COST' ? 'lowcost-model' : 'strong-model',
          outputRef: 'sim:fedcba9876543210',
          outputDigest: 'b'.repeat(64),
          usage: base,
          latencyMs: 150,
        }
      : { ok: false as const, reason: 'PROVIDER_FAILED' as const, usage: base, latencyMs: 150 };
  },
});

const request = (
  taskType: string,
  capability: RsiModelCallRequest['requiredCapability'],
  over: Partial<{ promptDigest: string; maxOutputTokens: number; maxCost: number }> = {},
): RsiModelInvocationRequest => ({
  taskType,
  complexity: capability === 'COMPLEX_CODE_FIX' ? 'HIGH' : 'LOW',
  maxCost: 0.5,
  latencyRequirementMs: 5_000,
  requiredCapability: capability,
  incidentId: 'inc-e2e',
  taskId: 'task-e2e',
  promptRef: 'prompt:task-e2e',
  promptDigest: 'c'.repeat(64),
  maxOutputTokens: 200,
  timeoutMs: 5_000,
  ...over,
});

describe('RSI 成本控制 E2E', () => {
  it('COST_E2E_A_RULE_SOLVABLE_USES_ZERO_LLM_CALLS：规则可解 → 零模型调用', async () => {
    const low = { n: 0 };
    const strong = { n: 0 };
    const ledger = createRsiCostLedger();
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', { succeeded: true, cost: 0.001 }, low),
      strong: adapter('STRONG', { succeeded: true, cost: 0.05 }, strong),
      usage: () => usage(),
      onCall: (record) =>
        ledger.record({
          ...record,
          entryId: `call-${record.provider}-${record.model}`,
          at: new Date().toISOString(),
          level: record.provider === 'provider-lowcost' ? 'LEVEL_1_LOW_COST' : 'LEVEL_2_STRONG',
        }),
    });

    const outcome = await router.outcomeOf(request('CI_FAIL', 'NONE'));
    expect(outcome.called).toBe(false);
    expect(low.n + strong.n).toBe(0);
    ledger.recordRuleResolved({ entryId: 'rule-1', at: new Date().toISOString(), incidentId: 'inc-e2e' });
    const snapshot = ledger.snapshot();
    expect(snapshot.today.lowCostCalls).toBe(0);
    expect(snapshot.today.strongCalls).toBe(0);
    expect(snapshot.today.ruleResolved).toBe(1);
    expect(snapshot.today.cost).toBe(0);
  });

  it('COST_E2E_B_LOW_COST_ONLY_FOR_SIMPLE_SEMANTICS：简单语义只用低成本模型', async () => {
    const low = { n: 0 };
    const strong = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', { succeeded: true, cost: 0.001 }, low),
      strong: adapter('STRONG', { succeeded: true, cost: 0.05 }, strong),
      usage: () => usage(),
    });
    const outcome = await router.outcomeOf(request('SEMANTIC', 'SEMANTIC_UNDERSTANDING'));
    expect(outcome.record?.provider).toBe('provider-lowcost');
    expect(strong.n).toBe(0);
  });

  it('COST_E2E_C_ESCALATES_TO_STRONG_WHEN_LOW_COST_INSUFFICIENT：低成本不足才升级强模型', async () => {
    const low = { n: 0 };
    const strong = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', { succeeded: false, cost: 0.001 }, low),
      strong: adapter('STRONG', { succeeded: true, cost: 0.05 }, strong),
      usage: () => usage(),
    });
    const outcome = await router.outcomeOf(request('COMPLEX_FIX', 'COMPLEX_CODE_FIX'));
    expect(low.n).toBe(1);
    expect(strong.n).toBe(1);
    expect(outcome.escalatedToStrong).toBe(true);
    expect(outcome.record?.provider).toBe('provider-strong');
  });

  it('COST_E2E_D_DAILY_BUDGET_EXHAUSTED_BLOCKS_AI_BUT_KEEPS_RULES：超预算 → AI 停止，规则仍可跑', async () => {
    const low = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', { succeeded: true, cost: 0.001 }, low),
      usage: () => usage({ spentToday: 999 }),
    });

    const ai = await router.outcomeOf(request('SEMANTIC', 'SEMANTIC_UNDERSTANDING'));
    expect(ai.called).toBe(false);
    expect(ai.reason).toBe('COST_SAFE_MODE');
    expect(low.n).toBe(0);

    const rules = await router.outcomeOf(request('HEALTH_CHECK', 'NONE'));
    expect(rules.called).toBe(false);
    expect(rules.reason).toBe('RULE_ENGINE');
    expect(low.n).toBe(0);
  });

  it('COST_E2E_E_INCIDENT_BUDGET_EXHAUSTED_STOPS_RECURSION：同一 Incident 达上限后不再烧 token', async () => {
    const low = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', { succeeded: false, cost: 0.01 }, low),
      usage: () => usage({ incidentAttempts: 3 }),
    });
    const outcome = await router.outcomeOf(request('SEMANTIC', 'SEMANTIC_UNDERSTANDING'));
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('AUTONOMY_BUDGET_EXHAUSTED');
    expect(low.n).toBe(0);
  });

  it('COST_E2E_F_WORST_CASE_EXCEEDS_REMAINING_REJECTS_BEFORE_CALL：最坏费用超剩余 → 不调用且台账记 REJECTED', async () => {
    const low = { n: 0 };
    const ledger = createRsiCostLedger();
    const records: RsiModelCallRecord[] = [];
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', { succeeded: true, cost: 0.001, pricing: OVER_BUDGET_PRICING }, low),
      usage: () => usage({ spentThisMonth: 49.9 }),
      onCall: (record) => {
        records.push(record);
        ledger.record({
          ...record,
          entryId: `reject-${records.length}`,
          at: new Date().toISOString(),
          level: 'LEVEL_1_LOW_COST',
        });
      },
    });

    const outcome = await router.outcomeOf(request('SEMANTIC', 'SEMANTIC_UNDERSTANDING'));
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('BUDGET_EXCEEDED');
    expect(outcome.worstCaseCostUsd).toBeGreaterThan(outcome.remainingUsd ?? 0);
    expect(low.n).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.result).toBe('REJECTED');
    const snapshot = ledger.snapshot();
    expect(snapshot.today.cost).toBe(0);
    expect(snapshot.entries).toBe(1);
  });
});
