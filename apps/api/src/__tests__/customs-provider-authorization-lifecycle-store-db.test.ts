/**
 * C18-7 持久化 — 授权生命周期 store 的真实 PostgreSQL 验收。
 *   · MSG-20261004-30（FINAL-2）：CHANGE A 折叠纳入已持久化历史（4 个**两次独立调用**的用例）；
 *     CHANGE B 事件主体完整性 + 坏事件整批 fail-closed；CHANGE C 幂等键 DB 唯一兜底。
 *   · MSG-20261004-31（FINAL-3）：CHANGE D 闸门未变化的合法观察也必须耐久化（事件语义 AUTHORIZATION_OBSERVED，
 *     不再用误导的 RESTORED，也不再丢事实）；一次调用多个事件时 snapshot.observedEvents 保存全部；
 *     CHANGE E REPLAYED 路径必须返回与正常路径相同的 fold 真值（persisted history + incoming）。
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
const T4 = new Date('2026-10-04T09:30:00.000Z');
const T5 = new Date('2026-10-05T00:00:00.000Z');
const NOW = new Date('2026-10-04T10:00:00.000Z');
const T6 = new Date('2026-10-06T00:00:00.000Z');
const NOW_AFTER_T6 = new Date('2026-10-06T12:00:00.000Z');
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
const AUTH_REF_2 = 'pauth:acme-us-2';

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

describe('C18-7 授权生命周期 store（PostgreSQL / FINAL-3）', () => {
  it('无 binding → BINDING_UNKNOWN，且不写任何事实', async () => {
    const result = await lifecycleStore().applyObservation(observation([event('REVOKED', T2)]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('BINDING_UNKNOWN');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(0);
  });

  it('同一 effectiveAt 出现授权类与终止类矛盾 → AUTHORIZATION_CONFLICT，fail-closed 不写库', async () => {
    await seedActiveBinding();
    const result = await lifecycleStore().applyObservation(
      observation([event('GRANTED', T2), event('REVOKED', T2)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reasonCode).toBe('AUTHORIZATION_CONFLICT');
    expect(await prisma.customsProviderTenantBindingLineage.count()).toBe(1);
    expect(await bindingStatus()).toBe('ACTIVE');
  });

  it('CHANGE F：未来生效的合法观察 → 不提前改闸门，但必须耐久化；生效后由历史落闸门', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();

    // 观察时点 NOW 早于 effectiveAt：不得提前撤销，但事实必须落库。
    const future = await store.applyObservation(observation([event('REVOKED', T6)], NOW));
    expect(future.ok).toBe(true);
    if (!future.ok) throw new Error('unreachable');
    expect(future.outcome).toBe('APPLIED');
    expect(future.bindingStatus).toBe('ACTIVE');
    expect(future.derived.status).toBe('UNKNOWN');
    expect(await bindingStatus()).toBe('ACTIVE');
    const facts = await lineageFacts(seeded.bindingId);
    expect(facts.map((row) => row.event)).toEqual(['BOUND', 'AUTHORIZATION_OBSERVED']);
    const snapshot = facts[1]!.snapshot as Record<string, unknown>;
    expect(snapshot.providerStatus).toBe('UNKNOWN');
    expect((snapshot.observedEvents as unknown[]).length).toBe(1);

    // 到 effectiveAt 之后再应用同一条观察：历史里的未来撤销生效，闸门必须跟着落下来（不得长期 stale）。
    const effective = await store.applyObservation(observation([event('REVOKED', T6)], NOW_AFTER_T6));
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error('unreachable');
    expect(effective.outcome).toBe('APPLIED');
    expect(effective.derived.status).toBe('REVOKED');
    expect(effective.bindingStatus).toBe('REVOKED');
    expect(await bindingStatus()).toBe('REVOKED');
    expect((await lineageFacts(seeded.bindingId)).map((row) => row.event)).toEqual([
      'BOUND',
      'AUTHORIZATION_OBSERVED',
      'REVOKED',
    ]);
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
    const invalid = event('REVOKED', T2, { sourceRef: 'https://evil.example/x' });
    const result = await lifecycleStore().applyObservation(observation([invalid, event('GRANTED', T3)]));
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

    expect(await bindingStatus()).toBe('REVOKED');
    const facts = await lineageFacts(seeded.bindingId);
    expect(facts.map((row) => row.event)).toEqual(['BOUND', 'REVOKED']);
    const snapshot = facts[1]!.snapshot as Record<string, unknown>;
    expect(snapshot.providerStatus).toBe('REVOKED');
    expect(snapshot.providerAuthorizationRef).toBe(AUTH_REF);
    expect(snapshot.triggeringEventKind).toBe('REVOKED');
    expect(snapshot.reasonCode).toBe('PROVIDER_REVOKED');
    expect((snapshot.triggeringEvent as { effectiveAt?: string }).effectiveAt).toBe(T2.toISOString());
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

  it('CHANGE A-1：REVOKED T2 之后 SUSPENDED T3 → 仍 REVOKED（并耐久化为 AUTHORIZATION_OBSERVED）', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok && first.outcome).toBe('APPLIED');

    const second = await store.applyObservation(observation([event('SUSPENDED', T3)], NOW_1H));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('APPLIED');
    expect(second.derived.status).toBe('REVOKED');
    expect(second.bindingStatus).toBe('REVOKED');
    expect(await bindingStatus()).toBe('REVOKED');
    const facts = await lineageFacts(seeded.bindingId);
    expect(facts.map((row) => row.event)).toEqual(['BOUND', 'REVOKED', 'AUTHORIZATION_OBSERVED']);
    expect((facts[2]!.snapshot as { providerStatus?: string }).providerStatus).toBe('REVOKED');
  });

  it('CHANGE A-2：REVOKED T2 之后迟到的旧 GRANTED T1 → 不得复活（仍耐久化）', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok && first.outcome).toBe('APPLIED');

    const second = await store.applyObservation(observation([event('GRANTED', T1)], NOW_1H));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('APPLIED');
    expect(second.derived.status).toBe('REVOKED');
    expect(await bindingStatus()).toBe('REVOKED');
    expect((await lineageFacts(seeded.bindingId)).map((row) => row.event)).toEqual([
      'BOUND',
      'REVOKED',
      'AUTHORIZATION_OBSERVED',
    ]);
  });

  it('CHANGE A-3：REVOKED T2 之后严格更晚的 GRANTED T3 → 恢复 ACTIVE（RESTORED）', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok && first.outcome).toBe('APPLIED');

    const second = await store.applyObservation(observation([event('GRANTED', T3)], NOW_1H));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('APPLIED');
    expect(second.derived.status).toBe('ACTIVE');
    expect(await bindingStatus()).toBe('ACTIVE');
    expect((await lineageFacts(seeded.bindingId)).map((row) => row.event)).toEqual([
      'BOUND',
      'REVOKED',
      'RESTORED',
    ]);
  });

  it('CHANGE A-4：EXPIRED 之后 REAUTH_REQUIRED → 仍 terminal（不可提交）', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const expired = await store.applyObservation(observation([event('EXPIRED', T1)], NOW_1H));
    expect(expired.ok).toBe(true);
    if (!expired.ok) throw new Error('unreachable');
    expect(expired.outcome).toBe('APPLIED');
    expect(expired.bindingStatus).toBe('REVOKED');
    const expiredFact = (await lineageFacts(seeded.bindingId)).at(-1)!;
    expect((expiredFact.snapshot as { providerStatus?: string }).providerStatus).toBe('EXPIRED');

    const reauth = await store.applyObservation(observation([event('REAUTH_REQUIRED', T3)], NOW_2H));
    expect(reauth.ok).toBe(true);
    if (!reauth.ok) throw new Error('unreachable');
    expect(reauth.outcome).toBe('APPLIED');
    expect(reauth.derived.status).toBe('EXPIRED');
    expect(await bindingStatus()).toBe('REVOKED');
    expect((await lineageFacts(seeded.bindingId)).map((row) => row.event)).toEqual([
      'BOUND',
      'REVOKED',
      'AUTHORIZATION_OBSERVED',
    ]);
  });

  it('CHANGE D-1：ACTIVE + RENEWED（含新 expiresAt）→ 闸门不变但观察必须耐久，且后续调用能读回', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const renewed = await store.applyObservation(
      observation([event('RENEWED', T2, { expiresAt: T5.toISOString() })], NOW),
    );
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) throw new Error('unreachable');
    expect(renewed.outcome).toBe('APPLIED');
    expect(renewed.bindingStatus).toBe('ACTIVE');
    expect(await bindingStatus()).toBe('ACTIVE');

    const facts = await lineageFacts(seeded.bindingId);
    expect(facts.map((row) => row.event)).toEqual(['BOUND', 'AUTHORIZATION_OBSERVED']);
    const snapshot = facts[1]!.snapshot as Record<string, unknown>;
    expect(snapshot.triggeringEventKind).toBe('RENEWED');
    expect(snapshot.expiresAt).toBe(T5.toISOString());
    expect((snapshot.observedEvents as unknown[]).length).toBe(1);

    // 后续调用必须能从 DB 历史读回这次 RENEWED（priorDerived 由历史折叠而来）。
    const second = await store.applyObservation(observation([event('SUSPENDED', T3)], NOW_1H));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.priorDerived.status).toBe('ACTIVE');
    expect(second.priorDerived.expiresAt).toBe(T5.toISOString());
  });

  it('CHANGE D-2：providerAuthorizationRef 变更（闸门不变）不得丢失', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const granted = await store.applyObservation(
      observation([event('GRANTED', T2, { providerAuthorizationRef: AUTH_REF_2 })], NOW),
    );
    expect(granted.ok && granted.outcome).toBe('APPLIED');
    const facts = await lineageFacts(seeded.bindingId);
    expect((facts[1]!.snapshot as { providerAuthorizationRef?: string }).providerAuthorizationRef).toBe(AUTH_REF_2);

    const second = await store.applyObservation(observation([event('SUSPENDED', T3)], NOW_1H));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.priorDerived.status).toBe('ACTIVE');
  });

  it('CHANGE D-3：一次调用携带多个事件 → 全部持久化（不能只留最后一条）', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const batch = await store.applyObservation(
      observation([event('RENEWED', T2, { expiresAt: T5.toISOString() }), event('GRANTED', T3)], NOW),
    );
    expect(batch.ok && batch.outcome).toBe('APPLIED');
    const snapshot = (await lineageFacts(seeded.bindingId))[1]!.snapshot as { observedEvents?: unknown[] };
    expect(snapshot.observedEvents?.length).toBe(2);

    const second = await store.applyObservation(observation([event('SUSPENDED', T4)], NOW_1H));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    // 两条历史事件都被读回参与折叠（只留 lastAppliedEvent 时这里会是 1）。
    expect(second.priorDerived.appliedEventCount).toBe(2);
  });

  it('CHANGE E：REPLAYED 必须返回与正常路径相同的 fold 真值（不得退回 incoming-only）', async () => {
    await seedActiveBinding();
    const store = lifecycleStore();
    const revoked = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(revoked.ok && revoked.outcome).toBe('APPLIED');

    // 迟到的旧 GRANTED：历史里已有 REVOKED，所以真实状态仍是 REVOKED（incoming-only 会算成 ACTIVE）。
    const stale = await store.applyObservation(observation([event('GRANTED', T1)], NOW_1H));
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error('unreachable');
    expect(stale.outcome).toBe('APPLIED');
    expect(stale.derived.status).toBe('REVOKED');

    const replay = await store.applyObservation(observation([event('GRANTED', T1)], NOW_1H));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error('unreachable');
    expect(replay.outcome).toBe('REPLAYED');
    expect(replay.derived.status).toBe('REVOKED');
    // CHANGE G：精确重放不重复 fold，derived/priorDerived 与 APPLIED 路径**全字段**一致（appliedEventCount 不增加）。
    expect(replay.derived).toEqual(stale.derived);
    expect(replay.derived.appliedEventCount).toBe(stale.derived.appliedEventCount);
    // priorDerived 的语义是「本次观察之前的状态」：该观察落库后它自然包含这条事实，故只断言终态一致。
    expect(replay.priorDerived.status).toBe('REVOKED');
  });

  it('CHANGE G-1：精确重放 → derived 全字段一致且 appliedEventCount 不增加', async () => {
    await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.derived.appliedEventCount).toBe(1);

    const replay = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error('unreachable');
    expect(replay.outcome).toBe('REPLAYED');
    expect(replay.derived).toEqual(first.derived);
    expect(replay.derived.appliedEventCount).toBe(1);
  });

  it('CHANGE G-2：同一 idempotency identity 但 payload 不同 → AUTHORIZATION_IDEMPOTENCY_CONFLICT + zero writes', async () => {
    const seeded = await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok && first.outcome).toBe('APPLIED');
    const factsAfterFirst = await lineageFacts(seeded.bindingId);

    // 同一 (kind, effectiveAt, observedAt, sourceRef)，但 reasonCode 不同 → 不是重放，是幂等冲突。
    const conflict = await store.applyObservation(
      observation([event('REVOKED', T2, { reasonCode: 'PROVIDER_REVOKED' })]),
    );
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error('unreachable');
    expect(conflict.reasonCode).toBe('AUTHORIZATION_IDEMPOTENCY_CONFLICT');
    expect(await bindingStatus()).toBe('REVOKED');
    expect((await lineageFacts(seeded.bindingId)).length).toBe(factsAfterFirst.length);
  });

  it('幂等：同一凭证重放 → REPLAYED，事实不重复追加', async () => {
    await seedActiveBinding();
    const store = lifecycleStore();
    const first = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(first.ok && first.outcome).toBe('APPLIED');
    const second = await store.applyObservation(observation([event('REVOKED', T2)]));
    expect(second.ok && second.outcome).toBe('REPLAYED');
    expect(
      await prisma.customsProviderTenantBindingLineage.count({ where: { event: 'REVOKED' as never } }),
    ).toBe(1);
  });

  it('并发：两个独立连接应用同一观察 → 一个 APPLIED、一个 REPLAYED，事实只有一条', async () => {
    await seedActiveBinding();
    const storeA = createPrismaProviderAuthorizationLifecycleStore(prisma);
    const storeB = createPrismaProviderAuthorizationLifecycleStore(prismaB);
    const [a, b] = await Promise.all([
      storeA.applyObservation(observation([event('REVOKED', T2)])),
      storeB.applyObservation(observation([event('REVOKED', T2)])),
    ]);
    expect(a.ok && b.ok).toBe(true);
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
