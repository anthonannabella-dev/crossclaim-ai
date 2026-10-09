/**
 * V2-05 — CUSTOMS UNLOCK PAYMENT（付费核验权益解锁核心 · server 权威 · fail-closed）
 * ---------------------------------------------------------------
 * 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE C。
 *
 * 不变式：
 *  1. 报价（quote）由**服务端**生成并版本化，带有效期；价格 / 币种 / 权益额度均服务端权威。
 *  2. 订单必须同时匹配 organizationId + opportunityId + productSku + 金额 + 币种，否则 HOLD。
 *  3. 支付通知必须完成 **HMAC-SHA256 验签 + 时间戳容忍窗**，并再次核对金额与币种。
 *  4. 事件幂等：同一 eventId 重复投递只发放一次权益（幂等由 eventId 与确定性 entitlementId 双重保证）。
 *  5. 权益只能在"验签通过 + 报价匹配"后发放；前端状态 / URL / 伪造回调**无法**解锁。
 *  6. 退款 / 取消 / 过期 / 争议必须有**一致**的权益处理，且未使用额度不得变成客户永久损失。
 *  7. `paymentsEnabled=false`（现有 Payment HOLD）→ 一律 HOLD，不发放权益。
 *  8. 本模块不持有卡数据、不发起扣款、不调用支付通道、不写库（存储以端口注入）。
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const CUSTOMS_UNLOCK_PAYMENT_VERSION = 'customs-unlock-payment-v2.0.0';

/** 建议草案价格（需按真实 Provider 成本复核后由宿主确认）。 */
export const CUSTOMS_UNLOCK_PRODUCTS = [
  {
    sku: 'CUSTOMS_SINGLE_REVIEW',
    displayName: 'Customs single review',
    priceMinor: 3900,
    currency: 'USD',
    quota: 1,
    billingMode: 'ONE_TIME',
  },
  {
    sku: 'CUSTOMS_PLUS_MONTHLY',
    displayName: 'Customs Plus (monthly)',
    priceMinor: 4900,
    currency: 'USD',
    quota: 3,
    billingMode: 'SUBSCRIPTION_MONTHLY',
  },
] as const;
export type CustomsUnlockProductSku = (typeof CUSTOMS_UNLOCK_PRODUCTS)[number]['sku'];
export type CustomsUnlockProduct = (typeof CUSTOMS_UNLOCK_PRODUCTS)[number];

export const CUSTOMS_SUCCESS_FEE_RATE_BPS = 1500;

/** 必须向客户逐条披露的条款（PHASE B §5–§7）。 */
export const CUSTOMS_UNLOCK_DISCLOSURES = [
  'SUCCESS_FEE_15_PERCENT_ON_ACTUAL_RECOVERY',
  'SUCCESS_FEE_ONLY_AFTER_VERIFIED_COLLECTION',
  'SERVICE_FEE_AND_SUCCESS_FEE_ARE_SEPARATE_CHARGES',
  'NO_GUARANTEE_OF_CUSTOMS_REFUND',
  'THIRD_PARTY_COSTS_MAY_APPLY',
  'REFUND_AND_CANCELLATION_TERMS',
] as const;
export type CustomsUnlockDisclosure = (typeof CUSTOMS_UNLOCK_DISCLOSURES)[number];

export function findCustomsUnlockProduct(sku: string): CustomsUnlockProduct | null {
  return CUSTOMS_UNLOCK_PRODUCTS.find((product) => product.sku === sku) ?? null;
}

export interface CustomsUnlockQuote {
  kind: 'CUSTOMS_UNLOCK_QUOTE';
  version: string;
  quoteId: string;
  quoteVersion: string;
  organizationId: string;
  opportunityId: string;
  productSku: CustomsUnlockProductSku;
  priceMinor: number;
  currency: string;
  quota: number;
  billingMode: CustomsUnlockProduct['billingMode'];
  issuedAt: string;
  expiresAt: string;
  successFeeRateBps: number;
  disclosures: readonly CustomsUnlockDisclosure[];
  /** 报价本身不代表收款。 */
  paymentCaptured: false;
  storesCardData: false;
}

export interface IssueCustomsUnlockQuoteInput {
  organizationId: string;
  opportunityId: string;
  productSku: string;
  now: Date;
  /** 报价有效期（分钟），缺省 30。 */
  ttlMinutes?: number;
  quoteVersion?: string;
  /** 可注入（测试确定性）；缺省使用随机 UUID。 */
  quoteIdFactory?: () => string;
}

export class CustomsUnlockError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}:${detail}`);
    this.name = 'CustomsUnlockError';
    this.code = code;
  }
}

export function issueCustomsUnlockQuote(input: IssueCustomsUnlockQuoteInput): CustomsUnlockQuote {
  const product = findCustomsUnlockProduct(input.productSku);
  if (product === null) {
    throw new CustomsUnlockError('UNKNOWN_PRODUCT_SKU', input.productSku);
  }
  if (input.organizationId.trim().length === 0 || input.opportunityId.trim().length === 0) {
    throw new CustomsUnlockError('QUOTE_SCOPE_REQUIRED', 'organizationId/opportunityId');
  }
  const ttlMinutes = input.ttlMinutes ?? 30;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0) {
    throw new CustomsUnlockError('QUOTE_TTL_INVALID', String(ttlMinutes));
  }
  const expiresAt = new Date(input.now.getTime() + ttlMinutes * 60_000);
  return {
    kind: 'CUSTOMS_UNLOCK_QUOTE',
    version: CUSTOMS_UNLOCK_PAYMENT_VERSION,
    quoteId: (input.quoteIdFactory ?? randomUUID)(),
    quoteVersion: input.quoteVersion ?? 'v1',
    organizationId: input.organizationId,
    opportunityId: input.opportunityId,
    productSku: product.sku,
    priceMinor: product.priceMinor,
    currency: product.currency,
    quota: product.quota,
    billingMode: product.billingMode,
    issuedAt: input.now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    successFeeRateBps: CUSTOMS_SUCCESS_FEE_RATE_BPS,
    disclosures: CUSTOMS_UNLOCK_DISCLOSURES,
    paymentCaptured: false,
    storesCardData: false,
  };
}

export type CustomsUnlockOrderReason =
  | 'ORDER_VALID'
  | 'QUOTE_EXPIRED'
  | 'ORG_MISMATCH'
  | 'OPPORTUNITY_MISMATCH'
  | 'PRODUCT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH';

export interface CustomsUnlockOrderInput {
  quote: CustomsUnlockQuote;
  order: {
    organizationId: string;
    opportunityId: string;
    productSku: string;
    amountMinor: number;
    currency: string;
  };
  now: Date;
}

export interface CustomsUnlockOrderVerdict {
  valid: boolean;
  reasonCodes: readonly CustomsUnlockOrderReason[];
  /** 服务端权威报价；客户端传来的价格一律忽略。 */
  serverPriceMinor: number;
  serverQuota: number;
}

/** 订单校验：客户端无法通过改价 / 换租户 / 换机会 / 换商品来解锁。 */
export function validateCustomsUnlockOrder(input: CustomsUnlockOrderInput): CustomsUnlockOrderVerdict {
  const reasons: CustomsUnlockOrderReason[] = [];
  if (Date.parse(input.quote.expiresAt) <= input.now.getTime()) reasons.push('QUOTE_EXPIRED');
  if (input.order.organizationId !== input.quote.organizationId) reasons.push('ORG_MISMATCH');
  if (input.order.opportunityId !== input.quote.opportunityId) reasons.push('OPPORTUNITY_MISMATCH');
  if (input.order.productSku !== input.quote.productSku) reasons.push('PRODUCT_MISMATCH');
  if (input.order.amountMinor !== input.quote.priceMinor) reasons.push('AMOUNT_MISMATCH');
  if (input.order.currency !== input.quote.currency) reasons.push('CURRENCY_MISMATCH');
  const valid = reasons.length === 0;
  if (valid) reasons.push('ORDER_VALID');
  return {
    valid,
    reasonCodes: reasons,
    serverPriceMinor: input.quote.priceMinor,
    serverQuota: input.quote.quota,
  };
}

export const CUSTOMS_PAYMENT_EVENT_TYPES = [
  'PAYMENT_SUCCEEDED',
  'PAYMENT_REFUNDED',
  'SUBSCRIPTION_CANCELED',
  'CHARGEBACK_OPENED',
] as const;
export type CustomsPaymentEventType = (typeof CUSTOMS_PAYMENT_EVENT_TYPES)[number];

export interface CustomsPaymentNotification {
  eventId: string;
  eventType: CustomsPaymentEventType;
  quoteId: string;
  organizationId: string;
  opportunityId: string;
  productSku: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
}

export type CustomsWebhookReason =
  | 'SIGNATURE_VALID'
  | 'SECRET_NOT_CONFIGURED'
  | 'SIGNATURE_HEADER_MISSING'
  | 'TIMESTAMP_HEADER_MISSING'
  | 'TIMESTAMP_OUT_OF_TOLERANCE'
  | 'SIGNATURE_MISMATCH'
  | 'PAYLOAD_MALFORMED';

export interface VerifyCustomsWebhookInput {
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  secret: string | null;
  now: Date;
  /** 时间戳容忍窗（秒），缺省 300。 */
  toleranceSeconds?: number;
}

export interface VerifyCustomsWebhookResult {
  verified: boolean;
  reasonCodes: readonly CustomsWebhookReason[];
  payload: CustomsPaymentNotification | null;
  /**
   * V2-R1 / CHANGE 02：**只有验签成功分支**才会产出可信证据。
   * 权益发放只接受本对象，普通调用方无法构造（品牌为模块私有 Symbol）。
   */
  evidence?: VerifiedPaymentEvidence | null;
}

const VERIFIED_PAYMENT_BRAND: unique symbol = Symbol('crossclaim.customs.verifiedPaymentEvidence');

/**
 * 不可伪造的支付证据：品牌键为模块私有 Symbol，外部无法构造等价对象；
 * 运行时另有 `isVerifiedPaymentEvidence()` 兜底（即使被 `as any` 强转也会被拒）。
 */
export interface VerifiedPaymentEvidence {
  readonly [VERIFIED_PAYMENT_BRAND]: true;
  readonly notification: CustomsPaymentNotification;
  readonly verifiedAt: string;
  readonly signatureScheme: 'HMAC_SHA256_TS_BODY';
}

export function isVerifiedPaymentEvidence(value: unknown): value is VerifiedPaymentEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string | symbol, unknown>;
  return record[VERIFIED_PAYMENT_BRAND] === true && typeof record.notification === 'object';
}

function buildVerifiedEvidence(
  notification: CustomsPaymentNotification,
  now: Date,
): VerifiedPaymentEvidence {
  return {
    [VERIFIED_PAYMENT_BRAND]: true,
    notification,
    verifiedAt: now.toISOString(),
    signatureScheme: 'HMAC_SHA256_TS_BODY',
  };
}

export function signCustomsWebhookBody(timestamp: string, rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function parseNotification(rawBody: string): CustomsPaymentNotification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const eventType = record.eventType;
  if (typeof eventType !== 'string' || !(CUSTOMS_PAYMENT_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return null;
  }
  const required: readonly string[] = [
    'eventId',
    'quoteId',
    'organizationId',
    'opportunityId',
    'productSku',
    'currency',
    'occurredAt',
  ];
  for (const key of required) {
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) return null;
  }
  if (typeof record.amountMinor !== 'number' || !Number.isInteger(record.amountMinor)) return null;
  return {
    eventId: record.eventId as string,
    eventType: eventType as CustomsPaymentEventType,
    quoteId: record.quoteId as string,
    organizationId: record.organizationId as string,
    opportunityId: record.opportunityId as string,
    productSku: record.productSku as string,
    amountMinor: record.amountMinor,
    currency: record.currency as string,
    occurredAt: record.occurredAt as string,
  };
}

/** 验签：HMAC-SHA256(`ts.body`) + 时间戳容忍窗 + 载荷结构校验。任一步失败 → verified=false。 */
export function verifyCustomsPaymentNotification(
  input: VerifyCustomsWebhookInput,
): VerifyCustomsWebhookResult {
  const reasons: CustomsWebhookReason[] = [];
  if (input.secret === null || input.secret.length === 0) {
    return { verified: false, reasonCodes: ['SECRET_NOT_CONFIGURED'], payload: null };
  }
  if (input.signatureHeader === null || input.signatureHeader.length === 0) {
    reasons.push('SIGNATURE_HEADER_MISSING');
  }
  if (input.timestampHeader === null || input.timestampHeader.length === 0) {
    reasons.push('TIMESTAMP_HEADER_MISSING');
  }
  if (reasons.length > 0) return { verified: false, reasonCodes: reasons, payload: null };

  const tolerance = input.toleranceSeconds ?? 300;
  const timestampSeconds = Number(input.timestampHeader);
  if (!Number.isFinite(timestampSeconds)) {
    return { verified: false, reasonCodes: ['TIMESTAMP_OUT_OF_TOLERANCE'], payload: null };
  }
  const skewSeconds = Math.abs(input.now.getTime() / 1000 - timestampSeconds);
  if (skewSeconds > tolerance) {
    return { verified: false, reasonCodes: ['TIMESTAMP_OUT_OF_TOLERANCE'], payload: null };
  }

  const expected = signCustomsWebhookBody(input.timestampHeader as string, input.rawBody, input.secret);
  const provided = input.signatureHeader as string;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return { verified: false, reasonCodes: ['SIGNATURE_MISMATCH'], payload: null };
  }

  const payload = parseNotification(input.rawBody);
  if (payload === null) {
    return { verified: false, reasonCodes: ['PAYLOAD_MALFORMED'], payload: null };
  }
  return {
    verified: true,
    reasonCodes: ['SIGNATURE_VALID'],
    payload,
    evidence: buildVerifiedEvidence(payload, input.now),
  };
}

export type CustomsEntitlementStatus = 'ACTIVE' | 'REVOKED' | 'CANCELED' | 'EXPIRED';

export interface CustomsUnlockEntitlement {
  entitlementId: string;
  organizationId: string;
  opportunityId: string;
  productSku: string;
  quotaTotal: number;
  quotaRemaining: number;
  status: CustomsEntitlementStatus;
  grantedAt: string;
  updatedAt: string;
  quoteId: string;
}

export type CustomsGrantOutcome =
  | 'ENTITLEMENT_GRANTED'
  | 'DUPLICATE_IGNORED'
  | 'HOLD';

export type CustomsGrantReason =
  | 'GRANT_OK'
  | 'PAYMENTS_HOLD'
  | 'UNVERIFIED_PAYMENT_EVIDENCE'
  | 'QUOTE_EXPIRED'
  | 'EVENT_NOT_PAYMENT_SUCCEEDED'
  | 'QUOTE_ID_MISMATCH'
  | 'ORG_MISMATCH'
  | 'OPPORTUNITY_MISMATCH'
  | 'PRODUCT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_EVENT';

export interface ApplyPaymentEventInput {
  /** V2-R1 / CHANGE 02：只接受验签流程产出的证据，不再接受裸 notification。 */
  evidence: VerifiedPaymentEvidence;
  quote: CustomsUnlockQuote;
  processedEventIds: ReadonlySet<string>;
  now: Date;
  paymentsEnabled: boolean;
}

export interface ApplyPaymentEventResult {
  outcome: CustomsGrantOutcome;
  reasonCodes: readonly CustomsGrantReason[];
  entitlement: CustomsUnlockEntitlement | null;
  /** 本模块永不自行扣款。 */
  paymentCaptured: false;
}

/**
 * 幂等发放：`entitlementId` 由 quoteId 确定性派生，同一报价重复回调不会产生第二份权益。
 */
export function applyVerifiedPaymentEvent(
  input: ApplyPaymentEventInput,
): ApplyPaymentEventResult {
  // CHANGE 02：先证明证据可信（运行时兜底，防止 as any 绕过编译期品牌）
  if (!isVerifiedPaymentEvidence(input.evidence)) {
    return {
      outcome: 'HOLD',
      reasonCodes: ['UNVERIFIED_PAYMENT_EVIDENCE'],
      entitlement: null,
      paymentCaptured: false,
    };
  }
  if (!input.paymentsEnabled) {
    return {
      outcome: 'HOLD',
      reasonCodes: ['PAYMENTS_HOLD'],
      entitlement: null,
      paymentCaptured: false,
    };
  }
  const notification = input.evidence.notification;
  const reasons: CustomsGrantReason[] = [];
  if (Date.parse(input.quote.expiresAt) <= input.now.getTime()) {
    return {
      outcome: 'HOLD',
      reasonCodes: ['QUOTE_EXPIRED'],
      entitlement: null,
      paymentCaptured: false,
    };
  }
  if (notification.eventType !== 'PAYMENT_SUCCEEDED') {
    return {
      outcome: 'HOLD',
      reasonCodes: ['EVENT_NOT_PAYMENT_SUCCEEDED'],
      entitlement: null,
      paymentCaptured: false,
    };
  }
  if (notification.quoteId !== input.quote.quoteId) reasons.push('QUOTE_ID_MISMATCH');
  if (notification.organizationId !== input.quote.organizationId) reasons.push('ORG_MISMATCH');
  if (notification.opportunityId !== input.quote.opportunityId) {
    reasons.push('OPPORTUNITY_MISMATCH');
  }
  if (notification.productSku !== input.quote.productSku) reasons.push('PRODUCT_MISMATCH');
  if (notification.amountMinor !== input.quote.priceMinor) reasons.push('AMOUNT_MISMATCH');
  if (notification.currency !== input.quote.currency) reasons.push('CURRENCY_MISMATCH');
  if (reasons.length > 0) {
    return { outcome: 'HOLD', reasonCodes: reasons, entitlement: null, paymentCaptured: false };
  }

  const entitlementId = `ent-${input.quote.quoteId}`;
  if (input.processedEventIds.has(notification.eventId)) {
    return {
      outcome: 'DUPLICATE_IGNORED',
      reasonCodes: ['DUPLICATE_EVENT'],
      entitlement: null,
      paymentCaptured: false,
    };
  }

  return {
    outcome: 'ENTITLEMENT_GRANTED',
    reasonCodes: ['GRANT_OK'],
    entitlement: {
      entitlementId,
      organizationId: input.quote.organizationId,
      opportunityId: input.quote.opportunityId,
      productSku: input.quote.productSku,
      quotaTotal: input.quote.quota,
      quotaRemaining: input.quote.quota,
      status: 'ACTIVE',
      grantedAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
      quoteId: input.quote.quoteId,
    },
    paymentCaptured: false,
  };
}

export type CustomsEntitlementLifecycleEvent =
  | 'PAYMENT_REFUNDED'
  | 'SUBSCRIPTION_CANCELED'
  | 'PERIOD_EXPIRED'
  | 'CHARGEBACK_OPENED';

export interface ApplyEntitlementLifecycleInput {
  entitlement: CustomsUnlockEntitlement;
  event: CustomsEntitlementLifecycleEvent;
  now: Date;
}

export interface ApplyEntitlementLifecycleResult {
  entitlement: CustomsUnlockEntitlement;
  reasonCodes: readonly string[];
  /** 未使用额度的处置（退款 / 额度恢复政策）。 */
  unusedQuotaDisposition:
    | 'REVOKED_ALL'
    | 'RETAINED_UNTIL_PERIOD_END'
    | 'REFUND_ELIGIBLE_FOR_UNUSED';
}

/** 一致的生命周期处理：退款 / 取消 / 过期 / 争议。 */
export function applyEntitlementLifecycle(
  input: ApplyEntitlementLifecycleInput,
): ApplyEntitlementLifecycleResult {
  const nowIso = input.now.toISOString();
  switch (input.event) {
    case 'PAYMENT_REFUNDED':
      return {
        entitlement: {
          ...input.entitlement,
          quotaRemaining: 0,
          status: 'REVOKED',
          updatedAt: nowIso,
        },
        reasonCodes: ['REFUND_REVOKES_REMAINING_QUOTA'],
        unusedQuotaDisposition: 'REFUND_ELIGIBLE_FOR_UNUSED',
      };
    case 'CHARGEBACK_OPENED':
      return {
        entitlement: {
          ...input.entitlement,
          quotaRemaining: 0,
          status: 'REVOKED',
          updatedAt: nowIso,
        },
        reasonCodes: ['CHARGEBACK_REVOKES_REMAINING_QUOTA'],
        unusedQuotaDisposition: 'REVOKED_ALL',
      };
    case 'SUBSCRIPTION_CANCELED':
      return {
        entitlement: { ...input.entitlement, status: 'CANCELED', updatedAt: nowIso },
        reasonCodes: ['CANCEL_STOPS_RENEWAL_KEEPS_PAID_QUOTA'],
        unusedQuotaDisposition: 'RETAINED_UNTIL_PERIOD_END',
      };
    case 'PERIOD_EXPIRED':
      return {
        entitlement: {
          ...input.entitlement,
          quotaRemaining: 0,
          status: 'EXPIRED',
          updatedAt: nowIso,
        },
        reasonCodes: ['PERIOD_ENDED'],
        unusedQuotaDisposition: 'REVOKED_ALL',
      };
  }
}

/** 消费一次核验额度（并发安全由调用方所在事务保证；此处只做纯扣减与下限保护）。 */
export function consumeEntitlementQuota(
  entitlement: CustomsUnlockEntitlement,
): { allowed: boolean; entitlement: CustomsUnlockEntitlement } {
  if (entitlement.status !== 'ACTIVE' || entitlement.quotaRemaining <= 0) {
    return { allowed: false, entitlement };
  }
  return {
    allowed: true,
    entitlement: { ...entitlement, quotaRemaining: entitlement.quotaRemaining - 1 },
  };
}

/** 是否应提示客户购买（已购且额度足够的用户不得被重复要求购买同一服务）。 */
export function shouldOfferCustomsUnlock(
  existing: CustomsUnlockEntitlement | null,
  productSku: string,
): boolean {
  if (existing === null) return true;
  if (existing.productSku !== productSku) return true;
  if (existing.status !== 'ACTIVE') return true;
  return existing.quotaRemaining <= 0;
}

/** 边界自证：本模块不持有卡数据、不发起扣款、不调用支付通道。 */
export const CUSTOMS_UNLOCK_PAYMENT_BOUNDARY = {
  storesCardData: false,
  initiatesCharge: false,
  paymentCaptured: false,
  providerInvoked: false,
  externalCallPerformed: false,
  autoCollectionEnabled: false,
  productionCredentials: 'ABSENT',
} as const;
