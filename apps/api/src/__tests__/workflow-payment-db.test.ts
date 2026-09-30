/**
 * C-0010-A — Payment domain + webhook receiver（真实 PostgreSQL 证明）。
 * ------------------------------------------------------------------
 * 架构方点名 4 条验收：
 *   A. PAYMENTS_ENABLED=false → 验签通过后 IGNORE + 200，只落 1 条 IGNORED
 *      PaymentEvent，Payment=0，发票保持 ISSUED；
 *   B. 同一 providerEventId 并发重放 → PROCESSED=1、DUPLICATE>=1，
 *      PaymentEvent=1、Payment=1，发票只被推进一次；
 *   C. 金额不符 → 发票不转 PAID，落 payment.reconciliation_failed；
 *   D. Recovery HITL 与 Payment HITL 是两个域：recovery.review_approved 不能
 *      替代 payment.review_required，Payment 审批也只落在 BillingInvoice 上。
 * 附加 E：Payment.invoiceId 跨租户触发器（19 → 20 的第 20 个）在真实库生效。
 */

import { createHmac } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ForbiddenError,
  handlePaymentWebhook,
  submitPaymentReview,
  submitRecoveryReview,
} from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'd1000000-0000-4000-8000-000000000001';
const ORG_B = 'd1000000-0000-4000-8000-000000000002';
const INVOICE = 'd1000000-0000-4000-8000-0000000000aa';
const CASE_ID = 'd1000000-0000-4000-8000-0000000000cc';
const SECRET = 'whsec_local_db_proof';
const NOW = new Date('2026-09-28T18:00:00Z');
const THRESHOLD = '1000.0000';

let ownerId = '';
let caseId = '';

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
});

function sign(rawBody: string, timestamp = Math.floor(NOW.getTime() / 1000)): string {
  const v1 = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** 金额一律按 provider 的最小单位（分）给，服务层负责换算成 4 位小数。 */
function succeededEvent(eventId: string, paymentId: string, amountCents: number): string {
  return JSON.stringify({
    id: eventId,
    type: 'payment_intent.succeeded',
    data: {
      object: { id: paymentId, amount: amountCents, currency: 'usd', metadata: { invoiceId: INVOICE } },
    },
  });
}

function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PAYMENT_WEBHOOK_SECRET: SECRET,
    PAYMENTS_ENABLED: 'true',
    PAYMENT_REVIEW_THRESHOLD: THRESHOLD,
    ...overrides,
  };
}

function post(rawBody: string, overrides: Record<string, string> = {}) {
  return handlePaymentWebhook(
    prisma,
    { rawBody, signatureHeader: sign(rawBody) },
    { env: testEnv(overrides), now: () => NOW },
  );
}

async function seed(options: { total?: string; currency?: string } = {}) {
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '支付租户', slug: 'payment-org' },
      { id: ORG_B, name: '外部租户', slug: 'payment-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'payment-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });
  const kase = await prisma.case.create({
    data: {
      id: CASE_ID,
      organizationId: ORG,
      caseNo: 'CASE-PAY-1',
      title: '支付验收案件',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('1500.0000'),
      recoveredAmount: new Prisma.Decimal('1500.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  const total = options.total ?? '3994.0000';
  const invoice = await prisma.billingInvoice.create({
    data: {
      id: INVOICE,
      organizationId: ORG,
      caseId: kase.id,
      invoiceNo: 'BILL-PAY-1',
      status: 'ISSUED',
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      currency: options.currency ?? 'USD',
      issuedAt: NOW,
    },
  });
  return { kase, invoice };
}

const invoiceRow = () => prisma.billingInvoice.findUniqueOrThrow({ where: { id: INVOICE } });
const auditCount = (action: string) =>
  prisma.auditLog.count({ where: { organizationId: ORG, action } });

describe('C-0010-A — 支付域（真实 PostgreSQL）', () => {
  it('A. flag 关闭：验签通过 → IGNORE + 200，只落 1 条 IGNORED 事件，发票保持 ISSUED', async () => {
    await seed();
    const result = await post(succeededEvent('evt_off_1', 'pi_off_1', 399400), {
      PAYMENTS_ENABLED: 'false',
    });

    expect(result).toMatchObject({
      httpStatus: 200,
      processingResult: 'IGNORED',
      reason: 'payments_disabled',
    });

    const events = await prisma.paymentEvent.findMany({ where: { organizationId: ORG } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'STRIPE',
      providerEventId: 'evt_off_1',
      eventType: 'payment_intent.succeeded',
      processingResult: 'IGNORED',
    });
    expect(events[0].payloadHash).toHaveLength(64);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(0);

    const invoice = await invoiceRow();
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.paidAt).toBeNull();
    expect(invoice.paidAmount.toFixed(4)).toBe('0.0000');
  });

  it('B. 同 providerEventId 并发重放：PROCESSED=1、DUPLICATE>=1，发票只推进一次', async () => {
    // 金额低于人工卡口阈值，让这条用例只考察幂等闸与 CAS
    await seed({ total: '900.0000' });
    const body = succeededEvent('evt_race_1', 'pi_race_1', 90000);

    const [first, second] = await Promise.all([post(body), post(body)]);

    expect([first.processingResult, second.processingResult].sort()).toEqual(['DUPLICATE', 'PROCESSED']);
    expect(await prisma.paymentEvent.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await auditCount('payment.succeeded')).toBe(1);

    const invoice = await invoiceRow();
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAt).not.toBeNull();
    expect(invoice.paidAmount.toFixed(4)).toBe('900.0000');
  });

  it('C. 金额不符：发票不转 PAID，落 payment.reconciliation_failed', async () => {
    await seed({ total: '3994.0000' });
    const result = await post(succeededEvent('evt_amount_1', 'pi_amount_1', 9900));
    expect(result).toMatchObject({ httpStatus: 200, processingResult: 'PROCESSED' });

    const invoice = await invoiceRow();
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.paidAt).toBeNull();

    const failures = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'payment.reconciliation_failed' },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0].changes).toMatchObject({
      reason: 'amount mismatch',
      expected: '3994.0000',
      received: '99.0000',
    });

    const payments = await prisma.payment.findMany({ where: { organizationId: ORG } });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('FAILED');
    expect(payments[0].amount.toFixed(4)).toBe('99.0000');
  });

  it('D. Payment HITL 与 Recovery HITL 域隔离；Payment 审批后才能 PAID', async () => {
    await seed({ total: '1500.0000' });

    // 1) 高额付款首次回调 → 进入 Payment 卡口，发票不动
    await post(succeededEvent('evt_hitl_1', 'pi_hitl_1', 150000));
    expect((await invoiceRow()).status).toBe('ISSUED');
    expect(await auditCount('payment.review_required')).toBe(1);

    // 2) 案件侧的 Recovery HITL 走完整流程（REQUEST → APPROVE）
    await submitRecoveryReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', caseId, decision: 'REQUEST' },
      () => NOW,
    );
    await submitRecoveryReview(
      prisma,
      {
        organizationId: ORG,
        actorUserId: ownerId,
        role: 'OWNER',
        caseId,
        decision: 'APPROVE',
        // CHANGE A（R2）：审批必须绑定本次操作载荷
        boundPayload: { recoveredAmount: '1500.0000', currency: 'USD', basisReference: 'payment-db-basis', evidenceArtifactId: null },
        boundAction: 'commission.charge',
      },
      () => NOW,
    );
    expect(await auditCount('recovery.review_approved')).toBe(1);

    // 3) Recovery 的审批不能替代 Payment 审批：新的付款事件仍被卡住
    await post(succeededEvent('evt_hitl_2', 'pi_hitl_2', 150000));
    expect((await invoiceRow()).status).toBe('ISSUED');
    expect(await auditCount('payment.review_required')).toBe(2);

    // 4) 两个域各自落在自己的实体上，互不串门
    const paymentReviewRows = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: { startsWith: 'payment.review' } },
      select: { entityType: true, entityId: true },
    });
    expect(paymentReviewRows).toHaveLength(2);
    expect(
      paymentReviewRows.every((row) => row.entityType === 'BillingInvoice' && row.entityId === INVOICE),
    ).toBe(true);
    const recoveryRows = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: { startsWith: 'recovery.review' } },
      select: { entityType: true, entityId: true },
    });
    expect(recoveryRows).toHaveLength(2);
    expect(recoveryRows.every((row) => row.entityType === 'Case' && row.entityId === CASE_ID)).toBe(true);

    // 5) FINANCE 能看账单但不能审批 Payment 卡口（与 Recovery 同一口径）
    await expect(
      submitPaymentReview(prisma, {
        organizationId: ORG,
        actorUserId: ownerId,
        role: 'FINANCE',
        invoiceId: INVOICE,
        decision: 'APPROVE',
      }),
    ).rejects.toThrow(ForbiddenError);

    // 6) OWNER 审批后，第三次回调把发票推进到 PAID
    const approval = await submitPaymentReview(prisma, {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      invoiceId: INVOICE,
      decision: 'APPROVE',
    });
    expect(approval.state).toBe('APPROVED');

    await post(succeededEvent('evt_hitl_3', 'pi_hitl_3', 150000));
    const invoice = await invoiceRow();
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAmount.toFixed(4)).toBe('1500.0000');
    expect(await auditCount('payment.succeeded')).toBe(1);
  });

  it('E. Payment.invoiceId 跨租户写入被数据库触发器拒绝', async () => {
    await seed();
    await expect(
      prisma.payment.create({
        data: {
          organizationId: ORG_B,
          invoiceId: INVOICE,
          provider: 'STRIPE',
          externalPaymentId: 'pi_cross_tenant',
          amount: new Prisma.Decimal('1.0000'),
          currency: 'USD',
          idempotencyKey: 'cross-tenant',
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.payment.count({ where: { organizationId: ORG_B } })).toBe(0);
  });
});
