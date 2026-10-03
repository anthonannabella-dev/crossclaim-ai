/**
 * C17 ledger 真实 PostgreSQL 验收（MSG-20261003-124 ㊲）。
 * 断言：一 key 一根 / 并发一根 / 状态事实逐条追加 / SUBMITTED 必须带 providerSubmissionId /
 *       append-only / 跨租户 lineage 拒绝 / digest 形状 / timeout 不建第二根 / ambiguous 不重发 /
 *       24h → MANUAL_REVIEW / 不存凭据与原始 payload。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CUSTOMS_SUBMISSION_LEDGER_BOUNDARY,
  evaluateReconciliationSchedule,
  openCustomsSubmissionAttempt,
  recordCustomsSubmissionAttemptFact,
} from '../services/customs/customs-submission-ledger';
import { createPrismaCustomsSubmissionLedgerStore } from '../services/customs/customs-submission-ledger-prisma-store';

const prisma = new PrismaClient();
const prismaB = new PrismaClient();
const ORG = 'cc190000-0000-4000-8000-000000000001';
const ORG_B = 'cc190000-0000-4000-8000-000000000009';
const USER = 'cc190000-0000-4000-8000-000000000002';
const OPP = 'opp-c17-1';
const DIGEST = 'a'.repeat(64);
const NOW = new Date('2026-10-03T09:00:00.000Z');

function rootInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    opportunityId: OPP,
    caseId: null,
    claimItemId: null,
    packageId: 'pkg-c17-1',
    packageDigest: DIGEST,
    provider: 'broker-a',
    operation: 'FILING_CREATE',
    jurisdiction: 'US',
    remedyType: 'DRAWBACK',
    idempotencyKey: 'idem-1',
    ...overrides,
  } as never;
}

beforeAll(async () => {
  await prisma.$connect();
  await prismaB.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await prismaB.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "CustomsSubmissionAttemptFact", "CustomsSubmissionAttempt", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;');
  await prisma.organization.create({ data: { id: ORG, name: 'C17 租户', slug: 'c17-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'C17 租户B', slug: 'c17-org-b' } });
  await prisma.user.create({
    data: { id: USER, email: 'c17@example.com', passwordHash: 'x', displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
});

describe('C17 — customs submission ledger (PostgreSQL)', () => {
  it('同一 idempotencyKey 只建一根；重复 open → ROOT_EXISTING 且 id 相同', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const first = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    const second = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.status).toBe('ROOT_CREATED');
    expect(second.status).toBe('ROOT_EXISTING');
    expect(second.root.id).toBe(first.root.id);
    expect(await prisma.customsSubmissionAttempt.count()).toBe(1);
  });

  it('真实并发（两个独立连接）→ 只建一根', async () => {
    const storeA = createPrismaCustomsSubmissionLedgerStore(prisma);
    const storeB = createPrismaCustomsSubmissionLedgerStore(prismaB);
    const [a, b] = await Promise.all([
      openCustomsSubmissionAttempt(rootInput(), { store: storeA, now: () => NOW }),
      openCustomsSubmissionAttempt(rootInput(), { store: storeB, now: () => NOW }),
    ]);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect([a.status, b.status].sort()).toEqual(['ROOT_CREATED', 'ROOT_EXISTING']);
    expect(a.root.id).toBe(b.root.id);
    expect(await prisma.customsSubmissionAttempt.count()).toBe(1);
  });

  it('状态事实逐条追加：ATTEMPTED → UNKNOWN_PROVIDER_RESPONSE → RECONCILING → SUBMITTED', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const opened = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    if (!opened.ok) throw new Error('expected ok');
    const attemptId = opened.root.id;
    const steps = [
      { status: 'ATTEMPTED', providerSubmissionId: null, observedAt: '2026-10-03T08:00:00.000Z', source: 'MANUAL' },
      { status: 'UNKNOWN_PROVIDER_RESPONSE', providerSubmissionId: null, observedAt: '2026-10-03T08:01:00.000Z', source: 'PROVIDER_API' },
      { status: 'RECONCILING', providerSubmissionId: null, observedAt: '2026-10-03T08:06:00.000Z', source: 'PROVIDER_API' },
      { status: 'SUBMITTED', providerSubmissionId: 'PROV-1', observedAt: '2026-10-03T08:11:00.000Z', source: 'PROVIDER_API' },
    ] as const;
    for (const step of steps) {
      const outcome = await recordCustomsSubmissionAttemptFact(
        { organizationId: ORG, attemptId, verificationLevel: 'PROVIDER_VERIFIED', providerReference: 'REF-1', ...step },
        { store, now: () => NOW },
      );
      if (!outcome.ok) throw new Error('expected ok, got ' + outcome.reason);
      expect(outcome.status).toBe('FACT_RECORDED');
    }
    const facts = await store.listFacts(ORG, attemptId);
    expect(facts.map((f) => f.status)).toEqual(['ATTEMPTED', 'UNKNOWN_PROVIDER_RESPONSE', 'RECONCILING', 'SUBMITTED']);
    expect(facts[3].providerSubmissionId).toBe('PROV-1');
  });

  it('㊲ SUBMITTED 缺 providerSubmissionId → service 拒绝；DB 直写同样拒绝', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const opened = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    if (!opened.ok) throw new Error('expected ok');
    const rejected = await recordCustomsSubmissionAttemptFact(
      { organizationId: ORG, attemptId: opened.root.id, status: 'SUBMITTED', providerSubmissionId: null, source: 'PROVIDER_API', verificationLevel: 'PROVIDER_VERIFIED', observedAt: '2026-10-03T08:00:00.000Z' },
      { store, now: () => NOW },
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe('SUBMITTED_REQUIRES_PROVIDER_ID');
    await expect(
      prisma.$executeRawUnsafe(
        'INSERT INTO "CustomsSubmissionAttemptFact" ("id","organizationId","attemptId","status","source","verificationLevel","observedAt","recordedAt") VALUES ($1,$2,$3,$4,$5,$6,now(),now())',
        'raw-1', ORG, opened.root.id, 'SUBMITTED', 'PROVIDER_API', 'PROVIDER_VERIFIED',
      ),
    ).rejects.toThrow();
  });

  it('㊲ append-only：事实 UPDATE / DELETE 被 DB 拒绝', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const opened = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    if (!opened.ok) throw new Error('expected ok');
    await recordCustomsSubmissionAttemptFact(
      { organizationId: ORG, attemptId: opened.root.id, status: 'ATTEMPTED', providerSubmissionId: null, source: 'MANUAL', verificationLevel: 'UNVERIFIED', observedAt: '2026-10-03T08:00:00.000Z' },
      { store, now: () => NOW },
    );
    await expect(prisma.$executeRawUnsafe('UPDATE "CustomsSubmissionAttemptFact" SET "status" = \'FAILED_CONFIRMED\'')).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('DELETE FROM "CustomsSubmissionAttemptFact"')).rejects.toThrow();
    expect(await prisma.customsSubmissionAttemptFact.count()).toBe(1);
  });

  it('㊲ 跨租户 lineage：fact.organizationId 与 attempt 所属租户不一致 → DB 拒绝', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const opened = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    if (!opened.ok) throw new Error('expected ok');
    await expect(
      prisma.customsSubmissionAttemptFact.create({
        data: {
          id: 'cross-1',
          organizationId: ORG_B,
          attemptId: opened.root.id,
          status: 'ATTEMPTED',
          source: 'MANUAL',
          verificationLevel: 'UNVERIFIED',
          observedAt: NOW,
          recordedAt: NOW,
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.customsSubmissionAttemptFact.count()).toBe(0);
  });

  it('㊲ digest 形状：非法 digest → service 拒绝；DB 直写同样拒绝', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const bad = await openCustomsSubmissionAttempt(rootInput({ packageDigest: 'zzz' }), { store, now: () => NOW });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('INVALID_DIGEST');
    await expect(
      prisma.customsSubmissionAttempt.create({
        data: {
          id: 'raw-root-bad',
          organizationId: ORG,
          opportunityId: OPP,
          packageId: 'pkg',
          packageDigest: 'nothex',
          provider: 'broker-a',
          operation: 'FILING_CREATE',
          jurisdiction: 'US',
          remedyType: 'DRAWBACK',
          idempotencyKey: 'idem-bad',
        },
      }),
    ).rejects.toThrow();
  });

  it('㊲ timeout 不建第二根；ambiguous 后只对账不重发（根数恒为 1）', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const opened = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    if (!opened.ok) throw new Error('expected ok');
    // ambiguous provider response: 只追加事实，不新建 root
    await recordCustomsSubmissionAttemptFact(
      { organizationId: ORG, attemptId: opened.root.id, status: 'UNKNOWN_PROVIDER_RESPONSE', providerSubmissionId: null, source: 'PROVIDER_API', verificationLevel: 'UNVERIFIED', observedAt: '2026-10-03T08:00:00.000Z' },
      { store, now: () => NOW },
    );
    const retry = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    if (!retry.ok) throw new Error('expected ok');
    expect(retry.status).toBe('ROOT_EXISTING');
    expect(await prisma.customsSubmissionAttempt.count()).toBe(1);
    const schedule = evaluateReconciliationSchedule({
      lastAttemptAt: '2026-10-03T08:00:00.000Z',
      now: new Date('2026-10-03T08:30:00.000Z'),
      reconciliationAttempt: 0,
    });
    expect(schedule.disposition).toBe('RETRY_RECONCILE');
    expect(schedule.nextDelayMinutes).toBe(1);
  });

  it('㊲ 24h 未收敛 → MANUAL_REVIEW 事实（对账排程给出 MANUAL_REVIEW）', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const opened = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    if (!opened.ok) throw new Error('expected ok');
    const schedule = evaluateReconciliationSchedule({
      lastAttemptAt: '2026-10-02T08:00:00.000Z',
      now: new Date('2026-10-03T09:00:00.000Z'),
      reconciliationAttempt: 3,
    });
    expect(schedule.disposition).toBe('MANUAL_REVIEW');
    expect(schedule.nextDelayMinutes).toBeNull();
    const outcome = await recordCustomsSubmissionAttemptFact(
      { organizationId: ORG, attemptId: opened.root.id, status: 'MANUAL_REVIEW', providerSubmissionId: null, source: 'PROVIDER_API', verificationLevel: 'UNVERIFIED', observedAt: '2026-10-03T08:59:00.000Z', errorCode: 'UNRESOLVED_AFTER_24H' },
      { store, now: () => NOW },
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.fact.status).toBe('MANUAL_REVIEW');
  });

  it('㊲ 边界：账本不存 credential / raw payload / 资金字段，且不做外写', async () => {
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      'SELECT column_name FROM information_schema.columns WHERE table_name IN (\'CustomsSubmissionAttempt\', \'CustomsSubmissionAttemptFact\')',
    );
    const names = columns.map((c) => c.column_name);
    for (const forbidden of ['accessToken', 'credential', 'credentialRef', 'rawPayload', 'rawRequest', 'secret', 'successFee', 'actualRecovered']) {
      expect(names).not.toContain(forbidden);
    }
    expect(CUSTOMS_SUBMISSION_LEDGER_BOUNDARY.filingSubmitted).toBe(false);
    expect(CUSTOMS_SUBMISSION_LEDGER_BOUNDARY.externalWritePerformed).toBe(false);
    expect(CUSTOMS_SUBMISSION_LEDGER_BOUNDARY.storesCredential).toBe(false);
    expect(CUSTOMS_SUBMISSION_LEDGER_BOUNDARY.storesRawPayload).toBe(false);
    expect(CUSTOMS_SUBMISSION_LEDGER_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});
