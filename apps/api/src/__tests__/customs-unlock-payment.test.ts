// V2-05 — CUSTOMS UNLOCK PAYMENT 回归
// ---------------------------------------------------------------------------
// 覆盖：服务端版本化报价 + 有效期 / 订单四要素匹配（改价换租户换机会换商品均 HOLD）/
//   Webhook HMAC 验签与时间戳容忍窗 / 载荷结构校验 / 事件幂等（重复回调只发一次权益）/
//   Payment HOLD 下不发放权益 / 退款·取消·过期·争议的一致权益处理 / 额度扣减与复购提示。

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_SUCCESS_FEE_RATE_BPS,
  CUSTOMS_UNLOCK_DISCLOSURES,
  CUSTOMS_UNLOCK_PAYMENT_BOUNDARY,
  CUSTOMS_UNLOCK_PAYMENT_VERSION,
  CustomsUnlockError,
  applyEntitlementLifecycle,
  applyVerifiedPaymentEvent,
  consumeEntitlementQuota,
  findCustomsUnlockProduct,
  issueCustomsUnlockQuote,
  isVerifiedPaymentEvidence,
  shouldOfferCustomsUnlock,
  signCustomsWebhookBody,
  validateCustomsUnlockOrder,
  verifyCustomsPaymentNotification,
  type CustomsPaymentNotification,
  type CustomsUnlockEntitlement,
  type CustomsUnlockQuote,
  type VerifiedPaymentEvidence,
} from '../services/customs/customs-unlock-payment';

const NOW = new Date('2026-10-09T13:00:00.000Z');
const SECRET = 'whsec_test_secret';

function quote(overrides: Partial<Parameters<typeof issueCustomsUnlockQuote>[0]> = {}): CustomsUnlockQuote {
  return issueCustomsUnlockQuote({
    organizationId: 'org-1',
    opportunityId: 'opp-1',
    productSku: 'CUSTOMS_SINGLE_REVIEW',
    now: NOW,
    quoteIdFactory: () => 'quote-1',
    ...overrides,
  });
}

function notification(overrides: Partial<CustomsPaymentNotification> = {}): CustomsPaymentNotification {
  return {
    eventId: 'evt-1',
    eventType: 'PAYMENT_SUCCEEDED',
    quoteId: 'quote-1',
    organizationId: 'org-1',
    opportunityId: 'opp-1',
    productSku: 'CUSTOMS_SINGLE_REVIEW',
    amountMinor: 3900,
    currency: 'USD',
    occurredAt: NOW.toISOString(),
    ...overrides,
  };
}

function entitlement(overrides: Partial<CustomsUnlockEntitlement> = {}): CustomsUnlockEntitlement {
  return {
    entitlementId: 'ent-quote-1',
    organizationId: 'org-1',
    opportunityId: 'opp-1',
    productSku: 'CUSTOMS_SINGLE_REVIEW',
    quotaTotal: 1,
    quotaRemaining: 1,
    status: 'ACTIVE',
    grantedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    quoteId: 'quote-1',
    ...overrides,
  };
}

/** CHANGE 02：权益发放只接受验签产出的证据；测试也走同一条真实验签路径。 */
function evidence(overrides: Partial<CustomsPaymentNotification> = {}): VerifiedPaymentEvidence {
  const body = JSON.stringify(notification(overrides));
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const verified = verifyCustomsPaymentNotification({
    rawBody: body,
    timestampHeader: timestamp,
    signatureHeader: signCustomsWebhookBody(timestamp, body, SECRET),
    secret: SECRET,
    now: NOW,
  });
  if (!verified.evidence) throw new Error('TEST_EVIDENCE_MISSING');
  return verified.evidence;
}

describe('V2-05 服务端报价', () => {
  it('已知商品 → 服务端权威价格 / 额度 / 披露条款', () => {
    const result = quote();
    expect(result.kind).toBe('CUSTOMS_UNLOCK_QUOTE');
    expect(result.version).toBe(CUSTOMS_UNLOCK_PAYMENT_VERSION);
    expect(result.priceMinor).toBe(3900);
    expect(result.currency).toBe('USD');
    expect(result.quota).toBe(1);
    expect(result.billingMode).toBe('ONE_TIME');
    expect(result.successFeeRateBps).toBe(CUSTOMS_SUCCESS_FEE_RATE_BPS);
    expect(result.disclosures).toEqual(CUSTOMS_UNLOCK_DISCLOSURES);
    expect(result.paymentCaptured).toBe(false);
    expect(result.storesCardData).toBe(false);
    expect(result.expiresAt).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
  });

  it('未知商品 / 缺范围 / 非法有效期 → 抛错（不生成报价）', () => {
    expect(() => quote({ productSku: 'NOPE' })).toThrow(CustomsUnlockError);
    expect(() => quote({ organizationId: '' })).toThrow(CustomsUnlockError);
    expect(() => quote({ ttlMinutes: 0 })).toThrow(CustomsUnlockError);
  });

  it('商品目录可解析，且 Plus 为订阅', () => {
    expect(findCustomsUnlockProduct('CUSTOMS_SINGLE_REVIEW')?.priceMinor).toBe(3900);
    const plus = findCustomsUnlockProduct('CUSTOMS_PLUS_MONTHLY');
    expect(plus?.priceMinor).toBe(4900);
    expect(plus?.billingMode).toBe('SUBSCRIPTION_MONTHLY');
    expect(findCustomsUnlockProduct('nope')).toBeNull();
  });
});

describe('V2-05 订单校验 — 前端无法伪造解锁', () => {
  it('四要素一致 → valid', () => {
    const verdict = validateCustomsUnlockOrder({
      quote: quote(),
      order: {
        organizationId: 'org-1',
        opportunityId: 'opp-1',
        productSku: 'CUSTOMS_SINGLE_REVIEW',
        amountMinor: 3900,
        currency: 'USD',
      },
      now: NOW,
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.reasonCodes).toEqual(['ORDER_VALID']);
    expect(verdict.serverPriceMinor).toBe(3900);
  });

  it('改价 / 换租户 / 换机会 / 换商品 / 换币种 / 过期 → 全部拒绝', () => {
    const base = {
      organizationId: 'org-1',
      opportunityId: 'opp-1',
      productSku: 'CUSTOMS_SINGLE_REVIEW',
      amountMinor: 3900,
      currency: 'USD',
    };
    const cases: [Partial<typeof base>, string][] = [
      [{ amountMinor: 1 }, 'AMOUNT_MISMATCH'],
      [{ organizationId: 'org-2' }, 'ORG_MISMATCH'],
      [{ opportunityId: 'opp-2' }, 'OPPORTUNITY_MISMATCH'],
      [{ productSku: 'CUSTOMS_PLUS_MONTHLY' }, 'PRODUCT_MISMATCH'],
      [{ currency: 'EUR' }, 'CURRENCY_MISMATCH'],
    ];
    for (const [patch, reason] of cases) {
      const verdict = validateCustomsUnlockOrder({
        quote: quote(),
        order: { ...base, ...patch },
        now: NOW,
      });
      expect(verdict.valid).toBe(false);
      expect(verdict.reasonCodes).toContain(reason);
    }

    const expired = validateCustomsUnlockOrder({
      quote: quote(),
      order: base,
      now: new Date(NOW.getTime() + 31 * 60_000),
    });
    expect(expired.reasonCodes).toContain('QUOTE_EXPIRED');
  });
});

describe('V2-05 Webhook 验签', () => {
  function signed(body: string, timestamp = String(Math.floor(NOW.getTime() / 1000))) {
    return { rawBody: body, timestampHeader: timestamp, signatureHeader: signCustomsWebhookBody(timestamp, body, SECRET) };
  }

  it('签名正确 → verified 且载荷解析成功', () => {
    const body = JSON.stringify(notification());
    const result = verifyCustomsPaymentNotification({ ...signed(body), secret: SECRET, now: NOW });
    expect(result.verified).toBe(true);
    expect(result.payload?.eventId).toBe('evt-1');
    expect(result.reasonCodes).toEqual(['SIGNATURE_VALID']);
  });

  it('密钥未配置 → 一律拒绝（fail-closed）', () => {
    const body = JSON.stringify(notification());
    const result = verifyCustomsPaymentNotification({ ...signed(body), secret: null, now: NOW });
    expect(result.verified).toBe(false);
    expect(result.reasonCodes).toEqual(['SECRET_NOT_CONFIGURED']);
    expect(result.payload).toBeNull();
  });

  it('缺签名头 / 缺时间戳头 → 拒绝', () => {
    const body = JSON.stringify(notification());
    const base = signed(body);
    expect(
      verifyCustomsPaymentNotification({ ...base, signatureHeader: null, secret: SECRET, now: NOW })
        .reasonCodes,
    ).toContain('SIGNATURE_HEADER_MISSING');
    expect(
      verifyCustomsPaymentNotification({ ...base, timestampHeader: null, secret: SECRET, now: NOW })
        .reasonCodes,
    ).toContain('TIMESTAMP_HEADER_MISSING');
  });

  it('篡改载荷 / 错误签名 / 非数字时间戳 → 拒绝', () => {
    const body = JSON.stringify(notification());
    const base = signed(body);
    const tampered = JSON.stringify(notification({ amountMinor: 1 }));
    expect(
      verifyCustomsPaymentNotification({ ...base, rawBody: tampered, secret: SECRET, now: NOW })
        .reasonCodes,
    ).toContain('SIGNATURE_MISMATCH');
    expect(
      verifyCustomsPaymentNotification({ ...base, signatureHeader: 'deadbeef', secret: SECRET, now: NOW })
        .reasonCodes,
    ).toContain('SIGNATURE_MISMATCH');
    expect(
      verifyCustomsPaymentNotification({ ...base, timestampHeader: 'abc', secret: SECRET, now: NOW })
        .reasonCodes,
    ).toContain('TIMESTAMP_OUT_OF_TOLERANCE');
  });

  it('时间戳超出容忍窗 → 拒绝（防重放）', () => {
    const body = JSON.stringify(notification());
    const oldTimestamp = String(Math.floor(NOW.getTime() / 1000) - 3600);
    const result = verifyCustomsPaymentNotification({
      ...signed(body, oldTimestamp),
      secret: SECRET,
      now: NOW,
    });
    expect(result.verified).toBe(false);
    expect(result.reasonCodes).toContain('TIMESTAMP_OUT_OF_TOLERANCE');
  });

  it('签名正确但载荷结构非法 / 事件类型未知 → PAYLOAD_MALFORMED', () => {
    for (const body of ['not-json', JSON.stringify({ ...notification(), eventType: 'NOPE' }), JSON.stringify({ hello: 1 })]) {
      const result = verifyCustomsPaymentNotification({ ...signed(body), secret: SECRET, now: NOW });
      expect(result.verified).toBe(false);
      expect(result.reasonCodes).toContain('PAYLOAD_MALFORMED');
    }
  });
});

describe('V2-05 权益发放 — 幂等与 Payment HOLD', () => {
  it('Payment HOLD 生效时 → HOLD，不发放权益', () => {
    const result = applyVerifiedPaymentEvent({
      evidence: evidence(),
      quote: quote(),
      processedEventIds: new Set<string>(),
      now: NOW,
      paymentsEnabled: false,
    });
    expect(result.outcome).toBe('HOLD');
    expect(result.reasonCodes).toEqual(['PAYMENTS_HOLD']);
    expect(result.entitlement).toBeNull();
  });

  it('非支付成功事件 → HOLD', () => {
    const result = applyVerifiedPaymentEvent({
      evidence: evidence({ eventType: 'PAYMENT_REFUNDED' }),
      quote: quote(),
      processedEventIds: new Set<string>(),
      now: NOW,
      paymentsEnabled: true,
    });
    expect(result.outcome).toBe('HOLD');
    expect(result.reasonCodes).toEqual(['EVENT_NOT_PAYMENT_SUCCEEDED']);
  });

  it('回调字段与报价不一致 → HOLD（伪造回调无法解锁）', () => {
    const result = applyVerifiedPaymentEvent({
      evidence: evidence({ organizationId: 'org-2', amountMinor: 1 }),
      quote: quote(),
      processedEventIds: new Set<string>(),
      now: NOW,
      paymentsEnabled: true,
    });
    expect(result.outcome).toBe('HOLD');
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['ORG_MISMATCH', 'AMOUNT_MISMATCH']),
    );
    expect(result.entitlement).toBeNull();
  });

  it('字段一致 → 发放权益，entitlementId 由报价确定性派生', () => {
    const result = applyVerifiedPaymentEvent({
      evidence: evidence(),
      quote: quote(),
      processedEventIds: new Set<string>(),
      now: NOW,
      paymentsEnabled: true,
    });
    expect(result.outcome).toBe('ENTITLEMENT_GRANTED');
    expect(result.entitlement?.entitlementId).toBe('ent-quote-1');
    expect(result.entitlement?.quotaRemaining).toBe(1);
    expect(result.entitlement?.status).toBe('ACTIVE');
    expect(result.paymentCaptured).toBe(false);
  });

  it('同一 eventId 重复投递 → DUPLICATE_IGNORED（不重复发放）', () => {
    const result = applyVerifiedPaymentEvent({
      evidence: evidence(),
      quote: quote(),
      processedEventIds: new Set<string>(['evt-1']),
      now: NOW,
      paymentsEnabled: true,
    });
    expect(result.outcome).toBe('DUPLICATE_IGNORED');
    expect(result.reasonCodes).toEqual(['DUPLICATE_EVENT']);
    expect(result.entitlement).toBeNull();
  });

  // CHANGE 02（P0）：未验签的裸对象即使被强转，也必须被拒。
  it('自行构造的对象冒充证据 → HOLD(UNVERIFIED_PAYMENT_EVIDENCE)，不发放权益', () => {
    const forged = { notification: notification() } as unknown as VerifiedPaymentEvidence;
    expect(isVerifiedPaymentEvidence(forged)).toBe(false);
    const result = applyVerifiedPaymentEvent({
      evidence: forged,
      quote: quote(),
      processedEventIds: new Set<string>(),
      now: NOW,
      paymentsEnabled: true,
    });
    expect(result.outcome).toBe('HOLD');
    expect(result.reasonCodes).toEqual(['UNVERIFIED_PAYMENT_EVIDENCE']);
    expect(result.entitlement).toBeNull();
  });

  it('真实验签证据在报价过期后提交 → HOLD(QUOTE_EXPIRED)', () => {
    const result = applyVerifiedPaymentEvent({
      evidence: evidence(),
      quote: quote(),
      processedEventIds: new Set<string>(),
      now: new Date(NOW.getTime() + 31 * 60_000),
      paymentsEnabled: true,
    });
    expect(result.outcome).toBe('HOLD');
    expect(result.reasonCodes).toEqual(['QUOTE_EXPIRED']);
    expect(result.entitlement).toBeNull();
  });

  it('验签成功结果携带可信证据，且证据绑定的是同一条通知', () => {
    const verified = evidence();
    expect(isVerifiedPaymentEvidence(verified)).toBe(true);
    expect(verified.notification.eventId).toBe('evt-1');
    expect(verified.signatureScheme).toBe('HMAC_SHA256_TS_BODY');
  });
});

describe('V2-05 生命周期 — 退款 / 取消 / 过期 / 争议', () => {
  it('退款 → 撤销剩余额度，未使用额度可退', () => {
    const result = applyEntitlementLifecycle({
      entitlement: entitlement({ quotaRemaining: 2, quotaTotal: 3 }),
      event: 'PAYMENT_REFUNDED',
      now: NOW,
    });
    expect(result.entitlement.status).toBe('REVOKED');
    expect(result.entitlement.quotaRemaining).toBe(0);
    expect(result.unusedQuotaDisposition).toBe('REFUND_ELIGIBLE_FOR_UNUSED');
  });

  it('争议（chargeback）→ 撤销剩余额度且不承诺退还', () => {
    const result = applyEntitlementLifecycle({
      entitlement: entitlement(),
      event: 'CHARGEBACK_OPENED',
      now: NOW,
    });
    expect(result.entitlement.status).toBe('REVOKED');
    expect(result.unusedQuotaDisposition).toBe('REVOKED_ALL');
  });

  it('取消订阅 → 停止续费但保留已付额度至期末', () => {
    const result = applyEntitlementLifecycle({
      entitlement: entitlement({ status: 'ACTIVE', quotaRemaining: 2 }),
      event: 'SUBSCRIPTION_CANCELED',
      now: NOW,
    });
    expect(result.entitlement.status).toBe('CANCELED');
    expect(result.entitlement.quotaRemaining).toBe(2);
    expect(result.unusedQuotaDisposition).toBe('RETAINED_UNTIL_PERIOD_END');
  });

  it('期间结束 → 过期且额度清零', () => {
    const result = applyEntitlementLifecycle({
      entitlement: entitlement(),
      event: 'PERIOD_EXPIRED',
      now: NOW,
    });
    expect(result.entitlement.status).toBe('EXPIRED');
    expect(result.entitlement.quotaRemaining).toBe(0);
  });
});

describe('V2-05 额度消费与复购提示', () => {
  it('仅 ACTIVE 且额度 > 0 可消费；扣减有下限保护', () => {
    const ok = consumeEntitlementQuota(entitlement({ quotaRemaining: 2 }));
    expect(ok.allowed).toBe(true);
    expect(ok.entitlement.quotaRemaining).toBe(1);

    expect(consumeEntitlementQuota(entitlement({ quotaRemaining: 0 })).allowed).toBe(false);
    expect(consumeEntitlementQuota(entitlement({ status: 'REVOKED' })).allowed).toBe(false);
  });

  it('已购且额度足够的用户不再被要求重复购买同一服务', () => {
    expect(shouldOfferCustomsUnlock(null, 'CUSTOMS_SINGLE_REVIEW')).toBe(true);
    expect(shouldOfferCustomsUnlock(entitlement({ quotaRemaining: 1 }), 'CUSTOMS_SINGLE_REVIEW')).toBe(false);
    expect(shouldOfferCustomsUnlock(entitlement({ quotaRemaining: 0 }), 'CUSTOMS_SINGLE_REVIEW')).toBe(true);
    expect(shouldOfferCustomsUnlock(entitlement({ status: 'REVOKED' }), 'CUSTOMS_SINGLE_REVIEW')).toBe(true);
    expect(shouldOfferCustomsUnlock(entitlement({ quotaRemaining: 1 }), 'CUSTOMS_PLUS_MONTHLY')).toBe(true);
  });
});

describe('V2-05 边界自证', () => {
  it('CUSTOMS_UNLOCK_PAYMENT_BOUNDARY 声明不持卡 / 不扣款 / 不调用支付通道', () => {
    expect(CUSTOMS_UNLOCK_PAYMENT_BOUNDARY.storesCardData).toBe(false);
    expect(CUSTOMS_UNLOCK_PAYMENT_BOUNDARY.initiatesCharge).toBe(false);
    expect(CUSTOMS_UNLOCK_PAYMENT_BOUNDARY.paymentCaptured).toBe(false);
    expect(CUSTOMS_UNLOCK_PAYMENT_BOUNDARY.providerInvoked).toBe(false);
    expect(CUSTOMS_UNLOCK_PAYMENT_BOUNDARY.autoCollectionEnabled).toBe(false);
    expect(CUSTOMS_UNLOCK_PAYMENT_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});
