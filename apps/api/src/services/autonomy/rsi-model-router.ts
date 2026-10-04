/**
 * RSI Model Router 适配层（RSI-COST-02）
 * ---------------------------------------------------------------
 * 职责：
 *   · 实现 `ModelRouterPort`：RSI 只声明需求，Router 决定实际模型；
 *   · **凭据只在 Router 侧**：本模块不读取任何环境变量、不持有 key；真实 HTTP 适配器由宿主注入
 *     （provider 凭据属 HOLD，必须经 OWNER/密钥管理）；
 *   · 调用前先过 `decideRsiModelCall()`：规则等级不发调用、预算/熔断被拒时**不触碰 provider**；
 *   · 每次调用产出脱敏记录（provider/model/tokens/cost/latency/retry），供台账与 /admin 成本面板消费；
 *   · 低成本优先：LEVEL_1 只允许低档 provider；只有 LEVEL_2 才允许强模型，且受
 *     `maxStrongModelCallsPerTask` 限制。
 */

import {
  decideRsiModelCall,
  RSI_BUDGET_DEFAULTS,
  type ModelRouterPort,
  type RsiBudgetLimits,
  type RsiCostUsage,
  type RsiModelCallRecord,
  type RsiModelCallRequest,
} from './rsi-cost-policy';

/** 单次调用结果（provider 侧返回值，不含任何凭据）。 */
export interface RsiProviderResult {
  model: string;
  output?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  latencyMs: number;
  retryCount: number;
  succeeded: boolean;
}

/** provider 适配器：由宿主注入；凭据在适配器内部解析（本模块不接触）。 */
export interface RsiModelProviderAdapter {
  readonly providerName: string;
  readonly tier: 'LOW_COST' | 'STRONG';
  invoke(request: RsiModelCallRequest): Promise<RsiProviderResult>;
}

export interface RsiRouterOutcome {
  called: boolean;
  level: string;
  reason: string;
  record: RsiModelCallRecord | null;
  escalatedToStrong?: boolean;
}

export function createRsiModelRouter(options: {
  lowCost: RsiModelProviderAdapter;
  strong?: RsiModelProviderAdapter;
  usage: () => RsiCostUsage;
  onCall?: (record: RsiModelCallRecord) => void;
  limits?: RsiBudgetLimits;
}): ModelRouterPort & { outcomeOf(request: RsiModelCallRequest): Promise<RsiRouterOutcome> } {
  const limits = options.limits ?? RSI_BUDGET_DEFAULTS;

  const runOnce = async (
    adapter: RsiModelProviderAdapter,
    request: RsiModelCallRequest,
    purpose: string,
  ): Promise<{ outcome: RsiRouterOutcome }> => {
    const result = await adapter.invoke(request);
    const record: RsiModelCallRecord = {
      incidentId: request.incidentId,
      taskId: request.taskId,
      provider: adapter.providerName,
      model: result.model,
      purpose,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCost: result.estimatedCost,
      latencyMs: result.latencyMs,
      result: result.succeeded ? 'SUCCESS' : 'FAILED',
      retryCount: result.retryCount,
    };
    options.onCall?.(record);
    return {
      outcome: {
        called: true,
        level: adapter.tier === 'LOW_COST' ? 'LEVEL_1_LOW_COST' : 'LEVEL_2_STRONG',
        reason: result.succeeded ? 'CALLED' : 'CALL_FAILED',
        record,
      },
    };
  };

  const route: ModelRouterPort['route'] = async (request) => {
    const outcome = await (
      routerApi as unknown as { outcomeOf(r: RsiModelCallRequest): Promise<RsiRouterOutcome> }
    ).outcomeOf(request);
    if (!outcome.called || outcome.record === null) {
      throw new Error('MODEL_CALL_REJECTED:' + outcome.reason);
    }
    return {
      provider: outcome.record.provider,
      model: outcome.record.model,
      inputTokens: outcome.record.inputTokens,
      outputTokens: outcome.record.outputTokens,
      estimatedCost: outcome.record.estimatedCost,
      latencyMs: outcome.record.latencyMs,
      retryCount: outcome.record.retryCount,
    };
  };

  const routerApi = {
    route,
    async outcomeOf(request: RsiModelCallRequest): Promise<RsiRouterOutcome> {
      const decision = decideRsiModelCall({
        signalKind: request.taskType,
        requiredCapabilities: [request.requiredCapability],
        usage: options.usage(),
        limits,
      });

      // 规则等级 / 预算 / 熔断：**不触碰 provider**。
      if (!decision.allowed) {
        return { called: false, level: decision.level, reason: decision.reason, record: null };
      }
      if (decision.level === 'LEVEL_0_RULE') {
        return { called: false, level: decision.level, reason: 'RULE_ENGINE', record: null };
      }

      if (decision.level === 'LEVEL_1_LOW_COST') {
        return (await runOnce(options.lowCost, request, 'LEVEL_1')).outcome;
      }

      // LEVEL_2：先低成本，失败且仍有 strong 额度才升级。
      if (options.strong === undefined) {
        return (await runOnce(options.lowCost, request, 'LEVEL_2_FALLBACK')).outcome;
      }
      const first = await runOnce(options.lowCost, request, 'LEVEL_2_PROBE');
      if (first.outcome.record?.result === 'SUCCESS') return first.outcome;
      const second = await runOnce(options.strong, request, 'LEVEL_2_STRONG');
      return { ...second.outcome, escalatedToStrong: true };
    },
  };

  return routerApi as ModelRouterPort & { outcomeOf(request: RsiModelCallRequest): Promise<RsiRouterOutcome> };
}

export const RSI_MODEL_ROUTER_BOUNDARY = {
  holdsProviderCredentials: false,
  readsEnvironmentSecrets: false,
  providersInjectedByHost: true,
  recordsCustomerData: false,
} as const;
