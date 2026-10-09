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

import { applyBpsFloorToCent, addDecimalAmounts, subtractDecimalAmounts } from './customs-profit-gate';
import { compareDecimalAmounts, normalizeDecimalAmount } from './customs-paid-api-gate';
import type { FeePolicy } from '../commercial/fee-policy';
import { createHmac, timingSafeEqual } from 'node:crypto';

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
  | 'FEE_POLICY_MISSING'
  | 'FEE_POLICY_RATE_MISSING'
  | 'FEE_POLICY_VERSION_REQUIRED'
  | 'FEE_POLICY_NOT_EFFECTIVE'
  | 'FEE_POLICY_RATE_OUT_OF_RANGE'
  | 'HISTORY_SOURCE_UNTRUSTED'
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
  | 'COLLECTION_FACT_UNTRUSTED'
  | 'COLLECTION_FACT_RECEIVABLE_MISMATCH'
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
  kind: 'PARTIAL_COLLECTION' | 'REVERSAL' | 'REFUND_ADJUSTMENT' | 'CHARGEBACK_ADJUSTMENT';
  settlementId: string | null;
  amount: string;
  signedAmount: string;
  reason: CustomsFeeCollectionReason;
}

/** 只有这两类来源可被视为可信收款事实（人工录入、客户端上报一律不算）。 */
export const CUSTOMS_TRUSTED_COLLECTION_SOURCES = [
  'PAYMENT_PROVIDER_WEBHOOK',
  'RECONCILIATION',
] as const;
export type CustomsTrustedCollectionSource = (typeof CUSTOMS_TRUSTED_COLLECTION_SOURCES)[number];

/** 调用方提供的**原始**收款事实（未经核验，不可直接驱动 COLLECTED）。 */
export interface CustomsFeeCollectionFact {
  transactionId: string | null;
  merchantAccountId: string | null;
  receivableId: string | null;
  currency: string | null;
  collectedAmount: string | null;
  outcome: 'COLLECTED' | 'FAILED' | 'REFUNDED' | 'CHARGEBACK';
  source: string | null;
  occurredAt: string | null;
}

const VERIFIED_COLLECTION_BRAND: unique symbol = Symbol('crossclaim.customs.verifiedCollectionFact');

/** 经核验的收款事实：品牌为模块私有 Symbol，只能由 verifyFeeCollectionFact 产出。 */
export interface VerifiedFeeCollectionFact extends CustomsFeeCollectionFact {
  readonly [VERIFIED_COLLECTION_BRAND]: true;
  readonly source: CustomsTrustedCollectionSource;
}

export function isVerifiedFeeCollectionFact(value: unknown): value is VerifiedFeeCollectionFact {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string | symbol, unknown>;
  return (
    record[VERIFIED_COLLECTION_BRAND] === true &&
    (CUSTOMS_TRUSTED_COLLECTION_SOURCES as readonly string[]).includes(record.source as string)
  );
}

export type CollectionAuthenticationReason =
  | 'COLLECTION_SECRET_NOT_CONFIGURED'
  | 'COLLECTION_SIGNATURE_MISSING'
  | 'COLLECTION_TIMESTAMP_MISSING'
  | 'COLLECTION_TIMESTAMP_OUT_OF_TOLERANCE'
  | 'COLLECTION_SIGNATURE_MISMATCH'
  | 'COLLECTION_PAYLOAD_MALFORMED'
  | 'COLLECTION_MERCHANT_BINDING_REQUIRED'
  | 'COLLECTION_RECEIVABLE_MISMATCH'
  | 'COLLECTION_CURRENCY_MISMATCH';

export interface AuthenticateCollectionFactInput {
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  secret: string | null;
  now: Date;
  toleranceSeconds?: number;
  /** 绑定预期：全部**必填**（CHANGE 10：不允许"预期缺失就跳过校验"）。 */
  expectedReceivableId: string;
  expectedMerchantAccountId: string;
  expectedCurrency: string;
}

export interface AuthenticateCollectionFactResult {
  verified: boolean;
  reasonCodes: readonly CollectionAuthenticationReason[];
  fact: VerifiedFeeCollectionFact | null;
}

function parseCollectionPayload(rawBody: string): CustomsFeeCollectionFact | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const outcome = record.outcome;
  if (
    outcome !== 'COLLECTED' &&
    outcome !== 'FAILED' &&
    outcome !== 'REFUNDED' &&
    outcome !== 'CHARGEBACK'
  ) {
    return null;
  }
  for (const key of ['transactionId', 'merchantAccountId', 'receivableId', 'currency', 'source', 'occurredAt'] as const) {
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) return null;
  }
  const collectedAmount = record.collectedAmount;
  if (collectedAmount !== null && typeof collectedAmount !== 'string') return null;
  return {
    transactionId: record.transactionId as string,
    merchantAccountId: record.merchantAccountId as string,
    receivableId: record.receivableId as string,
    currency: record.currency as string,
    collectedAmount: collectedAmount as string | null,
    outcome,
    source: record.source as string,
    occurredAt: record.occurredAt as string,
  };
}

/**
 * CHANGE 10：**唯一**可信收款事实的产出边界。
 * 必须先通过 HMAC-SHA256(timestamp.body) 验签（独立于调用方声明），再做归属绑定；
 * 商户/应收/币种预期缺失或为空 → 一律拒绝（不得跳过校验）。
 */
export function authenticateCollectionFact(
  input: AuthenticateCollectionFactInput,
): AuthenticateCollectionFactResult {
  const reject = (
    reason: CollectionAuthenticationReason,
  ): AuthenticateCollectionFactResult => ({ verified: false, reasonCodes: [reason], fact: null });

  if (input.expectedMerchantAccountId.trim().length === 0) {
    return reject('COLLECTION_MERCHANT_BINDING_REQUIRED');
  }
  if (input.secret === null || input.secret.length === 0) {
    return reject('COLLECTION_SECRET_NOT_CONFIGURED');
  }
  if (input.signatureHeader === null || input.signatureHeader.length === 0) {
    return reject('COLLECTION_SIGNATURE_MISSING');
  }
  if (input.timestampHeader === null || input.timestampHeader.length === 0) {
    return reject('COLLECTION_TIMESTAMP_MISSING');
  }
  const tolerance = input.toleranceSeconds ?? 300;
  const timestampSeconds = Number(input.timestampHeader);
  if (!Number.isFinite(timestampSeconds) || Math.abs(input.now.getTime() / 1000 - timestampSeconds) > tolerance) {
    return reject('COLLECTION_TIMESTAMP_OUT_OF_TOLERANCE');
  }
  const expectedSignature = createHmac('sha256', input.secret)
    .update(`${input.timestampHeader}.${input.rawBody}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const providedBuffer = Buffer.from(input.signatureHeader, 'utf8');
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return reject('COLLECTION_SIGNATURE_MISMATCH');
  }

  const fact = parseCollectionPayload(input.rawBody);
  if (fact === null) return reject('COLLECTION_PAYLOAD_MALFORMED');
  if (!(CUSTOMS_TRUSTED_COLLECTION_SOURCES as readonly string[]).includes(fact.source ?? '')) {
    return reject('COLLECTION_PAYLOAD_MALFORMED');
  }
  if (fact.receivableId !== input.expectedReceivableId) return reject('COLLECTION_RECEIVABLE_MISMATCH');
  if (fact.merchantAccountId !== input.expectedMerchantAccountId) return reject('COLLECTION_RECEIVABLE_MISMATCH');
  if (fact.currency !== input.expectedCurrency) return reject('COLLECTION_CURRENCY_MISMATCH');
  return {
    verified: true,
    reasonCodes: [],
    fact: {
      ...fact,
      source: fact.source as CustomsTrustedCollectionSource,
      [VERIFIED_COLLECTION_BRAND]: true,
    },
  };
}

/** 签名助手（供适配器与测试构造真实签名）。 */
export function signCollectionFactBody(timestamp: string, rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export interface CustomsFeeCollectionInput {
  settlement: CustomsFeeSettlementFact;
  authorization: CustomsFeeCollectionAuthorization;
  killSwitch: { engaged: boolean };
  billedSettlementIds: ReadonlySet<string>;
  /** CHANGE 03：只接受经核验的收款事实（品牌类型，无法自行构造）。 */
  collectionFact?: VerifiedFeeCollectionFact;
  /** 已入账的历史收款/退款合计（来自台账，不受当前授权状态影响）。 */
  /** V2-R2 / CHANGE 13：历史金额必须来自**可信台账**，不接受任意传入汇总数。 */
  ledger?: {
    source: 'LEDGER' | 'PROVIDER_RECONCILIATION_LEDGER';
    collectedAmount: string;
    refundedAmount: string;
  };
  /** CHANGE 07：费率只能来自服务端版本化费率策略（`CUSTOMS_SUCCESS_15`），不接受任意输入值。 */
  feePolicy: FeePolicy | null;
  /** V2-R2 / CHANGE 13：判定日（YYYY-MM-DD），用于校验费率策略有效期。 */
  asOfDate: string;
}

export const CUSTOMS_TRUSTED_LEDGER_SOURCES = [
  'LEDGER',
  'PROVIDER_RECONCILIATION_LEDGER',
] as const;

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
  /** HISTORICAL：已发生并被核验的收款合计，客户撤销授权**不会**抹除它。 */
  historicalCollectedAmount: string;
  /** 是否仍可对**未来**收款发起自动扣款（撤销授权后为 false）。 */
  collectionAuthorizedForFuture: boolean;
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

/** 展示用格式：至少两位小数（最多保留 4 位，**不做截断或四舍五入**）。 */
function formatAtLeastTwoDecimals(amount: string | null): string {
  const normalized = amount === null ? null : normalizeDecimalAmount(amount);
  if (normalized === null) return '0.00';
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length === 0) return `${whole}.00`;
  return fraction.length === 1 ? `${whole}.${fraction}0` : `${whole}.${fraction}`;
}

/**
 * 纯判定：给定服务端事实，返回该笔成功费当前所处的**唯一**状态。
 * 不发起扣款、不写库、不调用支付通道。
 */
export function evaluateCustomsSuccessFeeCollection(
  input: CustomsFeeCollectionInput,
): CustomsFeeCollectionResult {
  // CHANGE 07：费率解析必须先于任何金额计算；策略缺失/无费率一律不得计费。
  const feePolicy = input.feePolicy;
  const rateBps =
    feePolicy === null || feePolicy.rateBps === null
      ? 0
      : feePolicy.rateBps;
  const base = {
    kind: 'CUSTOMS_SUCCESS_FEE_COLLECTION' as const,
    version: CUSTOMS_FEE_COLLECTION_VERSION,
    rateBps,
    currency: input.settlement.currency,
    basisSettlementId: input.settlement.settlementId,
    historicalCollectedAmount:
      input.ledger === undefined ||
      !(CUSTOMS_TRUSTED_LEDGER_SOURCES as readonly string[]).includes(input.ledger.source)
        ? '0.00'
        : formatAtLeastTwoDecimals(input.ledger.collectedAmount),
    collectionAuthorizedForFuture: false,
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

  if (feePolicy === null) return calculated(['FEE_POLICY_MISSING'], null);
  if (feePolicy.rateBps === null) return calculated(['FEE_POLICY_RATE_MISSING'], null);
  if (feePolicy.policyId.trim().length === 0 || feePolicy.version.trim().length === 0) {
    return calculated(['FEE_POLICY_VERSION_REQUIRED'], null);
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate) ||
    feePolicy.effectiveFrom > input.asOfDate ||
    (feePolicy.effectiveTo !== null && input.asOfDate > feePolicy.effectiveTo)
  ) {
    return calculated(['FEE_POLICY_NOT_EFFECTIVE'], null);
  }
  if (
    !Number.isInteger(feePolicy.rateBps) ||
    feePolicy.rateBps <= 0 ||
    feePolicy.rateBps > 10000
  ) {
    return calculated(['FEE_POLICY_RATE_OUT_OF_RANGE'], null);
  }
  if (
    feePolicy.currency !== null &&
    input.settlement.currency !== null &&
    feePolicy.currency !== input.settlement.currency
  ) {
    return calculated(['CURRENCY_MISMATCH'], null);
  }
  if (
    input.ledger !== undefined &&
    !(CUSTOMS_TRUSTED_LEDGER_SOURCES as readonly string[]).includes(input.ledger.source)
  ) {
    return calculated(['HISTORY_SOURCE_UNTRUSTED'], null);
  }

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
    collectionAuthorizedForFuture: state === 'PAYMENT_COLLECTION_AUTHORIZED',
  });

  const fact = input.collectionFact;
  if (fact === undefined) {
    return authorized([], feeAmount, [], 'PAYMENT_COLLECTION_AUTHORIZED');
  }
  // CHANGE 03：伪造 / 未核验 / 归属不符的收款事实一律不得驱动 COLLECTED
  if (!isVerifiedFeeCollectionFact(fact)) {
    return authorized(['COLLECTION_FACT_UNTRUSTED'], feeAmount, [], 'PAYMENT_COLLECTION_AUTHORIZED');
  }
  if (fact.receivableId !== settlementId) {
    return authorized(
      ['COLLECTION_FACT_RECEIVABLE_MISMATCH'],
      feeAmount,
      [],
      'PAYMENT_COLLECTION_AUTHORIZED',
    );
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
          kind: 'PARTIAL_COLLECTION',
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
    collectionAuthorizedForFuture: false,
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
