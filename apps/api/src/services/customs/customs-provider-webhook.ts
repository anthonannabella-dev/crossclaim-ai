/**
 * C18-4 — PROVIDER WEBHOOK VERIFICATION（零外写，纯校验）
 * ---------------------------------------------------------------
 * provider 把状态/退款回传推给我们时，必须先证明「这条 webhook 真是该 provider 发的、且没被重放」，
 * 然后才能落到 C19 事实层。本模块只做校验与映射，不监听端口、不读凭据、不写库。
 *
 * 校验三件套（缺一不可）：
 *   1. 签名：HMAC-SHA256(secret, `${timestamp}.${rawBody}`)，constant-time 比较；
 *   2. 时间窗：|now - timestamp| ≤ tolerance（默认 300s），拒绝过期/未来时间；
 *   3. 交付幂等：deliveryId 不得重复（调用方传入已见过的集合；本模块不持久化）。
 *
 * 映射阶段复用 C18-2 的语义：provider 事件永远是 PROVIDER_VERIFIED，
 * 不得推导「已受理 / 已到账」（SUBMITTED ≠ ACCEPTED、APPROVED ≠ PAID）。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  mapProviderRefundStatusToRevision,
  mapProviderStatusToRevision,
  type CustomsProviderRefundRevision,
  type CustomsProviderStatusRevision,
} from './customs-provider-dto';

export const PROVIDER_WEBHOOK_SIGNATURE_HEADER = 'x-cc-signature';
export const PROVIDER_WEBHOOK_TIMESTAMP_HEADER = 'x-cc-timestamp';
export const PROVIDER_WEBHOOK_DELIVERY_HEADER = 'x-cc-delivery-id';
export const PROVIDER_WEBHOOK_DEFAULT_TOLERANCE_SECONDS = 300;

export type ProviderWebhookErrorCode =
  | 'MISSING_HEADERS'
  | 'INVALID_TIMESTAMP'
  | 'TIMESTAMP_OUT_OF_TOLERANCE'
  | 'INVALID_SIGNATURE'
  | 'REPLAY_DETECTED';

export type ProviderWebhookVerifyResult =
  | { ok: true; deliveryId: string; timestampSeconds: number }
  | { ok: false; code: ProviderWebhookErrorCode; detail: string };

function headerValue(headers: Record<string, string | undefined>, name: string): string | null {
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return typeof direct === 'string' && direct.trim() !== '' ? direct.trim() : null;
}

/** 供 provider 侧/测试侧计算签名（本函数不读取任何凭据存储）。 */
export function computeProviderWebhookSignature(input: {
  secret: string;
  timestampSeconds: number;
  rawBody: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(String(input.timestampSeconds) + '.' + input.rawBody, 'utf8')
    .digest('hex');
}

export function verifyProviderWebhook(input: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string;
  /** 已经处理过的 deliveryId（由调用方持久化，例如 C17 ledger）。 */
  seenDeliveryIds?: ReadonlySet<string>;
  toleranceSeconds?: number;
  now?: Date;
}): ProviderWebhookVerifyResult {
  const signature = headerValue(input.headers, PROVIDER_WEBHOOK_SIGNATURE_HEADER);
  const timestampRaw = headerValue(input.headers, PROVIDER_WEBHOOK_TIMESTAMP_HEADER);
  const deliveryId = headerValue(input.headers, PROVIDER_WEBHOOK_DELIVERY_HEADER);
  if (!signature || !timestampRaw || !deliveryId) {
    return { ok: false, code: 'MISSING_HEADERS', detail: 'signature / timestamp / delivery id are all required' };
  }

  const timestampSeconds = Number(timestampRaw);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    return { ok: false, code: 'INVALID_TIMESTAMP', detail: 'timestamp must be unix seconds' };
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSeconds ?? PROVIDER_WEBHOOK_DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    return { ok: false, code: 'TIMESTAMP_OUT_OF_TOLERANCE', detail: 'webhook timestamp outside tolerance window' };
  }

  const expected = computeProviderWebhookSignature({
    secret: input.secret,
    timestampSeconds,
    rawBody: input.rawBody,
  });
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signature.toLowerCase(), 'utf8');
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, code: 'INVALID_SIGNATURE', detail: 'HMAC signature mismatch' };
  }

  if (input.seenDeliveryIds && input.seenDeliveryIds.has(deliveryId)) {
    return { ok: false, code: 'REPLAY_DETECTED', detail: 'delivery id already processed' };
  }

  return { ok: true, deliveryId, timestampSeconds };
}

export type ProviderWebhookEventType = 'SUBMISSION_STATUS' | 'REFUND_STATUS' | 'REQUEST_FOR_INFORMATION';

export type ProviderWebhookMappingResult =
  | { ok: true; eventType: ProviderWebhookEventType; statusRevision: CustomsProviderStatusRevision | null; refundRevision: CustomsProviderRefundRevision | null }
  | { ok: false; code: 'UNKNOWN_EVENT_TYPE' | 'INVALID_PAYLOAD'; detail: string };

/**
 * 已验证 webhook → 内部事实草案（仍为 PROVIDER_VERIFIED，不得升级为 AUTHORITY_VERIFIED）。
 * 金额类事实不在此处记账（C20 结算与确认负责）。
 */
export function mapVerifiedProviderWebhookEvent(payload: {
  eventType?: string;
  providerSubmissionId?: string;
  status?: string;
  rawStatusText?: string | null;
  observedAt?: string;
  refundStatus?: string;
  refundedAmount?: string | null;
  currency?: string | null;
}): ProviderWebhookMappingResult {
  const eventType = (payload.eventType ?? '').toUpperCase() as ProviderWebhookEventType;
  if (!payload.providerSubmissionId || !payload.observedAt || Number.isNaN(Date.parse(payload.observedAt))) {
    return { ok: false, code: 'INVALID_PAYLOAD', detail: 'providerSubmissionId and observedAt are required' };
  }
  if (eventType === 'SUBMISSION_STATUS') {
    return {
      ok: true,
      eventType,
      statusRevision: mapProviderStatusToRevision({
        providerSubmissionId: payload.providerSubmissionId,
        status: payload.status ?? 'UNKNOWN',
        observedAt: payload.observedAt,
        rawStatusText: payload.rawStatusText ?? payload.status ?? null,
      }),
      refundRevision: null,
    };
  }
  if (eventType === 'REFUND_STATUS') {
    return {
      ok: true,
      eventType,
      statusRevision: null,
      refundRevision: mapProviderRefundStatusToRevision({
        providerSubmissionId: payload.providerSubmissionId,
        refundStatus: payload.refundStatus ?? 'UNKNOWN',
        refundedAmount: payload.refundedAmount ?? null,
        currency: payload.currency ?? null,
        observedAt: payload.observedAt,
      }),
    };
  }
  if (eventType === 'REQUEST_FOR_INFORMATION') {
    return { ok: true, eventType, statusRevision: null, refundRevision: null };
  }
  return { ok: false, code: 'UNKNOWN_EVENT_TYPE', detail: 'event type is not in the provider-neutral vocabulary' };
}
