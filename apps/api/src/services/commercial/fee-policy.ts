/**
 * COMMERCIAL C10–C11（HOST DIRECTIVE 2026-10-03 + MSG-20261003-122 ㊱ + MSG-20261003-123 ⑦）
 * — 15% SUCCESS-FEE POLICY / ESTIMATED FEE PREVIEW / FEE GUARD（内部实现，不得扣款）。
 * ---------------------------------------------------------------
 * 不变式：
 *   · 只有 **verified actual incremental recovered** 才能产生应收成功费（fee due）；
 *     estimation（Queue #8 estimate）只能产生 **ESTIMATE_ONLY 预览**。
 *   · 费率只能来自 **服务端 versioned FeePolicy**；client 提供 rate → 一律拒绝。
 *   · 本模块不扣款、不收款、不发起支付通道调用：Payment = 0 · collection = OFF · autopay = OFF。
 */

export const FEE_BASIS_POINTS_DENOMINATOR = 10000;
export const SUCCESS_FEE_15_RATE_BPS = 1500;

export type FeePolicyKind =
  | 'STANDARD_SUCCESS'
  | 'CUSTOMS_SUCCESS'
  | 'CUSTOMS_VIP_WAIVER'
  | 'ENTERPRISE_CUSTOM_RATE'
  | 'MICRO_NOT_SERVICED';

export interface FeePolicy {
  policyId: string;
  policyKind: FeePolicyKind;
  version: string;
  /** bps（1500 = 15%）；非计费策略（waiver / micro）为 null。 */
  rateBps: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** 费率减免上限（decimal string；仅 waiver 策略使用）。 */
  waiverCapAmount: string | null;
  /** null = 任意币种；否则限定币种。 */
  currency: string | null;
  description: string;
}

/** 服务端策略注册表（versioned；client 不得提供费率或策略内容）。 */
export const FEE_POLICY_REGISTRY: readonly FeePolicy[] = [
  {
    policyId: 'STANDARD_SUCCESS_15',
    policyKind: 'STANDARD_SUCCESS',
    version: 'v1',
    rateBps: SUCCESS_FEE_15_RATE_BPS,
    effectiveFrom: '2026-10-01',
    effectiveTo: null,
    waiverCapAmount: null,
    currency: null,
    description: '标准追回成功费 15%（仅基于 verified actual incremental recovered）',
  },
  {
    policyId: 'CUSTOMS_SUCCESS_15',
    policyKind: 'CUSTOMS_SUCCESS',
    version: 'v1',
    rateBps: SUCCESS_FEE_15_RATE_BPS,
    effectiveFrom: '2026-10-01',
    effectiveTo: null,
    waiverCapAmount: null,
    currency: null,
    description: 'Customs 追回成功费 15%（同标准费率；不另开资金系统）',
  },
  {
    policyId: 'CUSTOMS_VIP_WAIVER',
    policyKind: 'CUSTOMS_VIP_WAIVER',
    version: 'v1',
    rateBps: null,
    effectiveFrom: '2026-10-01',
    effectiveTo: null,
    waiverCapAmount: '500.00',
    currency: null,
    description: '高价值 Customs 案件的平台/承运费减免（服务器配置 waiverCap；非成功费本身）',
  },
  {
    policyId: 'MICRO_NOT_SERVICED',
    policyKind: 'MICRO_NOT_SERVICED',
    version: 'v1',
    rateBps: null,
    effectiveFrom: '2026-10-01',
    effectiveTo: null,
    waiverCapAmount: null,
    currency: null,
    description: '低于 execution threshold 的 Micro Opportunity：免费展示、不进入高成本人工执行、不计费',
  },
];

export class FeePolicyNotFoundError extends Error {
  readonly code = 'FEE_POLICY_NOT_FOUND';
}
export class FeePolicyNotEffectiveError extends Error {
  readonly code = 'FEE_POLICY_NOT_EFFECTIVE';
}

/** 按 policyId + 时点解析服务端策略（版本化；过期即失败）。 */
export function resolveFeePolicy(policyId: string, at: string): FeePolicy {
  const policy = FEE_POLICY_REGISTRY.find((p) => p.policyId === policyId);
  if (!policy) throw new FeePolicyNotFoundError(policyId);
  if (at < policy.effectiveFrom) throw new FeePolicyNotEffectiveError(policyId);
  if (policy.effectiveTo !== null && at > policy.effectiveTo) throw new FeePolicyNotEffectiveError(policyId);
  return policy;
}

/** decimal string × bps / 10000，四舍五入到 2 位（BigInt，无浮点）。 */
export function applyRateBps(amount: string, rateBps: number): string {
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount)) throw new Error('INVALID_AMOUNT:' + amount);
  const [whole, fraction = ''] = amount.split('.');
  const scale = 6;
  const scaledAmount = BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale));
  // scaledAmount 已是 1e-6 定点；除以 bps 分母即可得到 1e-6 定点的费率结果
  const numerator = scaledAmount * BigInt(rateBps);
  const denominator = BigInt(FEE_BASIS_POINTS_DENOMINATOR);
  // 四舍五入（half-up）
  const rounded = (numerator * 2n + denominator) / (denominator * 2n);
  const cents = (rounded * 100n) / (10n ** BigInt(scale));
  const remainder = (rounded * 100n) % (10n ** BigInt(scale));
  const adjustedCents = remainder * 2n >= 10n ** BigInt(scale) ? cents + 1n : cents;
  const centsStr = adjustedCents.toString().padStart(3, '0');
  return centsStr.slice(0, -2) + '.' + centsStr.slice(-2);
}

export interface EstimatedFeePreview {
  amountLabel: 'ESTIMATE_ONLY';
  basis: 'ESTIMATED_RECOVERABLE';
  policyId: string;
  policyVersion: string;
  rateBps: number;
  estimatedFeeAmount: string | null;
  currency: string;
  /** 预览永不等于应收，也永不触发收款。 */
  billable: false;
  paymentCollectionPerformed: false;
  autopayEnabled: false;
}

/**
 * estimatedRecoverable → **预览**（ESTIMATE_ONLY）。rateBps 必须来自服务端策略解析结果。
 */
export function computeEstimatedFeePreview(input: {
  estimatedRecoverableAmount: string | null;
  currency: string;
  policy: FeePolicy;
}): EstimatedFeePreview {
  const rateBps = input.policy.rateBps;
  const preview: EstimatedFeePreview = {
    amountLabel: 'ESTIMATE_ONLY',
    basis: 'ESTIMATED_RECOVERABLE',
    policyId: input.policy.policyId,
    policyVersion: input.policy.version,
    rateBps: rateBps ?? 0,
    estimatedFeeAmount: null,
    currency: input.currency,
    billable: false,
    paymentCollectionPerformed: false,
    autopayEnabled: false,
  };
  if (rateBps === null) return preview;
  if (input.currency.length !== 3 || input.currency !== input.currency.toUpperCase()) return preview;
  if (input.estimatedRecoverableAmount === null) return preview;
  return { ...preview, estimatedFeeAmount: applyRateBps(input.estimatedRecoverableAmount, rateBps) };
}

/** verified actual incremental recovered 的真值来源（PC-05 / R45–R46 money truth）。 */
export interface VerifiedRecoveredMoneyTruth {
  settlementId: string;
  verifiedAmount: string;
  currency: string;
  confirmationStatus: 'CONFIRMED';
  reconciliationStatus: 'RECONCILED' | 'PARTIAL';
}

export interface SuccessFeeDue {
  billable: true;
  basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED';
  policyId: string;
  policyVersion: string;
  rateBps: number;
  feeAmount: string;
  currency: string;
  settlementId: string;
}

export type FeeGuardReason =
  | 'CLIENT_SUPPLIED_RATE_REJECTED'
  | 'ESTIMATE_NOT_BILLABLE'
  | 'NO_VERIFIED_RECOVERED_TRUTH'
  | 'POLICY_NOT_BILLABLE'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_AMOUNT';

export type FeeGuardDecision =
  | { allowed: true; fee: SuccessFeeDue }
  | { allowed: false; reasonCode: FeeGuardReason };

/**
 * 统一 fee guard（C11）：只有 verified recovered truth + 服务端策略才能产生 fee due。
 * 所有其它路径（estimate / client rate / waiver / micro / 币种不符 / 金额非法）一律 fail-closed。
 */
export function evaluateFeeGuard(input: {
  policy: FeePolicy;
  basis: 'ESTIMATED_RECOVERABLE' | 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED';
  verifiedRecovered: VerifiedRecoveredMoneyTruth | null;
  clientSuppliedRateBps?: number | null;
}): FeeGuardDecision {
  if (input.clientSuppliedRateBps !== undefined && input.clientSuppliedRateBps !== null) {
    return { allowed: false, reasonCode: 'CLIENT_SUPPLIED_RATE_REJECTED' };
  }
  if (input.basis !== 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED') {
    return { allowed: false, reasonCode: 'ESTIMATE_NOT_BILLABLE' };
  }
  if (input.verifiedRecovered === null) {
    return { allowed: false, reasonCode: 'NO_VERIFIED_RECOVERED_TRUTH' };
  }
  if (input.policy.rateBps === null) {
    return { allowed: false, reasonCode: 'POLICY_NOT_BILLABLE' };
  }
  if (input.policy.currency !== null && input.policy.currency !== input.verifiedRecovered.currency) {
    return { allowed: false, reasonCode: 'CURRENCY_MISMATCH' };
  }
  if (!/^\d+(?:\.\d{1,6})?$/.test(input.verifiedRecovered.verifiedAmount)) {
    return { allowed: false, reasonCode: 'INVALID_AMOUNT' };
  }
  return {
    allowed: true,
    fee: {
      billable: true,
      basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
      policyId: input.policy.policyId,
      policyVersion: input.policy.version,
      rateBps: input.policy.rateBps,
      feeAmount: applyRateBps(input.verifiedRecovered.verifiedAmount, input.policy.rateBps),
      currency: input.verifiedRecovered.currency,
      settlementId: input.verifiedRecovered.settlementId,
    },
  };
}

/** 边界自证：策略/预览层不做任何资金动作。 */
export const FEE_POLICY_BOUNDARY = {
  paymentCollectionPerformed: false,
  autopayEnabled: false,
  externalPaymentWrite: false,
  chargesCustomer: false,
  platformWriteEnabled: false,
  productionCredentials: 'ABSENT',
} as const;
