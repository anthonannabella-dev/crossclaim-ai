/**
 * ② R4 — 自动状态判定与生命周期事件顺序（MSG-20260930-20 CHANGE B/C）
 * ---------------------------------------------------------------------
 * 1) 控制点：自动 review_required 路径在案件锁上等待时完成 APPROVE，恢复后
 *    **不得**按旧状态追加取代该审批的自动 REQUEST（否则刚批准的授权会被无意作废）。
 * 2) 生命周期事件时间在**案件锁内**生成：持锁期间发起请求，事件时间晚于持锁时段。
 * 3) 同一毫秒的事件按**严格递增**规则落库，轮次/取代判定在事务内外一致。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { RECOVERY_CONFIRMATION_ACTION } from '../services/action-guard/approval-verifier';
import { verifyApprovalBoundary } from '../services/action-guard/approval-tx-verify';
import {
  REVIEW_ACTIONS,
  resolveHighValueReviewState,
  submitRecoveryReview,
} from '../services/workflow/recovery-review';
import { confirmRecoveryOutcome } from '../services/workflow/recovery-outcome';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000f1';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'hitl-r4-pass-1';
const EMAIL = 'hitl-r4-owner@example.com';
const RATE = '0.1500';
/** CI 修复：审批有效期按真实时钟判定；固定 NOW 会在 NOW + TTL 之后必然失败，故以真实时钟（-60s）为基准，断言语义不变。 */
const NOW = new Date(Date.now() - 60_000);
const AMOUNT = '3000.0000';
const BASIS = 'r4-basis';
const ACTION = 'commission.charge';

let ownerId = '';
let caseId = '';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization", "KillSwitchRequest" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'HITL R4 租户', slug: 'hitl-r4-org' } });
  const owner = await prisma.user.create({
    data: { email: EMAIL, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  ownerId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });
  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'R4-1',
      title: 'R4 顺序用例',
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

async function counts() {
  return {
    settlement: await prisma.settlement.count({ where: { organizationId: ORG } }),
    ledger: await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } }),
    fee: await prisma.feeCalculation.count({ where: { organizationId: ORG } }),
    billing: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
    consumed: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.approval_consumed' } }),
  };
}

const ZERO = { settlement: 0, ledger: 0, fee: 0, billing: 0, consumed: 0 };

async function lifecycleEvents() {
  return prisma.auditLog.findMany({
    where: {
      organizationId: ORG,
      entityType: 'Case',
      entityId: caseId,
      action: { in: [REVIEW_ACTIONS.required, REVIEW_ACTIONS.approved, REVIEW_ACTIONS.rejected] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, action: true, createdAt: true, actorUserId: true, changes: true },
  });
}

const boundPayload = { recoveredAmount: AMOUNT, currency: 'USD', basisReference: BASIS, evidenceArtifactId: null };

/**
 * 控制点辅助：直接落库等价的生命周期事件（REQUEST + APPROVE）。
 * 用途见用例 01 —— 测试正持有案件锁，经 HTTP 提交审批会排在资金/自动路径之后，
 * 因此等待期间的状态变更必须走直写（与 R3 证据说明同一口径）。
 */
async function insertLifecycleApproval(): Promise<string> {
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: REVIEW_ACTIONS.required,
      entityType: 'Case',
      entityId: caseId,
      changes: { caseNo: 'R4-1', threshold: '1000.0000', recoveredAmount: AMOUNT, currency: 'USD' } as never,
      createdAt: new Date(NOW.getTime() + 1000),
    },
  });
  const approved = await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: REVIEW_ACTIONS.approved,
      entityType: 'Case',
      entityId: caseId,
      changes: {
        caseNo: 'R4-1',
        threshold: '1000.0000',
        boundAction: ACTION,
        boundPayload: { ...boundPayload, amount: AMOUNT, fingerprintVersion: 'v1' },
        expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
      } as never,
      createdAt: new Date(NOW.getTime() + 2000),
    },
  });
  return approved.id;
}

async function holdCaseLock(): Promise<{ release: () => void; pending: Promise<unknown> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-recovery-case:${caseId}`);
      await gate;
    },
    { timeout: 30_000 },
  );
  await waitCaseLockHeld();
  return { release, pending };
}

async function waitCaseLockHeld(): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const rows = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok',
      `cc-recovery-case:${caseId}`,
    );
    if (rows[0]?.ok === false) return;
    await sleep(25);
  }
  throw new Error('CASE_LOCK_NOT_HELD');
}

describe('② R4 — 自动状态判定与生命周期事件顺序（真实 PostgreSQL）', () => {
  it('01 自动路径等锁期间完成 APPROVE：恢复后不得追加取代该审批的自动 REQUEST', async () => {
    const lock = await holdCaseLock();

    // 自动 review_required 路径（高额、无 approvalId，直接调用服务层以触达该路径）：
    // 现在状态判定在案件锁内，故请求会先等待锁
    const pending = confirmRecoveryOutcome(
      prisma,
      {
        organizationId: ORG,
        actorUserId: ownerId,
        role: 'OWNER',
        caseId,
        recoveredAmount: AMOUNT,
        currency: 'USD',
        basisReference: BASIS,
      },
      () => new Date(),
    );
    expect(await Promise.race([pending.then(() => 'done', () => 'error'), sleep(400).then(() => 'blocked')])).toBe('blocked');

    // 等待期间完成 REQUEST+APPROVE（直写等价事件；测试持有案件锁，故不能走 HTTP）
    const approvalId = await insertLifecycleApproval();

    lock.release();
    await lock.pending;

    await expect(pending).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });

    // 核心不变量：审批之后没有新的 review_required（自动路径不得按旧状态取代刚批准的授权）
    const events = await lifecycleEvents();
    expect(events[events.length - 1].action).toBe(REVIEW_ACTIONS.approved);
    expect(resolveHighValueReviewState(events)).toBe('APPROVED');
    expect(events.filter((e) => e.action === REVIEW_ACTIONS.required)).toHaveLength(1);
    expect(await counts()).toEqual(ZERO);

    // 该审批仍可用作操作级授权：approvalId + 绑定载荷可通过事务内校验
    const boundary = await verifyApprovalBoundary(prisma, {
      organizationId: ORG,
      approvalId,
      action: RECOVERY_CONFIRMATION_ACTION,
      caseId,
      actorUserId: ownerId,
      payload: { amount: AMOUNT, currency: 'USD', basisReference: BASIS, evidenceArtifactId: null },
      now: new Date(NOW.getTime() + 3000),
    });
    expect(boundary).toMatchObject({ ok: true });
  }, 30_000);

  it('02 生命周期事件时间在案件锁内生成：持锁期间发起的请求，事件时间晚于持锁时段', async () => {
    const lock = await holdCaseLock();
    const startedAt = Date.now();
    const pending = submitRecoveryReview(
      prisma,
      {
        organizationId: ORG,
        actorUserId: ownerId,
        role: 'OWNER',
        caseId,
        decision: 'REQUEST',
        recoveredAmount: AMOUNT,
        currency: 'USD',
      },
      () => new Date(),
    );
    expect(await Promise.race([pending.then(() => 'done'), sleep(400).then(() => 'blocked')])).toBe('blocked');
    await sleep(1200);
    lock.release();
    await lock.pending;
    await pending;

    const events = await lifecycleEvents();
    expect(events).toHaveLength(1);
    // 事件时间不早于「持锁 + 等待」结束前 1 秒，证明时间不是在等锁前取的
    expect(events[0].createdAt.getTime()).toBeGreaterThanOrEqual(startedAt + 1000);
  }, 30_000);

  it('03 同一毫秒的生命周期事件严格递增：轮次取代在事务内外判定一致', async () => {
    const fixed = () => NOW;
    await submitRecoveryReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', caseId, decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' },
      fixed,
    );
    const approved = await submitRecoveryReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', caseId, decision: 'APPROVE', boundPayload, boundAction: ACTION },
      fixed,
    );
    await submitRecoveryReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', caseId, decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' },
      fixed,
    );

    const events = await lifecycleEvents();
    const times = events.map((e) => e.createdAt.getTime());
    expect(events.map((e) => e.action)).toEqual([
      REVIEW_ACTIONS.required,
      REVIEW_ACTIONS.approved,
      REVIEW_ACTIONS.required,
    ]);
    // 固定时钟下仍严格递增（同毫秒顺延 1ms）
    expect(times[0]).toBe(NOW.getTime());
    expect(times[1]).toBe(NOW.getTime() + 1);
    expect(times[2]).toBe(NOW.getTime() + 2);
    expect(resolveHighValueReviewState(events)).toBe('PENDING');

    // 旧审批在新轮次生效后被拒绝（事务内验证器与事务外同一规则）
    const boundary = await verifyApprovalBoundary(prisma, {
      organizationId: ORG,
      approvalId: String(approved.approvalId),
      action: RECOVERY_CONFIRMATION_ACTION,
      caseId,
      actorUserId: ownerId,
      payload: { amount: AMOUNT, currency: 'USD', basisReference: BASIS, evidenceArtifactId: null },
      now: new Date(NOW.getTime() + 3000),
    });
    expect(boundary).toMatchObject({ ok: false, reason: 'APPROVAL_NOT_APPROVED' });
  }, 30_000);
});
