/**
 * C-0010-A/B — provider webhook receiver (signature + idempotency + flag).
 * ---------------------------------------------------------------
 * Approved plan (MSG-20260928-80):
 *   · verify HMAC-SHA256 (`Stripe-Signature`: t + v1) with a 5-minute tolerance;
 *     a missing secret fails closed;
 *   · idempotency on (provider, providerEventId) — repeats are DUPLICATE + 200;
 *   · `PAYMENTS_ENABLED` off ⇒ **verify first, then IGNORE + 200** (keep the audit);
 *   · only event metadata is stored (eventId / eventType / payloadHash / receivedAt /
 *     processingResult) — never the raw payload;
 *   · self-implemented HMAC (no Stripe SDK dependency).
 *
 * Tenant note: `PaymentEvent` is tenant-scoped, so an event we cannot attribute to
 * an organization (unknown invoice, or a signature failure) is **not persisted** —
 * it goes to the structured security log instead (same principle as failed logins
 * without a resolvable tenant).
 */


import { Prisma, type PrismaClient } from '@prisma/client';

import {
  payloadHashOf as payloadHashOfBytes,
  verifyWebhookRequest,
  webhookFailureStatus,
} from '../webhooks/verification';
import { paymentsEnabled } from './payment';
import { executeAttempt } from './payment-attempt';

export const DEFAULT_TOLERANCE_SECONDS = 300;
/**
 * C-0010-C2 REVISE-1：期望的 provider 事件容器版本。
 * 版本**不做硬闸**（fail-soft）：不匹配时只写结构化告警，仍按字段解析；
 * 只有白名单字段缺失才 IGNORED / REJECTED。
 */
export const EXPECTED_PROVIDER_API_VERSION = '2024-06-20';
export const WEBHOOK_WHITELIST = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
] as const;

export interface SignatureInput {
  /** PC-10：允许传入**原始字节**（Buffer）以杜绝 canonicalization 漂移。 */
  rawBody: string | Buffer;
  signatureHeader: string | undefined;
  secret: string | undefined;
  toleranceSeconds?: number;
  now?: () => Date;
}

export type SignatureResult = 'VALID' | 'MISSING_SECRET' | 'MALFORMED' | 'EXPIRED' | 'MISMATCH';

export function verifyProviderSignature(input: SignatureInput): SignatureResult {
  // PC-10：委托统一 verification boundary（provider registry + raw-byte 验签 + 版本 / 时间窗判定）。
  const result = verifyWebhookRequest({
    provider: 'STRIPE',
    rawBody: input.rawBody,
    headers: input.signatureHeader ? { 'stripe-signature': input.signatureHeader } : {},
    env: input.secret ? { PAYMENT_WEBHOOK_SECRET: input.secret } : {},
    ...(input.now ? { now: input.now } : {}),
    ...(input.toleranceSeconds === undefined ? {} : { toleranceSeconds: input.toleranceSeconds }),
  });
  if (result.outcome === 'VERIFIED') return 'VALID';
  if (result.outcome === 'MISSING_SECRET') return 'MISSING_SECRET';
  if (result.outcome === 'TIMESTAMP_EXPIRED' || result.outcome === 'TIMESTAMP_IN_FUTURE') return 'EXPIRED';
  if (result.outcome === 'SIGNATURE_MISMATCH') return 'MISMATCH';
  return 'MALFORMED';
}

export function payloadHashOf(rawBody: string | Buffer): string {
  return payloadHashOfBytes(rawBody);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * 事件表既是幂等闸也是锁：`(provider, providerEventId)` 唯一约束让**并发重放**
 * 里的败者拿到 DUPLICATE，而不是两个请求同时推进资金状态。
 */
async function recordPaymentEvent(
  prisma: PrismaClient,
  data: {
    organizationId: string;
    provider: string;
    providerEventId: string;
    eventType: string;
    payloadHash: string;
    receivedAt: Date;
    processingResult: 'IGNORED' | 'PROCESSED';
  },
): Promise<{ outcome: 'CREATED' | 'DUPLICATE'; id: string | null }> {
  try {
    const row = await prisma.paymentEvent.create({ data, select: { id: true } });
    return { outcome: 'CREATED', id: row.id };
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: 'DUPLICATE', id: null };
    throw error;
  }
}

export interface WebhookResult {
  httpStatus: number;
  processingResult: 'PROCESSED' | 'IGNORED' | 'REJECTED' | 'DUPLICATE';
  reason: string;
  invoiceId?: string;
}

export interface WebhookDeps {
  provider?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

interface ProviderEvent {
  id?: unknown;
  type?: unknown;
  api_version?: unknown;
  data?: { object?: { id?: unknown; amount?: unknown; currency?: unknown; metadata?: Record<string, unknown> } };
}

export async function handlePaymentWebhook(
  prisma: PrismaClient,
  raw: {
    rawBody: string;
    rawBodyBytes?: Buffer;
    signatureHeader: string | undefined;
    providerHeader?: string;
    /** PC-10：完整请求头由 HTTP 层透传，回归 harness 与真实路径一致。 */
    headers?: Record<string, string | string[] | undefined>;
  },
  deps: WebhookDeps = {},
): Promise<WebhookResult> {
  const env = deps.env ?? process.env;
  const provider = deps.provider ?? raw.providerHeader ?? 'STRIPE';
  const at = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => undefined);
  const rawBytes = raw.rawBodyBytes ?? raw.rawBody;
  const payloadHash = payloadHashOf(rawBytes);

  // PC-10：统一 verification boundary —— 未知 provider / 未知 signature version / 时间窗失败一律拒绝。
  const verification = verifyWebhookRequest({
    provider,
    rawBody: rawBytes,
    headers: raw.headers ?? (raw.signatureHeader ? { 'stripe-signature': raw.signatureHeader } : {}),
    env,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const signature: SignatureResult = verification.verified
    ? 'VALID'
    : verification.outcome === 'MISSING_SECRET'
      ? 'MISSING_SECRET'
      : verification.outcome === 'TIMESTAMP_EXPIRED' || verification.outcome === 'TIMESTAMP_IN_FUTURE'
        ? 'EXPIRED'
        : verification.outcome === 'SIGNATURE_MISMATCH'
          ? 'MISMATCH'
          : 'MALFORMED';
  if (signature !== 'VALID') {
    // 无法归属租户（验签失败/缺密钥）→ 只写结构化安全日志，不落库。
    // PC-10 FINAL（MSG-20261003-98 CHANGE A）：失败状态端到端一致 —— 直接复用统一边界的失败映射
    // （缺 secret → 503；签名不匹配 → 401；未知 provider / 版本 / 格式 / 时间窗 → 400）。
    const httpStatus = webhookFailureStatus(verification.outcome);
    log('payment_webhook_rejected', { reason: signature, outcome: verification.outcome, payloadHash });
    return { httpStatus, processingResult: 'REJECTED', reason: signature };
  }

  let event: ProviderEvent;
  try {
    event = JSON.parse(raw.rawBody) as ProviderEvent;
  } catch {
    log('payment_webhook_malformed_json', { payloadHash });
    return { httpStatus: 400, processingResult: 'REJECTED', reason: 'malformed_json' };
  }

  const providerEventId = typeof event.id === 'string' ? event.id : '';
  const eventType = typeof event.type === 'string' ? event.type : '';

  // C-0010-C2 REVISE-1：版本不一致只告警，不阻断（结构化字段白名单：
  // provider / providerEventId / expectedApiVersion / receivedApiVersion / action；
  // 绝不含 payload、客户、支付方式、密钥或卡信息）
  const receivedApiVersion = typeof event.api_version === 'string' ? event.api_version : null;
  if (receivedApiVersion !== EXPECTED_PROVIDER_API_VERSION) {
    log('payment.provider_version_mismatch', {
      provider,
      providerEventId,
      expectedApiVersion: EXPECTED_PROVIDER_API_VERSION,
      receivedApiVersion: receivedApiVersion ?? 'MISSING',
      action: 'CONTINUE',
    });
  }

  const object = event.data?.object ?? {};
  const metadataInvoiceId =
    object.metadata && typeof object.metadata.invoiceId === 'string' ? object.metadata.invoiceId : '';

  const invoice = metadataInvoiceId
    ? await prisma.billingInvoice.findFirst({
        where: { id: metadataInvoiceId },
        select: { id: true, organizationId: true },
      })
    : null;
  if (!providerEventId || !eventType || !invoice) {
    // 无法归属到租户 → 不落库，仅日志（仍返回 200 让 provider 停止重试）
    log('payment_webhook_unattributed', { providerEventId, eventType, payloadHash });
    return { httpStatus: 200, processingResult: 'IGNORED', reason: 'unattributed_event' };
  }

  const existing = await prisma.paymentEvent.findFirst({
    where: { provider, providerEventId },
    select: { id: true },
  });
  if (existing) {
    // 幂等：不重复落库（唯一约束即幂等键），只在响应里标注 DUPLICATE
    log('payment_webhook_duplicate', { providerEventId, eventType, payloadHash });
    return { httpStatus: 200, processingResult: 'DUPLICATE', reason: 'duplicate_event' };
  }

  const processingResult = paymentsEnabled(env) ? 'PROCESSED' : 'IGNORED';
  const recorded = await recordPaymentEvent(prisma, {
    organizationId: invoice.organizationId,
    provider,
    providerEventId,
    eventType,
    payloadHash,
    receivedAt: at,
    processingResult,
  });
  if (recorded.outcome === 'DUPLICATE') {
    // 并发重放：唯一约束拦下的那一侧不推进任何资金状态
    log('payment_webhook_duplicate', { providerEventId, eventType, payloadHash });
    return { httpStatus: 200, processingResult: 'DUPLICATE', reason: 'duplicate_event' };
  }
  if (processingResult === 'IGNORED') {
    // 关闭期：验签通过、留痕，但不触碰发票状态，返回 200 让 provider 停止重试
    return { httpStatus: 200, processingResult: 'IGNORED', reason: 'payments_disabled', invoiceId: invoice.id };
  }

  if ((WEBHOOK_WHITELIST as readonly string[]).includes(eventType)) {
    if (eventType === 'payment_intent.succeeded') {
      const externalPaymentId = typeof object.id === 'string' ? object.id : providerEventId;
      const amount =
        typeof object.amount === 'number'
          ? (object.amount / 100).toFixed(4)
          : typeof object.amount === 'string'
            ? object.amount
            : '0.0000';
      const currency = typeof object.currency === 'string' ? object.currency.toUpperCase() : 'USD';
      // C-0010-B2：把这次处理记成一条执行尝试（含 paymentId 链接与失败分类）；
      // 执行失败不再让 webhook 抛错 —— 结论落在 attempt 上，由 replay / retry-due 恢复。
      await executeAttempt(
        prisma,
        {
          organizationId: invoice.organizationId,
          paymentEventId: recorded.id ?? '',
          provider,
          externalPaymentId,
          invoiceId: invoice.id,
          amount,
          currency,
          actorType: 'EXTERNAL',
          actorRef: provider,
          env,
        },
        { now: () => at },
      );
    }
  }

  return { httpStatus: 200, processingResult: 'PROCESSED', reason: 'processed', invoiceId: invoice.id };
}
