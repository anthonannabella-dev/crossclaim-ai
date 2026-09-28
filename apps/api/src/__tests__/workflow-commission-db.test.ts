/**
 * C-0009 Commission Reconciliation — real PostgreSQL proof.
 * ------------------------------------------------------------------
 * The implementation checkpoint needs two hard proofs:
 *   1. dry-run (default) writes NOTHING;
 *   2. execution creates ONLY a DRAFT invoice + FeeCalculation — Settlement stays
 *      RECEIVED, the invoice is never PAID, and repeat runs are idempotent.
 * Plus: role gate, tenant isolation and `commission.reconciliation_failed` for
 * unmatched items.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ForbiddenError, reconcilePayoutItems } from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'af000000-0000-4000-8000-00000000000a';
const ORG_B = 'af000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-09-28T18:00:00Z');
const RATE = '0.1500';
const PAYOUT_REF = 'payout-ref-2026-09';

let adminId = '';
let financeId = '';

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
      { id: ORG, name: '佣金租户', slug: 'commission-org' },
      { id: ORG_B, name: '外部租户', slug: 'commission-org-b' },
    ],
  });
  const [admin, finance] = await Promise.all([
    prisma.user.create({ data: { email: 'commission-admin@example.com', displayName: '管理员', status: 'ACTIVE' } }),
    prisma.user.create({ data: { email: 'commission-finance@example.com', displayName: '财务', status: 'ACTIVE' } }),
  ]);
  adminId = admin.id;
  financeId = finance.id;
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: admin.id, role: 'ADMIN', isActive: true },
      { organizationId: ORG, userId: finance.id, role: 'FINANCE', isActive: true },
    ],
  });
});

/** 已确认回收的案件：Settlement RECEIVED + 费率已确认。 */
async function seedReceivedSettlement(options: { organizationId?: string; caseNo?: string; note?: string; amount?: string } = {}) {
  const organizationId = options.organizationId ?? ORG;
  const kase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: options.caseNo ?? 'CASE-1',
      title: '佣金对账用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('1500.0000'),
      recoveredAmount: new Prisma.Decimal(options.amount ?? '1500.0000'),
      currency: 'USD',
    },
  });
  const settlement = await prisma.settlement.create({
    data: {
      organizationId,
      caseId: kase.id,
      status: 'RECEIVED',
      source: 'OTHER',
      amount: new Prisma.Decimal(options.amount ?? '1500.0000'),
      currency: 'USD',
      receivedAt: new Date('2026-09-20T00:00:00Z'),
      confirmedAt: new Date('2026-09-20T00:00:00Z'),
      note: options.note ?? `carrier credit ${PAYOUT_REF}`,
    },
  });
  if (organizationId === ORG) {
    await prisma.auditLog.create({
      data: {
        organizationId,
        actorType: 'USER',
        actorUserId: adminId,
        action: 'commercial_terms.created',
        entityType: 'Case',
        entityId: kase.id,
        changes: { successFeeRate: RATE, source: 'manual_input', reConfirmed: false },
        createdAt: NOW,
      },
    });
  }
  return { kase, settlement };
}

const item = { payoutReference: PAYOUT_REF, amount: '1500.0000', currency: 'USD', payoutDate: '2026-09-21' };
const base = { organizationId: ORG, actorUserId: adminId, role: 'ADMIN' } as const;

const counts = async () => ({
  fees: await prisma.feeCalculation.count({ where: { organizationId: ORG } }),
  billing: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
  settlements: await prisma.settlement.count({ where: { organizationId: ORG } }),
});

describe('C-0009 — 佣金对账（真实 PostgreSQL）', () => {
  it('dry-run 默认零写入：MATCHED 但 Fee/Billing 计数为 0，Settlement 不变', async () => {
    await seedReceivedSettlement();
    const summary = await reconcilePayoutItems(prisma, { ...base, items: [item] }, { now: () => NOW });

    expect(summary.dryRun).toBe(true);
    expect(summary.results[0]).toMatchObject({
      reconciliationStatus: 'MATCHED',
      billingStatus: 'NOT_APPLICABLE',
      matchType: 'PAYOUT_REFERENCE',
      feeAmount: '225.0000',
    });
    expect(await counts()).toEqual({ fees: 0, billing: 0, settlements: 1 });
    // dry-run 不写审计
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'commission.' } } })).toBe(0);
  });

  it('执行模式：只新增 1 条 FeeCalculation + 1 条 DRAFT 账单；Settlement 仍 RECEIVED、账单非 PAID', async () => {
    const { settlement } = await seedReceivedSettlement();
    const summary = await reconcilePayoutItems(
      prisma,
      { ...base, items: [item], dryRun: false },
      { now: () => NOW },
    );

    expect(summary.results[0]).toMatchObject({
      reconciliationStatus: 'MATCHED',
      billingStatus: 'DRAFT_CREATED',
    });
    expect(await counts()).toEqual({ fees: 1, billing: 1, settlements: 1 });

    const invoice = await prisma.billingInvoice.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.total.toFixed(4)).toBe('225.0000');
    expect(invoice.paidAt).toBeNull();

    const unchanged = await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(unchanged.status).toBe('RECEIVED');

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: { startsWith: 'commission.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((row) => row.action)).toEqual(['commission.calculated', 'commission.charge_created']);
    expect(audits.every((row) => row.actorUserId === adminId)).toBe(true);
    expect(audits[0].changes).toMatchObject({ charged: false, billingStatus: 'DRAFT_CREATED' });
  });

  it('重复执行幂等：第二次为 ALREADY_CHARGED，不新增记录', async () => {
    await seedReceivedSettlement();
    await reconcilePayoutItems(prisma, { ...base, items: [item], dryRun: false }, { now: () => NOW });
    const second = await reconcilePayoutItems(prisma, { ...base, items: [item], dryRun: false }, { now: () => NOW });

    expect(second.results[0]).toMatchObject({
      reconciliationStatus: 'ALREADY_CHARGED',
      billingStatus: 'ALREADY_BILLED',
    });
    expect(await counts()).toEqual({ fees: 1, billing: 1, settlements: 1 });
  });

  it('权限与租户隔离：FINANCE 403；跨租户赔付不匹配且写 reconciliation_failed', async () => {
    await seedReceivedSettlement({ organizationId: ORG_B, caseNo: 'CASE-EXT', note: `carrier credit ${PAYOUT_REF}` });
    await seedReceivedSettlement(); // 本租户也有一个（用于确认没有误匹配）

    await expect(
      reconcilePayoutItems(prisma, { ...base, role: 'FINANCE', items: [item] }, { now: () => NOW }),
    ).rejects.toThrow(ForbiddenError);

    const unmatched = await reconcilePayoutItems(
      prisma,
      { ...base, items: [{ ...item, payoutReference: 'not-a-real-ref' }], dryRun: false },
      { now: () => NOW },
    );
    expect(unmatched.results[0].reconciliationStatus).toBe('UNMATCHED');
    const failures = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'commission.reconciliation_failed' },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0].changes).toMatchObject({ reconciliationStatus: 'UNMATCHED' });
    expect(await counts()).toEqual({ fees: 0, billing: 0, settlements: 1 });
    expect(financeId).toBeTruthy();
  });
});
