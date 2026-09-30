// HITL 审批验证器（真实 PostgreSQL，审计派生状态）：租户/目标/状态绑定校验（授权项 ② 第一批）

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createHitlApprovalVerifier } from '../services/action-guard/hitl-approval-verifier';
import { withActionGuard } from '../services/action-guard/guard-enforcement';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000f1';
const ORG_B = 'cf000000-0000-4000-8000-0000000000f2';
const CASE = 'cf000000-0000-4000-8000-0000000000f3';
const CASE_B = 'cf000000-0000-4000-8000-0000000000f4';
const ACTOR = 'cf000000-0000-4000-8000-0000000000f5';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Membership", "User", "Case", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'HITL 租户', slug: 'hitl-org' },
      { id: ORG_B, name: 'HITL 他租户', slug: 'hitl-org-b' },
    ],
  });
  await prisma.case.createMany({
    data: [
      { id: CASE, organizationId: ORG, caseNo: 'HITL-1', title: 'HITL case', domain: 'LOGISTICS', currency: 'USD', openedAt: new Date(), updatedAt: new Date() },
      { id: CASE_B, organizationId: ORG_B, caseNo: 'HITL-2', title: 'HITL case B', domain: 'LOGISTICS', currency: 'USD', openedAt: new Date(), updatedAt: new Date() },
    ],
  });
  // 审计主体闭合要求（cc_audit_actor_membership）：USER 主体必须是该租户成员
  await prisma.user.create({
    data: {
      id: ACTOR,
      email: 'hitl-actor@example.com',
      displayName: 'HITL Actor',
      status: 'ACTIVE',
      emailVerified: true,
      failedLogins: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  await prisma.membership.createMany({
    data: [
      { id: randomUUID(), organizationId: ORG, userId: ACTOR, role: 'OWNER', isActive: true, joinedAt: new Date() },
      { id: randomUUID(), organizationId: ORG_B, userId: ACTOR, role: 'OWNER', isActive: true, joinedAt: new Date() },
    ],
  });
});

async function reviewEvent(organizationId: string, caseId: string, action: string, at: Date) {
  await prisma.auditLog.create({
    data: {
      id: randomUUID(),
      organizationId,
      actorType: 'USER',
      actorUserId: ACTOR,
      action,
      entityType: 'Case',
      entityId: caseId,
      changes: { synthetic: true } as never,
      createdAt: at,
    },
  });
}

const verifier = () => createHitlApprovalVerifier({ prisma });

describe('HITL approval verifier（真实 PostgreSQL）', () => {
  it('01 无复核记录 → APPROVAL_NOT_FOUND', async () => {
    const decision = await verifier().verify({ approvalId: 'a1', organizationId: ORG, action: 'claim.submit', actorUserId: ACTOR, targetRef: CASE });
    expect(decision).toEqual({ valid: false, reason: 'APPROVAL_NOT_FOUND' });
  });

  it('02 已请求未批准（PENDING）→ APPROVAL_NOT_APPROVED', async () => {
    await reviewEvent(ORG, CASE, 'recovery.review_required', new Date());
    const decision = await verifier().verify({ approvalId: 'a1', organizationId: ORG, action: 'claim.submit', actorUserId: ACTOR, targetRef: CASE });
    expect(decision).toEqual({ valid: false, reason: 'APPROVAL_NOT_APPROVED' });
  });

  it('03 已批准（approved 晚于 required）→ valid', async () => {
    await reviewEvent(ORG, CASE, 'recovery.review_required', new Date(Date.now() - 60_000));
    await reviewEvent(ORG, CASE, 'recovery.review_approved', new Date());
    await expect(
      verifier().verify({ approvalId: 'a1', organizationId: ORG, action: 'claim.submit', actorUserId: ACTOR, targetRef: CASE }),
    ).resolves.toEqual({ valid: true });
  });

  it('04 批准后再被拒绝 → APPROVAL_REJECTED', async () => {
    await reviewEvent(ORG, CASE, 'recovery.review_required', new Date(Date.now() - 120_000));
    await reviewEvent(ORG, CASE, 'recovery.review_approved', new Date(Date.now() - 60_000));
    await reviewEvent(ORG, CASE, 'recovery.review_rejected', new Date());
    const decision = await verifier().verify({ approvalId: 'a1', organizationId: ORG, action: 'claim.submit', actorUserId: ACTOR, targetRef: CASE });
    expect(decision).toEqual({ valid: false, reason: 'APPROVAL_REJECTED' });
  });

  it('05 缺少 targetRef → APPROVAL_TARGET_MISMATCH', async () => {
    await reviewEvent(ORG, CASE, 'recovery.review_required', new Date(Date.now() - 60_000));
    await reviewEvent(ORG, CASE, 'recovery.review_approved', new Date());
    const decision = await verifier().verify({ approvalId: 'a1', organizationId: ORG, action: 'claim.submit', actorUserId: ACTOR });
    expect(decision).toEqual({ valid: false, reason: 'APPROVAL_TARGET_MISMATCH' });
  });

  it('06 跨租户目标（B 的案件配 A 的租户）→ APPROVAL_TENANT_MISMATCH', async () => {
    await reviewEvent(ORG_B, CASE_B, 'recovery.review_required', new Date(Date.now() - 60_000));
    await reviewEvent(ORG_B, CASE_B, 'recovery.review_approved', new Date());
    const decision = await verifier().verify({ approvalId: 'a1', organizationId: ORG, action: 'claim.submit', actorUserId: ACTOR, targetRef: CASE_B });
    expect(decision).toEqual({ valid: false, reason: 'APPROVAL_TENANT_MISMATCH' });
  });

  it('07 wrapper 集成：批准→work 恰好一次；未批准→work=0（零副作用）', async () => {
    const guard = createRuntimeActionGuard({
      capabilities: {
        resolve: async () => ({
          tenantEnabled: true,
          writeEnabled: true,
          featureEnabled: { 'claim.submit': true },
          platformEnablement: { 'claim.submit': true },
          productionGate: 'SATISFIED' as const,
          hostApprovalGranted: true,
        }),
      },
      audit: { write: () => {} },
    });

    let calls = 0;
    const run = () =>
      withActionGuard({
        guard,
        input: { action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'appr-1' },
        approvals: verifier(),
        approvalTargetRef: CASE,
        work: () => {
          calls += 1;
        },
      });

    // 未批准：拒绝且零执行
    await expect(run()).rejects.toMatchObject({ code: 'ACTION_GUARD_APPROVAL_NOT_VERIFIED', reason: 'APPROVAL_NOT_FOUND' });
    expect(calls).toBe(0);

    // 批准：恰好执行一次
    await reviewEvent(ORG, CASE, 'recovery.review_required', new Date(Date.now() - 60_000));
    await reviewEvent(ORG, CASE, 'recovery.review_approved', new Date());
    await run();
    expect(calls).toBe(1);

    // 重试/再执行：重新核验（这里仍为批准态 → 再次执行一次，说明未沿用旧 ALLOW 之外还会重新查状态）
    await reviewEvent(ORG, CASE, 'recovery.review_rejected', new Date(Date.now() + 1000));
    await expect(run()).rejects.toMatchObject({ reason: 'APPROVAL_REJECTED' });
    expect(calls).toBe(1);
  });
});
