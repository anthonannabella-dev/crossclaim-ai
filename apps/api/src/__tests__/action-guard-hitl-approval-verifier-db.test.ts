// v3 审批验证器（操作级）：真实 PostgreSQL + 真实审批写入路径（授权项 ② R1 · CHANGE A/B）

import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createHitlApprovalVerifier } from '../services/action-guard/hitl-approval-verifier';
import { RECOVERY_CONFIRMATION_ACTION } from '../services/action-guard/approval-verifier';
import { submitRecoveryReview } from '../services/workflow/recovery-review';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000b1';
const ORG_B = 'cf000000-0000-4000-8000-0000000000b2';
const RATE = '0.1500';
/**
 * CI 修复：审批有效期按**真实时钟**判定，固定 NOW 会让用例在「NOW + TTL」之后必然失败。
 * 改为以真实时钟为基准（-60s），所有相对偏移与断言语义保持不变。
 */
const NOW = new Date(Date.now() - 60_000);

let ownerId = '';
let outsiderId = '';
let caseId = '';
let caseBId = '';

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
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'Approval 租户', slug: 'approval-org' },
      { id: ORG_B, name: 'Approval 他租户', slug: 'approval-org-b' },
    ],
  });
  const [owner, outsider] = await Promise.all([
    prisma.user.create({ data: { email: 'approval-owner@example.com', displayName: 'OWNER', status: 'ACTIVE', emailVerified: true } }),
    prisma.user.create({ data: { email: 'approval-outsider@example.com', displayName: 'OUTSIDER', status: 'ACTIVE', emailVerified: true } }),
  ]);
  ownerId = owner.id;
  outsiderId = outsider.id;
  // 审批人与执行人必须是 ACTIVE 成员（两个租户各建一条，夹具用同一 OWNER）
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true },
      { organizationId: ORG_B, userId: owner.id, role: 'OWNER', isActive: true },
    ],
  });

  const mk = async (org: string, no: string) => {
    const kase = await prisma.case.create({
      data: { organizationId: org, caseNo: no, title: 'approval case', domain: 'LOGISTICS', status: 'WON', claimedAmount: new Prisma.Decimal('5000.0000'), currency: 'USD' },
    });
    await prisma.claim.create({ data: { organizationId: org, caseId: kase.id, round: 1, status: 'APPROVED', target: 'CARRIER', aiDraftText: 'draft' } });
    await prisma.auditLog.create({
      data: {
        organizationId: org,
        actorType: 'USER',
        actorUserId: owner.id,
        action: 'commercial_terms.created',
        entityType: 'Case',
        entityId: kase.id,
        changes: { successFeeRate: RATE, source: 'manual_input', reConfirmed: false } as never,
        createdAt: NOW,
      },
    });
    return kase.id;
  };
  caseId = await mk(ORG, 'APPROVAL-1');
  caseBId = await mk(ORG_B, 'APPROVAL-2');
});

const PAYLOAD = { recoveredAmount: '3000.0000', currency: 'USD', basisReference: 'basis-1', evidenceArtifactId: null };

/** 走真实审批写入路径：REQUEST → APPROVE(boundPayload) → 返回 approvalId */
async function approveCase(targetCase = caseId, payload = PAYLOAD, ttlMs?: number, organizationId = ORG) {
  await submitRecoveryReview(
    prisma,
    { organizationId, actorUserId: ownerId, role: 'OWNER', caseId: targetCase, decision: 'REQUEST', recoveredAmount: payload.recoveredAmount, currency: payload.currency },
    () => NOW,
  );
  // 审批必须晚于它对应的 REQUEST（轮次不变量），因此用 +1s 的独立时刻
  const approvedAt = new Date(NOW.getTime() + 1000);
  const result = await submitRecoveryReview(
    prisma,
    {
      organizationId,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId: targetCase,
      decision: 'APPROVE',
      boundPayload: payload,
      boundAction: RECOVERY_CONFIRMATION_ACTION,
      approvalTtlMs: ttlMs,
    },
    () => approvedAt,
  );
  return result.approvalId as string;
}

const verifier = (now?: Date) => createHitlApprovalVerifier({ prisma, now: now ? () => now : undefined });

function query(over: Partial<Parameters<ReturnType<typeof verifier>['verify']>[0]> = {}) {
  return {
    approvalId: 'unknown',
    organizationId: ORG,
    action: RECOVERY_CONFIRMATION_ACTION,
    actorUserId: ownerId,
    targetRef: caseId,
    payload: PAYLOAD,
    ...over,
  } as Parameters<ReturnType<typeof verifier>['verify']>[0];
}

describe('HITL approval verifier v3（操作级绑定，真实 PostgreSQL）', () => {
  it('01 随机 approvalId → APPROVAL_NOT_FOUND', async () => {
    await expect(verifier().verify(query({ approvalId: randomUUID() }))).resolves.toEqual({ valid: false, reason: 'APPROVAL_NOT_FOUND' });
  });

  it('02 只有 REQUEST、无 APPROVE → APPROVAL_NOT_FOUND', async () => {
    await submitRecoveryReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', caseId, decision: 'REQUEST', recoveredAmount: PAYLOAD.recoveredAmount, currency: PAYLOAD.currency },
      () => NOW,
    );
    await expect(verifier().verify(query({ approvalId: randomUUID() }))).resolves.toMatchObject({ reason: 'APPROVAL_NOT_FOUND' });
  });

  it('03 真实审批 + 载荷一致 + 执行人是成员 → valid', async () => {
    const approvalId = await approveCase();
    await expect(verifier().verify(query({ approvalId }))).resolves.toEqual({ valid: true });
  });

  it('04 载荷变化（金额/币种/依据/证据）→ APPROVAL_PAYLOAD_MISMATCH', async () => {
    const approvalId = await approveCase();
    for (const payload of [
      { ...PAYLOAD, recoveredAmount: '3000.0001' },
      { ...PAYLOAD, currency: 'EUR' },
      { ...PAYLOAD, basisReference: 'basis-2' },
      { ...PAYLOAD, evidenceArtifactId: 'ev-1' },
    ]) {
      await expect(verifier().verify(query({ approvalId, payload }))).resolves.toMatchObject({ reason: 'APPROVAL_PAYLOAD_MISMATCH' });
    }
  });

  it('05 动作不匹配（用 claim.submit 复用回收审批）→ APPROVAL_ACTION_MISMATCH', async () => {
    const approvalId = await approveCase();
    await expect(verifier().verify(query({ approvalId, action: 'claim.submit' }))).resolves.toMatchObject({
      reason: 'APPROVAL_ACTION_MISMATCH',
    });
  });

  it('06 目标不匹配（他案）→ APPROVAL_TARGET_MISMATCH', async () => {
    const approvalId = await approveCase();
    await expect(verifier().verify(query({ approvalId, targetRef: caseBId }))).resolves.toMatchObject({
      reason: 'APPROVAL_TARGET_MISMATCH',
    });
  });

  it('07 跨租户：他租户审批不可用于本租户；目标租户不一致 → TENANT_MISMATCH', async () => {
    const approvalB = await approveCase(caseBId, PAYLOAD, undefined, ORG_B);
    // 他租户审批 id 在本租户查询 → 不存在
    await expect(verifier().verify(query({ approvalId: approvalB }))).resolves.toMatchObject({ reason: 'APPROVAL_NOT_FOUND' });

    // 合成：A 租户的审批事件指向 B 租户的案件（模拟越权绑定）
    const forged = await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: ownerId,
        action: 'recovery.review_approved',
        entityType: 'Case',
        entityId: caseBId,
        changes: { boundPayload: { amount: '3000.0000', currency: 'USD', basisReference: 'basis-1', evidenceArtifactId: null, fingerprintVersion: 'v1' }, boundAction: RECOVERY_CONFIRMATION_ACTION, expiresAt: new Date(Date.now() + 3600_000).toISOString() } as never,
        createdAt: new Date(),
      },
    });
    await expect(verifier().verify(query({ approvalId: forged.id, targetRef: caseBId }))).resolves.toMatchObject({
      reason: 'APPROVAL_TENANT_MISMATCH',
    });
  });

  it('08 执行人不是成员 → APPROVAL_ACTOR_MISMATCH', async () => {
    const approvalId = await approveCase();
    await expect(verifier().verify(query({ approvalId, actorUserId: outsiderId }))).resolves.toMatchObject({
      reason: 'APPROVAL_ACTOR_MISMATCH',
    });
  });

  it('09 过期 → APPROVAL_EXPIRED', async () => {
    const approvalId = await approveCase(caseId, PAYLOAD, 1000);
    await expect(verifier(new Date(NOW.getTime() + 5000)).verify(query({ approvalId }))).resolves.toMatchObject({
      reason: 'APPROVAL_EXPIRED',
    });
  });

  it('10 撤销（晚于审批的 rejected 事件）→ APPROVAL_REVOKED', async () => {
    const approvalId = await approveCase();
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: ownerId,
        action: 'recovery.approval_revoked',
        entityType: 'Case',
        entityId: caseId,
        changes: { approvalId } as never,
        createdAt: new Date(NOW.getTime() + 60_000),
      },
    });
    await expect(verifier(new Date(NOW.getTime() + 120_000)).verify(query({ approvalId }))).resolves.toMatchObject({
      reason: 'APPROVAL_REVOKED',
    });
  });

  it('11 已消费（同审批同载荷、策略与权限仍满足）→ 允许幂等返回（valid + consumed 标记）', async () => {
    const approvalId = await approveCase();
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: ownerId,
        action: 'recovery.approval_consumed',
        entityType: 'Case',
        entityId: caseId,
        changes: { approvalId, operationId: 'op-1' } as never,
        createdAt: new Date(NOW.getTime() + 60_000),
      },
    });
    await expect(verifier(new Date(NOW.getTime() + 120_000)).verify(query({ approvalId }))).resolves.toEqual({
      valid: true,
      consumed: true,
    });
  });

  it('11b 已消费但随后被撤销 → 仍拒绝（生命周期优先于幂等）', async () => {
    const approvalId = await approveCase();
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: ownerId,
        action: 'recovery.approval_consumed',
        entityType: 'Case',
        entityId: caseId,
        changes: { approvalId, operationId: 'op-1' } as never,
        createdAt: new Date(NOW.getTime() + 60_000),
      },
    });
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: ownerId,
        action: 'recovery.approval_revoked',
        entityType: 'Case',
        entityId: caseId,
        changes: { approvalId } as never,
        createdAt: new Date(NOW.getTime() + 90_000),
      },
    });
    await expect(verifier(new Date(NOW.getTime() + 120_000)).verify(query({ approvalId }))).resolves.toMatchObject({
      reason: 'APPROVAL_REVOKED',
    });
  });

  it('12 审批源异常 → APPROVAL_SOURCE_ERROR（不冒充租户不匹配）', async () => {
    const failing = createHitlApprovalVerifier({
      prisma,
      readApprovalEvent: async () => {
        throw new Error('audit source down');
      },
    });
    await expect(failing.verify(query({ approvalId: 'x' }))).resolves.toEqual({ valid: false, reason: 'APPROVAL_SOURCE_ERROR' });
  });
});
