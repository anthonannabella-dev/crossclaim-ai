// V2-HANDOFF-02 — CHECKOUT 适配层回归（默认禁用）

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_CHECKOUT_ADAPTER_VERSION,
  CUSTOMS_CHECKOUT_BOUNDARY,
  resolveCustomsCheckout,
  type CustomsCheckoutInput,
} from '../services/customs/customs-unlock-checkout';
import { issueCustomsUnlockQuote } from '../services/customs/customs-unlock-payment';

const NOW = new Date('2026-10-10T09:00:00.000Z');

function quote(ttlMinutes = 30) {
  return issueCustomsUnlockQuote({
    organizationId: 'org-1',
    opportunityId: 'opp-1',
    productSku: 'CUSTOMS_SINGLE_REVIEW',
    now: NOW,
    ttlMinutes,
    quoteIdFactory: () => 'quote-1',
  });
}

function input(overrides: Partial<CustomsCheckoutInput> = {}): CustomsCheckoutInput {
  const base: CustomsCheckoutInput = {
    quote: quote(),
    now: NOW,
    payment: {
      paymentsEnabled: true,
      hostedCheckoutUrl: 'https://checkout.example.test/pay',
      productionPaymentAuthorized: true,
    },
  };
  return { ...base, ...overrides };
}

describe('V2-HANDOFF-02 收银台适配 — 默认禁用与 fail-closed', () => {
  it('Payment HOLD → DISABLED，不产生任何链接', () => {
    const result = resolveCustomsCheckout(
      input({ payment: { paymentsEnabled: false, hostedCheckoutUrl: 'https://x', productionPaymentAuthorized: true } }),
    );
    expect(result.state).toBe('DISABLED');
    expect(result.reasonCodes).toEqual(['PAYMENTS_HOLD']);
    expect(result.redirectUrl).toBeNull();
  });

  it('无报价 / 报价过期 → 不产生链接', () => {
    expect(resolveCustomsCheckout(input({ quote: null })).reasonCodes).toEqual(['QUOTE_REQUIRED']);
    const expired = resolveCustomsCheckout(input({ now: new Date(NOW.getTime() + 31 * 60_000) }));
    expect(expired.state).toBe('HOLD_QUOTE_INVALID');
    expect(expired.reasonCodes).toEqual(['QUOTE_EXPIRED']);
    expect(expired.redirectUrl).toBeNull();
    expect(expired.priceMinor).toBe(3900); // 报价仍可见，但不可跳转
  });

  it('未配置收银台端点 / 未授权生产支付 → DISABLED（即使报价有效）', () => {
    const noEndpoint = resolveCustomsCheckout(
      input({ payment: { paymentsEnabled: true, hostedCheckoutUrl: null, productionPaymentAuthorized: true } }),
    );
    expect(noEndpoint.reasonCodes).toEqual(['CHECKOUT_ENDPOINT_NOT_CONFIGURED']);
    expect(noEndpoint.redirectUrl).toBeNull();

    const notAuthorized = resolveCustomsCheckout(
      input({
        payment: {
          paymentsEnabled: true,
          hostedCheckoutUrl: 'https://checkout.example.test/pay',
          productionPaymentAuthorized: false,
        },
      }),
    );
    expect(notAuthorized.reasonCodes).toEqual(['PRODUCTION_PAYMENT_NOT_AUTHORIZED']);
    expect(notAuthorized.redirectUrl).toBeNull();
  });

  it('全部条件满足 → 只产出描述符（含 quoteId/quoteVersion），且不创建会话', () => {
    const result = resolveCustomsCheckout(input());
    expect(result.state).toBe('READY_FOR_HOST_REDIRECT');
    expect(result.redirectUrl).toContain('checkout.example.test');
    expect(result.redirectUrl).toContain('quoteId=quote-1');
    expect(result.redirectUrl).toContain('quoteVersion=v1');
    expect(result.priceMinor).toBe(3900);
    expect(result.currency).toBe('USD');
    expect(result.checkoutSessionCreated).toBe(false);
    expect(result.cardDataStored).toBe(false);
    expect(result.chargesPerformed).toBe(false);
  });

  it('报价被标记为已扣款（脏数据）→ 拒绝', () => {
    const dirty = { ...quote(), paymentCaptured: true } as unknown as ReturnType<typeof quote>;
    const result = resolveCustomsCheckout(input({ quote: dirty }));
    expect(result.state).toBe('DISABLED');
    expect(result.reasonCodes).toEqual(['QUOTE_MALFORMED']);
  });
});

describe('V2-HANDOFF-02 收银台适配 — 边界自证', () => {
  it('适配层不建会话 / 不持卡 / 不扣款 / 默认 DISABLED', () => {
    expect(CUSTOMS_CHECKOUT_BOUNDARY.checkoutSessionCreated).toBe(false);
    expect(CUSTOMS_CHECKOUT_BOUNDARY.cardDataStored).toBe(false);
    expect(CUSTOMS_CHECKOUT_BOUNDARY.chargesPerformed).toBe(false);
    expect(CUSTOMS_CHECKOUT_BOUNDARY.defaultState).toBe('DISABLED');
    expect(CUSTOMS_CHECKOUT_ADAPTER_VERSION).toBe('customs-unlock-checkout-v2.0.0');
  });
});
