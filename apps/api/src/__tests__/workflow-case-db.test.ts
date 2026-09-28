/**
 * C-0008-B2-1 — case creation against real PostgreSQL.
 * ------------------------------------------------------------------
 * Proves the approved contract of `POST /opportunities/:id/case`:
 *   · QUALIFIED opportunity + closure reuse ⇒ exactly one Case (idempotent)
 *   · opportunity becomes CONVERTED, Claim DRAFT exists, case ready
 *   · DETECTED is refused (409), cross-tenant is NOT_FOUND, OPS cannot set rates
 *   · commercial_terms.created audit carries the actor and the rate only
 *   · no synthetic money: Settlement / RecoveryLedger / Billing stay untouched
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { confirmCommercialTerms, createCaseForOpportunity } from '../services/workflow';
import { ForbiddenError } from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'dd000000-0000-4000-8000-00000000000a';
const ORG_B = 'dd000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-09-28T18:00:00Z');
const TERMS = { successFeeRate: '0.1500', source: 'manual_input' };

let adminId = '';
let opsId = '';

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
      { id: ORG, name: '建案租户', slug: 'case-org' },
      { id: ORG_B, name: '外部租户', slug: 'case-org-b' },
    ],
  });
  const admin = await prisma.user.create({
    data: { email: 'case-admin@example.com', displayName: '管理员', status: 'ACTIVE' },
  });
  const ops = await prisma.user.create({
    data: { email: 'case-ops@example.com', displayName: '运营', status: 'ACTIVE' },
  });
  adminId = admin.id;
  opsId = ops.id;
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: admin.id, role: 'ADMIN', isActive: true },
      { organizationId: ORG, userId: ops.id, role: 'OPS', isActive: true },
    ],
  });
});

async function seedOpportunity(organizationId = ORG, status: 'QUALIFIED' | 'CONVERTED' | 'DETECTED' = 'QUALIFIED') {
  return prisma.recoveryOpportunity.create({
    data: {
      organizationId,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      status,
      opportunityType: 'FREIGHT_RATE_VARIANCE',
      title: '建案用例',
      amountExpected: new Prisma.Decimal('17.7500'),
      amountActual: new Prisma.Decimal('20.4125'),
      recoverableAmount: new Prisma.Decimal('2.6625'),
      currency: 'USD',
      detectedAt: NOW,
    },
  });
}

describe('C-0008-B2-1 — Case 创建（真实 PostgreSQL）', () => {
  it('QUALIFIED 建案：Case + Claim DRAFT + 机会转 CONVERTED，且不产生任何合成资金', async () => {
    const opportunity = await seedOpportunity();
    const result = await createCaseForOpportunity(
      prisma,
      {
        organizationId: ORG,
        actorUserId: adminId,
        role: 'ADMIN',
        opportunityId: opportunity.id,
        commercialTerms: TERMS,
      },
      () => NOW,
    );

    expect(result.created).toBe(true);
    expect(result.caseNo).toBe(`CASE-${opportunity.id}`);
    expect(result.claimId).not.toBe('');

    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('CONVERTED');

    const kase = await prisma.case.findUniqueOrThrow({ where: { id: result.caseId } });
    expect(kase.caseNo).toBe(`CASE-${opportunity.id}`);
    expect(kase.claimedAmount?.toFixed(4)).toBe('2.6625');

    const claim = await prisma.claim.findUniqueOrThrow({ where: { id: result.claimId } });
    expect(claim.status).toBe('DRAFT');
    expect(claim.round).toBe(1);

    // 审计：费率只以「用户填写」的形式落库，且带 actorUserId
    const termsAudits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'commercial_terms.created' },
    });
    expect(termsAudits).toHaveLength(1);
    expect(termsAudits[0]).toMatchObject({
      actorType: 'USER',
      actorUserId: adminId,
      entityType: 'Case',
      entityId: result.caseId,
    });
    expect(termsAudits[0].changes).toEqual({
      successFeeRate: '0.1500',
      source: 'manual_input',
      opportunityId: opportunity.id,
      caseNo: `CASE-${opportunity.id}`,
      caseCreated: true,
    });

    // 用户侧不触发合成 Settlement：没有 Settlement / 账本 / 计费
    expect(await prisma.settlement.count()).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count()).toBe(0);
    expect(await prisma.billingInvoice.count()).toBe(0);
    expect(await prisma.feeCalculation.count()).toBe(0);
  });

  it('重复调用幂等：不创建第二个 Case（你的 PASS 条件）', async () => {
    const opportunity = await seedOpportunity();
    const input = {
      organizationId: ORG,
      actorUserId: adminId,
      role: 'ADMIN',
      opportunityId: opportunity.id,
      commercialTerms: TERMS,
    } as const;

    const first = await createCaseForOpportunity(prisma, input, () => NOW);
    const second = await createCaseForOpportunity(prisma, input, () => NOW);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.caseId).toBe(first.caseId);
    expect(await prisma.case.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.claim.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.caseOpportunity.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('DETECTED 未人工确认 → ILLEGAL_TRANSITION，且不建案', async () => {
    const opportunity = await seedOpportunity(ORG, 'DETECTED');
    await expect(
      createCaseForOpportunity(
        prisma,
        {
          organizationId: ORG,
          actorUserId: adminId,
          role: 'ADMIN',
          opportunityId: opportunity.id,
          commercialTerms: TERMS,
        },
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    expect(await prisma.case.count()).toBe(0);
    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('DETECTED');
  });

  it('跨租户 → NOT_FOUND，零写入', async () => {
    const foreign = await seedOpportunity(ORG_B);
    await expect(
      createCaseForOpportunity(
        prisma,
        {
          organizationId: ORG,
          actorUserId: adminId,
          role: 'ADMIN',
          opportunityId: foreign.id,
          commercialTerms: TERMS,
        },
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await prisma.case.count()).toBe(0);
    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(row.status).toBe('QUALIFIED');
  });

  it('OPS 不能填写费率 → ForbiddenError，且不建案', async () => {
    const opportunity = await seedOpportunity();
    await expect(
      createCaseForOpportunity(
        prisma,
        {
          organizationId: ORG,
          actorUserId: opsId,
          role: 'OPS',
          opportunityId: opportunity.id,
          commercialTerms: TERMS,
        },
        () => NOW,
      ),
    ).rejects.toThrow(ForbiddenError);

    expect(await prisma.case.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('OPS 建案不带费率 → pending；OWNER 事后商务确认后完成（不产生资金记录）', async () => {
    const opportunity = await seedOpportunity();
    const created = await createCaseForOpportunity(
      prisma,
      {
        organizationId: ORG,
        actorUserId: opsId,
        role: 'OPS',
        opportunityId: opportunity.id,
      },
      () => NOW,
    );

    expect(created.created).toBe(true);
    expect(created.commercialTermsPending).toBe(true);
    expect(created.commercialTerms).toBeNull();

    const caseCreated = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'case.created' },
    });
    expect(caseCreated).toHaveLength(1);
    expect(caseCreated[0]).toMatchObject({
      actorType: 'USER',
      actorUserId: opsId,
      entityType: 'Case',
      entityId: created.caseId,
    });
    expect(caseCreated[0].changes).toMatchObject({ commercialTermsPending: true });
    expect(await prisma.auditLog.count({ where: { action: 'commercial_terms.created' } })).toBe(0);

    const confirmed = await confirmCommercialTerms(
      prisma,
      {
        organizationId: ORG,
        actorUserId: adminId,
        role: 'ADMIN',
        caseId: created.caseId,
        commercialTerms: TERMS,
      },
      () => NOW,
    );
    expect(confirmed).toEqual({
      caseId: created.caseId,
      caseNo: created.caseNo,
      confirmed: true,
      alreadyConfirmed: false,
    });

    const termsAudits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'commercial_terms.created' },
    });
    expect(termsAudits).toHaveLength(1);
    expect(termsAudits[0]).toMatchObject({ actorType: 'USER', actorUserId: adminId, entityId: created.caseId });
    expect(termsAudits[0].changes).toMatchObject({ reConfirmed: false });

    // 商务确认本身不产生任何资金记录（Billing 触发模型待架构方裁定）
    expect(await prisma.feeCalculation.count()).toBe(0);
    expect(await prisma.billingInvoice.count()).toBe(0);
    expect(await prisma.settlement.count()).toBe(0);
  });
});
