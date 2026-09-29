// Claim Tracking 写路径（真实 PostgreSQL）：CAS 并发、幂等、跨租户、I1/I3/I5。
// 依据：MSG-20260929-23（S1-S5 GO）与 MSG-20260929-25（A1 权限位 GO）。

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuditWriter } from '../services/audit';
import { createPrismaAuditSink } from '../services/audit/prisma-sink';
import {
  recordAcknowledgement,
  recordSubmission,
  recordTerminal,
  setDeadline,
} from '../services/claims/tracking-service';

const prisma = new PrismaClient();
const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: 'claim-tracking-test-salt' });

const ORG = 'b6000000-0000-4000-8000-000000000001';
const ORG_B = 'b6000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-29T10:00:00Z');

let ownerId = '';
let claimId = '';
let foreignClaimId = '';

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
      { id: ORG, name: '轨迹租户', slug: 'tracking-org' },
      { id: ORG_B, name: '外部租户', slug: 'tracking-org-b' },
    ],
  });
  const owner = await prisma.user.create({
    data: { email: 'tracking-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });

  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CASE-TRK-1',
      title: '轨迹用例案件',
      domain: 'LOGISTICS',
      status: 'OPEN',
      currency: 'USD',
    },
  });
  const claim = await prisma.claim.create({
    data: { organizationId: ORG, caseId: kase.id, round: 1, status: 'DRAFT', target: 'PLATFORM' },
  });
  claimId = claim.id;

  const foreignCase = await prisma.case.create({
    data: {
      organizationId: ORG_B,
      caseNo: 'CASE-TRK-FOREIGN',
      title: '外部案件',
      domain: 'LOGISTICS',
      status: 'OPEN',
      currency: 'USD',
    },
  });
  const foreignClaim = await prisma.claim.create({
    data: { organizationId: ORG_B, caseId: foreignCase.id, round: 1, status: 'DRAFT', target: 'PLATFORM' },
  });
  foreignClaimId = foreignClaim.id;
});

const deps = { prisma, audit, now: () => NOW };
const base = () => ({ organizationId: ORG, claimId, actorUserId: ownerId, role: 'OWNER' }) as const;

describe('Claim Tracking 写路径（真实 PostgreSQL）', () => {
  it('01 recordSubmission：DRAFT → SUBMITTED 并留下人工批准痕迹', async () => {
    const result = await recordSubmission({ ...base() }, deps);
    expect(result.status).toBe('SUBMITTED');
    const row = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
    expect(row.status).toBe('SUBMITTED');
    expect(row.approvedByUserId).toBe(ownerId);
    expect(row.approvedAt).not.toBeNull();
  });

  it('02 CAS 并发：两个并发提交只有一个成功，另一个拿到稳定冲突错误码', async () => {
    const [a, b] = await Promise.allSettled([
      recordSubmission({ ...base() }, deps),
      recordSubmission({ ...base() }, deps),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { code?: string }).code).toBe('ILLEGAL_TRANSITION');
  });

  it('03 跨租户：不得对他人租户的 Claim 写入（不存在即拒绝）', async () => {
    await expect(
      recordSubmission({ ...base(), claimId: foreignClaimId }, deps),
    ).rejects.toThrowError(/不存在或不属于该租户/);
    const foreign = await prisma.claim.findUniqueOrThrow({ where: { id: foreignClaimId } });
    expect(foreign.status).toBe('DRAFT');
  });

  it('04 recordAcknowledgement：平台案件号幂等（重复录入 reused=true，不重复迁移）', async () => {
    await recordSubmission({ ...base() }, deps);
    const first = await recordAcknowledgement({ ...base(), platformCaseRef: 'AMZ-CASE-1' }, deps);
    const second = await recordAcknowledgement({ ...base(), platformCaseRef: 'AMZ-CASE-1' }, deps);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.status).toBe('ACKNOWLEDGED');
  });

  it('05 setDeadline：I1 —— 有 dueAt 必须有来源，来源 UNKNOWN 时不得有日期', async () => {
    await expect(
      setDeadline({ ...base(), dueAt: NOW, deadlineSource: 'UNKNOWN' }, deps),
    ).rejects.toThrowError(/有效来源/);
    await expect(
      setDeadline({ ...base(), dueAt: null, deadlineSource: 'PLATFORM_NOTICE' }, deps),
    ).rejects.toThrowError(/UNKNOWN/);

    const ok = await setDeadline(
      { ...base(), dueAt: new Date('2026-10-05T00:00:00Z'), deadlineSource: 'PLATFORM_NOTICE' },
      deps,
    );
    expect(ok.dueAt).toBe('2026-10-05T00:00:00.000Z');
  });

  it('06 recordTerminal：I3 部分批准必须给金额；I5 终局清空 open deadline', async () => {
    await recordSubmission({ ...base() }, deps);
    await recordAcknowledgement({ ...base(), platformCaseRef: 'AMZ-CASE-2' }, deps);
    await setDeadline(
      { ...base(), dueAt: new Date('2026-10-05T00:00:00Z'), deadlineSource: 'PLATFORM_NOTICE' },
      deps,
    );

    await expect(
      recordTerminal({ ...base(), status: 'PARTIALLY_APPROVED', terminalReasonCode: 'PLATFORM_DECISION' }, deps),
    ).rejects.toThrowError(/responseAmount/);

    const done = await recordTerminal(
      {
        ...base(),
        status: 'PARTIALLY_APPROVED',
        terminalReasonCode: 'PLATFORM_DECISION',
        responseAmount: '30.0000',
      },
      deps,
    );
    expect(done.status).toBe('PARTIALLY_APPROVED');
    const row = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
    expect(row.responseAmount?.toFixed(4)).toBe('30.0000');
    expect(row.dueAt).toBeNull();
    expect(row.deadlineSource).toBe('UNKNOWN');
  });

  it('07 终局不可回退（I4）：已终局再提交被拒', async () => {
    await recordSubmission({ ...base() }, deps);
    await recordTerminal({ ...base(), status: 'REJECTED', terminalReasonCode: 'INSUFFICIENT_EVIDENCE' }, deps);
    await expect(recordSubmission({ ...base() }, deps)).rejects.toThrowError(/状态已变化/);
  });

  it('08 审计留痕：提交 / 回执 / 截止 / 终局四类动作均可追溯', async () => {
    await recordSubmission({ ...base() }, deps);
    await recordAcknowledgement({ ...base(), platformCaseRef: 'AMZ-CASE-3' }, deps);
    await setDeadline({ ...base(), dueAt: new Date('2026-10-05T00:00:00Z'), deadlineSource: 'CONTRACT' }, deps);
    await recordTerminal({ ...base(), status: 'APPROVED', terminalReasonCode: 'PLATFORM_DECISION' }, deps);

    const actions = (
      await prisma.auditLog.findMany({ where: { organizationId: ORG }, orderBy: { createdAt: 'asc' } })
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'claim.submitted_by_human',
        'claim.platform_case_ref_recorded',
        'claim.deadline_recorded',
        'claim.terminal_recorded',
      ]),
    );
  });
});
