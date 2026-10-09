/**
 * V2-HANDOFF-02 — CUSTOMS UNLOCK CHECKOUT（收银台适配层 · 默认禁用）
 * ---------------------------------------------------------------
 * 授权：审计 `MSG-20261010-57` 的 `NEXT_AUTHORIZED = V2_HOST_HANDOFF_AND_EXTERNAL_ENABLEMENT_PREPARATION`
 *   （该裁决指出 `CHECKOUT_REDIRECT` "不是单纯等待外部服务自动解决，仍需要实际实现"）。
 *
 * 不变式：
 *  1. 只有**服务端签发的有效报价**（未过期、四要素齐备）才可能产生跳转描述。
 *  2. `paymentsEnabled=false`（现有 Payment HOLD）或未配置收银台端点 → 一律 `DISABLED`，不产生任何 URL。
 *  3. 本模块**不**创建真实收银台会话、**不**调用支付通道、**不**持有卡数据；只产出描述符供宿主接线时消费。
 *  4. 客户端传入的价格 / 币种一律忽略，以报价为唯一权威。
 */

import type { CustomsUnlockQuote } from './customs-unlock-payment';

export const CUSTOMS_CHECKOUT_ADAPTER_VERSION = 'customs-unlock-checkout-v2.0.0';

export const CUSTOMS_CHECKOUT_STATES = [
  'DISABLED',
  'HOLD_QUOTE_INVALID',
  'READY_FOR_HOST_REDIRECT',
] as const;
export type CustomsCheckoutState = (typeof CUSTOMS_CHECKOUT_STATES)[number];

export interface CustomsCheckoutInput {
  quote: CustomsUnlockQuote | null;
  now: Date;
  payment: {
    /** 现有 Payment HOLD 开关。 */
    paymentsEnabled: boolean;
    /** 宿主编排的收银台端点（未配置 → 只能 DISABLED）。 */
    hostedCheckoutUrl: string | null;
    /** 真实生产支付是否已授权（未授权 → 即使其它都就绪也只能 HOLD）。 */
    productionPaymentAuthorized: boolean;
  };
}

export interface CustomsCheckoutDecision {
  kind: 'CUSTOMS_UNLOCK_CHECKOUT';
  version: string;
  state: CustomsCheckoutState;
  reasonCodes: readonly string[];
  /** 仅在 READY_FOR_HOST_REDIRECT 时非空；其余情况**不得**返回任何链接。 */
  redirectUrl: string | null;
  /** 展示用价格（服务端报价权威；客户端传入值不参与）。 */
  priceMinor: number | null;
  currency: string | null;
  /** 收银台会话是否已创建 —— 本模块恒为 false（创建属宿主接线）。 */
  checkoutSessionCreated: false;
  cardDataStored: false;
  chargesPerformed: false;
  externalCallPerformed: false;
  productionCredentials: 'ABSENT';
}

export function resolveCustomsCheckout(
  input: CustomsCheckoutInput,
): CustomsCheckoutDecision {
  const base = {
    kind: 'CUSTOMS_UNLOCK_CHECKOUT' as const,
    version: CUSTOMS_CHECKOUT_ADAPTER_VERSION,
    checkoutSessionCreated: false as const,
    cardDataStored: false as const,
    chargesPerformed: false as const,
    externalCallPerformed: false as const,
    productionCredentials: 'ABSENT' as const,
  };
  const hold = (reason: string, extra: Partial<CustomsCheckoutDecision> = {}) => ({
    ...base,
    state: 'DISABLED' as const,
    reasonCodes: [reason],
    redirectUrl: null,
    priceMinor: null,
    currency: null,
    ...extra,
  });

  if (!input.payment.paymentsEnabled) return hold('PAYMENTS_HOLD');
  if (input.quote === null) return hold('QUOTE_REQUIRED');

  const quote = input.quote;
  if (Date.parse(quote.expiresAt) <= input.now.getTime()) {
    return {
      ...base,
      state: 'HOLD_QUOTE_INVALID',
      reasonCodes: ['QUOTE_EXPIRED'],
      redirectUrl: null,
      priceMinor: quote.priceMinor,
      currency: quote.currency,
    };
  }
  // 运行期脏数据护栏：类型上 paymentCaptured 恒为 false，但外部对象可能被污染
  const captured: unknown = (quote as unknown as { paymentCaptured?: unknown }).paymentCaptured;
  if (captured === true) {
    // 报价对象不该带这种标记；出现即视为脏数据
    return hold('QUOTE_MALFORMED');
  }
  if (input.payment.hostedCheckoutUrl === null || input.payment.hostedCheckoutUrl.length === 0) {
    return hold('CHECKOUT_ENDPOINT_NOT_CONFIGURED', {
      priceMinor: quote.priceMinor,
      currency: quote.currency,
    });
  }
  if (!input.payment.productionPaymentAuthorized) {
    return hold('PRODUCTION_PAYMENT_NOT_AUTHORIZED', {
      priceMinor: quote.priceMinor,
      currency: quote.currency,
    });
  }

  // 只有全部条件满足时才产出**描述符**（真正的会话创建仍由宿主完成）
  const url = new URL(input.payment.hostedCheckoutUrl);
  url.searchParams.set('quoteId', quote.quoteId);
  url.searchParams.set('quoteVersion', quote.quoteVersion);
  return {
    ...base,
    state: 'READY_FOR_HOST_REDIRECT',
    reasonCodes: ['READY_FOR_HOST_CHECKOUT'],
    redirectUrl: url.toString(),
    priceMinor: quote.priceMinor,
    currency: quote.currency,
  };
}

/** 边界自证：适配层不建会话、不持卡、不扣款、不发起外部调用。 */
export const CUSTOMS_CHECKOUT_BOUNDARY = {
  checkoutSessionCreated: false,
  cardDataStored: false,
  chargesPerformed: false,
  externalCallPerformed: false,
  defaultState: 'DISABLED',
  productionCredentials: 'ABSENT',
} as const;
