/** C18-4 单元验收：provider webhook 验签（HMAC + 时间窗 + 重放）与事件映射（零外写）。 */

import { describe, expect, it } from 'vitest';

import {
  computeProviderWebhookSignature,
  mapVerifiedProviderWebhookEvent,
  verifyProviderWebhook,
} from '../services/customs/customs-provider-webhook';

const SECRET = 'sandbox-webhook-secret';
const NOW = new Date('2026-10-04T06:00:00.000Z');
const TS = Math.floor(NOW.getTime() / 1000);
const BODY = JSON.stringify({ eventType: 'SUBMISSION_STATUS', status: 'ACCEPTED' });

const headersFor = (input: { body?: string; timestamp?: number; secret?: string; deliveryId?: string }) => {
  const body = input.body ?? BODY;
  const timestamp = input.timestamp ?? TS;
  return {
    'x-cc-signature': computeProviderWebhookSignature({
      secret: input.secret ?? SECRET,
      timestampSeconds: timestamp,
      rawBody: body,
    }),
    'x-cc-timestamp': String(timestamp),
    'x-cc-delivery-id': input.deliveryId ?? 'delivery-1',
  };
};

describe('C18-4 — provider webhook verification（unit）', () => {
  it('合法签名 + 时间窗内 → ok（返回 deliveryId / timestamp）', () => {
    const result = verifyProviderWebhook({ rawBody: BODY, headers: headersFor({}), secret: SECRET, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deliveryId).toBe('delivery-1');
      expect(result.timestampSeconds).toBe(TS);
    }
  });

  it('缺任一必需头 → MISSING_HEADERS', () => {
    const headers = headersFor({});
    delete (headers as Record<string, string | undefined>)['x-cc-timestamp'];
    const result = verifyProviderWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_HEADERS');
  });

  it('时间戳非法 / 超出容差 → fail-closed', () => {
    const badTs = verifyProviderWebhook({
      rawBody: BODY,
      headers: { ...headersFor({}), 'x-cc-timestamp': 'not-a-number' },
      secret: SECRET,
      now: NOW,
    });
    expect(badTs.ok).toBe(false);
    if (!badTs.ok) expect(badTs.code).toBe('INVALID_TIMESTAMP');

    const stale = verifyProviderWebhook({
      rawBody: BODY,
      headers: headersFor({ timestamp: TS - 3600 }),
      secret: SECRET,
      now: NOW,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('TIMESTAMP_OUT_OF_TOLERANCE');
  });

  it('错误密钥 / body 被篡改 → INVALID_SIGNATURE（constant-time 比较）', () => {
    const wrongSecret = verifyProviderWebhook({
      rawBody: BODY,
      headers: headersFor({ secret: 'other-secret' }),
      secret: SECRET,
      now: NOW,
    });
    expect(wrongSecret.ok).toBe(false);
    if (!wrongSecret.ok) expect(wrongSecret.code).toBe('INVALID_SIGNATURE');

    const tampered = verifyProviderWebhook({
      rawBody: BODY.replace('ACCEPTED', 'PAID'),
      headers: headersFor({}),
      secret: SECRET,
      now: NOW,
    });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.code).toBe('INVALID_SIGNATURE');
  });

  it('已处理过的 deliveryId → REPLAY_DETECTED（幂等由调用方持久化）', () => {
    const result = verifyProviderWebhook({
      rawBody: BODY,
      headers: headersFor({}),
      secret: SECRET,
      now: NOW,
      seenDeliveryIds: new Set(['delivery-1']),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('REPLAY_DETECTED');
  });

  it('事件映射：状态/退款恒为 PROVIDER_VERIFIED，不推导已受理/已到账', () => {
    const status = mapVerifiedProviderWebhookEvent({
      eventType: 'SUBMISSION_STATUS',
      providerSubmissionId: 'sub:1',
      status: 'SUBMITTED',
      observedAt: '2026-10-04T06:01:00.000Z',
    });
    expect(status.ok).toBe(true);
    if (status.ok && status.statusRevision) {
      expect(status.statusRevision.status).toBe('SUBMITTED');
      expect(status.statusRevision.sourceLevel).toBe('PROVIDER_VERIFIED');
      expect(status.statusRevision.derivesRecoveredCash).toBe(false);
    }

    const refund = mapVerifiedProviderWebhookEvent({
      eventType: 'REFUND_STATUS',
      providerSubmissionId: 'sub:1',
      refundStatus: 'REFUNDED',
      refundedAmount: '100.00',
      currency: 'USD',
      observedAt: '2026-10-04T06:02:00.000Z',
    });
    expect(refund.ok).toBe(true);
    if (refund.ok && refund.refundRevision) {
      expect(refund.refundRevision.sourceLevel).toBe('PROVIDER_VERIFIED');
      expect(refund.refundRevision.derivesRecoveredCash).toBe(false);
      expect(refund.refundRevision.derivesFee).toBe(false);
    }
  });

  it('未知事件类型 / 缺关键字段 → fail-closed', () => {
    const unknown = mapVerifiedProviderWebhookEvent({
      eventType: 'SOMETHING_ELSE',
      providerSubmissionId: 'sub:1',
      observedAt: '2026-10-04T06:03:00.000Z',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('UNKNOWN_EVENT_TYPE');

    const missing = mapVerifiedProviderWebhookEvent({ eventType: 'SUBMISSION_STATUS', observedAt: '2026-10-04T06:03:00.000Z' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('INVALID_PAYLOAD');
  });
});
