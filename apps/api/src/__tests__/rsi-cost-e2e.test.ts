/**
 * RSI 成本控制 E2E（Test A–E，OWNER《AI Model Invocation / Cost Control Layer》第 9 节）
 * 组合：cost policy + model router（假 provider）+ ledger。无需真实密钥。
 *
 *   A 规则可解 → LLM calls = 0
 *   B 简单语义 → 只用低成本模型，不升级强模型
 *   C 复杂问题 → 低成本不足 → 升级强模型
 *   D 超日预算 → COST_SAFE_MODE → 普通 AI 停止，规则引擎继续
 *   E 同一 Incident 连续失败 → 达上限 → 不再递归烧 token
 */

import { describe, expect, it } from 'vitest';

import { createRsiCostLedger } from '../services/autonomy/rsi-cost-ledger';
import { createRsiModelRouter, type RsiModelProviderAdapter } from '../services/autonomy/rsi-model-router';
import type { RsiCostUsage, RsiModelCallRequest } from '../services/autonomy/rsi-cost-policy';

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

const adapter = (
  tier: 'LOW_COST' | 'STRONG',
  opts: { succeeded: boolean; cost: number },
  counter: { n: number },
): RsiModelProviderAdapter => ({
  providerName: tier === 'LOW_COST' ? 'provider-lowcost' : 'provider-strong',
  tier,
  async invoke() {
    counter.n += 1;
    return {
      model: tier === 'LOW_COST' ? 'lowcost-model' : 'strong-model',
      inputTokens: 120,
      outputTokens: 60,
      estimatedCost: opts.cost,
      latencyMs: 150,
      retryCount: 0,
      succeeded: opts.succeeded,
    };
  },
});

const request = (taskType: string, capability: RsiModelCallRequest['requiredCapability']): RsiModelCallRequest => ({
  taskType,
  complexity: capability === 'COMPLEX_CODE_FIX' ? 'HIGH' : 'LOW',
  maxCost: 0.5,
  latencyRequirementMs: 5_000,
  requiredCapability: capability,
  incidentId: 'inc-e2e',
  taskId: 'task-e2e',
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
      onCall: (record) => ledger.record({ ...record, entryId: `call-${record.model}`, at: new Date().toISOString(), level: 'LEVEL_1_LOW_COST' }),
    });

    // 规则可解信号（CI_FAIL 等）不声明 AI 能力
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

  it('COST_E2E_C_ESCALATES_TO_STRONG_WHEN_LOW_COST_INSUFFICIENT：复杂问题升级强模型', async () => {
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

  it('COST_E2E_D_DAILY_BUDGET_EXHAUSTED_BLOCKS_AI_BUT_KEEPS_RULES：超日预算 → 普通 AI 停、规则继续', async () => {
    const low = { n: 0 };
    const exhausted = usage({ spentToday: 999 });
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', { succeeded: true, cost: 0.001 }, low),
      usage: () => exhausted,
    });

    const ai = await router.outcomeOf(request('SEMANTIC', 'SEMANTIC_UNDERSTANDING'));
    expect(ai.called).toBe(false);
    expect(ai.reason).toBe('COST_SAFE_MODE');
    expect(low.n).toBe(0);

    // 规则引擎 / 健康检查在 COST_SAFE_MODE 下继续
    const rules = await router.outcomeOf(request('HEALTH_CHECK', 'NONE'));
    expect(rules.called).toBe(false);
    expect(rules.reason).toBe('RULE_ENGINE');
    expect(low.n).toBe(0);
  });

  it('COST_E2E_E_INCIDENT_BUDGET_EXHAUSTED_STOPS_RECURSION：同一 Incident 达上限后不再调用模型', async () => {
    const low = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', { succeeded: false, cost: 0.01 }, low),
      usage: () => usage({ incidentAttempts: 3 }), // 达到 maxAttemptsPerIncident
    });
    const outcome = await router.outcomeOf(request('SEMANTIC', 'SEMANTIC_UNDERSTANDING'));
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('AUTONOMY_BUDGET_EXHAUSTED');
    expect(low.n).toBe(0); // 不再递归烧 token
  });
});
