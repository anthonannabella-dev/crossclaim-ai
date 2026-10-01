// CHANGE C：并发首次提交 + 四类资金对象「恰为 1」+ 幂等重试 + 授权变化（真实 PostgreSQL）

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RECOVERY_CONFIRMATION_ACTION } from '../services/action-guard/approval-verifier';
import { confirmRecoveryOutcome } from '../services/workflow/recovery-outcome';
import { submitRecoveryReview } from '../services/workflow/recovery-review';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000c1';
const RATE = '0.1500';
/** CI 修复：审批有效期按真实时钟判定；固定 NOW 会在 NOW + TTL 之后必然失败，故以真实时钟（-60s）为基准，断言语义不变。 */
const NOW = new Date(Date.now() - 60_000);
const AMOUNT = '3000.0000';
const BASIS = 'concurrency-basis';

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
    'TRUNCATE TABLE "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'Concurrency 租户', slug: 'concurrency-org' } });
  const owner = await prisma.user.create({ data: { email: 'concurrency-owner@example.com', displayName: 'OWNER', status: 'ACTIVE', emailVerified: true } });
  ownerId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });

  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CONC-1',
      title: '并发用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  await prisma.claim.create({ data: { organizationId: ORG, caseId, round: 1, status: 'APPROVED', target: 'CARRIER', aiDraftText: 'draft' } });
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'commercial_terms.created',
      entityType: 'Case',
      entityId: caseId,
      changes: { successFeeRate: RATE, source: 'manual_input', reConfirmed: false } as never,
      createdAt: NOW,
    },
  });
});

async function approve() {
  await submitRecoveryReview(
    prisma,
    { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', caseId, decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' },
    () => NOW,
  );
  const result = await submitRecoveryReview(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId,
      decision: 'APPROVE',
      boundPayload: { recoveredAmount: AMOUNT, currency: 'USD', basisReference: BASIS, evidenceArtifactId: null },
      boundAction: RECOVERY_CONFIRMATION_ACTION,
    },
    () => new Date(NOW.getTime() + 1000),
  );
  return result.approvalId as string;
}

function confirm(approvalId: string) {
  return confirmRecoveryOutcome(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId,
      recoveredAmount: AMOUNT,
      currency: 'USD',
      basisReference: BASIS,
      approvalId,
    },
    () => new Date(NOW.getTime() + 2000),
  );
}

async function counts() {
  return {
    settlement: await prisma.settlement.count({ where: { organizationId: ORG } }),
    ledger: await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } }),
    fee: await prisma.feeCalculation.count({ where: { organizationId: ORG } }),
    billing: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
    consumed: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.approval_consumed' } }),
  };
}

describe('HITL 原子消费与恰一次（真实 PostgreSQL）', () => {
  it('01 首次确认：四类资金对象各恰好 1，消费事件恰好 1', async () => {
    const approvalId = await approve();
    const first = await confirm(approvalId);
    expect(first.created).toBe(true);
    expect(await counts()).toEqual({ settlement: 1, ledger: 1, fee: 1, billing: 1, consumed: 1 });
  });

  it('02 合法重复请求：返回既有结果，不新增资金对象（created=false）', async () => {
    const approvalId = await approve();
    const first = await confirm(approvalId);
    const second = await confirm(approvalId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.settlementId).toBe(first.settlementId);
    expect(await counts()).toEqual({ settlement: 1, ledger: 1, fee: 1, billing: 1, consumed: 1 });
  });

  it('03 并发首次提交（同一审批）：只允许一次成功，其余幂等；四类资金对象恰为 1', async () => {
    const approvalId = await approve();
    const results = await Promise.allSettled([confirm(approvalId), confirm(approvalId), confirm(approvalId), confirm(approvalId)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof confirm>>>[];
    expect(fulfilled.length).toBe(4);
    const createdCount = fulfilled.filter((r) => r.value.created).length;
    expect(createdCount).toBe(1);
    const ids = new Set(fulfilled.map((r) => r.value.settlementId));
    expect(ids.size).toBe(1);
    expect(await counts()).toEqual({ settlement: 1, ledger: 1, fee: 1, billing: 1, consumed: 1 });
  });

  it('04 成功后撤销授权：再次提交被最终拒绝（R3：锁内重验优先于幂等返回），零新增资金', async () => {
    const approvalId = await approve();
    await confirm(approvalId);
    // 撤销事件（晚于审批）
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: ownerId,
        action: 'recovery.approval_revoked',
        entityType: 'Case',
        entityId: caseId,
        changes: { approvalId } as never,
        createdAt: new Date(NOW.getTime() + 5000),
      },
    });
    // R3 CHANGE B：既有资金链的返回到达之前必须先通过锁内完整重验 —— 撤销后不得再返回成功
    await expect(confirm(approvalId)).rejects.toMatchObject({ reason: 'APPROVAL_REVOKED' });
    expect(await counts()).toEqual({ settlement: 1, ledger: 1, fee: 1, billing: 1, consumed: 1 });
  });
});
