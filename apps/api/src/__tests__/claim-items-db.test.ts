/**
 * C-0011 — ClaimItem 基础服务（真实 PostgreSQL 证明）。
 * 覆盖：幂等、platformRef 空值告警、CAS 状态机、caseId 不变量、关闭原因、
 * 跨租户触发器、FINANCE 字段裁剪、证据联结权限。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createClaimItem,
  getClaimItem,
  linkEvidence,
  listClaimItemEvidence,
  listClaimItems,
  transitionClaimItem,
} from '../services/claim/claim-items';
import { ForbiddenError, WorkflowError } from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'b4000000-0000-4000-8000-000000000001';
let opportunityId = '';
const ORG_B = 'b4000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-28T18:00:00Z');

let ownerId = '';
let caseId = '';
let foreignCaseId = '';
let evidenceId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  /**
   * 隔离债修复（P2E-DB5 根因，审计 MSG-20261008-14 / MSG-20261009-01 登记的测试隔离债）：
   * 本文件此前**只在 beforeEach 清理**，文件跑完会把最后一个用例的业务行留在共享开发库里
   * （实测残留 1 条 `Settlement`，见 tools/verification/si-rsi-suite-runs/p2e-db5-isolation.json）。
   * 同库的其它测试若做「全表为 0」断言就会被污染 ⇒ 这里补一次与 beforeEach **完全相同**的 TRUNCATE。
   * 只补清理，不改任何判据。
   */
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ClaimItemEvidence", "ClaimItem", "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "PlatformAccount", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ClaimItemEvidence", "ClaimItem", "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "PlatformAccount", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '归一化租户', slug: 'claim-org' },
      { id: ORG_B, name: '外部租户', slug: 'claim-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'claim-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });

  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CASE-CLAIM-1',
      title: '归一化用例案件',
      domain: 'LOGISTICS',
      status: 'OPEN',
      claimedAmount: new Prisma.Decimal('100.0000'),
      recoveredAmount: new Prisma.Decimal('0.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  const foreignCase = await prisma.case.create({
    data: {
      organizationId: ORG_B,
      caseNo: 'CASE-FOREIGN',
      title: '外部租户案件',
      domain: 'LOGISTICS',
      status: 'OPEN',
      currency: 'USD',
    },
  });
  foreignCaseId = foreignCase.id;

  // TRACK B BATCH 2 / B2-3：active new ClaimItem 必须是 account-scoped；
  // 夹具提供可信 opportunity 上下文（本租户 + 已归因账户）。
  const claimAccount = await prisma.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: 'AMAZON',
      externalAccountId: 'fixture-' + ORG,
      displayName: 'fixture account',
    },
  });
  const opportunity = await prisma.recoveryOpportunity.create({
    data: {
      organizationId: ORG,
      accountId: claimAccount.id,
      domain: 'LOGISTICS',
      channel: 'AMAZON_OTHER',
      opportunityType: 'FREIGHT_RATE_OVERCHARGE',
      title: 'fixture opportunity',
      amountExpected: new Prisma.Decimal('100.0000'),
      amountActual: new Prisma.Decimal('120.0000'),
      recoverableAmount: new Prisma.Decimal('20.0000'),
      currency: 'USD',
      status: 'QUALIFIED',
    },
  });
  opportunityId = opportunity.id;

  const evidence = await prisma.evidenceArtifact.create({
    data: { organizationId: ORG, kind: 'POD', title: 'POD 证据' },
  });
  evidenceId = evidence.id;
});

const base = () => ({ organizationId: ORG, actorUserId: ownerId, role: 'OWNER' }) as const;

async function create(
  overrides: Partial<Parameters<typeof createClaimItem>[1]> = {},
): Promise<{ id: string; created: boolean; idempotency: string }> {
  return createClaimItem(
    prisma,
    {
      ...base(),
      platformType: 'AMAZON',
      claimType: 'FBA_LOSS',
      platformRef: 'adj-1',
      opportunityId,
      occurredAt: NOW,
      normalizerVersion: 'normalizer-1.0.0',
      ...overrides,
    },
    { now: () => NOW },
  );
}

const auditActions = async () =>
  (await prisma.auditLog.findMany({ where: { organizationId: ORG }, orderBy: { createdAt: 'asc' } })).map(
    (row) => row.action,
  );

describe('C-0011 — ClaimItem（真实 PostgreSQL）', () => {
  it('platformRef 幂等：第二次创建返回既有行，表里仍只有 1 条', async () => {
    const first = await create();
    const second = await create();
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ id: first.id, created: false, idempotency: 'PLATFORM_REF' });
    expect(await prisma.claimItem.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('platformRef 为空：允许创建两条，但每条都写 claim.item_created_without_platform_ref 告警', async () => {
    const first = await create({ platformRef: null });
    const second = await create({ platformRef: null });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.idempotency).toBe('UNAVAILABLE');
    expect(second.id).not.toBe(first.id);
    expect(await prisma.claimItem.count({ where: { organizationId: ORG } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'claim.item_created_without_platform_ref' } })).toBe(2);
  });

  it('状态机 + caseId 不变量 + 关闭原因，并且审计带 from/to/claimItemId/caseId', async () => {
    const created = await create();

    await transitionClaimItem(
      prisma,
      { ...base(), claimItemId: created.id, to: 'VERIFIED' },
      { now: () => NOW },
    );
    await expect(
      transitionClaimItem(prisma, { ...base(), claimItemId: created.id, to: 'REVIEW_REQUIRED' }),
    ).rejects.toMatchObject({ code: 'CLAIM_ITEM_CASE_REQUIRED' });

    await transitionClaimItem(
      prisma,
      { ...base(), claimItemId: created.id, to: 'REVIEW_REQUIRED', caseId },
      { now: () => NOW },
    );
    const row = await prisma.claimItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ status: 'REVIEW_REQUIRED', caseId });

    await expect(
      transitionClaimItem(prisma, { ...base(), claimItemId: created.id, to: 'CLOSED' }),
    ).rejects.toThrow(WorkflowError);
    const closed = await transitionClaimItem(
      prisma,
      { ...base(), claimItemId: created.id, to: 'CLOSED', closedReason: 'NOT_WORTH_PURSUING' },
      { now: () => NOW },
    );
    expect(closed.closedReason).toBe('NOT_WORTH_PURSUING');
    const after = await prisma.claimItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.status).toBe('CLOSED');
    expect(after.closedAt).not.toBeNull();

    const transitionAudits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'claim.verified_to_review_required' },
    });
    expect(transitionAudits).toHaveLength(1);
    expect(transitionAudits[0].changes).toMatchObject({
      fromStatus: 'VERIFIED',
      toStatus: 'REVIEW_REQUIRED',
      claimItemId: created.id,
      caseId,
    });
    expect(await auditActions()).toContain('claim.review_required_to_closed');
  });

  it('并发迁移同一 ClaimItem：只有一个成功（CAS）', async () => {
    const created = await create();
    await transitionClaimItem(prisma, { ...base(), claimItemId: created.id, to: 'VERIFIED' }, { now: () => NOW });
    // 两个**相同目标**的并发迁移：串行化时后者会因「已是该状态」被拒，
    // 真并发时后者会被 CAS 拒绝 —— 两种时序下都只能有一个成功。
    const settled = await Promise.allSettled([
      transitionClaimItem(prisma, { ...base(), claimItemId: created.id, to: 'REVIEW_REQUIRED', caseId }, { now: () => NOW }),
      transitionClaimItem(prisma, { ...base(), claimItemId: created.id, to: 'REVIEW_REQUIRED', caseId }, { now: () => NOW }),
    ]);
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const row = await prisma.claimItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('REVIEW_REQUIRED');
    // 只留一条迁移审计（没有重复迁移）
    expect(
      await prisma.auditLog.count({
        where: { organizationId: ORG, action: 'claim.verified_to_review_required' },
      }),
    ).toBe(1);
  });

  it('跨租户 caseId 被数据库触发器拒绝（不落脏数据）', async () => {
    const created = await create();
    await transitionClaimItem(prisma, { ...base(), claimItemId: created.id, to: 'VERIFIED' }, { now: () => NOW });
    await expect(
      transitionClaimItem(
        prisma,
        { ...base(), claimItemId: created.id, to: 'REVIEW_REQUIRED', caseId: foreignCaseId },
        { now: () => NOW },
      ),
    ).rejects.toThrow();
    const row = await prisma.claimItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('VERIFIED');
  });

  it('证据联结：只建引用；OWNER 可读，FINANCE / VIEWER 一律 403', async () => {
    const created = await create();
    const link = await linkEvidence(
      prisma,
      { ...base(), claimItemId: created.id, evidenceId, evidenceType: 'POD' },
      { now: () => NOW },
    );
    expect(link.created).toBe(true);
    const again = await linkEvidence(
      prisma,
      { ...base(), claimItemId: created.id, evidenceId, evidenceType: 'POD' },
      { now: () => NOW },
    );
    expect(again.created).toBe(false);
    expect(await prisma.claimItemEvidence.count({ where: { organizationId: ORG } })).toBe(1);

    const ownerLinks = await listClaimItemEvidence(prisma, { organizationId: ORG, role: 'OWNER' }, created.id);
    expect(ownerLinks).toHaveLength(1);
    expect(ownerLinks[0].evidenceType).toBe('POD');

    for (const role of ['FINANCE', 'VIEWER']) {
      await expect(
        listClaimItemEvidence(prisma, { organizationId: ORG, role }, created.id),
      ).rejects.toThrow(ForbiddenError);
    }
    await expect(
      linkEvidence(prisma, { ...base(), role: 'FINANCE', claimItemId: created.id, evidenceId }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('FINANCE 只拿到 status / recoverableAmount / settlementRef；VIEWER 403；跨租户 404', async () => {
    const created = await create({ recoverableAmount: '120.0000' });
    await transitionClaimItem(prisma, { ...base(), claimItemId: created.id, to: 'VERIFIED' }, { now: () => NOW });
    await transitionClaimItem(
      prisma,
      { ...base(), claimItemId: created.id, to: 'REVIEW_REQUIRED', caseId },
      { now: () => NOW },
    );
    await prisma.settlement.create({
      data: {
        organizationId: ORG,
        caseId,
        status: 'RECEIVED',
        source: 'OTHER',
        amount: new Prisma.Decimal('120.0000'),
        currency: 'USD',
        receivedAt: NOW,
        confirmedAt: NOW,
      },
    });

    const financeRows = await listClaimItems(prisma, { organizationId: ORG, role: 'FINANCE' });
    expect(financeRows).toHaveLength(1);
    expect(Object.keys(financeRows[0]).sort()).toEqual(['id', 'recoverableAmount', 'settlementRef', 'status']);
    expect(financeRows[0]).toMatchObject({ status: 'REVIEW_REQUIRED', recoverableAmount: '120.0000' });
    expect((financeRows[0] as { settlementRef: string | null }).settlementRef).not.toBeNull();

    await expect(
      listClaimItems(prisma, { organizationId: ORG, role: 'VIEWER' }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      getClaimItem(prisma, { organizationId: ORG_B, role: 'OWNER' }, created.id),
    ).rejects.toThrow(WorkflowError);
  });
});
