/**
 * C-0010-B2 — execution attempts（真实 PostgreSQL 证明）。
 * ------------------------------------------------------------------
 * TD-PAYMENT-002 Recovery Safety：同一事件 attempt#1 失败 → attempt#2 成功 ⇒
 *   Payment = 1、账单 `ISSUED → PAID` 恰好一次、成功审计只有 1 条。
 * TD-PAYMENT-003 Replay Reason：空 / 非白名单原因一律 400 且零写入。
 * TD-PAYMENT-004 一致性：成功 attempt 必须带 paymentId 且指向存在的 Payment；
 *   成功 attempt 不允许改绑（CAS 只收口 RUNNING）；跨租户 paymentId 被触发器拒绝。
 */

import { createHmac } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ForbiddenError,
  WorkflowError,
  applyPaymentSucceeded,
  handlePaymentWebhook,
  replayPaymentEvent,
  runDueRetries,
  startAttempt,
} from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'f2000000-0000-4000-8000-000000000001';
const ORG_B = 'f2000000-0000-4000-8000-000000000002';
const INVOICE = 'f2000000-0000-4000-8000-0000000000aa';
const EVENT_B = 'f2000000-0000-4000-8000-0000000000bb';
const SECRET = 'whsec_attempt_db_proof';
const NOW = new Date('2026-09-28T18:00:00Z');

let ownerId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '执行租户', slug: 'attempt-org' },
      { id: ORG_B, name: '外部租户', slug: 'attempt-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'attempt-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });
});

async function seedInvoice(options: { total?: string; status?: 'ISSUED' | 'PAID' } = {}) {
  return prisma.billingInvoice.create({
    data: {
      id: INVOICE,
      organizationId: ORG,
      invoiceNo: 'BILL-ATTEMPT-1',
      status: options.status ?? 'ISSUED',
      subtotal: new Prisma.Decimal(options.total ?? '900.0000'),
      total: new Prisma.Decimal(options.total ?? '900.0000'),
      currency: 'USD',
      issuedAt: NOW,
    },
  });
}

async function seedEvent(options: { organizationId?: string; id?: string; providerEventId?: string } = {}) {
  return prisma.paymentEvent.create({
    data: {
      id: options.id ?? 'f2000000-0000-4000-8000-0000000000cc',
      organizationId: options.organizationId ?? ORG,
      provider: 'STRIPE',
      providerEventId: options.providerEventId ?? 'evt_attempt_1',
      eventType: 'payment_intent.succeeded',
      payloadHash: 'a'.repeat(64),
      receivedAt: NOW,
      processingResult: 'PROCESSED',
    },
  });
}

async function seedPayment(invoiceId = INVOICE, organizationId = ORG) {
  return prisma.payment.create({
    data: {
      organizationId,
      invoiceId,
      provider: 'STRIPE',
      externalPaymentId: 'pi_attempt_1',
      amount: new Prisma.Decimal('900.0000'),
      currency: 'USD',
      status: 'SUCCEEDED',
      idempotencyKey: 'pi_attempt_1',
    },
  });
}

/** 模拟「Payment 已记账、但账单推进失败」：attempt#1 = RETRYABLE_FAILED + 到点可重试。 */
async function seedFailedAttempt(eventId: string, paymentId: string) {
  return prisma.paymentProcessingAttempt.create({
    data: {
      organizationId: ORG,
      paymentEventId: eventId,
      attemptNo: 1,
      status: 'RETRYABLE_FAILED',
      errorCode: 'CAS_CONFLICT',
      errorSummary: 'simulated transient failure',
      startedAt: NOW,
      finishedAt: NOW,
      nextRetryAt: new Date(NOW.getTime() - 60_000),
      actorType: 'EXTERNAL',
      actorRef: 'STRIPE',
      paymentId,
    },
  });
}

const sign = (rawBody: string, timestamp = Math.floor(NOW.getTime() / 1000)) =>
  `t=${timestamp},v1=${createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`;

const eventBody = (amountCents = 90000) =>
  JSON.stringify({
    id: 'evt_attempt_webhook',
    type: 'payment_intent.succeeded',
    data: {
      object: { id: 'pi_attempt_webhook', amount: amountCents, currency: 'usd', metadata: { invoiceId: INVOICE } },
    },
  });

const auditCount = (action: string) => prisma.auditLog.count({ where: { organizationId: ORG, action } });
const invoiceRow = () => prisma.billingInvoice.findUniqueOrThrow({ where: { id: INVOICE } });

/** 首处理模式（webhook 语义）的探针：既有 Payment 时必须返回 ILLEGAL_TRANSITION。 */
async function applyPaymentSucceededProbe(payment: {
  invoiceId: string;
  externalPaymentId: string;
  amount: Prisma.Decimal;
  currency: string;
}): Promise<string> {
  const result = await applyPaymentSucceeded(
    prisma,
    {
      organizationId: ORG,
      provider: 'STRIPE',
      externalPaymentId: payment.externalPaymentId,
      invoiceId: payment.invoiceId,
      amount: payment.amount.toFixed(4),
      currency: payment.currency,
    },
    { now: () => NOW },
  );
  return result.status;
}

describe('C-0010-B2 — 执行尝试（真实 PostgreSQL）', () => {
  it('webhook 成功路径：一条 SUCCEEDED attempt（带 paymentId）+ 链接审计', async () => {
    await seedInvoice();
    const body = eventBody();
    const result = await handlePaymentWebhook(
      prisma,
      { rawBody: body, signatureHeader: sign(body) },
      { env: { PAYMENT_WEBHOOK_SECRET: SECRET, PAYMENTS_ENABLED: 'true' }, now: () => NOW },
    );
    expect(result.processingResult).toBe('PROCESSED');

    const attempts = await prisma.paymentProcessingAttempt.findMany({ where: { organizationId: ORG } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, status: 'SUCCEEDED', resultStatus: 'PAID' });
    expect(attempts[0].paymentId).not.toBeNull();
    expect(await auditCount('payment.processing_payment_linked')).toBe(1);

    // TD-PAYMENT-004 Case 1：成功 attempt 的 paymentId 指向存在的 Payment
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: attempts[0].paymentId! } });
    expect(payment.organizationId).toBe(ORG);
    expect((await invoiceRow()).status).toBe('PAID');
  });

  it('TD-PAYMENT-002：retry-due 重放后 Payment = 1、账单只 PAID 一次、成功审计 1 条', async () => {
    await seedInvoice();
    const event = await seedEvent();
    const payment = await seedPayment();
    await seedFailedAttempt(event.id, payment.id);

    const result = await runDueRetries(prisma, { organizationId: ORG, role: 'ADMIN' }, { now: () => NOW });
    expect(result.scanned).toBe(1);
    expect(result.deadLettered).toHaveLength(0);
    expect(result.retried).toHaveLength(1);
    expect(result.retried[0]).toMatchObject({ status: 'SUCCEEDED', resultStatus: 'PAID' });

    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(1);
    const invoice = await invoiceRow();
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAmount.toFixed(4)).toBe('900.0000');
    expect(await auditCount('payment.succeeded')).toBe(1);

    const attempts = await prisma.paymentProcessingAttempt.findMany({
      where: { organizationId: ORG },
      orderBy: { attemptNo: 'asc' },
    });
    expect(attempts.map((row) => row.status)).toEqual(['RETRYABLE_FAILED', 'SUCCEEDED']);
    expect(attempts[1].paymentId).toBe(payment.id);

    // TD-PAYMENT-004 Case 2（不变量）：不存在「成功但没有 paymentId」的 attempt
    expect(
      await prisma.paymentProcessingAttempt.count({
        where: { organizationId: ORG, status: 'SUCCEEDED', paymentId: null },
      }),
    ).toBe(0);
  });

  it('TD-PAYMENT-003：replay 需要白名单原因；有上下文时按 record 重放且审计齐全', async () => {
    await seedInvoice();
    const event = await seedEvent();
    const payment = await seedPayment();
    await seedFailedAttempt(event.id, payment.id);

    const base = {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      paymentEventId: event.id,
    };

    await expect(replayPaymentEvent(prisma, { ...base, reason: '' })).rejects.toThrow(WorkflowError);
    await expect(replayPaymentEvent(prisma, { ...base, reason: 'BECAUSE_I_SAID_SO' })).rejects.toThrow(WorkflowError);
    expect(await prisma.paymentProcessingAttempt.count({ where: { organizationId: ORG } })).toBe(1);

    await expect(
      replayPaymentEvent(prisma, { ...base, role: 'FINANCE', reason: 'MANUAL_RECOVERY' }),
    ).rejects.toThrow(ForbiddenError);

    const replayed = await replayPaymentEvent(
      prisma,
      { ...base, reason: 'MANUAL_RECOVERY', note: 'provider console confirmed the capture' },
      { now: () => NOW },
    );
    expect(replayed).toMatchObject({ attemptNo: 2, status: 'SUCCEEDED', resultStatus: 'PAID' });
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(1);
    expect((await invoiceRow()).status).toBe('PAID');

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'payment.processing_replayed' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].changes).toMatchObject({
      paymentEventId: event.id,
      oldAttemptNo: 1,
      newAttemptNo: 2,
      reason: 'MANUAL_RECOVERY',
    });
    expect(audits[0].actorUserId).toBe(base.actorUserId);

    // MSG-96 REVISE-2：恢复成功要有独立审计标识，且链路三段齐全
    const recovered = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'payment.processing_recovered' },
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0].changes).toMatchObject({
      paymentEventId: event.id,
      paymentId: payment.id,
      resultStatus: 'PAID',
      recovery: true,
    });
    expect(await auditCount('payment.processing_payment_linked')).toBeGreaterThanOrEqual(1);
    expect((await invoiceRow()).status).toBe('PAID');
  });

  it('MSG-96 REVISE：首处理与恢复语义隔离（同一笔已记账付款）', async () => {
    await seedInvoice();
    const event = await seedEvent();
    const payment = await seedPayment();
    // 应用的真实形态：事件已处理、Payment 已记账、账单推进失败 → attempt#1 记下 paymentId
    await seedFailedAttempt(event.id, payment.id);

    // 首处理（webhook 语义）：既有 Payment → ILLEGAL_TRANSITION，账单不动
    const first = await applyPaymentSucceededProbe(payment);
    expect(first).toBe('ILLEGAL_TRANSITION');
    expect((await invoiceRow()).status).toBe('ISSUED');

    // 恢复（replay）：同一笔 Payment 继续把账单推到终态
    const replayed = await replayPaymentEvent(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', paymentEventId: event.id, reason: 'MANUAL_RECOVERY' },
      { now: () => NOW },
    );
    expect(replayed.resultStatus).toBe('PAID');
    expect((await invoiceRow()).status).toBe('PAID');
  });

  it('MSG-96 REVISE：成功 attempt 不可改写（paymentId 改绑 / 成功但无 paymentId 都被数据库拒绝）', async () => {
    await seedInvoice();
    const event = await seedEvent();
    const payment = await seedPayment();
    const other = await prisma.payment.create({
      data: {
        organizationId: ORG,
        invoiceId: INVOICE,
        provider: 'STRIPE',
        externalPaymentId: 'pi_other',
        amount: new Prisma.Decimal('900.0000'),
        currency: 'USD',
        status: 'SUCCEEDED',
        idempotencyKey: 'pi_other',
      },
    });

    const attempt = await prisma.paymentProcessingAttempt.create({
      data: {
        organizationId: ORG,
        paymentEventId: event.id,
        attemptNo: 1,
        status: 'SUCCEEDED',
        resultStatus: 'PAID',
        actorType: 'EXTERNAL',
        actorRef: 'STRIPE',
        paymentId: payment.id,
        startedAt: NOW,
        finishedAt: NOW,
      },
    });

    // 改绑被触发器拒绝
    await expect(
      prisma.paymentProcessingAttempt.update({ where: { id: attempt.id }, data: { paymentId: other.id } }),
    ).rejects.toThrow();
    // 成功但无 paymentId 被 CHECK 拒绝
    await expect(
      prisma.paymentProcessingAttempt.create({
        data: {
          organizationId: ORG,
          paymentEventId: event.id,
          attemptNo: 2,
          status: 'SUCCEEDED',
          actorType: 'EXTERNAL',
          actorRef: 'STRIPE',
        },
      }),
    ).rejects.toThrow();
    const unchanged = await prisma.paymentProcessingAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(unchanged.paymentId).toBe(payment.id);
  });

  it('并发保护：同一事件同一时刻只允许一个进行中的 attempt；跨租户 paymentId 被拒', async () => {
    await seedInvoice();
    const event = await seedEvent();
    const payment = await seedPayment();

    const first = await startAttempt(
      prisma,
      { organizationId: ORG, paymentEventId: event.id, actorType: 'OPERATOR', actorRef: 'u-1' },
      { now: () => NOW },
    );
    expect(first.attemptNo).toBe(1);

    // 部分唯一索引（PENDING/RUNNING）确定性证明
    await expect(
      startAttempt(prisma, {
        organizationId: ORG,
        paymentEventId: event.id,
        actorType: 'OPERATOR',
        actorRef: 'u-2',
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_ALREADY_RUNNING' });

    // 并发 replay：不变量必须仍然成立
    await prisma.paymentProcessingAttempt.updateMany({
      where: { id: first.id },
      data: { status: 'RETRYABLE_FAILED', paymentId: payment.id, nextRetryAt: new Date(NOW.getTime() - 1000) },
    });
    const settled = await Promise.allSettled([
      replayPaymentEvent(
        prisma,
        { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', paymentEventId: event.id, reason: 'MANUAL_RECOVERY' },
        { now: () => NOW },
      ),
      replayPaymentEvent(
        prisma,
        { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', paymentEventId: event.id, reason: 'MANUAL_RECOVERY' },
        { now: () => NOW },
      ),
    ]);
    expect(settled.some((entry) => entry.status === 'fulfilled')).toBe(true);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(1);
    expect((await invoiceRow()).status).toBe('PAID');
    expect(await auditCount('payment.succeeded')).toBe(1);

    // TD-PAYMENT-004 Case 3：跨租户 paymentId 必须被数据库触发器拒绝
    const foreignEvent = await seedEvent({ organizationId: ORG_B, id: EVENT_B, providerEventId: 'evt_foreign' });
    await expect(
      prisma.paymentProcessingAttempt.create({
        data: {
          organizationId: ORG_B,
          paymentEventId: foreignEvent.id,
          attemptNo: 1,
          status: 'RUNNING',
          actorType: 'EXTERNAL',
          actorRef: 'STRIPE',
          paymentId: payment.id,
        },
      }),
    ).rejects.toThrow();
  });
});
