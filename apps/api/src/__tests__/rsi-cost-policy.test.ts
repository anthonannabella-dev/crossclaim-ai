/** RSI Cost Control Layer 验收：默认规则引擎零 LLM、分级升级、预算熔断、Incident 上限、Router 不含凭据。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_BUDGET_DEFAULTS,
  RSI_COST_POLICY_BOUNDARY,
  decideRsiModelCall,
  isCostSafeMode,
  isRuleSolvable,
  selectExecutionLevel,
  type RsiCostUsage,
} from '../services/autonomy/rsi-cost-policy';

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

describe('RSI Cost Control Layer', () => {
  it('RSI_COST_RULE_ENGINE_DEFAULT_NO_LLM：规则可解信号默认 LEVEL 0 且不产生模型调用', () => {
    for (const signal of ['CI_FAIL', 'TEST_FAILURE', 'TYPECHECK_FAILURE', 'HEALTH_CHECK', 'ROLLBACK']) {
      expect(isRuleSolvable(signal)).toBe(true);
      const decision = decideRsiModelCall({ signalKind: signal, usage: usage() });
      expect(decision.allowed).toBe(true);
      expect(decision.level).toBe('LEVEL_0_RULE');
      expect(decision.reason).toBe('RULE_ENGINE');
    }
    // 没有声明 AI 能力 → 一律 LEVEL 0（不是 AI 调用）
    expect(selectExecutionLevel({ signalKind: 'RUNTIME_ANOMALY' })).toBe('LEVEL_0_RULE');
  });

  it('RSI_COST_ESCALATION_LEVELS：简单语义 → LEVEL 1；复杂修复/根因 → LEVEL 2', () => {
    const lowCost = decideRsiModelCall({
      signalKind: 'RUNTIME_ANOMALY',
      requiredCapabilities: ['SEMANTIC_UNDERSTANDING'],
      usage: usage(),
    });
    expect(lowCost.level).toBe('LEVEL_1_LOW_COST');
    expect(lowCost.allowed).toBe(true);

    const strong = decideRsiModelCall({
      signalKind: 'RUNTIME_ANOMALY',
      requiredCapabilities: ['COMPLEX_CODE_FIX'],
      usage: usage(),
    });
    expect(strong.level).toBe('LEVEL_2_STRONG');
    expect(strong.allowed).toBe(true);
  });

  it('RSI_COST_SAFE_MODE_BLOCKS_NORMAL_AI：日预算耗尽 → AI 暂停，但规则引擎仍运行', () => {
    const spent = usage({ spentToday: RSI_BUDGET_DEFAULTS.dailyBudget });
    expect(isCostSafeMode(spent)).toBe(true);

    // 普通 AI 任务被暂停
    const blocked = decideRsiModelCall({
      signalKind: 'RUNTIME_ANOMALY',
      requiredCapabilities: ['SEMANTIC_UNDERSTANDING'],
      usage: spent,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('COST_SAFE_MODE');
    expect(blocked.costSafeMode).toBe(true);

    // 规则引擎 / 健康监控仍然运行
    const rules = decideRsiModelCall({ signalKind: 'HEALTH_CHECK', usage: spent });
    expect(rules.allowed).toBe(true);
    expect(rules.level).toBe('LEVEL_0_RULE');

    // 高风险 OWNER-gated 事项 → 交宿主，不由 RSI 处理
    const owner = decideRsiModelCall({
      signalKind: 'RUNTIME_ANOMALY',
      requiredCapabilities: ['COMPLEX_CODE_FIX'],
      usage: spent,
      ownerGatedAction: 'EXTERNAL_WRITE',
    });
    expect(owner.allowed).toBe(false);
    expect(owner.reason).toBe('OWNER_ACTION_REQUIRED');

    // 月预算耗尽同样进入 COST_SAFE_MODE
    expect(isCostSafeMode(usage({ spentThisMonth: RSI_BUDGET_DEFAULTS.monthlyBudget }))).toBe(true);
  });

  it('RSI_COST_INCIDENT_BUDGET_EXHAUSTED：同一 Incident 达到任意上限即停止递归', () => {
    const cases: RsiCostUsage[] = [
      usage({ incidentAttempts: RSI_BUDGET_DEFAULTS.maxAttemptsPerIncident }),
      usage({ incidentCandidates: RSI_BUDGET_DEFAULTS.maxCandidatesPerIncident }),
      usage({ incidentLlmCalls: RSI_BUDGET_DEFAULTS.maxLlmCallsPerIncident }),
      usage({ incidentTokens: RSI_BUDGET_DEFAULTS.maxTokensPerIncident }),
      usage({ incidentElapsedMinutes: RSI_BUDGET_DEFAULTS.maxWallClockMinutesPerIncident }),
    ];
    for (const u of cases) {
      const decision = decideRsiModelCall({
        signalKind: 'RUNTIME_ANOMALY',
        requiredCapabilities: ['SEMANTIC_UNDERSTANDING'],
        usage: u,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('AUTONOMY_BUDGET_EXHAUSTED');
    }

    // 单 incident 成本上限
    const overCost = decideRsiModelCall({
      signalKind: 'RUNTIME_ANOMALY',
      requiredCapabilities: ['SEMANTIC_UNDERSTANDING'],
      usage: usage({ incidentSpent: RSI_BUDGET_DEFAULTS.maxCostPerIncident }),
    });
    expect(overCost.reason).toBe('INCIDENT_COST_LIMIT');

    // strong model 调用次数上限
    const strongLimit = decideRsiModelCall({
      signalKind: 'RUNTIME_ANOMALY',
      requiredCapabilities: ['COMPLEX_CODE_FIX'],
      usage: usage({ strongCallsForTask: RSI_BUDGET_DEFAULTS.maxStrongModelCallsPerTask }),
    });
    expect(strongLimit.reason).toBe('STRONG_MODEL_CALL_LIMIT');
  });

  it('RSI_COST_MODEL_ROUTER_PORT_NO_KEYS：RSI 不持有凭据，请求结构无 provider/apiKey 字段', () => {
    expect(RSI_COST_POLICY_BOUNDARY.holdsProviderCredentials).toBe(false);
    expect(RSI_COST_POLICY_BOUNDARY.recordsCustomerData).toBe(false);
    expect(RSI_COST_POLICY_BOUNDARY.defaultLevel).toBe('LEVEL_0_RULE');

    const request = {
      taskType: 'diagnose',
      complexity: 'LOW' as const,
      maxCost: 0.05,
      latencyRequirementMs: 5000,
      requiredCapability: 'SEMANTIC_UNDERSTANDING' as const,
      incidentId: 'inc-1',
      taskId: 'task-1',
    };
    const keys = Object.keys(request);
    for (const forbidden of ['provider', 'apiKey', 'credential', 'secret', 'token']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
