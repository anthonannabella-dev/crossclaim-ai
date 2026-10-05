/** RSI 本地仿真 Adapter + Router 组合验收：零网络 / 输入输出过滤 / 预算硬上限 / 台账 */

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../services/autonomy/rsi-adapter-safety';
import { createRsiCostLedger } from '../services/autonomy/rsi-cost-ledger';
import {
  createRsiLocalSimModelProviderComposition,
  RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY,
} from '../services/autonomy/rsi-model-provider-composition';
import {
  RSI_LOCAL_SIM_ADAPTER_BOUNDARY,
  RSI_LOCAL_SIM_MAX_OUTPUT_TOKENS,
  RSI_LOCAL_SIM_MODEL_ID,
  RSI_LOCAL_SIM_PRICING,
  createRsiLocalSimAdapter,
  parseRsiLocalSimOutput,
} from '../services/autonomy/rsi-local-sim-adapter';
import type { RsiModelInvocation } from '../services/autonomy/rsi-model-router';
import type { RsiCostUsage } from '../services/autonomy/rsi-cost-policy';

const invocation = (over: Partial<RsiModelInvocation> = {}): RsiModelInvocation => ({
  callId: 'call-1',
  taskKind: 'RUNTIME_ANOMALY',
  promptRef: 'prompt:task-1',
  promptDigest: 'd'.repeat(64),
  tier: 'LOW_COST',
  timeoutMs: 5_000,
  maxOutputTokens: 512,
  budget: { remainingUsd: 0.05, maxUsdThisCall: 0.05 },
  ...over,
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

describe('RSI local sim adapter', () => {
  it('RSI_SIM_ADAPTER_SUCCESS：返回 modelId/outputRef/outputDigest/usage，且不做网络调用', async () => {
    const adapter = createRsiLocalSimAdapter();
    const result = await adapter.invoke(invocation());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.modelId).toBe(RSI_LOCAL_SIM_MODEL_ID);
    expect(result.outputRef.startsWith('sim:')).toBe(true);
    expect(result.outputDigest).toHaveLength(64);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.estimatedCost).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(adapter.pricing).toEqual(RSI_LOCAL_SIM_PRICING);
  });

  it('RSI_SIM_ADAPTER_PROMPT_DIGEST_MISMATCH：ref 背后内容变了 → INPUT_SCHEMA_INVALID', async () => {
    const adapter = createRsiLocalSimAdapter({ resolvePrompt: () => 'a stable prompt body' });
    const result = await adapter.invoke(invocation({ promptDigest: sha256Hex('a different body') }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('INPUT_SCHEMA_INVALID');

    const matching = await adapter.invoke(invocation({ promptDigest: sha256Hex('a stable prompt body') }));
    expect(matching.ok).toBe(true);
  });

  it('RSI_SIM_ADAPTER_INPUT_FILTER：prompt 含敏感数据 → INPUT_SENSITIVE_DATA_DETECTED 且不产出', async () => {
    const adapter = createRsiLocalSimAdapter({ resolvePrompt: () => 'reach me at ops@example.com' });
    const result = await adapter.invoke(invocation({ promptDigest: sha256Hex('reach me at ops@example.com') }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('INPUT_SENSITIVE_DATA_DETECTED');
  });

  it('RSI_SIM_ADAPTER_OUTPUT_FILTER：输出带敏感数据 → OUTPUT_SENSITIVE_DATA_DETECTED', async () => {
    const adapter = createRsiLocalSimAdapter();
    const result = await adapter.invoke(invocation({ taskKind: 'reach ops@example.com' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('OUTPUT_SENSITIVE_DATA_DETECTED');
  });

  it('RSI_SIM_ADAPTER_EXPLICIT_LIMITS：timeoutMs / maxOutputTokens / 调用上限非法时 fail-closed', async () => {
    const adapter = createRsiLocalSimAdapter();
    const timeout = await adapter.invoke(invocation({ timeoutMs: 0 }));
    expect(timeout.ok).toBe(false);
    if (timeout.ok) throw new Error('expected failure');
    expect(timeout.reason).toBe('TIMEOUT_MS_INVALID');

    const tokens = await adapter.invoke(invocation({ maxOutputTokens: 0 }));
    expect(tokens.ok).toBe(false);
    if (tokens.ok) throw new Error('expected failure');
    expect(tokens.reason).toBe('MAX_OUTPUT_TOKENS_INVALID');

    const tiny = await adapter.invoke(invocation({ maxOutputTokens: 10 }));
    expect(tiny.ok).toBe(false);
    if (tiny.ok) throw new Error('expected failure');
    expect(tiny.reason).toBe('MAX_OUTPUT_TOKENS_INVALID');

    const unenforceable = await adapter.invoke(invocation({ budget: { remainingUsd: 0.0001, maxUsdThisCall: 0.0001 } }));
    expect(unenforceable.ok).toBe(false);
    if (unenforceable.ok) throw new Error('expected failure');
    expect(unenforceable.reason).toBe('BUDGET_GUARD_UNENFORCEABLE');
  });

  it('RSI_SIM_ADAPTER_RESPECTS_MAX_OUTPUT_TOKENS：输出 token 不超过调用方上限', async () => {
    const adapter = createRsiLocalSimAdapter();
    const result = await adapter.invoke(invocation({ maxOutputTokens: 40 }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.usage.outputTokens).toBeLessThanOrEqual(40);

    // 请求超过适配器硬上限时按硬上限截断，绝不会超出声明上限
    const clamped = await adapter.invoke(invocation({ maxOutputTokens: RSI_LOCAL_SIM_MAX_OUTPUT_TOKENS * 4 }));
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) throw new Error('expected success');
    expect(clamped.usage.outputTokens).toBeLessThanOrEqual(RSI_LOCAL_SIM_MAX_OUTPUT_TOKENS);
  });

  it('RSI_SIM_ADAPTER_OUTPUT_SCHEMA：schema 校验严格（字段集合与类型）', () => {
    expect(parseRsiLocalSimOutput({ kind: 'RSI_LOCAL_SIM', taskKind: 'CI_FAIL', summary: 'ok' }).ok).toBe(true);
    expect(parseRsiLocalSimOutput({ kind: 'RSI_LOCAL_SIM', taskKind: 'CI_FAIL' }).ok).toBe(false);
    expect(parseRsiLocalSimOutput({ kind: 'OTHER', taskKind: 'CI_FAIL', summary: 'ok' }).ok).toBe(false);
    expect(parseRsiLocalSimOutput({ kind: 'RSI_LOCAL_SIM', taskKind: 'CI_FAIL', summary: 'ok', extra: 1 }).ok).toBe(false);
    expect(parseRsiLocalSimOutput(null).ok).toBe(false);
    expect(RSI_LOCAL_SIM_ADAPTER_BOUNDARY.performsNetworkCalls).toBe(false);
    expect(RSI_LOCAL_SIM_ADAPTER_BOUNDARY.holdsProviderCredentials).toBe(false);
    expect(RSI_LOCAL_SIM_ADAPTER_BOUNDARY.internalRetry).toBe(false);
    expect(RSI_LOCAL_SIM_ADAPTER_BOUNDARY.sdkAutoRetry).toBe(false);
    expect(RSI_LOCAL_SIM_ADAPTER_BOUNDARY.transport).toBe(false);
    expect(RSI_LOCAL_SIM_ADAPTER_BOUNDARY.payment).toBe(false);
  });
});

describe('RSI model provider composition（本地仿真）', () => {
  it('RSI_COMPOSITION_RULE_SIGNAL_RECORDS_NOTHING：规则信号不调用也不写台账调用记录', async () => {
    const ledger = createRsiCostLedger();
    const composition = createRsiLocalSimModelProviderComposition({ usage: () => usage(), ledger });
    const outcome = await composition.router.outcomeOf({
      taskType: 'CI_FAIL',
      complexity: 'LOW',
      maxCost: 0.05,
      latencyRequirementMs: 5_000,
      requiredCapability: 'NONE',
      incidentId: 'inc-1',
      taskId: 'task-1',
      promptRef: 'prompt:task-1',
      promptDigest: 'e'.repeat(64),
      maxOutputTokens: 512,
      timeoutMs: 5_000,
    });
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('RULE_ENGINE');
    expect(composition.ledgerEntries()).toBe(0);
    expect(ledger.snapshot().entries).toBe(0);
  });

  it('RSI_COMPOSITION_SUCCESS_WRITES_LEDGER：仿真调用成功且台账记录成本', async () => {
    const ledger = createRsiCostLedger();
    const composition = createRsiLocalSimModelProviderComposition({ usage: () => usage(), ledger });
    const outcome = await composition.router.outcomeOf({
      taskType: 'SEMANTIC',
      complexity: 'LOW',
      maxCost: 0.05,
      latencyRequirementMs: 5_000,
      requiredCapability: 'SEMANTIC_UNDERSTANDING',
      incidentId: 'inc-1',
      taskId: 'task-1',
      promptRef: 'prompt:task-1',
      promptDigest: 'e'.repeat(64),
      maxOutputTokens: 512,
      timeoutMs: 5_000,
    });
    expect(outcome.called).toBe(true);
    expect(outcome.record?.provider).toBe('rsi-local-sim-low-cost');
    expect(outcome.record?.result).toBe('SUCCESS');
    const snapshot = ledger.snapshot();
    expect(snapshot.today.lowCostCalls).toBe(1);
    expect(snapshot.today.cost).toBeGreaterThan(0);
    expect(composition.strong).toBeNull();
  });

  it('RSI_COMPOSITION_BUDGET_REJECTION_WRITES_REJECTED：预算不足 → 不调用且台账记 REJECTED', async () => {
    const ledger = createRsiCostLedger();
    const composition = createRsiLocalSimModelProviderComposition({
      usage: () => usage({ incidentSpent: 0.498 }),
      ledger,
    });
    const outcome = await composition.router.outcomeOf({
      taskType: 'SEMANTIC',
      complexity: 'LOW',
      maxCost: 0.05,
      latencyRequirementMs: 5_000,
      requiredCapability: 'SEMANTIC_UNDERSTANDING',
      incidentId: 'inc-1',
      taskId: 'task-1',
      promptRef: 'prompt:task-1',
      promptDigest: 'e'.repeat(64),
      maxOutputTokens: 512,
      timeoutMs: 5_000,
    });
    expect(outcome.called).toBe(false);
    expect(outcome.reason).toBe('BUDGET_EXCEEDED');
    expect(outcome.record?.result).toBe('REJECTED');
    const snapshot = ledger.snapshot();
    expect(snapshot.today.cost).toBe(0);
    expect(snapshot.entries).toBe(1);
    expect(RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY.realProviderNetwork).toBe('HOLD');
    expect(RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY.paidModelCalls).toBe('HOLD');
    expect(RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY.performsNetworkCalls).toBe(false);
  });
});
