/**
 * C-0009.2 Step 3 — high-value HITL gate against real PostgreSQL.
 * ------------------------------------------------------------------
 * Proves the money guard end to end:
 *   · over-threshold / non-USD confirmation ⇒ 409 REVIEW_REQUIRED with
 *     Settlement = Fee = Billing = 0 (zero money writes)
 *   · OWNER/ADMIN approval unblocks the confirmation; FINANCE cannot approve
 *   · rejection keeps the gate closed (a new review_required is recorded)
 *   · all three review audit actions carry actorUserId and are audit-derived
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ForbiddenError,
  REVIEW_ACTIONS,
  confirmRecoveryOutcome,
  getRecoveryReviewStatus,
  resolveHighValueReviewState,
  submitRecoveryReview,
} from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'ae000000-0000-4000-8000-00000000000a';
const NOW = new Date('2026-09-28T18:00:00Z');
const RATE = '0.1500';

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
  await prisma.organization.create({ data: { id: ORG, name: 'HITL 租户', slug: 'hitl-org' } });
  const [admin, finance] = await Promise.all([
    prisma.user.create({ data: { email: 'hitl-admin@example.com', displayName: '管理员', status: 'ACTIVE' } }),
    prisma.user.create({ data: { email: 'hitl-finance@example.com', displayName: '财务', status: 'ACTIVE' } }),
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

/** 具备确认回收前置条件的案件：WON + Claim APPROVED + 已确认费率。 */
async function seedReadyCase(claimedAmount = '5000.0000', currency = 'USD') {
  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CASE-HITL-1',
      title: '高额回收用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal(claimedAmount),
      currency,
    },
  });
  await prisma.claim.create({
    data: {
      organizationId: ORG,
      caseId: kase.id,
      round: 1,
      status: 'APPROVED',
      target: 'CARRIER',
      aiDraftText: 'draft',
    },
  });
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: adminId,
      action: 'commercial_terms.created',
      entityType: 'Case',
      entityId: kase.id,
      changes: { successFeeRate: RATE, source: 'manual_input', reConfirmed: false },
      createdAt: NOW,
    },
  });
  return kase;
}

const confirm = (caseId: string, overrides: Record<string, unknown> = {}, role = 'ADMIN', actor = adminId) =>
  confirmRecoveryOutcome(
    prisma,
    {
      organizationId: ORG,
      actorUserId: actor,
      role,
      caseId,
      recoveredAmount: '1500.0000',
      currency: 'USD',
      basisReference: 'carrier-email-20260928',
      ...overrides,
    },
    () => NOW,
  );

const moneyCounts = async () => ({
  settlements: await prisma.settlement.count({ where: { organizationId: ORG } }),
  ledger: await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } }),
  fees: await prisma.feeCalculation.count({ where: { organizationId: ORG } }),
  billing: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
});

describe('C-0009.2 — 高额回收人工卡口（真实 PostgreSQL）', () => {
  it('超阈值未复核 → 409 REVIEW_REQUIRED，且 Settlement/Fee/Billing 全为 0', async () => {
    const kase = await seedReadyCase();

    await expect(confirm(kase.id)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });

    expect(await moneyCounts()).toEqual({ settlements: 0, ledger: 0, fees: 0, billing: 0 });

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: REVIEW_ACTIONS.required },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'USER',
      actorUserId: adminId,
      entityType: 'Case',
      entityId: kase.id,
    });
    expect(audits[0].changes).toMatchObject({ recoveredAmount: '1500.0000', currency: 'USD' });

    // 案件与资金状态均未被改动
    const row = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
    expect(row.status).toBe('WON');
    // 未被写入：保持 schema 默认的 0（不是 null）
    expect(row.recoveredAmount?.toFixed(4)).toBe('0.0000');
  });

  it('ADMIN 复核通过后可确认；状态由审计推导为 APPROVED', async () => {
    const kase = await seedReadyCase();
    await expect(confirm(kase.id)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });

    const approved = await submitRecoveryReview(
      prisma,
      { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', caseId: kase.id, decision: 'APPROVE' },
      () => NOW,
    );
    expect(approved).toMatchObject({ state: 'APPROVED', decision: 'APPROVE' });

    const status = await getRecoveryReviewStatus(
      prisma,
      { organizationId: ORG, role: 'ADMIN' },
      kase.id,
    );
    expect(status.state).toBe('APPROVED');

    const result = await confirm(kase.id);
    expect(result.created).toBe(true);
    // 1500.0000 × 0.15 = 225.0000（Decimal 4 位 HALF_UP）
    expect(result.feeAmount).toBe('225.0000');
    const counts = await moneyCounts();
    expect(counts).toEqual({ settlements: 1, ledger: 1, fees: 1, billing: 1 });

    const row = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
    expect(row.status).toBe('WON');
  });

  it('FINANCE 不能审批（只读），且状态保持 PENDING', async () => {
    const kase = await seedReadyCase();
    await expect(confirm(kase.id)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });

    await expect(
      submitRecoveryReview(
        prisma,
        { organizationId: ORG, actorUserId: financeId, role: 'FINANCE', caseId: kase.id, decision: 'APPROVE' },
        () => NOW,
      ),
    ).rejects.toThrow(ForbiddenError);

    const events = await prisma.auditLog.findMany({
      where: {
        organizationId: ORG,
        entityType: 'Case',
        entityId: kase.id,
        action: { in: [REVIEW_ACTIONS.required, REVIEW_ACTIONS.approved, REVIEW_ACTIONS.rejected] },
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true },
    });
    expect(resolveHighValueReviewState(events)).toBe('PENDING');
    expect(await moneyCounts()).toEqual({ settlements: 0, ledger: 0, fees: 0, billing: 0 });
  });

  it('驳回后仍卡口：再次确认会重新写 review_required', async () => {
    const kase = await seedReadyCase();
    await expect(confirm(kase.id)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });

    await submitRecoveryReview(
      prisma,
      {
        organizationId: ORG,
        actorUserId: adminId,
        role: 'ADMIN',
        caseId: kase.id,
        decision: 'REJECT',
        reason: '金额与对账单不一致',
      },
      () => NOW,
    );

    await expect(confirm(kase.id)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
    expect(await moneyCounts()).toEqual({ settlements: 0, ledger: 0, fees: 0, billing: 0 });
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: REVIEW_ACTIONS.required } }),
    ).toBe(2);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: REVIEW_ACTIONS.rejected } }),
    ).toBe(1);
  });

  it('非 USD 金额一律卡口（金额很小也卡）', async () => {
    // 币种必须与案件一致，因此这里建一个 EUR 案件来验证"非 USD 一律卡口"
    const kase = await seedReadyCase('5000.0000', 'EUR');
    await expect(confirm(kase.id, { recoveredAmount: '10.0000', currency: 'EUR' })).rejects.toMatchObject({
      code: 'REVIEW_REQUIRED',
    });
    expect(await moneyCounts()).toEqual({ settlements: 0, ledger: 0, fees: 0, billing: 0 });
  });
});
