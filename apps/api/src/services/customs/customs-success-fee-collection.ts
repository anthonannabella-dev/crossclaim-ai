/**
 * V2-08 — CUSTOMS SUCCESS FEE COLLECTION（15% 成功费五态分层 · 收款门禁）
 * ---------------------------------------------------------------
 * 授权：HOST DIRECTIVE 2026-10-10「V2-AUTONOMOUS-20261010-01」§四。
 *
 * 五个**互相独立**的状态（不得混用）：
 *   SUCCESS_FEE_CALCULATED        —— 算出金额，但尚不构成应收（未证实 / 重复 / 金额非法）
 *   SUCCESS_FEE_RECEIVABLE        —— 已验证实际回款 → 应收成立
 *   PAYMENT_COLLECTION_HOLD       —— 有应收但收款门禁未开（默认状态）
 *   PAYMENT_COLLECTION_AUTHORIZED —— 客户授权 + 支付方式支持 + 宿主开闸 + Kill Switch 未触发
 *   PAYMENT_COLLECTED             —— 仅由**可信支付事实**驱动（本模块不发起扣款）
 *
 * 硬约束：
 *  1. 无真实回款 / 仅有预估 / 无可信结算证据 → 不产生应收。
 *  2. 费率来自既有版本化策略（默认 1500 bps = 15%），金额定点、向下取整到分。
 *  3. 重复通知不得重复计费（以 settlementId 为幂等键）。
 *  4. 退款与冲正必须留下可审计调整记录。
 *  5. 客户撤销授权必须被尊重：不得继续自动划扣。
 *  6. `AUTO_COLLECTION=HOLD` 默认；未显式开闸时永远停在 PAYMENT_COLLECTION_HOLD。
 *  7. 本模块不持卡、不发起扣款、不调用支付通道、不写库。
 */

import {
  CUSTOMS_SUCCESS_FEE_RATE_BPS,
} from './customs-unlock-payment';
import { applyBpsFloorToCent, addDecimalAmounts, subtractDecimalAmounts } from './customs-profit-gate';
import { compareDecimalAmounts, normalizeDecimalAmount } from './customs-paid-api-gate';

export const CUSTOMS_FEE_COLLECTION_VERSION = 'customs-success-fee-collection-v2.0.0';

export const CUSTOMS_FEE_COLLECTION_STATES = [
  'SUCCESS_FEE_CALCULATED',
  'SUCCESS_FEE_RECEIVABLE',
  'PAYMENT_COLLECTION_HOLD',
  'PAYMENT_COLLECTION_AUTHORIZED',
  'PAYMENT_COLLECTED',
] as const;
export type CustomsFeeCollectionState = (typeof CUSTOMS_FEE_COLLECTION_STATES)[number];

export type CustomsFeeCollectionReason =
  | 'SETTLEMENT_NOT_VERIFIED'
  | 'SETTLEMENT_REFERENCE_MISSING'
  | 'SETTLEMENT_AMOUNT_INVALID'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_FEE_SUPPRESSED'
  | 'RECEIVABLE_ESTABLISHED'
  | 'CUSTOMER_AUTHORIZATION_MISSING'
  | 'CUSTOMER_AUTHORIZATION_REVOKED'
  | 'PAYMENT_METHOD_NOT_SUPPORTED'
  | 'AUTO_COLLECTION_NOT_ENABLED'
  | 'KILL_SWITCH_ENGAGED'
  | 'COLLECTION_AUTHORIZED'
  | 'COLLECTION_FAILED'
  | 'COLLECTION_AMOUNT_UNTRUSTED'
  | 'PARTIAL_COLLECTION_PENDING'
  | 'COLLECTED_VERIFIED'
  | 'REVERSAL_RECORDED'
  | 'REFUND_ADJUSTED'
  | 'CHARGEBACK_RECORDED';

export interface CustomsFeeSettlementFact {
  settlementId: string | null;
  organizationId: string;
  currency: string | null;
  /** 已验证的实际新增回款（decimal string）。 */
  verifiedAmount: string | null;
  /** 是否已有可信 Provider / 对账证据。 */
  verified: boolean;
}

export interface CustomsFeeCollectionAuthorization {
  /** 客户是否事先接受了 15% 服务协议并授权后续自动收款。 */
  active: boolean;
  /** 客户是否已撤销授权。 */
  revoked: boolean;
  /** 支付服务商是否支持后续自动收款。 */
  paymentMethodSupportsAutoCollection: boolean;
  /** 宿主是否已正式开闸（AUTO_COLLECTION 总开关）。 */
  hostAutoCollectionEnabled: boolean;
}

export interface CustomsFeeAdjustmentEntry {
  kind: 'REVERSAL' | 'REFUND_ADJUSTMENT' | 'CHARGEBACK_ADJUSTMENT';
  settlementId: string | null;
  amount: string;
  signedAmount: string;
  reason: CustomsFeeCollectionReason;
}

export interface CustomsFeeCollectionFact {
  /** 可信支付事实：实际收到的金额（decimal string）。 */
  collectedAmount: string | null;
  outcome: 'COLLECTED' | 'FAILED' | 'REFUNDED' | 'CHARGEBACK';
}

export interface CustomsFeeCollectionInput {
  settlement: CustomsFeeSettlementFact;
  authorization: CustomsFeeCollectionAuthorization;
  killSwitch: { engaged: boolean };
  billedSettlementIds: ReadonlySet<string>;
  collectionFact?: CustomsFeeCollectionFact;
  rateBps?: number;
}

export interface CustomsFeeCollectionResult {
  kind: 'CUSTOMS_SUCCESS_FEE_COLLECTION';
  version: string;
  state: CustomsFeeCollectionState;
  reasonCodes: readonly CustomsFeeCollectionReason[];
  rateBps: number;
  feeAmount: string | null;
  currency: string | null;
  basisSettlementId: string | null;
  remainingCollectible: string | null;
  adjustments: readonly CustomsFeeAdjustmentEntry[];
  autoCollection: 'HOLD' | 'AUTHORIZED';
  collectionInitiated: false;
  chargedAmount: null;
  paymentCaptured: false;
  storesCardData: false;
  productionCredentials: 'ABSENT';
}

function isPositiveAmount(value: string | null): value is string {
  if (value === null) return false;
  const normalized = normalizeDecimalAmount(value);
  if (normalized === null) return false;
  return compareDecimalAmounts(normalized, '0') === 1;
}

/**
 * 纯判定：给定服务端事实，返回该笔成功费当前所处的**唯一**状态。
 * 不发起扣款、不写库、不调用支付通道。
 */
export function evaluateCustomsSuccessFeeCollection(
  input: CustomsFeeCollectionInput,
): CustomsFeeCollectionResult {
  const rateBps = input.rateBps ?? CUSTOMS_SUCCESS_FEE_RATE_BPS;
  const base = {
    kind: 'CUSTOMS_SUCCESS_FEE_COLLECTION' as const,
    version: CUSTOMS_FEE_COLLECTION_VERSION,
    rateBps,
    currency: input.settlement.currency,
    basisSettlementId: input.settlement.settlementId,
    collectionInitiated: false as const,
    chargedAmount: null,
    paymentCaptured: false as const,
    storesCardData: false as const,
    productionCredentials: 'ABSENT' as const,
  };
  const calculated = (
    reasonCodes: readonly CustomsFeeCollectionReason[],
    feeAmount: string | null,
  ): CustomsFeeCollectionResult => ({
    ...base,
    state: 'SUCCESS_FEE_CALCULATED',
    reasonCodes,
    feeAmount,
    remainingCollectible: null,
    adjustments: [],
    autoCollection: 'HOLD',
  });

  // 1) 计费基础必须可信
  const reasons: CustomsFeeCollectionReason[] = [];
  if (!input.settlement.verified) reasons.push('SETTLEMENT_NOT_VERIFIED');
  if (input.settlement.settlementId === null) reasons.push('SETTLEMENT_REFERENCE_MISSING');
  if (!isPositiveAmount(input.settlement.verifiedAmount)) reasons.push('SETTLEMENT_AMOUNT_INVALID');
  if (input.settlement.currency === null) reasons.push('CURRENCY_MISMATCH');
  if (reasons.length > 0) {
    const provisional =
      input.settlement.verifiedAmount === null
        ? null
        : applyBpsFloorToCent(input.settlement.verifiedAmount, rateBps);
    return calculated(reasons, provisional);
  }

  const feeAmount = applyBpsFloorToCent(input.settlement.verifiedAmount as string, rateBps);
  if (feeAmount === null) return calculated(['SETTLEMENT_AMOUNT_INVALID'], null);

  // 2) 幂等：同一结算不得重复计费
  const settlementId = input.settlement.settlementId as string;
  if (input.billedSettlementIds.has(settlementId)) {
    return calculated(['DUPLICATE_FEE_SUPPRESSED'], feeAmount);
  }

  // 3) 应收成立
  const receivableReasons: CustomsFeeCollectionReason[] = ['RECEIVABLE_ESTABLISHED'];

  // 4a) 不具备自动收款能力 → 停在"应收账单"路径（生成应收账单与合规收款流程）
  const billingReasons: CustomsFeeCollectionReason[] = [];
  if (!input.authorization.hostAutoCollectionEnabled) {
    billingReasons.push('AUTO_COLLECTION_NOT_ENABLED');
  }
  if (!input.authorization.paymentMethodSupportsAutoCollection) {
    billingReasons.push('PAYMENT_METHOD_NOT_SUPPORTED');
  }
  if (billingReasons.length > 0) {
    return {
      ...base,
      state: 'SUCCESS_FEE_RECEIVABLE',
      reasonCodes: [...receivableReasons, ...billingReasons],
      feeAmount,
      remainingCollectible: feeAmount,
      adjustments: [],
      autoCollection: 'HOLD',
    };
  }

  // 4b) 具备自动收款能力，但授权/安全门禁未放行 → HOLD
  const holdReasons: CustomsFeeCollectionReason[] = [];
  if (input.killSwitch.engaged) holdReasons.push('KILL_SWITCH_ENGAGED');
  if (input.authorization.revoked) holdReasons.push('CUSTOMER_AUTHORIZATION_REVOKED');
  else if (!input.authorization.active) holdReasons.push('CUSTOMER_AUTHORIZATION_MISSING');
  if (holdReasons.length > 0) {
    return {
      ...base,
      state: 'PAYMENT_COLLECTION_HOLD',
      reasonCodes: [...receivableReasons, ...holdReasons],
      feeAmount,
      remainingCollectible: feeAmount,
      adjustments: [],
      autoCollection: 'HOLD',
    };
  }

  // 5) 门禁全开 → 授权可发起（仍然不由本模块发起）
  const authorized = (extra: readonly CustomsFeeCollectionReason[], remaining: string | null, adjustments: readonly CustomsFeeAdjustmentEntry[], state: CustomsFeeCollectionState): CustomsFeeCollectionResult => ({
    ...base,
    state,
    reasonCodes: [...receivableReasons, 'COLLECTION_AUTHORIZED', ...extra],
    feeAmount,
    remainingCollectible: remaining,
    adjustments,
    autoCollection: 'AUTHORIZED',
  });

  const fact = input.collectionFact;
  if (fact === undefined) {
    return authorized([], feeAmount, [], 'PAYMENT_COLLECTION_AUTHORIZED');
  }

  if (fact.outcome === 'FAILED') {
    return authorized(['COLLECTION_FAILED'], feeAmount, [], 'PAYMENT_COLLECTION_HOLD');
  }

  if (fact.outcome === 'REFUNDED' || fact.outcome === 'CHARGEBACK') {
    const kind =
      fact.outcome === 'REFUNDED' ? 'REFUND_ADJUSTMENT' : 'CHARGEBACK_ADJUSTMENT';
    const reason: CustomsFeeCollectionReason =
      fact.outcome === 'REFUNDED' ? 'REFUND_ADJUSTED' : 'CHARGEBACK_RECORDED';
    const adjustment: CustomsFeeAdjustmentEntry = {
      kind,
      settlementId,
      amount: feeAmount,
      signedAmount: subtractDecimalAmounts('0', feeAmount) ?? `-${feeAmount}`,
      reason,
    };
    return authorized(['REVERSAL_RECORDED', reason], '0.00', [adjustment], 'PAYMENT_COLLECTION_HOLD');
  }

  // 6) 实际到账：金额必须可信且不超过应收
  if (!isPositiveAmount(fact.collectedAmount)) {
    return authorized(['COLLECTION_AMOUNT_UNTRUSTED'], feeAmount, [], 'PAYMENT_COLLECTION_AUTHORIZED');
  }
  const collected = normalizeDecimalAmount(fact.collectedAmount as string) as string;
  if (compareDecimalAmounts(collected, feeAmount) === 1) {
    return authorized(['COLLECTION_AMOUNT_UNTRUSTED'], feeAmount, [], 'PAYMENT_COLLECTION_AUTHORIZED');
  }
  const remaining = subtractDecimalAmounts(feeAmount, collected) ?? '0.00';
  const fullyCollected = compareDecimalAmounts(remaining, '0') === 0;
  if (!fullyCollected) {
    return authorized(
      ['PARTIAL_COLLECTION_PENDING'],
      remaining,
      [
        {
          kind: 'REVERSAL',
          settlementId,
          amount: collected,
          signedAmount: subtractDecimalAmounts('0', collected) ?? `-${collected}`,
          reason: 'PARTIAL_COLLECTION_PENDING',
        },
      ],
      'PAYMENT_COLLECTION_AUTHORIZED',
    );
  }

  return {
    ...base,
    state: 'PAYMENT_COLLECTED',
    reasonCodes: [...receivableReasons, 'COLLECTION_AUTHORIZED', 'COLLECTED_VERIFIED'],
    feeAmount,
    remainingCollectible: '0.00',
    adjustments: [],
    autoCollection: 'AUTHORIZED',
  };
}

/** 应收合计（同币种内相加；跨币种一律返回 null，不做汇率换算）。 */
export function sumReceivablesSameCurrency(
  entries: readonly { currency: string | null; feeAmount: string | null }[],
): string | null {
  const currencies = new Set(entries.map((entry) => entry.currency));
  if (currencies.size !== 1 || currencies.has(null)) return null;
  let total = '0.00';
  for (const entry of entries) {
    if (entry.feeAmount === null) return null;
    total = addDecimalAmounts(total, entry.feeAmount) ?? '0.00';
  }
  return total;
}

/** 边界自证：本模块不持卡 / 不发起扣款 / 不调用支付通道 / 不自动收款。 */
export const CUSTOMS_FEE_COLLECTION_BOUNDARY = {
  storesCardData: false,
  initiatesCharge: false,
  collectionInitiated: false,
  paymentCaptured: false,
  autoCollectionDefault: 'HOLD',
  providerInvoked: false,
  chargedAmount: null,
  productionCredentials: 'ABSENT',
} as const;
