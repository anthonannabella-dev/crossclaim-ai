/**
 * PHASE 2 U1 —— Model Gateway capability port（唯一 Model Router 接入 ONE SI Runtime）
 * ---------------------------------------------------------------
 * 硬约束（HOST 2026-10-06 PHASE 2 / 禁第二 Model Router）：
 *   - 本模块**不实现**任何路由 / 预算 / 缓存 / 质量 / 升级逻辑，只把既有唯一 Gateway
 *     `services/autonomy/rsi-model-router.ts` 包装成 SI Runtime 可注入的 capability port；
 *   - cheap-first、budget guard、cache、business-value gate、quality evaluator、
 *     bounded strong escalation、tenant budget、Cost Safe Mode 全部沿用 Gateway 内部实现；
 *   - `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` = HOLD：默认只允许 host 注入的
 *     local simulation adapter（`rsi-local-sim-adapter`）；
 *   - provider failure / budget 拒绝一律 fail-closed，不由此模块放宽。
 */

import {
  createRsiModelRouter,
  type RsiModelCachePort,
  type RsiModelProviderAdapter,
  type RsiProviderTier,
  type RsiRouterOutcome,
} from '../services/autonomy/rsi-model-router';
import type { RsiCostUsage, RsiModelCallRequest } from '../services/autonomy/rsi-cost-policy';
import type { AiEscalationLimits, AiQualityVerdict } from '../services/autonomy/rsi-model-escalation-policy';

export const SI_MODEL_GATEWAY_BOUNDARY = {
  owner: 'services/autonomy/rsi-model-router.ts（唯一 Model Router）',
  secondRouter: 'FORBIDDEN',
  reimplementsRouting: false,
  realProviderNetwork: 'HOLD',
  paidModelCalls: 'HOLD',
  localSimulationAdapterOnly: true,
  providerFailure: 'fail-closed（由 Gateway 判定）',
  deterministicFirst: true,
} as const;

export interface SiModelGatewayInvokeResult {
  called: boolean;
  reason: string;
  level: string;
  provider: string | null;
  model: string | null;
  estimatedCostUsd: number;
  cacheHit: boolean;
  escalatedToStrong: boolean;
}

/** SI Runtime 侧唯一模型入口（结构性端口；实现只能来自 shared Gateway）。 */
export interface RsiSiModelGatewayPort {
  readonly gatewayOwner: 'rsi-model-router';
  invoke(request: RsiModelCallRequest): Promise<SiModelGatewayInvokeResult>;
}

export interface SiModelGatewayDeps {
  lowCost: RsiModelProviderAdapter;
  strong?: RsiModelProviderAdapter;
  usage: () => RsiCostUsage;
  limits?: Parameters<typeof createRsiModelRouter>[0]['limits'];
  qualityEvaluator?: Parameters<typeof createRsiModelRouter>[0]['qualityEvaluator'];
  escalationLimits?: AiEscalationLimits;
  cache?: RsiModelCachePort;
  costSafeMode?: Parameters<typeof createRsiModelRouter>[0]['costSafeMode'];
  businessValue?: Parameters<typeof createRsiModelRouter>[0]['businessValue'];
  concurrency?: Parameters<typeof createRsiModelRouter>[0]['concurrency'];
  onCall?: (record: { provider: string; executionLevel: string; estimatedCost: number }) => void;
  onCacheSavings?: Parameters<typeof createRsiModelRouter>[0]['onCacheSavings'];
  now?: () => number;
}

const toResult = (outcome: RsiRouterOutcome): SiModelGatewayInvokeResult => ({
  called: outcome.called,
  reason: outcome.reason,
  level: outcome.level,
  provider: outcome.record?.provider ?? null,
  model: outcome.record?.model ?? null,
  estimatedCostUsd: outcome.record?.estimatedCost ?? 0,
  cacheHit: outcome.cacheHit === true,
  escalatedToStrong: outcome.escalatedToStrong === true,
});

/**
 * 用共享 Gateway 组装 SI capability port。
 * **禁止**在此处新增路由/预算/质量逻辑；任何绕过必须在上层被拒绝。
 */
export function createSiModelGatewayPort(deps: SiModelGatewayDeps): RsiSiModelGatewayPort {
  const router = createRsiModelRouter({
    lowCost: deps.lowCost,
    ...(deps.strong === undefined ? {} : { strong: deps.strong }),
    usage: deps.usage,
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    ...(deps.qualityEvaluator === undefined ? {} : { qualityEvaluator: deps.qualityEvaluator }),
    ...(deps.escalationLimits === undefined ? {} : { escalationLimits: deps.escalationLimits }),
    ...(deps.cache === undefined ? {} : { cache: deps.cache }),
    ...(deps.costSafeMode === undefined ? {} : { costSafeMode: deps.costSafeMode }),
    ...(deps.businessValue === undefined ? {} : { businessValue: deps.businessValue }),
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    ...(deps.onCacheSavings === undefined ? {} : { onCacheSavings: deps.onCacheSavings }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.onCall === undefined
      ? {}
      : {
          onCall: (record) =>
            deps.onCall?.({
              provider: record.provider,
              executionLevel: record.purpose,
              estimatedCost: record.estimatedCost,
            }),
        }),
  });
  return {
    gatewayOwner: 'rsi-model-router',
    async invoke(request) {
      return toResult(await router.outcomeOf(request));
    },
  };
}

/** SI Model Gateway 任务级请求（Router 合同之上补 invocation 必需字段；无凭据字段）。 */
export type { RsiModelCallRequest, RsiProviderTier, AiQualityVerdict };
