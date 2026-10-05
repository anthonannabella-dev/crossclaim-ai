/**
 * SI-COST-OPTIMIZATION C3 —— 验收（MSG-20261005-37：C3 IMPLEMENTATION = AUTHORIZED）
 * 覆盖：Cost Safe Mode / business-value cost policy / cache runtime wiring / 并发槽拒绝路径。
 * 纯单元（零外部 IO）；真实 PostgreSQL 取证见 si-cost-c3-db.test.ts。
 */

import { describe, expect, it } from 'vitest';

import {
  AI_COST_SAFE_MODE_BOUNDARY,
  decideAiCostSafeModeAdmission,
  evaluateAiCostSafeMode,
} from '../services/autonomy/si-cost-safe-mode';
import {
  AI_BUSINESS_VALUE_BOUNDARY,
  AI_BUSINESS_VALUE_HARD_CAPS,
  AI_VALUE_METRIC_NOT_YET_MEASURABLE,
  assertAiBusinessValueTierAllowed,
  computeAiCostRatioMetrics,
  decideAiBusinessValueTier,
  type AiTrustedRecoveryBasis,
} from '../services/autonomy/si-ai-business-value-policy';
import { AI_MODEL_CACHE_RUNTIME_BOUNDARY } from '../services/autonomy/si-model-cache-runtime';
import {
  createRsiModelRouter,
  type RsiModelCachePort,
  type RsiModelInvocationRequest,
  type RsiModelProviderAdapter,
} from '../services/autonomy/rsi-model-router';
import type { AiDeterministicEvidence } from '../services/autonomy/rsi-ai-necessity-gate';
import type { RsiCostUsage, RsiModelCallRecord } from '../services/autonomy/rsi-cost-policy';
import {
  createRsiLocalSimModelProviderComposition,
  RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY,
} from '../services/autonomy/rsi-model-provider-composition';

const evidence = (outcome: AiDeterministicEvidence['outcome']): AiDeterministicEvidence => ({
  outcome,
  ruleVersion: 'rule/v1',
  schemaVersion: 'schema/v1',
  inputDigest: 'a'.repeat(64),
});

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

const cacheScope = (over: Partial<{ organizationId: string | null }> = {}) => ({
  taskType: 'SEMANTIC',
  promptDigest: 'b'.repeat(64),
  inputDigest: 'c'.repeat(64),
  ruleVersion: 'rule/v1',
  schemaVersion: 'schema/v1',
  capabilityTier: 'LOW_COST',
  organizationId: 'org-c3' as string | null,
  ...over,
});

const adapter = (
  tier: 'LOW_COST' | 'STRONG',
  succeeded: boolean,
  counter: { n: number },
): RsiModelProviderAdapter => ({
  providerName: tier === 'LOW_COST' ? 'provider-lowcost' : 'provider-strong',
  tier,
  pricing: { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000002, maxInputTokens: 1_000 },
  async invoke() {
    counter.n += 1;
    const base = { inputTokens: 100, outputTokens: 20, estimatedCost: tier === 'LOW_COST' ? 0.001 : 0.05 };
    return succeeded
      ? {
          ok: true as const,
          modelId: tier === 'LOW_COST' ? 'lowcost-model' : 'strong-model',
          outputRef: 'sim:x',
          outputDigest: 'd'.repeat(64),
          usage: base,
          latencyMs: 100,
        }
      : { ok: false as const, reason: 'PROVIDER_FAILED' as const, usage: base, latencyMs: 100 };
  },
});

const request = (over: Partial<RsiModelInvocationRequest> = {}): RsiModelInvocationRequest => ({
  taskType: 'SEMANTIC',
  complexity: 'LOW',
  maxCost: 0.5,
  latencyRequirementMs: 5_000,
  requiredCapability: 'SEMANTIC_UNDERSTANDING',
  incidentId: 'inc-c3',
  taskId: 'task-c3',
  promptRef: 'prompt:task-c3',
  promptDigest: 'c'.repeat(64),
  maxOutputTokens: 256,
  timeoutMs: 5_000,
  necessity: evidence('AMBIGUOUS'),
  ...over,
});

describe('C3 · Cost Safe Mode（只停 STANDARD_AI；豁免通道不受影响；无重试风暴）', () => {
  it('C3_SM1 预算内 → NORMAL，STANDARD_AI 放行', () => {
    const verdict = evaluateAiCostSafeMode({
      budget: { dailyLimitMicros: 1_000_000, monthlyLimitMicros: 10_000_000 },
      usage: { dayMicros: 10, monthMicros: 100, incidentMicros: 0, dayTokens: 5, dayStrongCalls: 0 },
    });
    expect(verdict.state).toBe('NORMAL');
    expect(verdict.standardAiAllowed).toBe(true);
    expect(decideAiCostSafeModeAdmission({ verdict, channel: 'STANDARD_AI' }).allowed).toBe(true);
  });

  it('C3_SM2 日预算触顶 → COST_SAFE，STANDARD_AI 拒绝且 retryAllowed=false', () => {
    const verdict = evaluateAiCostSafeMode({
      budget: { dailyLimitMicros: 1_000 },
      usage: { dayMicros: 1_000, monthMicros: 1_000, incidentMicros: 0, dayTokens: 0, dayStrongCalls: 0 },
    });
    expect(verdict.state).toBe('COST_SAFE');
    expect(verdict.exhaustedDimensions).toContain('DAILY');
    const admission = decideAiCostSafeModeAdmission({ verdict, channel: 'STANDARD_AI' });
    expect(admission.allowed).toBe(false);
    expect(admission.reason).toContain('AI_COST_SAFE_MODE');
    expect(admission.retryAllowed).toBe(false);
    expect(verdict.retryAllowed).toBe(false);
  });

  it('C3_SM3 SAFE MODE 下 LEVEL_0_RULE / HEALTH_CHECK / CRITICAL_ALERT 仍放行', () => {
    const verdict = evaluateAiCostSafeMode({
      budget: { monthlyLimitMicros: 10 },
      usage: { dayMicros: 0, monthMicros: 10, incidentMicros: 0, dayTokens: 0, dayStrongCalls: 0 },
    });
    expect(verdict.state).toBe('COST_SAFE');
    for (const channel of ['LEVEL_0_RULE', 'HEALTH_CHECK', 'CRITICAL_ALERT'] as const) {
      const admission = decideAiCostSafeModeAdmission({ verdict, channel });
      expect(admission.allowed).toBe(true);
      expect(admission.reason).toContain('EXEMPT');
    }
    expect(AI_COST_SAFE_MODE_BOUNDARY.level0RuleAffected).toBe(false);
    expect(AI_COST_SAFE_MODE_BOUNDARY.healthCheckAffected).toBe(false);
    expect(AI_COST_SAFE_MODE_BOUNDARY.criticalAlertAffected).toBe(false);
    expect(AI_COST_SAFE_MODE_BOUNDARY.retryStormAllowed).toBe(false);
  });

  it('C3_SM4 非法输入（负数 / 非整数）→ fail-closed（抛错，不据此放行）', () => {
    expect(() =>
      evaluateAiCostSafeMode({
        budget: { dailyLimitMicros: 1 },
        usage: { dayMicros: -1, monthMicros: 0, incidentMicros: 0, dayTokens: 0, dayStrongCalls: 0 },
      }),
    ).toThrow(/AI_COST_SAFE_MODE_USAGE_INVALID/);
    expect(() =>
      evaluateAiCostSafeMode({
        budget: { dailyLimitMicros: 1.5 },
        usage: { dayMicros: 0, monthMicros: 0, incidentMicros: 0, dayTokens: 0, dayStrongCalls: 0 },
      }),
    ).toThrow(/AI_COST_SAFE_MODE_BUDGET_INVALID/);
  });

  it('C3_SM5 token / strong-call 维度同样触发 SAFE MODE', () => {
    const token = evaluateAiCostSafeMode({
      budget: { tokenLimit: 100 },
      usage: { dayMicros: 0, monthMicros: 0, incidentMicros: 0, dayTokens: 100, dayStrongCalls: 0 },
    });
    expect(token.state).toBe('COST_SAFE');
    expect(token.exhaustedDimensions).toContain('TOKEN');
    const strong = evaluateAiCostSafeMode({
      budget: { strongCallLimit: 1 },
      usage: { dayMicros: 0, monthMicros: 0, incidentMicros: 0, dayTokens: 0, dayStrongCalls: 1 },
    });
    expect(strong.exhaustedDimensions).toContain('STRONG_CALL');
  });
});

describe('C3 · Business-value cost policy（价值只来自可信 basis；caller 不得放大）', () => {
  it('C3_BV1 无可信 basis → UNKNOWN，strong 禁止（fail-closed）', () => {
    const decision = decideAiBusinessValueTier({ basis: null, taskType: 'SEMANTIC', requestedTier: 'STRONG' });
    expect(decision.valueBand).toBe('UNKNOWN');
    expect(decision.strongAllowed).toBe(false);
    expect(decision.maxTier).toBe('LOW_COST');
    expect(decision.allowed).toBe(true);
    expect(assertAiBusinessValueTierAllowed({ decision, requestedTier: 'STRONG' }).allowed).toBe(false);
  });

  it('C3_BV2 高价值（>= $1000）**且** canonical eligible risk → 允许 STRONG；低价值 → 仅 LOW_COST', () => {
    const high = decideAiBusinessValueTier({
      basis: { basisRef: 'recovery-basis:1', estimatedRecoveryValueMicros: 2_000_000_000, riskClass: 'LOW' },
      taskType: 'SEMANTIC',
      requestedTier: 'STRONG',
    });
    expect(high.valueBand).toBe('HIGH');
    expect(high.riskEligible).toBe(true);
    expect(high.strongAllowed).toBe(true);
    expect(assertAiBusinessValueTierAllowed({ decision: high, requestedTier: 'STRONG' }).allowed).toBe(true);

    const low = decideAiBusinessValueTier({
      basis: { basisRef: 'recovery-basis:2', estimatedRecoveryValueMicros: 1_000_000 },
      taskType: 'SEMANTIC',
      requestedTier: 'STRONG',
    });
    expect(low.valueBand).toBe('LOW');
    expect(low.strongAllowed).toBe(false);
  });

  it('C3_BV2b 高价值但风险不可接受 / 未知 → 只允许 LOW_COST（CHANGE A）', () => {
    for (const riskClass of ['HIGH', null, undefined] as const) {
      const decision = decideAiBusinessValueTier({
        basis: { basisRef: 'recovery-basis:risk', estimatedRecoveryValueMicros: 5_000_000_000, riskClass },
        taskType: 'SEMANTIC',
        requestedTier: 'STRONG',
      });
      expect(decision.valueBand).toBe('HIGH');
      expect(decision.riskEligible).toBe(false);
      expect(decision.strongAllowed).toBe(false);
      expect(decision.maxTier).toBe('LOW_COST');
      expect(assertAiBusinessValueTierAllowed({ decision, requestedTier: 'STRONG' }).allowed).toBe(false);
    }
    expect(AI_BUSINESS_VALUE_HARD_CAPS.strongRequiresHighValueAndEligibleRisk).toBe(true);
    expect(AI_BUSINESS_VALUE_HARD_CAPS.unknownRiskMayUseStrong).toBe(false);
  });

  it('C3_BV3 caller 自报价值一律忽略（不得据此获得 strong）', () => {
    const decision = decideAiBusinessValueTier({
      basis: null,
      taskType: 'SEMANTIC',
      requestedTier: 'STRONG',
      callerClaimedValueMicros: 9_000_000_000,
    });
    expect(decision.callerValueIgnored).toBe(true);
    expect(decision.valueBand).toBe('UNKNOWN');
    expect(decision.strongAllowed).toBe(false);
    expect(decision.effectiveRecoveryValueMicros).toBeNull();
    expect(AI_BUSINESS_VALUE_BOUNDARY.callerReportedValue).toContain('FORBIDDEN');
    expect(AI_BUSINESS_VALUE_BOUNDARY.hostMayRaiseThresholds).toBe(false);
  });

  it('C3_BV4 坏 basis（空引用 / 负价值 / 非整数）→ UNKNOWN fail-closed', () => {
    for (const basis of [
      { basisRef: '   ', estimatedRecoveryValueMicros: 1_000_000 },
      { basisRef: 'recovery-basis:3', estimatedRecoveryValueMicros: -1 },
      { basisRef: 'recovery-basis:4', estimatedRecoveryValueMicros: 1.5 },
    ]) {
      const decision = decideAiBusinessValueTier({ basis, taskType: 'SEMANTIC', requestedTier: 'LOW_COST' });
      expect(decision.valueBand).toBe('UNKNOWN');
      expect(decision.strongAllowed).toBe(false);
      expect(decision.basisTrusted).toBe(false);
    }
  });

  it('C3_BV5 业务价值比：缺可信分母 → NOT_YET_MEASURABLE（禁止伪造）', () => {
    const na = computeAiCostRatioMetrics({
      aiCostMicros: 5_000,
      denominators: { opportunities: null, cases: null, successfulRecoveries: null, recoveredMicros: null },
    });
    expect(na.AI_COST_PER_OPPORTUNITY).toBe(AI_VALUE_METRIC_NOT_YET_MEASURABLE);
    expect(na.AI_COST_PER_1000_RECOVERED).toBe(AI_VALUE_METRIC_NOT_YET_MEASURABLE);
    const real = computeAiCostRatioMetrics({
      aiCostMicros: 1_000_000,
      denominators: { opportunities: 10, cases: 5, successfulRecoveries: 2, recoveredMicros: 500_000_000 },
    });
    expect(real.AI_COST_PER_OPPORTUNITY).toBe(100_000);
    expect(real.AI_COST_PER_SUCCESSFUL_RECOVERY).toBe(500_000);
    expect(real.MODEL_COST_TO_RECOVERY_VALUE_RATIO).toBe(0.002);
  });
});

describe('C3 · Model Router 运行时接线（cache / safe mode / business value / 并发槽）', () => {
  it('C3_R1 cache HIT → MODEL_CALL = SKIPPED（零 provider 调用、无 provider ledger entry）', async () => {
    const provider = { n: 0 };
    const records: RsiModelCallRecord[] = [];
    const savings: Array<{ savedTokens: number | null }> = [];
    const cache: RsiModelCachePort = {
      async lookup() {
        return {
          hit: true,
          reason: 'HIT',
          resultDigest: 'e'.repeat(64),
          savedTokens: null,
          savedCostMicros: null,
          savingsSource: 'NOT_YET_MEASURABLE',
        };
      },
    };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, provider),
      usage: () => usage(),
      onCall: (r) => records.push(r),
      cache,
      onCacheSavings: (s) => savings.push({ savedTokens: s.savedTokens }),
    });
    const outcome = await router.outcomeOf(request({ cacheScope: cacheScope() }));
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('MODEL_CALL_SKIPPED_CACHE_HIT');
    expect(outcome.cacheHit).toBe(true);
    expect(outcome.savingsSource).toBe('NOT_YET_MEASURABLE');
    expect(provider.n).toBe(0);
    expect(records).toHaveLength(0);
    expect(savings).toHaveLength(1);
    expect(AI_MODEL_CACHE_RUNTIME_BOUNDARY.fakeProviderLedgerEntryOnHit).toBe('FORBIDDEN');
  });

  it('C3_R2 cache MISS → 正常 Necessity / model 路径（provider 调用 1 次）', async () => {
    const provider = { n: 0 };
    const cache: RsiModelCachePort = {
      async lookup() {
        return { hit: false, reason: 'MISS_ABSENT' };
      },
    };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, provider),
      usage: () => usage(),
      cache,
    });
    const outcome = await router.outcomeOf(request({ cacheScope: cacheScope() }));
    expect(outcome.called).toBe(true);
    expect(provider.n).toBe(1);
  });

  it('C3_R3 cache identity 非法（tenant 缺失）→ fail-closed，不降级为 miss 放行 provider', async () => {
    const provider = { n: 0 };
    const cache: RsiModelCachePort = {
      async lookup() {
        throw new Error('AI_MODEL_CACHE_TENANT_REQUIRED');
      },
    };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, provider),
      usage: () => usage(),
      cache,
    });
    const outcome = await router.outcomeOf(request({ cacheScope: cacheScope({ organizationId: null }) }));
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toContain('AI_MODEL_CACHE_LOOKUP_FAIL_CLOSED');
    expect(provider.n).toBe(0);
  });

  it('C3_R4 COST_SAFE → STANDARD_AI 拒绝，provider 0 次', async () => {
    const provider = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, provider),
      usage: () => usage(),
      costSafeMode: () => ({ standardAiAllowed: false, state: 'COST_SAFE', reason: 'AI_COST_SAFE_MODE:DAILY' }),
    });
    const outcome = await router.outcomeOf(request());
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('AI_COST_SAFE_MODE:DAILY');
    expect(provider.n).toBe(0);
  });

  it('C3_R5 business-value 拒绝 → provider 0 次（caller 无法放宽）', async () => {
    const provider = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, provider),
      usage: () => usage(),
      businessValue: () => ({ allowed: false, maxTier: 'LOW_COST', reason: 'AI_BUSINESS_VALUE_TIER_DENIED:UNKNOWN' }),
    });
    const outcome = await router.outcomeOf(request());
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toContain('AI_BUSINESS_VALUE_TIER_DENIED');
    expect(provider.n).toBe(0);
  });

  it('C3_R6 并发槽拒绝 → 零 provider 调用且不消耗 attempt（无重试风暴）', async () => {
    const provider = { n: 0 };
    let reject = true;
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, provider),
      usage: () => usage(),
      concurrency: async (run) =>
        reject ? { ok: false as const, reason: 'AI_BUDGET_CONCURRENCY_EXCEEDED' } : { ok: true as const, value: await run() },
    });
    const rejected = await router.outcomeOf(request());
    expect(rejected.called).toBe(false);
    expect(rejected.reason).toBe('AI_BUDGET_CONCURRENCY_EXCEEDED');
    expect(provider.n).toBe(0);
    // 拒绝不计 attempt：放开槽位后同一 task 仍可正常执行一次
    reject = false;
    const allowed = await router.outcomeOf(request());
    expect(allowed.called).toBe(true);
    expect(provider.n).toBe(1);
  });
});

describe('C3 · 组合根接线（SI 成本控制内部链路 + local sim adapter）', () => {
  it('C3_W1 组合根可注入 cache：HIT 跳过模型调用且不产生 provider 台账记录', async () => {
    const composition = createRsiLocalSimModelProviderComposition({
      usage: () => usage(),
      includeStrongAdapter: false,
      resolvePrompt: () => 'local-sim-prompt',
      cache: {
        async lookup() {
          return {
            hit: true,
            reason: 'HIT',
            resultDigest: 'e'.repeat(64),
            savedTokens: null,
            savedCostMicros: null,
            savingsSource: 'NOT_YET_MEASURABLE',
          };
        },
      },
    });
    const outcome = await composition.router.outcomeOf(request({ cacheScope: cacheScope() }));
    expect(outcome.reason).toBe('MODEL_CALL_SKIPPED_CACHE_HIT');
    expect(composition.ledgerEntries()).toBe(0);
    expect(composition.cacheHits()).toBe(1);
    expect(RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY.cacheHitCreatesProviderLedgerEntry).toBe(false);
    expect(RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY.realProviderNetwork).toBe('HOLD');
    expect(RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY.paidModelCalls).toBe('HOLD');
  });

  it('C3_W2 组合根缺省行为不变（无 cache 端口 → 正常 provider 调用并记录台账）', async () => {
    const composition = createRsiLocalSimModelProviderComposition({
      usage: () => usage(),
      resolvePrompt: () => 'local-sim-prompt',
    });
    const outcome = await composition.router.outcomeOf(request());
    expect(outcome.called).toBe(true);
    expect(composition.ledgerEntries()).toBe(1);
    expect(composition.cacheHits()).toBe(0);
  });
});

describe('C3 FINAL-2 · CHANGE A —— STRONG 升级必须再过一道 business-value gate', () => {
  const valuePort =
    (basis: AiTrustedRecoveryBasis | null) =>
    (input: { taskType: string; requestedTier: 'LOW_COST' | 'STRONG' }) => {
      const decision = decideAiBusinessValueTier({ basis, taskType: input.taskType, requestedTier: input.requestedTier });
      const verdict = assertAiBusinessValueTierAllowed({ decision, requestedTier: input.requestedTier });
      return { allowed: verdict.allowed, maxTier: decision.maxTier, reason: verdict.reason };
    };

  const runEscalation = async (basis: AiTrustedRecoveryBasis | null) => {
    const cheap = { n: 0 };
    const strong = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', false, cheap),
      strong: adapter('STRONG', true, strong),
      usage: () => usage(),
      qualityEvaluator: () => 'FAIL' as const,
      businessValue: valuePort(basis),
    });
    const outcome = await router.outcomeOf(request());
    return { outcome, cheapCalls: cheap.n, strongCalls: strong.n };
  };

  it('C3_F2_A1 价值 UNKNOWN + cheap FAIL → strong = 0', async () => {
    const r = await runEscalation(null);
    expect(r.cheapCalls).toBe(1);
    expect(r.strongCalls).toBe(0);
    expect(r.outcome.called).toBe(true);
  });

  it('C3_F2_A2 LOW / MEDIUM 价值 + cheap FAIL → strong = 0', async () => {
    for (const value of [1_000_000, 100_000_000]) {
      const r = await runEscalation({ basisRef: 'recovery-basis:low', estimatedRecoveryValueMicros: value, riskClass: 'LOW' });
      expect(r.strongCalls).toBe(0);
    }
  });

  it('C3_F2_A3 HIGH 价值 + canonical eligible risk + cheap FAIL → strong = 1（有界升级）', async () => {
    const r = await runEscalation({
      basisRef: 'recovery-basis:high',
      estimatedRecoveryValueMicros: 2_000_000_000,
      riskClass: 'LOW',
    });
    expect(r.strongCalls).toBe(1);
  });

  it('C3_F2_A4 HIGH 价值但风险不可接受 → strong = 0（fail-closed）', async () => {
    const r = await runEscalation({
      basisRef: 'recovery-basis:high-risk',
      estimatedRecoveryValueMicros: 2_000_000_000,
      riskClass: 'HIGH',
    });
    expect(r.strongCalls).toBe(0);
  });
});
