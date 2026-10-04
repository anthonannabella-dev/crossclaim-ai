/**
 * C18-7 持久化 — 授权生命周期 store 的真实 PostgreSQL 验收（MSG-20261004-29 下一阶段要求）：
 *   · fail-closed：无 binding → BINDING_UNKNOWN；冲突事件 → AUTHORIZATION_CONFLICT；全部未来生效 → AUTHORIZATION_UNKNOWN；三者都不写库；
 *   · 同事务：binding.status 与 lineage 事实一起写；任一步失败一起回滚（由 DB 不变量与事务保证）；
 *   · 幂等：同一 (bindingId, event, sourceRef) 只落一条，重放 → REPLAYED；
 *   · 并发：两个独立连接同时应用同一观察 → 一个 APPLIED、一个 REPLAYED，事实仍只有一条；
 *   · 时间语义：REVOKED 只能被 effectiveAt **严格更晚**的授权事件解除（同 effectiveAt 是 conflict）。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaProviderTenantBindingStore } from '../services/customs/customs-provider-tenant-binding-prisma-store';
import { computeProviderBindingScopeKey } from '../services/customs/customs-provider-tenant-binding';
import {
  evaluateProviderSubmissionPrecondition,
  type ProviderAuthorizationEvent,
} from '../services/customs/customs-provider-authorization-lifecycle';
import { createPrismaProviderAuthorizationLifecycleStore } from '../services/customs/customs-provider-authorization-lifecycle-prisma-store';

const prisma = new PrismaClient();
const prismaB = new PrismaClient();
const ORG = 'cc180700-0000-4000-8000-000000000001';
const USER = 'cc180700-0000-4000-8000-000000000002';
const T0 = new Date('2026-10-04T06:00:00.000Z');
const T1 = new Date('2026-10-04T07:00:00.000Z');
const T2 = new Date('2026-10-04T08:00:00.000Z');
const NOW = new Date('2026-10-04T09:00:00.000Z');
const NOW_LATE = new Date('2026-10-04T12:00:00.000Z');
const DIGEST_A = 'a'.repeat(64);

const SCOPE = {
  principalRef: 'ior:acme',
  jurisdictionAnchor: 'US',
  bindingSlotRef: 'slot:acme-us-1',
};
const PROVIDER_ID = 'provider:customs-a';
const AUTH_REF = 'pauth:acme-us-1';

const bindingRow = (status: string) => ({
  organizationId: ORG,
  principalRef: SCOPE.principalRef,
  providerId: PROVIDER_ID,
  bindingScopeVersion: 'v1',
  jurisdictionAnchor: SCOPE.jurisdictionAnchor,
  bindingSlotRef: SCOPE.bindingSlotRef,
  bindingScopeKey: computeProviderBindingScopeKey(SCOPE),
  providerTenantRef: 'ptenant:acme-us',
  providerAccountRef: 'paccount:broker-a',
  relationship: 'CROSSCLAIM_SAAS',
  relationshipEvidenceRef: 'evidence:saas-agreement',
  relationshipVerifiedAt: T0,
  jurisdictionScope: ['US'],
  status,
  verifiedAt: T0,
  credentialReference: 'credref:slot-1',
});

const event = (
  kind: ProviderAuthorizationEvent['kind'],
  effectiveAt: Date,
  extra: Partial<ProviderAuthorizationEvent> = {},
): ProviderAuthorizationEvent => ({
  providerId: PROVIDER_ID,
  providerAuthorizationRef: AUTH_REF,
  organizationId: ORG,
  principalRef: SCOPE.principalRef,
  kind,
  effectiveAt: effectiveAt.toISOString(),
  observedAt: effectiveAt.toISOString(),
  expiresAt: null,
  reasonCode: null,
  sourceRef: `webhook:${kind}:${effectiveAt.toISOString()}`,
  ...extra,
});

const observation = (events: readonly ProviderAuthorizationEvent[], now: Date = NOW) => ({
  organizationId: ORG,
  providerId: PROVIDER_ID,
  ...SCOPE,
  events,
  now,
});

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
  await prisma.organization.create({ data: { id: ORG, name: 'C18-7 租户', slug: 'c18-7-org' } });
  await prisma.user.create({
    data: {
      id: USER,
      email: 'c18-7@example.com',
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

const seedActiveBinding = async () => {
  const store = createPrismaProviderTenantBindingStore(prisma);
  return store.upsertWithLineage({
    row: bindingRow('ACTIVE'),
    event: 'BOUND',
    actorRef: 'actor:ops',
    occurredAt: T0,
    snapshotDigest: DIGEST_A,
  });
};

describe('C18-7 授权生命周期 store（PostgreSQL）', () => {
  it('无 binding → BINDING_UNKNOWN，且不写任何事实', async () => {
    const store = createPrismaProviderAuthorizationLifecycleStore(prisma);
    const result = await store.applyObservation(observation([event('REVOKED', T1)]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('BINDING_UNKNOWN');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(0);
    expect(await prisma.customsProviderTenantBinding.count()).toBe(0);
  });

  it('同一 effectiveAt 出现授权类与终止类矛盾 → AUTHORIZATION_CONFLICT，fail-closed 不写库', async () => {
    await seedActiveBinding();
    const store = createPrismaProviderAuthorizationLifecycleStore(prisma);
    const result = await store.applyObservation(
      observation([event('GRANTED', T1), event('REVOKED', T1)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('AUTHORIZATION_CONFLICT');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(1); // 只有 seed 的 BOUND
    const binding = await prisma.customsProviderTenantBinding.findFirstOrThrow();
    expect(binding.status).toBe('ACTIVE');
  });

  it('全部事件都尚未生效（effectiveAt > now）→ AUTHORIZATION_UNKNOWN，不得提前变 ACTIVE', async () => {
    await seedActiveBinding();
    const store = createPrismaProviderAuthorizationLifecycleStore(prisma);
    const result = await store.applyObservation(
      observation([event('REVOKED', new Date('2026-10-05T00:00:00.000Z'))]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('AUTHORIZATION_UNKNOWN');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(1);
  });

  it('provider 撤销 → binding REVOKED + lineage REVOKED，且提交闸门立刻拒绝', async () => {
    const seeded = await seedActiveBinding();
    const store = createPrismaProviderAuthorizationLifecycleStore(prisma);
    const result = await store.applyObservation(observation([event('REVOKED', T1)]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.outcome).toBe('APPLIED');
    expect(result.bindingStatus).toBe('REVOKED');
    expect(result.derived.status).toBe('REVOKED');

    const binding = await prisma.customsProviderTenantBinding.findFirstOrThrow();
    expect(binding.status).toBe('REVOKED');

    const lineage = await prisma.customsProviderTenantBindingLineage.findMany({
      where: { bindingId: seeded.bindingId },
      orderBy: [{ occurredAt: 'asc' }],
    });
    expect(lineage.map((row) => row.event)).toEqual(['BOUND', 'REVOKED']);
    const revocation = lineage[1]!;
    expect((revocation.snapshot as { providerStatus?: string }).providerStatus).toBe('REVOKED');
    expect(revocation.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);

    const precondition = evaluateProviderSubmissionPrecondition({
      internal: { status: 'VERIFIED' },
      provider: result.derived,
      now: NOW,
    });
    expect(precondition.allowed).toBe(false);
    expect(precondition.reasonCode).toBe('PROVIDER_AUTHORIZATION_REVOKED');
    expect(precondition.requiredAction).toBe('RE_SIGN_POA');
    expect(precondition.externalWritePerformed).toBe(false);
    expect(precondition.filingSubmitted).toBe(false);
    expect(precondition.transportEnabled).toBe(false);
    expect(precondition.productionCredentials).toBe('ABSENT');
  });

  it('幂等：同一凭证重放 → REPLAYED，事实不重复追加', async () => {
    await seedActiveBinding();
    const store = createPrismaProviderAuthorizationLifecycleStore(prisma);
    const first = await store.applyObservation(observation([event('REVOKED', T1)]));
    expect(first.ok && first.outcome).toBe('APPLIED');

    const second = await store.applyObservation(observation([event('REVOKED', T1)]));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('REPLAYED');
    expect(second.bindingStatus).toBe('REVOKED');

    expect(
      await prisma.customsProviderTenantBindingLineage.count({ where: { event: 'REVOKED' as never } }),
    ).toBe(1);
  });

  it('并发：两个独立连接应用同一观察 → 一个 APPLIED、一个 REPLAYED，事实只有一条', async () => {
    await seedActiveBinding();
    const storeA = createPrismaProviderAuthorizationLifecycleStore(prisma);
    const storeB = createPrismaProviderAuthorizationLifecycleStore(prismaB);

    const [a, b] = await Promise.all([
      storeA.applyObservation(observation([event('REVOKED', T1)])),
      storeB.applyObservation(observation([event('REVOKED', T1)])),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect([a.outcome, b.outcome].sort()).toEqual(['APPLIED', 'REPLAYED']);
    expect(await prisma.customsProviderTenantBindingLineage.count({ where: { event: 'REVOKED' as never } })).toBe(1);
  });

  it('过期 → binding REVOKED（快照保留 providerStatus=EXPIRED）；只有严格更晚的授权事件才能恢复 ACTIVE', async () => {
    await seedActiveBinding();
    const store = createPrismaProviderAuthorizationLifecycleStore(prisma);

    const expired = await store.applyObservation(
      observation([event('GRANTED', T0, { expiresAt: T1.toISOString() }), event('EXPIRED', T1)]),
    );
    expect(expired.ok).toBe(true);
    if (!expired.ok) throw new Error('unreachable');
    expect(expired.bindingStatus).toBe('REVOKED');
    const expiredLineage = await prisma.customsProviderTenantBindingLineage.findFirstOrThrow({
      where: { event: 'REVOKED' as never },
    });
    expect((expiredLineage.snapshot as { providerStatus?: string }).providerStatus).toBe('EXPIRED');

    // 同一 effectiveAt 的"恢复"是 conflict，不得复活。
    const sameInstant = await store.applyObservation(
      observation([event('GRANTED', T0, { expiresAt: T1.toISOString() }), event('EXPIRED', T1), event('GRANTED', T1)]),
    );
    expect(sameInstant.ok).toBe(false);
    if (sameInstant.ok) throw new Error('unreachable');
    expect(sameInstant.reasonCode).toBe('AUTHORIZATION_CONFLICT');
    expect((await prisma.customsProviderTenantBinding.findFirstOrThrow()).status).toBe('REVOKED');

    // 严格更晚的 GRANTED 才恢复 ACTIVE。
    const restored = await store.applyObservation(
      observation([
        event('GRANTED', T0, { expiresAt: T1.toISOString() }),
        event('EXPIRED', T1),
        event('GRANTED', T2, { expiresAt: null }),
      ], NOW_LATE),
    );
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('unreachable');
    expect(restored.outcome).toBe('APPLIED');
    expect(restored.bindingStatus).toBe('ACTIVE');
    expect((await prisma.customsProviderTenantBinding.findFirstOrThrow()).status).toBe('ACTIVE');
    expect(
      await prisma.customsProviderTenantBindingLineage.count({ where: { event: 'RESTORED' as never } }),
    ).toBe(1);
  });

  it('provider 撤销的事实是 append-only：DB 拒绝改写与删除', async () => {
    await seedActiveBinding();
    const store = createPrismaProviderAuthorizationLifecycleStore(prisma);
    const applied = await store.applyObservation(observation([event('REVOKED', T1)]));
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('unreachable');

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "CustomsProviderTenantBindingLineage" SET "note" = 'tampered' WHERE "id" = '${applied.lineageId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM "CustomsProviderTenantBindingLineage" WHERE "id" = '${applied.lineageId}'`,
      ),
    ).rejects.toThrow();
    expect(
      await prisma.customsProviderTenantBindingLineage.count({ where: { id: applied.lineageId! } }),
    ).toBe(1);
  });
});
