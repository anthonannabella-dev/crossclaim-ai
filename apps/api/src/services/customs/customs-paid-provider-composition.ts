/**
 * V2-02 — CUSTOMS PAID PROVIDER COMPOSITION（唯一 composition 点 · 全出口 Gate 覆盖）
 * ---------------------------------------------------------------
 * 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE A / PHASE D。
 * 目标：任何未来接入的真实关税 Provider 都只能通过本 composition 进入运行时，
 *       且**全部出站方法**必须被 PAID_CUSTOMS_API_GATE 包装；漏包即抛错（fail-closed）。
 *
 * 不变式：
 *  1. provider 为 null → 返回 `gated: false` + `provider: null`（消费方应回落到 CLAIM_READY / BROKER_HANDOFF）。
 *  2. provider 非 null → 必须先包装再断言全出口覆盖；断言失败**不返回**任何可用 provider。
 *  3. 组合结果被冻结：不允许事后把原始方法挂回去。
 *  4. 本模块不发起任何调用、不读凭据、不写库、不扣款。
 */

import {
  CUSTOMS_FILING_PROVIDER_OUTBOUND_METHODS,
  METHOD_BY_OPERATION,
  PAID_CUSTOMS_API_GATE_VERSION,
  assertProviderFullyGated,
  createPaidCustomsCallCounter,
  wrapPaidCustomsProvider,
  type CustomsFilingProviderOutboundMethod,
  type PaidCustomsCallCounter,
  type PaidCustomsGateContext,
  type PaidCustomsOperation,
} from './customs-paid-api-gate';

export interface ComposeGatedCustomsProviderInput<TProvider extends object> {
  provider: TProvider | null;
  /**
   * 每次出站调用前解析 Gate 上下文（归属 / 权益 / 额度 / 授权 / 报价 / 预算 / 利润门 /
   * Kill Switch / 支付开关）。返回 null → HOLD。
   */
  resolveContext: (
    operation: PaidCustomsOperation,
    method: CustomsFilingProviderOutboundMethod,
  ) => PaidCustomsGateContext | null;
  /** 可注入计数器（遥测 / 验收断言）；缺省新建进程内计数。 */
  counter?: PaidCustomsCallCounter;
  now?: () => Date;
}

export interface GatedCustomsProviderComposition<TProvider extends object> {
  provider: TProvider | null;
  counter: PaidCustomsCallCounter;
  gated: boolean;
  gateVersion: string;
  /** 已确认被 Gate 覆盖的出站方法集合（provider 为 null 时为空）。 */
  outboundMethods: readonly CustomsFilingProviderOutboundMethod[];
  /** 本组合自身永不发起外部写 / 资金动作。 */
  externalCallPerformed: false;
  productionCredentials: 'ABSENT';
}

/**
 * 唯一 composition：把任意 provider 变成"全出口受 Gate 约束"的 provider。
 * 未通过全出口覆盖断言 → 抛 CustomsProviderUngatedExitError（不返回半成品）。
 */
export function composeGatedCustomsFilingProvider<TProvider extends object>(
  input: ComposeGatedCustomsProviderInput<TProvider>,
): GatedCustomsProviderComposition<TProvider> {
  const counter = input.counter ?? createPaidCustomsCallCounter();
  if (input.provider === null) {
    return {
      provider: null,
      counter,
      gated: false,
      gateVersion: PAID_CUSTOMS_API_GATE_VERSION,
      outboundMethods: [],
      externalCallPerformed: false,
      productionCredentials: 'ABSENT',
    };
  }

  const wrapped = wrapPaidCustomsProvider({
    provider: input.provider,
    counter,
    resolveContext: (operation) =>
      input.resolveContext(operation, METHOD_BY_OPERATION[operation]),
    now: input.now,
  });
  assertProviderFullyGated(input.provider, wrapped);

  return {
    provider: Object.freeze(wrapped) as TProvider,
    counter,
    gated: true,
    gateVersion: PAID_CUSTOMS_API_GATE_VERSION,
    outboundMethods: CUSTOMS_FILING_PROVIDER_OUTBOUND_METHODS,
    externalCallPerformed: false,
    productionCredentials: 'ABSENT',
  };
}

/** 边界自证：组合层不产生外部调用 / 资金动作。 */
export const CUSTOMS_PROVIDER_COMPOSITION_BOUNDARY = {
  externalCallPerformed: false,
  providerInvoked: false,
  chargedAmount: null,
  paymentCaptured: false,
  autoCollectionEnabled: false,
  transportEnabled: false,
  platformWriteEnabled: false,
  productionCredentials: 'ABSENT',
} as const;
