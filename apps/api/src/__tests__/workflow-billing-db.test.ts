/**
 * C-0008-B2-3b — billing state machine against real PostgreSQL.
 * ------------------------------------------------------------------
 * Proves: DRAFT → ISSUED → PAID with CAS, PAID requiring a payment reference,
 * audit attribution, tenant isolation, OPS read-only, VIEWER no access, and the
 * boundary that Billing (what we charge) is not Settlement (what a third party paid).
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { advanceBillingInvoice, listBillingInvoices } from '../services/workflow';
import { ForbiddenError } from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'ab000000-0000-4000-8000-00000000000a';
const ORG_B = 'ab000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-09-28T18:00:00Z');

let financeId = '';
let opsId = '';
let viewerId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'Billing 租户', slug: 'billing-org' },
      { id: ORG_B, name: '外部租户', slug: 'billing-org-b' },
    ],
  });
  const [finance, ops, viewer] = await Promise.all([
    prisma.user.create({ data: { email: 'billing-finance@example.com', displayName: '财务', status: 'ACTIVE' } }),
    prisma.user.create({ data: { email: 'billing-ops@example.com', displayName: '运营', status: 'ACTIVE' } }),
    prisma.user.create({ data: { email: 'billing-viewer@example.com', displayName: '只读', status: 'ACTIVE' } }),
  ]);
  financeId = finance.id;
  opsId = ops.id;
  viewerId = viewer.id;
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: finance.id, role: 'FINANCE', isActive: true },
      { organizationId: ORG, userId: ops.id, role: 'OPS', isActive: true },
      { organizationId: ORG, userId: viewer.id, role: 'VIEWER', isActive: true },
    ],
  });
});

async function seedInvoice(options: { status?: string; organizationId?: string; invoiceNo?: string } = {}) {
  const organizationId = options.organizationId ?? ORG;
  const kase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: `CASE-${options.invoiceNo ?? 'BILL-1'}`,
      title: 'Billing 用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('2.6625'),
      currency: 'USD',
    },
  });
  const invoice = await prisma.billingInvoice.create({
    data: {
      organizationId,
      caseId: kase.id,
      invoiceNo: options.invoiceNo ?? 'BILL-1',
      status: (options.status ?? 'DRAFT') as Prisma.BillingInvoiceCreateInput['status'],
      subtotal: new Prisma.Decimal('0.3994'),
      taxAmount: new Prisma.Decimal('0'),
      total: new Prisma.Decimal('0.3994'),
      currency: 'USD',
    },
  });
  return { kase, invoice };
}

const advance = (invoiceId: string, to: string, extra: Record<string, unknown> = {}, role = 'FINANCE', actor = financeId, organizationId = ORG) =>
  advanceBillingInvoice(
    prisma,
    { organizationId, actorUserId: actor, role, invoiceId, to, ...extra },
    () => NOW,
  );

describe('C-0008-B2-3b — Billing 状态机（真实 PostgreSQL）', () => {
  it('DRAFT → ISSUED → PAID：时间戳、金额与审计正确', async () => {
    const { invoice } = await seedInvoice();

    const issued = await advance(invoice.id, 'ISSUED');
    expect(issued).toEqual({ invoiceId: invoice.id, from: 'DRAFT', to: 'ISSUED', paymentReferenceProvided: false });
    const afterIssue = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(afterIssue.status).toBe('ISSUED');
    expect(afterIssue.issuedAt?.getTime()).toBe(NOW.getTime());
    expect(afterIssue.paidAt).toBeNull();

    const paid = await advance(invoice.id, 'PAID', { paymentReference: 'bank-ref-2026-09' });
    expect(paid.paymentReferenceProvided).toBe(true);
    const afterPay = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(afterPay.status).toBe('PAID');
    expect(afterPay.paidAt?.getTime()).toBe(NOW.getTime());
    expect(afterPay.paidAmount.toFixed(4)).toBe('0.3994');
    expect(afterPay.externalRef).toBe('bank-ref-2026-09');

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'billing.status_changed' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[0].changes).toMatchObject({ from: 'DRAFT', to: 'ISSUED', paymentReferenceProvided: false });
    expect(audits[1].changes).toMatchObject({ from: 'ISSUED', to: 'PAID', paymentReferenceProvided: true });
    expect(audits.every((row) => row.actorUserId === financeId)).toBe(true);
    // 审计不含支付引用原文
    expect(JSON.stringify(audits)).not.toContain('bank-ref-2026-09');
    // Billing 与 Settlement 是两个对象：本用例没有 Settlement
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('DRAFT → PAID 被拒（含 note 也不行），状态与审计不变', async () => {
    const { invoice } = await seedInvoice();
    await expect(advance(invoice.id, 'PAID', { note: 'bank transfer' })).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row.status).toBe('DRAFT');
    expect(await prisma.auditLog.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('PAID 缺 paymentReference 与 note → PAYMENT_REFERENCE_REQUIRED', async () => {
    const { invoice } = await seedInvoice({ status: 'ISSUED' });
    await expect(advance(invoice.id, 'PAID')).rejects.toMatchObject({
      code: 'PAYMENT_REFERENCE_REQUIRED',
    });
    expect(await prisma.auditLog.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('并发推进同一张发票：CAS 只放行一个', async () => {
    const { invoice } = await seedInvoice();
    const [a, b] = await Promise.allSettled([
      advance(invoice.id, 'ISSUED'),
      advance(invoice.id, 'ISSUED'),
    ]);
    const winners = [a, b].filter((r) => r.status === 'fulfilled');
    const losers = [a, b].filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row.status).toBe('ISSUED');
    const audits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'billing.status_changed' },
    });
    expect(audits).toHaveLength(1);
  });

  it('OPS 可读不可推进；VIEWER 不可见；跨租户 404', async () => {
    const { invoice } = await seedInvoice();
    await expect(advance(invoice.id, 'ISSUED', {}, 'OPS', opsId)).rejects.toThrow(ForbiddenError);

    const opsList = await listBillingInvoices(prisma, { organizationId: ORG, role: 'OPS' });
    expect(opsList).toHaveLength(1);
    expect(opsList[0]).toMatchObject({ invoiceNo: 'BILL-1', status: 'DRAFT', currency: 'USD' });
    expect(opsList[0].total).toBe('0.3994');

    await expect(listBillingInvoices(prisma, { organizationId: ORG, role: 'VIEWER' })).rejects.toThrow(
      ForbiddenError,
    );

    const foreign = await seedInvoice({ organizationId: ORG_B, invoiceNo: 'BILL-EXT' });
    await expect(advance(foreign.invoice.id, 'ISSUED')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const financeList = await listBillingInvoices(prisma, { organizationId: ORG, role: 'FINANCE' });
    expect(financeList.map((row) => row.invoiceNo)).toEqual(['BILL-1']);
    expect(viewerId).toBeTruthy();
  });
});
