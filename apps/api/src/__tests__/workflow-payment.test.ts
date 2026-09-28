/**
 * C-0010-A — Payment domain + webhook receiver (unit, no database).
 * ---------------------------------------------------------------
 * Covers the architect's acceptance tests: feature-flag proof (IGNORED + 200),
 * duplicate detection (PROCESSED=1 / DUPLICATE>=1), PAID protection on amount
 * mismatch, and Payment-HITL isolation from the Recovery HITL domain.
 */

import { createHmac } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PAYMENT_REVIEW_THRESHOLD,
  PAYMENT_REVIEW_ACTIONS,
  applyPaymentSucceeded,
  handlePaymentWebhook,
  paymentsEnabled,
  requiresPaymentReview,
  resolvePaymentReviewState,
  resolvePaymentReviewThreshold,
  verifyProviderSignature,
} from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-000000000017';
const INVOICE = 'cccccccc-3333-4333-8333-cccccccccccc';
const NOW = new Date('2026-09-28T18:00:00Z');
const SECRET = 'whsec_test_secret_value';

function sign(rawBody: string, secret = SECRET, timestamp = Math.floor(NOW.getTime() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

const succeededBody = JSON.stringify({
  id: 'evt_1',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_1', amount: 3994, currency: 'usd', metadata: { invoiceId: INVOICE } } },
});

describe('C-0010-A — Webhook 验签', () => {
  it('合法签名通过；篡改/过期/缺密钥/格式错误分别拒绝', () => {
    expect(
      verifyProviderSignature({ rawBody: succeededBody, signatureHeader: sign(succeededBody), secret: SECRET, now: () => NOW }),
    ).toBe('VALID');
    expect(
      verifyProviderSignature({
        rawBody: `${succeededBody} `,
        signatureHeader: sign(succeededBody),
        secret: SECRET,
        now: () => NOW,
      }),
    ).toBe('MISMATCH');
    expect(
      verifyProviderSignature({
        rawBody: succeededBody,
        signatureHeader: sign(succeededBody, SECRET, Math.floor(NOW.getTime() / 1000) - 3600),
        secret: SECRET,
        now: () => NOW,
      }),
    ).toBe('EXPIRED');
    expect(
      verifyProviderSignature({ rawBody: succeededBody, signatureHeader: sign(succeededBody), secret: undefined, now: () => NOW }),
    ).toBe('MISSING_SECRET');
    expect(
      verifyProviderSignature({ rawBody: succeededBody, signatureHeader: 'garbage', secret: SECRET, now: () => NOW }),
    ).toBe('MALFORMED');
  });
});

describe('C-0010-A — 阈值与开关', () => {
  it('PAYMENT_REVIEW_THRESHOLD 独立于追回阈值；非法回退默认', () => {
    expect(resolvePaymentReviewThreshold({})).toBe(DEFAULT_PAYMENT_REVIEW_THRESHOLD);
    expect(resolvePaymentReviewThreshold({ PAYMENT_REVIEW_THRESHOLD: '2500' })).toBe('2500.0000');
    expect(resolvePaymentReviewThreshold({ PAYMENT_REVIEW_THRESHOLD: 'oops' })).toBe(
      DEFAULT_PAYMENT_REVIEW_THRESHOLD,
    );
  });

  it('USD 严格大于阈值才需要复核；非 USD 一律复核；开关默认关闭', () => {
    expect(requiresPaymentReview({ amount: '1000.0000', currency: 'USD', threshold: '1000.0000' })).toBe(false);
    expect(requiresPaymentReview({ amount: '1000.0001', currency: 'USD', threshold: '1000.0000' })).toBe(true);
    expect(requiresPaymentReview({ amount: '1.0000', currency: 'EUR', threshold: '1000.0000' })).toBe(true);
    expect(paymentsEnabled({})).toBe(false);
    expect(paymentsEnabled({ PAYMENTS_ENABLED: 'true' })).toBe(true);
  });

  it('Payment HITL 与 Recovery HITL 审计域隔离（只认 payment.* 动作）', () => {
    // 只有追回域动作 → 支付域视为未要求
    expect(
      resolvePaymentReviewState([
        { action: 'recovery.review_required', createdAt: NOW },
        { action: 'recovery.review_approved', createdAt: NOW },
      ]),
    ).toBe('NOT_REQUIRED');
    // 支付域内 approved 必须晚于 required
    const ordered = [
      { action: PAYMENT_REVIEW_ACTIONS.required, createdAt: new Date('2026-09-28T09:00:00Z') },
      { action: PAYMENT_REVIEW_ACTIONS.approved, createdAt: new Date('2026-09-28T10:00:00Z') },
    ];
    expect(resolvePaymentReviewState(ordered)).toBe('APPROVED');
    expect(
      resolvePaymentReviewState([
        ordered[1],
        { action: PAYMENT_REVIEW_ACTIONS.required, createdAt: new Date('2026-09-28T11:00:00Z') },
      ]),
    ).toBe('PENDING');
  });
});

function fakeWebhookPrisma(options: { flagOn: boolean; invoice?: boolean; existingEvent?: boolean } = { flagOn: false }) {
  const eventCreate: ReturnType<typeof vi.fn> = vi.fn(async () => ({ id: 'event-1' }));
  const invoiceFindFirst: ReturnType<typeof vi.fn> = vi.fn(async () =>
    options.invoice === false ? null : { id: INVOICE, organizationId: ORG },
  );
  const prisma = {
    billingInvoice: { findFirst: invoiceFindFirst },
    paymentEvent: {
      findFirst: vi.fn(async () => (options.existingEvent ? { id: 'existing' } : null)),
      create: eventCreate,
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ paymentEvent: { create: eventCreate } }),
    ),
  } as unknown as PrismaClient;
  return { prisma, eventCreate, invoiceFindFirst };
}

describe('C-0010-A — Webhook 处理（开关 / 幂等 / 归属）', () => {
  it('缺密钥 → 400 REJECTED 且不落库', async () => {
    const { prisma, eventCreate } = fakeWebhookPrisma();
    const result = await handlePaymentWebhook(
      prisma,
      { rawBody: succeededBody, signatureHeader: sign(succeededBody) },
      { env: { PAYMENTS_ENABLED: 'true' }, now: () => NOW },
    );
    expect(result).toMatchObject({ httpStatus: 400, processingResult: 'REJECTED', reason: 'MISSING_SECRET' });
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it('验签失败 → 400 REJECTED（只写安全日志）', async () => {
    const { prisma, eventCreate } = fakeWebhookPrisma();
    const logs: string[] = [];
    const result = await handlePaymentWebhook(
      prisma,
      { rawBody: succeededBody, signatureHeader: 't=1,v1=deadbeef' },
      {
        env: { PAYMENT_WEBHOOK_SECRET: SECRET, PAYMENTS_ENABLED: 'true' },
        now: () => NOW,
        log: (event) => logs.push(event),
      },
    );
    expect(result.httpStatus).toBe(400);
    expect(eventCreate).not.toHaveBeenCalled();
    expect(logs).toContain('payment_webhook_rejected');
  });

  it('无法归属租户的事件 → 200 IGNORED 且不落库（仍回 200 让 provider 停止重试）', async () => {
    const { prisma, eventCreate } = fakeWebhookPrisma({ flagOn: true, invoice: false });
    const result = await handlePaymentWebhook(
      prisma,
      { rawBody: succeededBody, signatureHeader: sign(succeededBody) },
      { env: { PAYMENT_WEBHOOK_SECRET: SECRET, PAYMENTS_ENABLED: 'true' }, now: () => NOW },
    );
    expect(result).toMatchObject({ httpStatus: 200, processingResult: 'IGNORED', reason: 'unattributed_event' });
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it('Feature flag 关闭 → IGNORED + 200，且只写 1 条 PaymentEvent（Payment/Billing 不动）', async () => {
    const { prisma, eventCreate } = fakeWebhookPrisma({ flagOn: false });
    const result = await handlePaymentWebhook(
      prisma,
      { rawBody: succeededBody, signatureHeader: sign(succeededBody) },
      { env: { PAYMENT_WEBHOOK_SECRET: SECRET, PAYMENTS_ENABLED: 'false' }, now: () => NOW },
    );
    expect(result).toMatchObject({ httpStatus: 200, processingResult: 'IGNORED', reason: 'payments_disabled' });
    expect(eventCreate).toHaveBeenCalledTimes(1);
    expect(eventCreate.mock.calls[0][0].data).toMatchObject({
      provider: 'STRIPE',
      providerEventId: 'evt_1',
      eventType: 'payment_intent.succeeded',
      processingResult: 'IGNORED',
    });
  });

  it('重复事件 → 200 DUPLICATE 且不重复落库', async () => {
    const { prisma, eventCreate } = fakeWebhookPrisma({ flagOn: true, existingEvent: true });
    const result = await handlePaymentWebhook(
      prisma,
      { rawBody: succeededBody, signatureHeader: sign(succeededBody) },
      { env: { PAYMENT_WEBHOOK_SECRET: SECRET, PAYMENTS_ENABLED: 'true' }, now: () => NOW },
    );
    expect(result).toMatchObject({ httpStatus: 200, processingResult: 'DUPLICATE' });
    expect(eventCreate).not.toHaveBeenCalled();
  });
});

function fakePaymentPrisma(options: {
  invoiceStatus?: string;
  total?: string;
  currency?: string;
  reviewEvents?: Array<{ action: string; createdAt: Date }>;
  casHits?: boolean;
} = {}) {
  const invoiceStatus = options.invoiceStatus ?? 'ISSUED';
  const total = options.total ?? '3994.0000';
  const currency = options.currency ?? 'USD';
  const auditCreate: ReturnType<typeof vi.fn> = vi.fn(async () => ({ id: 'audit-1' }));
  const paymentCreate: ReturnType<typeof vi.fn> = vi.fn(async () => ({ id: 'payment-1' }));
  const updateMany: ReturnType<typeof vi.fn> = vi.fn(async () => ({ count: options.casHits === false ? 0 : 1 }));

  const tx = {
    payment: { findFirst: vi.fn(async () => null), create: paymentCreate },
    billingInvoice: { updateMany },
    auditLog: { create: auditCreate, findMany: vi.fn(async () => options.reviewEvents ?? []) },
  };

  const prisma = {
    billingInvoice: {
      findFirst: vi.fn(async () => ({
        id: INVOICE,
        status: invoiceStatus,
        total: new Prisma.Decimal(total),
        currency,
        invoiceNo: 'BILL-1',
      })),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;

  return { prisma, auditCreate, paymentCreate, updateMany };
}

describe('C-0010-A — PAID 推进保护', () => {
  it('金额不一致 → AMOUNT_MISMATCH，绝不推进 PAID', async () => {
    const { prisma, updateMany, auditCreate } = fakePaymentPrisma({ total: '9900.0000' });
    const result = await applyPaymentSucceeded(
      prisma,
      {
        organizationId: ORG,
        provider: 'STRIPE',
        externalPaymentId: 'pi_1',
        invoiceId: INVOICE,
        amount: '10000.0000',
        currency: 'USD',
      },
      { now: () => NOW },
    );
    expect(result.status).toBe('AMOUNT_MISMATCH');
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate.mock.calls.map((c) => c[0].data.action)).toContain('payment.reconciliation_failed');
  });

  it('高额账单未经 Payment HITL → PENDING_REVIEW（不推进 PAID）', async () => {
    const { prisma, updateMany, auditCreate } = fakePaymentPrisma({ total: '1500.0000' });
    const result = await applyPaymentSucceeded(
      prisma,
      {
        organizationId: ORG,
        provider: 'STRIPE',
        externalPaymentId: 'pi_2',
        invoiceId: INVOICE,
        amount: '1500.0000',
        currency: 'USD',
      },
      { now: () => NOW },
    );
    expect(result.status).toBe('PENDING_REVIEW');
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditCreate.mock.calls.map((c) => c[0].data.action)).toContain(PAYMENT_REVIEW_ACTIONS.required);
  });

  it('金额一致且已通过复核 → PAID（CAS 命中一次）', async () => {
    const { prisma, updateMany, auditCreate } = fakePaymentPrisma({
      total: '1500.0000',
      reviewEvents: [
        { action: PAYMENT_REVIEW_ACTIONS.required, createdAt: new Date('2026-09-28T09:00:00Z') },
        { action: PAYMENT_REVIEW_ACTIONS.approved, createdAt: new Date('2026-09-28T10:00:00Z') },
      ],
    });
    const result = await applyPaymentSucceeded(
      prisma,
      {
        organizationId: ORG,
        provider: 'STRIPE',
        externalPaymentId: 'pi_3',
        invoiceId: INVOICE,
        amount: '1500.0000',
        currency: 'USD',
      },
      { now: () => NOW },
    );
    expect(result.status).toBe('PAID');
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ status: 'ISSUED' });
    expect(auditCreate.mock.calls.map((c) => c[0].data.action)).toContain('payment.succeeded');
  });

  it('CAS 未命中（已被其他事件推进）→ ILLEGAL_TRANSITION + 异常审计', async () => {
    const { prisma, auditCreate } = fakePaymentPrisma({
      casHits: false,
      reviewEvents: [
        { action: PAYMENT_REVIEW_ACTIONS.required, createdAt: new Date('2026-09-28T09:00:00Z') },
        { action: PAYMENT_REVIEW_ACTIONS.approved, createdAt: new Date('2026-09-28T10:00:00Z') },
      ],
    });
    const result = await applyPaymentSucceeded(
      prisma,
      {
        organizationId: ORG,
        provider: 'STRIPE',
        externalPaymentId: 'pi_4',
        invoiceId: INVOICE,
        amount: '3994.0000',
        currency: 'USD',
      },
      { now: () => NOW },
    );
    expect(result.status).toBe('ILLEGAL_TRANSITION');
    expect(auditCreate.mock.calls.map((c) => c[0].data.action)).toContain('payment.reconciliation_failed');
  });
});
