// MSG-20260929-32 验收（真实 PostgreSQL）：通知投影只读（事实快照不变）、租户隔离、
// 真实 Membership 收件人解析、Kill Switch、DISPUTED 金额裁剪。

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildNotifications } from '../services/operations/notification-projection';

const prisma = new PrismaClient();
const ORG = 'b8000000-0000-4000-8000-000000000001';
const ORG_B = 'b8000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-29T09:00:00Z');

let ownerId = '';
let viewerId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RecoveryPayout", "ClaimItemEvidence", "ClaimItem", "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '通知租户', slug: 'notify-org' },
      { id: ORG_B, name: '外部租户', slug: 'notify-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'notify-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  const viewer = await prisma.user.create({
    data: { email: 'notify-viewer@example.com', displayName: '只读', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  viewerId = viewer.id;
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true },
      { organizationId: ORG, userId: viewer.id, role: 'VIEWER', isActive: true },
    ],
  });

  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CASE-NOTIFY-1',
      title: '通知用例案件',
      domain: 'LOGISTICS',
      status: 'CLAIMED',
      currency: 'USD',
    },
  });
  await prisma.claim.create({
    data: {
      organizationId: ORG,
      caseId: kase.id,
      round: 1,
      status: 'SUBMITTED',
      target: 'PLATFORM',
      dueAt: new Date('2026-10-02T00:00:00Z'),
      deadlineSource: 'PLATFORM_NOTICE',
    },
  });

  const settlement = await prisma.settlement.create({
    data: {
      organizationId: ORG,
      caseId: kase.id,
      status: 'RECEIVED',
      source: 'OTHER',
      amount: new Prisma.Decimal('100.0000'),
      currency: 'USD',
      receivedAt: NOW,
    },
  });
  await prisma.recoveryPayout.create({
    data: {
      organizationId: ORG,
      settlementId: settlement.id,
      payoutRef: 'PY-NOTIFY-1',
      amount: new Prisma.Decimal('112.0000'),
      currency: 'USD',
      receivedAt: NOW,
      sourceType: 'PLATFORM_SETTLEMENT',
    },
  });
  // 真实运行中该状态由 recordRecoveryPayout 的投影回写（112 > 100 → DISPUTED）；
  // 此处直接落状态，避免在通知用例里重复覆盖已批准的写路径。
  await prisma.settlement.update({
    where: { id: settlement.id },
    data: { reconciliationStatus: 'DISPUTED' },
  });

  // 外部租户：同结构，验证 A 的通知不含 B 的实体
  const foreignCase = await prisma.case.create({
    data: {
      organizationId: ORG_B,
      caseNo: 'CASE-NOTIFY-FOREIGN',
      title: '外部案件',
      domain: 'LOGISTICS',
      status: 'CLAIMED',
      currency: 'USD',
    },
  });
  await prisma.claim.create({
    data: {
      organizationId: ORG_B,
      caseId: foreignCase.id,
      round: 1,
      status: 'SUBMITTED',
      target: 'PLATFORM',
      dueAt: new Date('2026-10-02T00:00:00Z'),
      deadlineSource: 'PLATFORM_NOTICE',
    },
  });
});

const deps = { prisma, now: () => NOW };

describe('MSG-32 · 通知投影（真实 PostgreSQL）', () => {
  it('01 只读：派生前后 Claim / Settlement / AuditLog 快照完全一致（无事实修改）', async () => {
    const snapshot = async () => ({
      claims: await prisma.claim.count(),
      settlements: await prisma.settlement.count(),
      payouts: await prisma.recoveryPayout.count(),
      audits: await prisma.auditLog.count(),
      claimUpdatedAt: (
        await prisma.claim.findFirstOrThrow({ where: { organizationId: ORG } })
      ).updatedAt.toISOString(),
      settlementUpdatedAt: (
        await prisma.settlement.findFirstOrThrow({ where: { organizationId: ORG } })
      ).updatedAt.toISOString(),
    });

    const before = await snapshot();
    await buildNotifications(deps, { organizationId: ORG });
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it('02 租户隔离：A 的通知实体全部属于 A', async () => {
    const batch = await buildNotifications(deps, { organizationId: ORG });
    expect(batch.notifications.length).toBeGreaterThan(0);
    const orgClaimIds = (
      await prisma.claim.findMany({ where: { organizationId: ORG }, select: { id: true } })
    ).map((row) => row.id);
    for (const notification of batch.notifications) {
      if (notification.entity.type === 'Claim') expect(orgClaimIds).toContain(notification.entity.id);
    }
    expect(JSON.stringify(batch)).not.toContain('CASE-NOTIFY-FOREIGN');
  });

  it('03 收件人来自真实 Membership：VIEWER 不在受众中', async () => {
    const batch = await buildNotifications(deps, { organizationId: ORG });
    for (const notification of batch.notifications) {
      expect(notification.audienceUserIds).not.toContain(viewerId);
      expect(notification.audienceUserIds).toContain(ownerId);
    }
  });

  it('04 DISPUTED：112 > 100 → 通知带金额方差且不自动改账', async () => {
    const batch = await buildNotifications(deps, { organizationId: ORG });
    const discrepancy = batch.notifications.find((item) => item.eventId === 'recovery.payout_discrepancy');
    expect(discrepancy?.amounts).toEqual({ confirmed: '100.0000', received: '112.0000', variance: '12.0000' });
    const settlement = await prisma.settlement.findFirstOrThrow({ where: { organizationId: ORG } });
    // 投影不写回事实：金额与对账状态保持原样
    expect(settlement.amount.toFixed(4)).toBe('100.0000');
  });

  it('05 Kill Switch 关闭时不产生任何通知', async () => {
    const batch = await buildNotifications(
      { ...deps, killSwitchEnabled: false },
      { organizationId: ORG },
    );
    expect(batch.notifications).toHaveLength(0);
    expect(batch.unroutable).toHaveLength(0);
  });
});
