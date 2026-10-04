/**
 * C18-6 Prisma Store 真实 PostgreSQL 验收（MSG-20261004-29 下一阶段要求）：
 *   · 读路径 fail-closed：0 条 → BINDING_UNKNOWN；1 条 → 解析成功；>1 条适用 → BINDING_AMBIGUOUS；
 *   · 写入同事务：lineage 失败 → binding 一起回滚（不留半截状态）；
 *   · 并发 rebind：行锁串行化 → lineage 不丢（两条事实都在）。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaProviderTenantBindingStore } from '../services/customs/customs-provider-tenant-binding-prisma-store';
import { computeProviderBindingScopeKey } from '../services/customs/customs-provider-tenant-binding';

const prisma = new PrismaClient();
const prismaB = new PrismaClient();
const ORG = 'cc180600-0000-4000-8000-000000000001';
const USER = 'cc180600-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-04T06:00:00.000Z');
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const row = (over: Record<string, unknown> = {}) => {
  const principalRef = (over.principalRef as string) ?? 'ior:acme';
  const anchor = (over.jurisdictionAnchor as string) ?? 'US';
  const slot = (over.bindingSlotRef as string) ?? 'slot:acme-us-1';
  return {
    organizationId: ORG,
    principalRef,
    providerId: 'provider:customs-a',
    bindingScopeVersion: 'v1',
    jurisdictionAnchor: anchor,
    bindingSlotRef: slot,
    bindingScopeKey: computeProviderBindingScopeKey({ principalRef, jurisdictionAnchor: anchor, bindingSlotRef: slot }),
    providerTenantRef: (over.providerTenantRef as string) ?? 'ptenant:acme-us',
    providerAccountRef: (over.providerAccountRef as string) ?? 'paccount:broker-a',
    relationship: 'CROSSCLAIM_SAAS',
    relationshipEvidenceRef: 'evidence:saas-agreement',
    relationshipVerifiedAt: NOW,
    jurisdictionScope: ['US'],
    status: 'ACTIVE',
    verifiedAt: NOW,
    credentialReference: 'credref:slot-1',
    ...over,
  } as Parameters<ReturnType<typeof createPrismaProviderTenantBindingStore>['upsertWithLineage']>[0]['row'];
};

beforeAll(async () => {
  await prisma.$connect();
  await prismaB.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await prismaB.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CustomsProviderTenantBindingLineage", "CustomsProviderTenantBinding", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'C18-6 租户', slug: 'c18-6-org' } });
  await prisma.user.create({
    data: {
      id: USER,
      email: 'c18-6@example.com',
      passwordHash: 'x',
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true },
  });
});

describe('C18-6 Prisma store (PostgreSQL)', () => {
  it('读路径：无绑定 → BINDING_UNKNOWN；有绑定 → 解析出 server-derived ref', async () => {
    const store = createPrismaProviderTenantBindingStore(prisma);
    const query = {
      organizationId: ORG,
      providerId: 'provider:customs-a',
      principalRef: 'ior:acme',
      jurisdiction: 'US',
    };

    const missing = await store.resolve(query);
    expect(missing.ok).toBe(false);
    expect(missing.reasonCode).toBe('BINDING_UNKNOWN');

    await store.upsertWithLineage({
      row: row(),
      event: 'BOUND',
      actorRef: 'actor:ops',
      occurredAt: NOW,
      snapshotDigest: DIGEST_A,
    });

    const resolved = await store.resolve(query);
    expect(resolved.ok).toBe(true);
    expect(resolved.providerTenantRef).toBe('ptenant:acme-us');
  });

  it('读路径：同一 principal 两条适用绑定 → BINDING_AMBIGUOUS（fail-closed）', async () => {
    const store = createPrismaProviderTenantBindingStore(prisma);
    await store.upsertWithLineage({
      row: row({ bindingSlotRef: 'slot:a' }),
      event: 'BOUND',
      actorRef: 'actor:ops',
      occurredAt: NOW,
      snapshotDigest: DIGEST_A,
    });
    await store.upsertWithLineage({
      row: row({ bindingSlotRef: 'slot:b' }),
      event: 'BOUND',
      actorRef: 'actor:ops',
      occurredAt: NOW,
      snapshotDigest: DIGEST_B,
    });
    const ambiguous = await store.resolve({
      organizationId: ORG,
      providerId: 'provider:customs-a',
      principalRef: 'ior:acme',
      jurisdiction: 'US',
    });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.reasonCode).toBe('BINDING_AMBIGUOUS');
  });

  it('写入同事务：lineage 失败（非法 snapshotDigest）→ binding 一起回滚', async () => {
    const store = createPrismaProviderTenantBindingStore(prisma);
    await expect(
      store.upsertWithLineage({
        row: row(),
        event: 'BOUND',
        actorRef: 'actor:ops',
        occurredAt: NOW,
        snapshotDigest: 'not-a-64-hex-digest',
      }),
    ).rejects.toThrow();

    expect(await prisma.customsProviderTenantBinding.count()).toBe(0);
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(0);
  });

  it('并发 rebind（两个独立连接）：lineage 不丢，两条事实都在', async () => {
    const storeA = createPrismaProviderTenantBindingStore(prisma);
    const storeB = createPrismaProviderTenantBindingStore(prismaB);
    const first = await storeA.upsertWithLineage({
      row: row({ providerAccountRef: 'paccount:broker-a' }),
      event: 'BOUND',
      actorRef: 'actor:ops',
      occurredAt: NOW,
      snapshotDigest: DIGEST_A,
    });

    await Promise.all([
      storeA.upsertWithLineage({
        row: row({ providerAccountRef: 'paccount:broker-b' }),
        event: 'REBOUND',
        actorRef: 'actor:ops-1',
        occurredAt: new Date(NOW.getTime() + 1000),
        snapshotDigest: DIGEST_A,
      }),
      storeB.upsertWithLineage({
        row: row({ providerAccountRef: 'paccount:broker-c' }),
        event: 'REBOUND',
        actorRef: 'actor:ops-2',
        occurredAt: new Date(NOW.getTime() + 2000),
        snapshotDigest: DIGEST_B,
      }),
    ]);

    const lineage = await prisma.customsProviderTenantBindingLineage.findMany({
      where: { bindingId: first.bindingId },
      orderBy: [{ occurredAt: 'asc' }],
    });
    expect(lineage).toHaveLength(3);
    expect(lineage.map((entry) => entry.event)).toEqual(['BOUND', 'REBOUND', 'REBOUND']);
    expect(await prisma.customsProviderTenantBinding.count()).toBe(1);
  });
});
