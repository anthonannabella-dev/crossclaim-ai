/**
 * C-0008-B1 — opportunity review against real PostgreSQL.
 * ------------------------------------------------------------------
 * Proves:
 *   1. DETECTED → QUALIFIED / DETECTED → REJECTED happy paths, with the reject
 *      reason persisted on the row *and* in the audit trail.
 *   2. Illegal transitions (repeated review) fail closed with zero writes.
 *   3. Tenant isolation: an opportunity of another tenant is NOT_FOUND.
 *   4. Role matrix: FINANCE / VIEWER cannot review (FORBIDDEN, zero writes).
 *   5. The AuditLog row lands in the same transaction as the UPDATE — if the
 *      audit insert fails, the status change rolls back.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { reviewOpportunity } from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'f0000000-0000-4000-8000-00000000000c';
const ORG_B = 'f0000000-0000-4000-8000-00000000000d';
const NOW = new Date('2026-09-28T18:00:00Z');

let actorUserId = '';

async function seedOpportunity(organizationId = ORG, status: Prisma.RecoveryOpportunityCreateInput['status'] = 'DETECTED') {
  return prisma.recoveryOpportunity.create({
    data: {
      organizationId,
      domain: 'LOGISTICS',
      channel: 'UPS',
      status,
      opportunityType: 'FREIGHT_RATE_VARIANCE',
      title: '测试机会',
      description: 'C-0008-B1 test fixture',
      amountExpected: new Prisma.Decimal('100.0000'),
      recoverableAmount: new Prisma.Decimal('17.7500'),
      detectedAt: NOW,
    },
  });
}

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "RecoveryOpportunity", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '工作流租户', slug: 'workflow-org' },
      { id: ORG_B, name: '另一租户', slug: 'workflow-org-b' },
    ],
  });
  const actor = await prisma.user.create({
    data: { email: 'ops@example.com', displayName: '运营', status: 'ACTIVE', emailVerified: true },
  });
  actorUserId = actor.id;
  await prisma.membership.create({
    data: { organizationId: ORG, userId: actor.id, role: 'OPS', isActive: true },
  });
});

const auditRows = (entityId: string) =>
  prisma.auditLog.findMany({ where: { entityType: 'RecoveryOpportunity', entityId } });

describe('C-0008-B1 — 机会人工复核（真实 PostgreSQL）', () => {
  it('DETECTED → QUALIFIED：状态、qualifiedAt 与审计同事务落地', async () => {
    const opportunity = await seedOpportunity();
    const result = await reviewOpportunity(
      prisma,
      {
        organizationId: ORG,
        opportunityId: opportunity.id,
        actorUserId,
        role: 'OPS',
        decision: 'QUALIFY',
      },
      () => NOW,
    );

    expect(result).toMatchObject({ from: 'DETECTED', to: 'QUALIFIED', reason: null });

    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('QUALIFIED');
    expect(row.qualifiedAt?.getTime()).toBe(NOW.getTime());
    expect(row.rejectedReason).toBeNull();

    const audits = await auditRows(opportunity.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: ORG,
      actorType: 'USER',
      actorUserId,
      action: 'opportunity.status_changed',
    });
    expect(audits[0].changes).toEqual({
      from: 'DETECTED',
      to: 'QUALIFIED',
      decision: 'QUALIFY',
    });
  });

  it('DETECTED → REJECTED：原因写入行与审计，且必须是批准词表', async () => {
    const opportunity = await seedOpportunity();
    const result = await reviewOpportunity(
      prisma,
      {
        organizationId: ORG,
        opportunityId: opportunity.id,
        actorUserId,
        role: 'OWNER',
        decision: 'REJECT',
        reason: 'not_recoverable',
      },
      () => NOW,
    );

    expect(result.to).toBe('REJECTED');
    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('REJECTED');
    expect(row.rejectedReason).toBe('not_recoverable');
    expect(row.qualifiedAt).toBeNull();

    const audits = await auditRows(opportunity.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].changes).toEqual({
      from: 'DETECTED',
      to: 'REJECTED',
      decision: 'REJECT',
      reason: 'not_recoverable',
    });
    // 审计内容不含凭据类字段。
    expect(JSON.stringify(audits[0].changes)).not.toMatch(/token|password|secret|hash/i);
  });

  it('重复复核 → ILLEGAL_TRANSITION，状态与审计都不再变化', async () => {
    const opportunity = await seedOpportunity();
    const input = {
      organizationId: ORG,
      opportunityId: opportunity.id,
      actorUserId,
      role: 'ADMIN' as const,
      decision: 'QUALIFY' as const,
    };
    await reviewOpportunity(prisma, input, () => NOW);
    const before = await auditRows(opportunity.id);

    await expect(reviewOpportunity(prisma, input, () => NOW)).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
    await expect(
      reviewOpportunity(
        prisma,
        { ...input, decision: 'REJECT', reason: 'duplicate' },
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('QUALIFIED');
    expect(await auditRows(opportunity.id)).toHaveLength(before.length);
  });

  it('跨租户复核 → NOT_FOUND，零写入', async () => {
    const opportunity = await seedOpportunity(ORG_B);
    await expect(
      reviewOpportunity(
        prisma,
        {
          organizationId: ORG,
          opportunityId: opportunity.id,
          actorUserId,
          role: 'OWNER',
          decision: 'QUALIFY',
        },
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('DETECTED');
    expect(await auditRows(opportunity.id)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('FINANCE / VIEWER 复核 → FORBIDDEN，零写入', async () => {
    const opportunity = await seedOpportunity();
    for (const role of ['FINANCE', 'VIEWER', 'UNKNOWN_ROLE']) {
      await expect(
        reviewOpportunity(
          prisma,
          {
            organizationId: ORG,
            opportunityId: opportunity.id,
            actorUserId,
            role,
            decision: 'QUALIFY',
          },
          () => NOW,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('DETECTED');
    expect(await auditRows(opportunity.id)).toHaveLength(0);
  });

  it('审计写入失败时状态回滚（同事务，不产生「改了但没留痕」）', async () => {
    const opportunity = await seedOpportunity();

    const flaky = {
      $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        prisma.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get: (target, key, receiver) =>
                key === 'auditLog'
                  ? { create: () => Promise.reject(new Error('audit sink unavailable')) }
                  : Reflect.get(target, key, receiver),
            }),
          ),
        ),
    } as unknown as PrismaClient;

    await expect(
      reviewOpportunity(
        flaky,
        {
          organizationId: ORG,
          opportunityId: opportunity.id,
          actorUserId,
          role: 'OWNER',
          decision: 'QUALIFY',
        },
        () => NOW,
      ),
    ).rejects.toThrow('audit sink unavailable');

    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('DETECTED');
    expect(row.qualifiedAt).toBeNull();
    expect(await auditRows(opportunity.id)).toHaveLength(0);
  });

  it('并发 qualify/reject：恰好一个成功、另一个 ILLEGAL_TRANSITION，且只有一条成功审计', async () => {
    const opportunity = await seedOpportunity();
    const base = {
      organizationId: ORG,
      opportunityId: opportunity.id,
      actorUserId,
      role: 'OPS',
    } as const;

    // 同一 DETECTED 机会上同时发起两个复核；数据库必须用原子 CAS 只放行一个。
    const [first, second] = await Promise.allSettled([
      reviewOpportunity(prisma, { ...base, decision: 'QUALIFY' }, () => NOW),
      reviewOpportunity(prisma, { ...base, decision: 'REJECT', reason: 'duplicate' }, () => NOW),
    ]);

    const settled = [first, second];
    const winners = settled.filter((result) => result.status === 'fulfilled');
    const losers = settled.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });

    const winner = (
      winners[0] as PromiseFulfilledResult<{ to: 'QUALIFIED' | 'REJECTED'; reason: string | null }>
    ).value;
    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe(winner.to);
    if (winner.to === 'QUALIFIED') {
      expect(row.qualifiedAt?.getTime()).toBe(NOW.getTime());
      expect(row.rejectedReason).toBeNull();
    } else {
      expect(row.rejectedReason).toBe('duplicate');
    }

    // 审计真实性：只有成功的那一次转换留下记录，且与最终状态一致。
    const audits = await auditRows(opportunity.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'USER', actorUserId, action: 'opportunity.status_changed' });
    expect(audits[0].changes).toMatchObject({ from: 'DETECTED', to: winner.to });
  });
});
