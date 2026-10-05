/**
 * RSI Model Provider 组合根（本地仿真，默认零网络零费用）
 * ---------------------------------------------------------------
 * 裁定依据：MSG-20261005-09 —— 本轮只授权 LOCAL_SIM + ROUTER_TO_SIM_ADAPTER_WIRING。
 *
 * 组合内容：
 *   · 低成本仿真 adapter 必选；强模型仿真 adapter 仅在同一组合里显式开启（默认关闭）；
 *   · Router 的所有调用记录（SUCCESS / FAILED / REJECTED）都写入 append-only 台账；
 *   · 真实 provider 网络与付费调用保持 HOLD —— 本组合不读任何密钥、不新建真实传输。
 */

import {
  RSI_BUDGET_DEFAULTS,
  type RsiBudgetLimits,
  type RsiCostUsage,
  type RsiModelCallRecord,
} from './rsi-cost-policy';
import type { RsiCostLedger } from './rsi-cost-ledger';
import { createRsiLocalSimAdapter } from './rsi-local-sim-adapter';
import {
  createRsiModelRouter,
  type RsiCostSafeModePort,
  type RsiModelProviderAdapter,
  type RsiModelCachePort,
  type RsiProviderTier,
} from './rsi-model-router';

export interface RsiModelProviderComposition {
  lowCost: RsiModelProviderAdapter;
  strong: RsiModelProviderAdapter | null;
  router: ReturnType<typeof createRsiModelRouter>;
  ledgerEntries: () => number;
  /** C3：cache 命中计数（本组合根内的 dev 观测；**不是** durable 事实源） */
  cacheHits: () => number;
}

export function createRsiLocalSimModelProviderComposition(options: {
  usage: () => RsiCostUsage;
  ledger?: RsiCostLedger;
  limits?: RsiBudgetLimits;
  now?: () => number;
  /** 默认 false：仿真阶段只保留低成本通道，强模型升级路径在测试里显式开启 */
  includeStrongAdapter?: boolean;
  resolvePrompt?: (promptRef: string) => string | undefined | Promise<string | undefined>;
  /** C3：可选 cost-control 端口（缺省不启用 ⇒ 行为与 C1/C2 完全一致） */
  cache?: RsiModelCachePort;
  /** C3 FINAL-3：支持 async（可直接注入 durable Safe Mode adapter） */
  costSafeMode?: RsiCostSafeModePort;
  businessValue?: (input: { taskType: string; requestedTier: RsiProviderTier }) => {
    allowed: boolean;
    maxTier: RsiProviderTier;
    reason: string;
  };
  concurrency?: <T>(run: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; reason: string }>;
}): RsiModelProviderComposition {
  const now = options.now ?? (() => Date.now());
  const lowCost = createRsiLocalSimAdapter({
    tier: 'LOW_COST',
    providerName: 'rsi-local-sim-low-cost',
    now,
    ...(options.resolvePrompt === undefined ? {} : { resolvePrompt: options.resolvePrompt }),
  });
  const strong = options.includeStrongAdapter === true
    ? createRsiLocalSimAdapter({ tier: 'STRONG', providerName: 'rsi-local-sim-strong', now })
    : null;

  let sequence = 0;
  let entries = 0;
  let cacheHits = 0;
  const onCall = (record: RsiModelCallRecord): void => {
    entries += 1;
    if (options.ledger === undefined) return;
    sequence += 1;
    options.ledger.record({
      ...record,
      entryId: `rsi-model-call-${sequence}`,
      at: new Date(now()).toISOString(),
      level: record.provider === lowCost.providerName ? 'LEVEL_1_LOW_COST' : 'LEVEL_2_STRONG',
    });
  };

  const router = createRsiModelRouter({
    lowCost,
    ...(strong === null ? {} : { strong }),
    usage: options.usage,
    limits: options.limits ?? RSI_BUDGET_DEFAULTS,
    now,
    onCall,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.costSafeMode === undefined ? {} : { costSafeMode: options.costSafeMode }),
    ...(options.businessValue === undefined ? {} : { businessValue: options.businessValue }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    // C3：cache HIT 只登记 savings 计数，绝不伪造 provider 台账记录（真实成本仍只来自 ledger）
    onCacheSavings: () => {
      cacheHits += 1;
    },
  });

  return { lowCost, strong, router, ledgerEntries: () => entries, cacheHits: () => cacheHits };
}

export const RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY = {
  localSimulationOnly: true,
  realProviderNetwork: 'HOLD',
  paidModelCalls: 'HOLD',
  readsCredentials: false,
  performsNetworkCalls: false,
  ledgerRecordsRejectedCalls: true,
  externalWrite: false,
  payment: false,
  transport: false,
  productionCredentials: 'ABSENT',
  /** C3：cost-control 端口为可选注入；cache HIT 不产生 provider 台账记录 */
  costControlPorts: 'OPTIONAL_INJECTED（cache / costSafeMode / businessValue / concurrency）',
  cacheHitCreatesProviderLedgerEntry: false,
} as const;
