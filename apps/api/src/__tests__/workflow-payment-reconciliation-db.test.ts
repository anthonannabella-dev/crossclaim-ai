/**
 * C-0010-B — finance reconciliation（真实 PostgreSQL 证明）。
 * ------------------------------------------------------------------
 * 需要证明：
 *   1. Payment × BillingInvoice × Audit 三类差异都能被识别（含 Payment HITL 待审）；
 *   2. 跨租户发票**绝不出现**在清单里；
 *   3. 本模块**零写入**（Payment / BillingInvoice / AuditLog 计数前后不变）；
 *   4. CSV 与 JSON 同源（7 列，行数一致）。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ForbiddenError,
  RECONCILIATION_CSV_HEADER,
  listPaymentReconciliation,
  toReconciliationCsv,
} from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'e1000000-0000-4000-8000-000000000001';
const ORG_B = 'e1000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-28T18:00:00Z');

let adminId = '';

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
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '对账租户', slug: 'recon-org' },
      { id: ORG_B, name: '外部租户', slug: 'recon-org-b' },
    ],
  });
  const admin = await prisma.user.create({
    data: { email: 'recon-admin@example.com', displayName: '财务管理员', status: 'ACTIVE' },
  });
  adminId = admin.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: admin.id, role: 'ADMIN', isActive: true }],
  });
});

async function seedInvoice(options: {
  organizationId?: string;
  invoiceNo: string;
  status: 'DRAFT' | 'ISSUED' | 'PAID';
  total: string;
  paidAmount?: string;
  currency?: string;
  payments?: Array<{ amount: string; status: 'CREATED' | 'SUCCEEDED' | 'FAILED'; currency?: string }>;
  review?: 'pending' | 'rejected' | 'approved';
}) {
  const organizationId = options.organizationId ?? ORG;
  const invoice = await prisma.billingInvoice.create({
    data: {
      organizationId,
      invoiceNo: options.invoiceNo,
      status: options.status,
      subtotal: new Prisma.Decimal(options.total),
      total: new Prisma.Decimal(options.total),
      currency: options.currency ?? 'USD',
      paidAmount: new Prisma.Decimal(options.paidAmount ?? '0.0000'),
      issuedAt: NOW,
      paidAt: options.status === 'PAID' ? NOW : null,
    },
  });
  for (const [index, payment] of (options.payments ?? []).entries()) {
    await prisma.payment.create({
      data: {
        organizationId,
        invoiceId: invoice.id,
        provider: 'STRIPE',
        externalPaymentId: `${options.invoiceNo}-pi-${index}`,
        amount: new Prisma.Decimal(payment.amount),
        currency: payment.currency ?? 'USD',
        status: payment.status,
        idempotencyKey: `${options.invoiceNo}:${index}`,
      },
    });
  }
  if (options.review) {
    const actions =
      options.review === 'pending'
        ? ['payment.review_required']
        : options.review === 'approved'
          ? ['payment.review_required', 'payment.review_approved']
          : ['payment.review_required', 'payment.review_rejected'];
    for (const [index, action] of actions.entries()) {
      await prisma.auditLog.create({
        data: {
          organizationId,
          actorType: 'EXTERNAL',
          actorRef: 'STRIPE',
          action,
          entityType: 'BillingInvoice',
          entityId: invoice.id,
          changes: { invoiceNo: options.invoiceNo },
          createdAt: new Date(NOW.getTime() + index * 60_000),
        },
      });
    }
  }
  return invoice;
}

const counts = async () => ({
  payments: await prisma.payment.count(),
  paymentsEvents: await prisma.paymentEvent.count(),
  invoices: await prisma.billingInvoice.count(),
  audits: await prisma.auditLog.count(),
});

const asActor = (role: string) => ({ organizationId: ORG, role });

describe('C-0010-B — 财务对账差异清单（真实 PostgreSQL）', () => {
  it('识别金额不符 / 待审 / 未 PAID / PAID 无付款 / paidAmount 不符 / 失败付款', async () => {
    const amountMismatch = await seedInvoice({
      invoiceNo: 'BILL-AMOUNT',
      status: 'ISSUED',
      total: '1000.0000',
      payments: [{ amount: '900.0000', status: 'SUCCEEDED' }],
    });
    const awaiting = await seedInvoice({
      invoiceNo: 'BILL-REVIEW',
      status: 'ISSUED',
      total: '1500.0000',
      payments: [{ amount: '1500.0000', status: 'SUCCEEDED' }],
      review: 'pending',
    });
    const notPaid = await seedInvoice({
      invoiceNo: 'BILL-NOTPAID',
      status: 'ISSUED',
      total: '800.0000',
      payments: [{ amount: '800.0000', status: 'SUCCEEDED' }],
    });
    const paidNoPayment = await seedInvoice({
      invoiceNo: 'BILL-MANUAL',
      status: 'PAID',
      total: '500.0000',
      paidAmount: '500.0000',
    });
    const paidAmountMismatch = await seedInvoice({
      invoiceNo: 'BILL-PAID-DIFF',
      status: 'PAID',
      total: '700.0000',
      paidAmount: '600.0000',
      payments: [{ amount: '700.0000', status: 'SUCCEEDED' }],
    });
    const failed = await seedInvoice({
      invoiceNo: 'BILL-FAILED',
      status: 'ISSUED',
      total: '300.0000',
      payments: [{ amount: '300.0000', status: 'FAILED' }],
    });
    // 对账完全一致的发票：不应出现在清单里
    const healthy = await seedInvoice({
      invoiceNo: 'BILL-OK',
      status: 'PAID',
      total: '400.0000',
      paidAmount: '400.0000',
      payments: [{ amount: '400.0000', status: 'SUCCEEDED' }],
    });

    const before = await counts();
    const report = await listPaymentReconciliation(prisma, asActor('ADMIN'), { now: () => NOW });
    const after = await counts();

    const byInvoice = new Map(report.items.map((item) => [item.invoiceId, item]));
    expect(byInvoice.get(amountMismatch.id)?.differenceType).toBe('AMOUNT_MISMATCH');
    expect(byInvoice.get(awaiting.id)).toMatchObject({
      differenceType: 'AWAITING_PAYMENT_REVIEW',
      status: 'ISSUED|SUCCEEDED',
    });
    expect(byInvoice.get(notPaid.id)?.differenceType).toBe('PAYMENT_WITHOUT_PAID_INVOICE');
    expect(byInvoice.get(paidNoPayment.id)).toMatchObject({
      differenceType: 'PAID_WITHOUT_PAYMENT',
      paymentId: null,
      status: 'PAID|NO_PAYMENT',
    });
    expect(byInvoice.get(paidAmountMismatch.id)?.differenceType).toBe('PAID_AMOUNT_MISMATCH');
    expect(byInvoice.get(failed.id)?.differenceType).toBe('FAILED_PAYMENT');
    expect(byInvoice.has(healthy.id)).toBe(false);
    expect(report.items).toHaveLength(6);
    expect(report.scannedInvoices).toBe(7);
    expect(report.counts.AMOUNT_MISMATCH).toBe(1);
    expect(report.counts.AWAITING_PAYMENT_REVIEW).toBe(1);
    expect(report.counts.PAID_AMOUNT_MISMATCH).toBe(1);
    expect(after).toEqual(before);
  });

  it('跨租户发票绝不进入清单；CSV 与 JSON 同源且为架构方指定的 7 列', async () => {
    await seedInvoice({
      invoiceNo: 'BILL-OURS',
      status: 'ISSUED',
      total: '1000.0000',
      payments: [{ amount: '900.0000', status: 'SUCCEEDED' }],
    });
    const foreign = await seedInvoice({
      organizationId: ORG_B,
      invoiceNo: 'BILL-FOREIGN',
      status: 'ISSUED',
      total: '1000.0000',
      payments: [{ amount: '900.0000', status: 'SUCCEEDED' }],
    });

    const report = await listPaymentReconciliation(prisma, asActor('OWNER'), { now: () => NOW });
    expect(report.items.some((item) => item.invoiceId === foreign.id)).toBe(false);
    expect(report.scannedInvoices).toBe(1);

    const csv = toReconciliationCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toBe([...RECONCILIATION_CSV_HEADER].join(','));
    expect(lines).toHaveLength(report.items.length + 1);
    expect(lines[1]).toContain('"AMOUNT_MISMATCH"');
  });

  it('权限：FINANCE / OPS 可读，VIEWER 403 且零写入', async () => {
    await seedInvoice({
      invoiceNo: 'BILL-ROLE',
      status: 'ISSUED',
      total: '1000.0000',
      payments: [{ amount: '900.0000', status: 'SUCCEEDED' }],
    });
    for (const role of ['FINANCE', 'OPS']) {
      const report = await listPaymentReconciliation(prisma, asActor(role), { now: () => NOW });
      expect(report.items).toHaveLength(1);
    }
    const before = await counts();
    await expect(listPaymentReconciliation(prisma, asActor('VIEWER'), { now: () => NOW })).rejects.toThrow(
      ForbiddenError,
    );
    expect(await counts()).toEqual(before);
    expect(adminId).toBeTruthy();
  });
});
