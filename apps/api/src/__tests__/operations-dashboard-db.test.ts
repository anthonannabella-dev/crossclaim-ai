// MSG-20260929-30 验收（真实 PostgreSQL）：租户隔离、金额裁剪、游标分页、
// 「看板不是写入口」、窗口约束、索引可用性（EXPLAIN 证据）。

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildOperationsDashboard,
  listClaimBucketDetail,
  listRecoveryDetail,
  MAX_PAGE_SIZE,
} from '../services/operations/dashboard-projection';
import { WorkflowError } from '../services/workflow/opportunity-review';

const prisma = new PrismaClient();
const ORG = 'b7000000-0000-4000-8000-000000000001';
const ORG_B = 'b7000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-29T09:00:00Z');

let ownerId = '';
let claimId = '';
let settlementId = '';

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
      { id: ORG, name: '看板租户', slug: 'dash-org' },
      { id: ORG_B, name: '外部租户', slug: 'dash-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'dash-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });

  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CASE-DASH-1',
      title: '看板用例案件',
      domain: 'LOGISTICS',
      status: 'CLAIMED',
      currency: 'USD',
    },
  });
  // DRAFT 桶要求已完成商务确认（commercial_terms.created 审计）
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'commercial_terms.created',
      entityType: 'Case',
      entityId: kase.id,
      changes: { successFeeRate: '0.25', source: 'synthetic' },
    },
  });
  const claim = await prisma.claim.create({
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
  claimId = claim.id;

  // 外部租户：同结构数据，用于证明 A 看不到 B
  const foreignCase = await prisma.case.create({
    data: {
      organizationId: ORG_B,
      caseNo: 'CASE-DASH-FOREIGN',
      title: '外部案件',
      domain: 'LOGISTICS',
      status: 'CLAIMED',
      currency: 'USD',
    },
  });
  await prisma.claim.create({
    data: { organizationId: ORG_B, caseId: foreignCase.id, round: 1, status: 'SUBMITTED', target: 'PLATFORM' },
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
  settlementId = settlement.id;
  await prisma.recoveryPayout.create({
    data: {
      organizationId: ORG,
      settlementId: settlement.id,
      payoutRef: 'PY-DASH-1',
      amount: new Prisma.Decimal('40.0000'),
      currency: 'USD',
      receivedAt: NOW,
      sourceType: 'PLATFORM_SETTLEMENT',
    },
  });
  const foreignSettlement = await prisma.settlement.create({
    data: {
      organizationId: ORG_B,
      caseId: foreignCase.id,
      status: 'RECEIVED',
      source: 'OTHER',
      amount: new Prisma.Decimal('9999.0000'),
      currency: 'USD',
      receivedAt: NOW,
    },
  });
  await prisma.recoveryPayout.create({
    data: {
      organizationId: ORG_B,
      settlementId: foreignSettlement.id,
      payoutRef: 'PY-DASH-FOREIGN',
      amount: new Prisma.Decimal('9999.0000'),
      currency: 'USD',
      receivedAt: NOW,
      sourceType: 'PLATFORM_SETTLEMENT',
    },
  });
});

const deps = { prisma, now: () => NOW };

describe('MSG-30 · 运营看板（真实 PostgreSQL）', () => {
  it('01 租户隔离：A 的汇总与明细都不含 B 的任何行与金额', async () => {
    const payload = await buildOperationsDashboard(deps, { organizationId: ORG, role: 'OWNER' });
    expect(payload.recovery?.amounts?.confirmedTotal).toBe('100.0000');
    expect(payload.recovery?.amounts?.receivedTotal).toBe('40.0000');
    expect(JSON.stringify(payload)).not.toContain('9999');

    const detail = await listRecoveryDetail(deps, { organizationId: ORG, role: 'OWNER' });
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]?.settlementId).toBe(settlementId);
  });

  it('02 金额裁剪：FINANCE 有回收金额、无 Claim 管线；OPS 反之；VIEWER 403', async () => {
    const finance = await buildOperationsDashboard(deps, { organizationId: ORG, role: 'FINANCE' });
    expect(finance.recovery?.amounts?.confirmedTotal).toBe('100.0000');
    expect(finance.claimPipeline).toBeNull();
    expect(finance.denied).toContain('claimPipeline');

    const ops = await buildOperationsDashboard(deps, { organizationId: ORG, role: 'OPS' });
    expect(ops.claimPipeline).not.toBeNull();
    expect(ops.recovery).toBeNull();
    expect(JSON.stringify(ops)).not.toContain('confirmedTotal');

    await expect(
      buildOperationsDashboard(deps, { organizationId: ORG, role: 'VIEWER' }),
    ).rejects.toThrowError(/无权/);
  });

  it('03 明细金额裁剪：无 recoveryPayoutRecord 的角色拿不到 amounts 键', async () => {
    await expect(
      listRecoveryDetail(deps, { organizationId: ORG, role: 'OPS' }),
    ).rejects.toThrowError(/无权/);

    const owner = await listRecoveryDetail(deps, { organizationId: ORG, role: 'OWNER' });
    expect(owner.items[0]?.amounts).toEqual({
      confirmed: '100.0000',
      received: '40.0000',
      outstanding: '60.0000',
    });
  });

  it('04 桶谓词（真实数据）：SUBMITTED + dueAt 在视野内 → 待回执 + 到期临近', async () => {
    const payload = await buildOperationsDashboard(deps, { organizationId: ORG, role: 'OWNER' });
    const buckets = payload.claimPipeline?.buckets ?? [];
    expect(buckets.find((row) => row.bucket === 'awaiting_response')?.count).toBe(1);
    expect(buckets.find((row) => row.bucket === 'deadline_approaching')?.count).toBe(1);
    expect(buckets.find((row) => row.bucket === 'overdue')?.count).toBe(0);
  });

  it('05 游标分页：单页上限 100、nextCursor 不重不漏', async () => {
    const kase = await prisma.case.findFirstOrThrow({ where: { organizationId: ORG } });
    for (let index = 0; index < 3; index += 1) {
      await prisma.claim.create({
        data: {
          organizationId: ORG,
          caseId: kase.id,
          round: index + 2,
          status: 'SUBMITTED',
          target: 'PLATFORM',
        },
      });
    }

    const first = await listClaimBucketDetail(deps, { organizationId: ORG, role: 'OWNER', bucket: 'awaiting_response', limit: 2 });
    expect(first.items.length).toBeLessThanOrEqual(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listClaimBucketDetail(deps, {
      organizationId: ORG,
      role: 'OWNER',
      bucket: 'awaiting_response',
      limit: 2,
      cursor: first.nextCursor,
    });
    const ids = [...first.items, ...second.items].map((row) => row.claimId);
    expect(new Set(ids).size).toBe(ids.length);

    const capped = await listClaimBucketDetail(deps, { organizationId: ORG, role: 'OWNER', bucket: 'awaiting_response', limit: 500 });
    expect(capped.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  it('06 非法 bucket / cursor / limit 都被拒绝', async () => {
    await expect(
      listClaimBucketDetail(deps, { organizationId: ORG, role: 'OWNER', bucket: 'nope' }),
    ).rejects.toThrowError(/bucket/);
    await expect(
      listClaimBucketDetail(deps, { organizationId: ORG, role: 'OWNER', bucket: 'draft', cursor: '!!!not-base64!!!' }),
    ).rejects.toThrowError();
    await expect(
      listClaimBucketDetail(deps, { organizationId: ORG, role: 'OWNER', bucket: 'draft', limit: 0 }),
    ).rejects.toThrowError(/limit/);
  });

  it('07 窗口约束：31d / 3650 抛 INVALID_WINDOW', async () => {
    for (const bad of ['31d', '3650']) {
      try {
        await buildOperationsDashboard(deps, { organizationId: ORG, role: 'OWNER', window: bad });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as WorkflowError).code).toBe('INVALID_WINDOW');
      }
    }
  });

  it('08 看板不是写入口：读取前后所有相关表的行数与 Claim.updatedAt 不变', async () => {
    const snapshot = async () => ({
      claims: await prisma.claim.count(),
      settlements: await prisma.settlement.count(),
      payouts: await prisma.recoveryPayout.count(),
      audits: await prisma.auditLog.count(),
      claimUpdatedAt: (await prisma.claim.findUniqueOrThrow({ where: { id: claimId } })).updatedAt.toISOString(),
    });

    const before = await snapshot();
    await buildOperationsDashboard(deps, { organizationId: ORG, role: 'OWNER' });
    await listClaimBucketDetail(deps, { organizationId: ORG, role: 'OWNER', bucket: 'awaiting_response' });
    await listRecoveryDetail(deps, { organizationId: ORG, role: 'OWNER' });
    const after = await snapshot();

    expect(after).toEqual(before);
  });

  it('09 EXPLAIN 证据：Claim(organizationId,status,dueAt) 索引可用', async () => {
    // 同一条连接内执行：先关闭 seq scan（证明索引可用），再取计划
    const text = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const plan = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `EXPLAIN SELECT "id", "status", "dueAt" FROM "Claim"
          WHERE "organizationId" = $1 AND "status" = $2::"ClaimStatus" AND "dueAt" >= $3
          ORDER BY "dueAt" ASC`,
        ORG,
        'SUBMITTED',
        NOW,
      );
      return plan.map((row) => String(row['QUERY PLAN'] ?? '')).join('\n');
    });
    expect(text).toContain('Claim_organizationId_status_dueAt_idx');
  });
});
