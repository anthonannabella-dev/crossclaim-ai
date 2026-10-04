/**
 * C18-7 持久化 — 授权生命周期 store 的真实 PostgreSQL 验收。
 * MSG-20261004-30（C18 PRODUCTION PERSISTENCE CHECKPOINT FINAL-2）三项必修都在这里有实测：
 *   CHANGE A：折叠把**已持久化的历史**算进去 —— 4 个用例都是**两次独立 applyObservation 调用**
 *             （不再每次重传完整历史）：REVOKED T2 → SUSPENDED T3 仍 REVOKED；REVOKED T2 → 迟到 GRANTED T1 仍 REVOKED；
 *             REVOKED T2 → GRANTED T3 变 ACTIVE；EXPIRED T2 → REAUTH_REQUIRED T3 仍 terminal。
 *   CHANGE B：事件主体必须匹配 input（AUTHORIZATION_SUBJECT_MISMATCH / zero writes）；坏事件整批拒绝
 *             （AUTHORIZATION_EVENT_INVALID，不得静默过滤后继续算）。
 *   CHANGE C：幂等键 (bindingId, event, sourceRef) 有 DB 唯一索引兜底（直接重复插入被拒）。
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
const T3 = new Date('2026-10-04T09:00:00.000Z');
const NOW = new Date('2026-10-04T10:00:00.000Z');
// 多次调用要用**递增的观察时钟**：occurredAt 由调用方 now 决定，同一 now 会造成事实排序并列（按 uuid 决胜）。
const NOW_1H = new Date('2026-10-04T11:00:00.000Z');
const NOW_2H = new Date('2026-10-04T12:00:00.000Z');
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

const lifecycleStore = () => createPrismaProviderAuthorizationLifecycleStore(prisma);
const bindingStatus = async () =>
  (await prisma.customsProviderTenantBinding.findFirstOrThrow()).status as string;
const lineageFacts = async (bindingId: string) =>
  prisma.customsProviderTenantBindingLineage.findMany({
    where: { bindingId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });

describe('C18-7 授权生命周期 store（PostgreSQL / FINAL-2）', () => {
  it('无 binding → BINDING_UNKNOWN，且不写任何事实', async () => {
    const result = await lifecycleStore().applyObservation(observation([event('REVOKED', T2)]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('BINDING_UNKNOWN');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(0);
    expect(await prisma.customsProviderTenantBinding.count()).toBe(0);
  });

  it('同一 effectiveAt 出现授权类与终止类矛盾 → AUTHORIZATION_CONFLICT，fail-closed 不写库', async () => {
    await seedActiveBinding();
    const result = await lifecycleStore().applyObservation(
      observation([event('GRANTED', T2), event('REVOKED', T2)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('AUTHORIZATION_CONFLICT');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(1); // 只有 seed 的 BOUND
    expect(await bindingStatus()).toBe('ACTIVE');
  });

  it('全部事件尚未生效（effectiveAt > now）→ AUTHORIZATION_UNKNOWN，不得提前变 ACTIVE', async () => {
    await seedActiveBinding();
    const result = await lifecycleStore().applyObservation(
      observation([event('REVOKED', new Date('2026-10-05T00:00:00.000Z'))]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('AUTHORIZATION_UNKNOWN');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(1);
  });

  it('CHANGE B：事件主体与 input 不一致 → AUTHORIZATION_SUBJECT_MISMATCH，zero writes', async () => {
    await seedActiveBinding();
    const foreign = event('REVOKED', T2, { organizationId: 'cc180700-0000-4000-8000-0000000000ff' });
    const result = await lifecycleStore().applyObservation(observation([foreign]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('AUTHORIZATION_SUBJECT_MISMATCH');
    expect(await bindingStatus()).toBe('ACTIVE');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(1);

    const foreignProvider = event('REVOKED', T2, { providerId: 'provider:other' });
    const result2 = await lifecycleStore().applyObservation(observation([foreignProvider]));
    expect(result2.ok).toBe(false);
    if (result2.ok) throw new Error('unreachable');
    expect(result2.reasonCode).toBe('AUTHORIZATION_SUBJECT_MISMATCH');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(1);
  });

  it('CHANGE B：非法事件整批 fail-closed（坏 REVOKED 被过滤后不得算出 ACTIVE）', async () => {
    await seedActiveBinding();
    // sourceRef 是裸 URL → validateProviderAuthorizationEvent 判 MISSING_SOURCE_REF（非法）。
    const invalid = event('REVOKED', T2, { sourceRef: 'https://evil.example/x' });
    const result = await lifecycleStore().applyObservation(
      observation([invalid, event('GRANTED', T3)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('AUTHORIZATION_EVENT_INVALID');
    expect(await bindingStatus()).toBe('ACTIVE');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(1);
  });

  it('provider 撤销 → binding REVOKED + lineage REVOKED（快照含主体/原因），闸门立刻拒绝', async () => {
    const seeded = await seedActiveBinding();
    const result = await lifecycleStore().applyObservation(
      observation([event('REVOKED', T2, { reasonCode: 'PROVIDER_REVOKED' })]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.outcome).toBe('APPLIED');
    expect(result.bindingStatus).toBe('REVOKED');
    expect(result.derived.status).toBe('REVOKED');

    expect(await bindingStatus()).toBe('REVOKED');
    const facts = await lineageFacts(seeded.bindingId);
    expect(facts.map((row) => row.event)).toEqual(['BOUND', 'REVOKED']);
    const snapshot = facts[1]!.snapshot as {
      providerStatus?: string;
      providerAuthorizationRef?: string;
      triggeringEventKind?: string;
      reasonCode?: string | null;
      triggeringEvent?: { effectiveAt?: string };
    };
    expect(snapshot.providerStatus).toBe('REVOKED');
    expect(snapshot.providerAuthorizationRef).toBe(AUTH_REF);
    expect(snapshot.triggeringEventKind).toBe('REVOKED');
    expect(snapshot.reasonCode).toBe('PROVIDER_REVOKED');
    expect(snapshot.triggeringEvent?.effectiveAt).toBe(T2.toISOString());
    expect(facts[1]!.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);

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

  it('CHANGE A-1：REVOKED T2 之后再来 SUSPENDED T3 → 仍 REVOKED，且不追加事实', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok && first.outcome).toBe('APPLIED');

    const second = await store.applyObservation(observation([event('SUSPENDED', T3)], NOW_1H));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('UNCHANGED');
    expect(second.priorDerived.status).toBe('REVOKED');
    expect(second.derived.status).toBe('REVOKED');
    expect(await bindingStatus()).toBe('REVOKED');
    expect((await lineageFacts(seeded.bindingId)).map((row) => row.event)).toEqual(['BOUND', 'REVOKED']);
  });

  it('CHANGE A-2：REVOKED T2 之后来一条迟到的旧 GRANTED T1 → 不得复活', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok && first.outcome).toBe('APPLIED');

    const second = await store.applyObservation(observation([event('GRANTED', T1)], NOW_1H));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('UNCHANGED');
    expect(second.derived.status).toBe('REVOKED');
    expect(await bindingStatus()).toBe('REVOKED');
    expect((await lineageFacts(seeded.bindingId)).map((row) => row.event)).toEqual(['BOUND', 'REVOKED']);
  });

  it('CHANGE A-3：REVOKED T2 之后来严格更晚的 GRANTED T3 → 恢复 ACTIVE（RESTORED）', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok && first.outcome).toBe('APPLIED');

    const second = await store.applyObservation(observation([event('GRANTED', T3)], NOW_1H));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('APPLIED');
    expect(second.priorDerived.status).toBe('REVOKED');
    expect(second.derived.status).toBe('ACTIVE');
    expect(second.bindingStatus).toBe('ACTIVE');
    expect(await bindingStatus()).toBe('ACTIVE');
    expect((await lineageFacts(seeded.bindingId)).map((row) => row.event)).toEqual([
      'BOUND',
      'REVOKED',
      'RESTORED',
    ]);
  });

  it('CHANGE A-4：EXPIRED T2 之后 REAUTH_REQUIRED T3 → 仍 terminal（不可提交）', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    // 第 1 次调用：provider 侧过期 → 闸门从 ACTIVE 变 REVOKED（这一条是真变化，必须落事实）。
    const expired = await store.applyObservation(observation([event('EXPIRED', T1)], NOW_1H));
    expect(expired.ok).toBe(true);
    if (!expired.ok) throw new Error('unreachable');
    expect(expired.outcome).toBe('APPLIED');
    expect(expired.ok && expired.bindingStatus).toBe('REVOKED');
    const expiredFact = (await lineageFacts(seeded.bindingId)).at(-1)!;
    expect((expiredFact.snapshot as { providerStatus?: string }).providerStatus).toBe('EXPIRED');

    // 第 2 次调用：再来一个 REAUTH_REQUIRED（既不解除 terminal，也不改变闸门）→ UNCHANGED，不追加事实。
    const reauth = await store.applyObservation(observation([event('REAUTH_REQUIRED', T3)], NOW_2H));
    expect(reauth.ok).toBe(true);
    if (!reauth.ok) throw new Error('unreachable');
    expect(reauth.outcome).toBe('UNCHANGED');
    expect(reauth.derived.status).toBe('EXPIRED');
    expect(await bindingStatus()).toBe('REVOKED');
    expect((await lineageFacts(seeded.bindingId)).map((row) => row.event)).toEqual(['BOUND', 'REVOKED']);
  });

  it('幂等：同一凭证重放 → REPLAYED，事实不重复追加', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok && first.outcome).toBe('APPLIED');

    const second = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('REPLAYED');
    expect(second.bindingStatus).toBe('REVOKED');
    expect(
      await prisma.customsProviderTenantBindingLineage.count({ where: { event: 'REVOKED' as never } }),
    ).toBe(1);
    void seeded;
  });

  it('并发：两个独立连接应用同一观察 → 一个 APPLIED、一个 REPLAYED，事实只有一条', async () => {
    await seedActiveBinding();
    const storeA = createPrismaProviderAuthorizationLifecycleStore(prisma);
    const storeB = createPrismaProviderAuthorizationLifecycleStore(prismaB);
    const [a, b] = await Promise.all([
      storeA.applyObservation(observation([event('REVOKED', T2)])),
      storeB.applyObservation(observation([event('REVOKED', T2)])),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect([a.outcome, b.outcome].sort()).toEqual(['APPLIED', 'REPLAYED']);
    expect(await prisma.customsProviderTenantBindingLineage.count({ where: { event: 'REVOKED' as never } })).toBe(1);
  });

  it('CHANGE C：DB 唯一索引兜底 —— 直接重复插入同一 (bindingId, event, sourceRef) 被拒', async () => {
    const seeded = await seedActiveBinding();
    const applied = await lifecycleStore().applyObservation(observation([event('REVOKED', T2)]));
    expect(applied.ok && applied.outcome).toBe('APPLIED');
    if (!applied.ok) throw new Error('unreachable');
    const fact = await prisma.customsProviderTenantBindingLineage.findFirstOrThrow({
      where: { bindingId: seeded.bindingId, event: 'REVOKED' as never },
    });
    await expect(
      prisma.customsProviderTenantBindingLineage.create({
        data: {
          organizationId: ORG,
          bindingId: seeded.bindingId,
          event: 'REVOKED' as never,
          actorRef: 'system:rogue-writer',
          note: null,
          snapshot: { forged: true } as never,
          snapshotDigest: DIGEST_A,
          occurredAt: T3,
          sourceRef: fact.sourceRef,
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.customsProviderTenantBindingLineage.count({
        where: { bindingId: seeded.bindingId, event: 'REVOKED' as never },
      }),
    ).toBe(1);
  });

  it('provider 撤销的事实是 append-only：DB 拒绝改写与删除', async () => {
    await seedActiveBinding();
    const applied = await lifecycleStore().applyObservation(observation([event('REVOKED', T2)]));
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
    expect(await prisma.customsProviderTenantBindingLineage.count({ where: { id: applied.lineageId! } })).toBe(1);
  });
});
