/**
 * G8 — Customs C1–C5 append-only 持久化 **真实 PostgreSQL 验收**。
 * 断言：重复 ingest 只产生一份 immutable fact；digest 相同但 payload 不同 → fail closed；
 *       投影重算只追加历史；UPDATE/DELETE 被 DB 触发器拒绝；跨租户 lineage 被拒绝；
 *       latest 由 computedAt (+id) 确定性推导。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { normalizeCustomsEntryFact, type CustomsEntryFact } from '../services/customs/customs-entry-contract';
import {
  CUSTOMS_ENTRY_FACT_STORE_BOUNDARY,
  CustomsEntryFactStoreError,
  computeCustomsEntryContentDigest,
  createPrismaCustomsEntryFactStore,
} from '../services/customs/customs-entry-fact-store';

const prisma = new PrismaClient();
const ORG = 'cc200000-0000-4000-8000-000000000001';
const ORG_B = 'cc200000-0000-4000-8000-000000000009';
const NOW = new Date('2026-10-03T12:00:00.000Z');
const LATER = new Date('2026-10-03T12:30:00.000Z');

function factOf(amount = '120.00', overrides: Record<string, unknown> = {}): CustomsEntryFact {
  return normalizeCustomsEntryFact({
    entryNumber: 'ABI-2026-000123',
    entryDate: '2026-09-18',
    jurisdiction: 'US',
    portOfEntry: 'Los Angeles, CA',
    importerOfRecordRef: 'ior_acct_88213',
    source: 'ABI_VENDOR',
    rawReference: 'abi:entry:88213',
    observedAt: '2026-09-19T02:11:00.000Z',
    dutyLines: [
      { kind: 'DUTY', rawCode: 'DUTY-9901', amount, currency: 'USD' },
      { kind: 'TAX', rawCode: 'MPF', amount: '30.50', currency: 'USD' },
    ],
    ...overrides,
  });
}

const store = () => createPrismaCustomsEntryFactStore(prisma);

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CustomsDutyTruthRecord", "CustomsDiscrepancyRecord", "CustomsEligibilityRecord", "CustomsRecoveryEstimateRecord", "CustomsEntryDutyLineRecord", "CustomsEntryFactRecord", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'G8 租户', slug: 'g8-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'G8 租户B', slug: 'g8-org-b' } });
});

describe('G8 — customs entry fact store (PostgreSQL)', () => {
  it('重复 ingest → exactly one fact（且事件状态为 ALREADY_RECORDED，id 相同）', async () => {
    const s = store();
    const first = await s.recordFact({ organizationId: ORG, fact: factOf() });
    const second = await s.recordFact({ organizationId: ORG, fact: factOf() });
    expect(first.status).toBe('RECORDED');
    expect(second.status).toBe('ALREADY_RECORDED');
    expect(second.factId).toBe(first.factId);
    expect(await prisma.customsEntryFactRecord.count()).toBe(1);
    expect(await prisma.customsEntryDutyLineRecord.count()).toBe(2);
    const loaded = await s.loadFact({ organizationId: ORG, factId: first.factId });
    expect(loaded?.lines.map((line) => line.lineOrdinal)).toEqual([0, 1]);
    expect(loaded?.contentDigest).toBe(computeCustomsEntryContentDigest(factOf()));
  });

  it('digest 相同但 immutable payload 不同 → FACT_IMMUTABLE_MISMATCH（fail closed）', async () => {
    const constantDigest = createPrismaCustomsEntryFactStore(prisma, { computeDigest: () => 'f'.repeat(64) });
    await constantDigest.recordFact({ organizationId: ORG, fact: factOf('120.00') });
    await expect(constantDigest.recordFact({ organizationId: ORG, fact: factOf('999.00') })).rejects.toMatchObject({
      code: 'FACT_IMMUTABLE_MISMATCH',
    });
    expect(await prisma.customsEntryFactRecord.count()).toBe(1);
    const err = await constantDigest.recordFact({ organizationId: ORG, fact: factOf('1.00') }).catch((error) => error);
    expect(err).toBeInstanceOf(CustomsEntryFactStoreError);
  });

  it('投影重算只追加历史：旧记录仍在，latest 由 computedAt 推导', async () => {
    const s = store();
    const fact = await s.recordFact({ organizationId: ORG, fact: factOf() });
    const base = {
      organizationId: ORG,
      kind: 'ELIGIBILITY' as const,
      inputFactId: fact.factId,
      inputDigest: fact.contentDigest,
      algorithmVersion: 'g4-c4-v1',
      policyId: 'customs-us-2026',
      policyVersion: '1.0.0',
    };
    await s.appendProjection({ ...base, resultDigest: 'a'.repeat(64), computedAt: NOW, payload: { status: 'ELIGIBLE' } });
    await s.appendProjection({ ...base, resultDigest: 'b'.repeat(64), computedAt: LATER, payload: { status: 'NOT_ELIGIBLE' } });

    const history = await s.listProjections({ organizationId: ORG, inputFactId: fact.factId, kind: 'ELIGIBILITY' });
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.computedAt)).toEqual([LATER.toISOString(), NOW.toISOString()]);
    const latest = await s.loadLatestProjection({ organizationId: ORG, inputFactId: fact.factId, kind: 'ELIGIBILITY' });
    expect(latest?.computedAt).toBe(LATER.toISOString());
    expect((latest?.payload as { status: string }).status).toBe('NOT_ELIGIBLE');
    expect(latest?.policyId).toBe('customs-us-2026');
    expect(await prisma.customsEligibilityRecord.count()).toBe(2);
  });

  it('同一输入重复 append 投影 → 幂等（ALREADY_APPENDED，不产生第二行）', async () => {
    const s = store();
    const fact = await s.recordFact({ organizationId: ORG, fact: factOf() });
    const input = {
      organizationId: ORG,
      kind: 'DUTY_TRUTH' as const,
      inputFactId: fact.factId,
      inputDigest: fact.contentDigest,
      algorithmVersion: 'g4-c2-v1',
      resultDigest: 'c'.repeat(64),
      computedAt: NOW,
      payload: { totalByCurrency: { USD: '150.50' } },
    };
    expect((await s.appendProjection(input)).status).toBe('APPENDED');
    expect((await s.appendProjection(input)).status).toBe('ALREADY_APPENDED');
    expect(await prisma.customsDutyTruthRecord.count()).toBe(1);
  });

  it('UPDATE / DELETE immutable fact 与 projection → DB 触发器拒绝', async () => {
    const s = store();
    const fact = await s.recordFact({ organizationId: ORG, fact: factOf() });
    await s.appendProjection({
      organizationId: ORG,
      kind: 'ESTIMATE',
      inputFactId: fact.factId,
      inputDigest: fact.contentDigest,
      algorithmVersion: 'g4-c5-v1',
      resultDigest: 'd'.repeat(64),
      computedAt: NOW,
      payload: { status: 'ESTIMATED' },
      policyId: 'customs-estimate-2026',
      policyVersion: '1.0.0',
    });
    const projectionId = (
      await prisma.customsRecoveryEstimateRecord.findFirstOrThrow({ where: { organizationId: ORG } })
    ).id;

    await expect(
      prisma.$executeRawUnsafe('UPDATE "CustomsEntryFactRecord" SET "entryNumber" = \'X\' WHERE "id" = $1', fact.factId),
    ).rejects.toThrow(/CUSTOMS_ENTRY_FACT_APPEND_ONLY/);
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM "CustomsEntryFactRecord" WHERE "id" = $1', fact.factId),
    ).rejects.toThrow(/CUSTOMS_ENTRY_FACT_APPEND_ONLY/);
    await expect(
      prisma.$executeRawUnsafe('UPDATE "CustomsRecoveryEstimateRecord" SET "algorithmVersion" = \'x\' WHERE "id" = $1', projectionId),
    ).rejects.toThrow(/CUSTOMS_PROJECTION_APPEND_ONLY/);
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM "CustomsRecoveryEstimateRecord" WHERE "id" = $1', projectionId),
    ).rejects.toThrow(/CUSTOMS_PROJECTION_APPEND_ONLY/);
    expect(await prisma.customsEntryFactRecord.count()).toBe(1);
    expect(await prisma.customsRecoveryEstimateRecord.count()).toBe(1);
  });

  it('跨租户 lineage → DB 触发器拒绝（B 租户不得引用 A 租户 fact）', async () => {
    const s = store();
    const fact = await s.recordFact({ organizationId: ORG, fact: factOf() });
    await expect(
      s.appendProjection({
        organizationId: ORG_B,
        kind: 'DUTY_TRUTH',
        inputFactId: fact.factId,
        inputDigest: fact.contentDigest,
        algorithmVersion: 'g4-c2-v1',
        resultDigest: 'e'.repeat(64),
        computedAt: NOW,
        payload: {},
      }),
    ).rejects.toThrow();
    expect(await prisma.customsDutyTruthRecord.count()).toBe(0);
  });

  it('非只读事实 / 空 organizationId → fail closed；边界常量声明只追加', async () => {
    const s = store();
    await expect(s.recordFact({ organizationId: ORG, fact: { ...factOf(), readOnly: false } as unknown as CustomsEntryFact })).rejects.toMatchObject(
      { code: 'NOT_A_READ_ONLY_FACT' },
    );
    await expect(s.recordFact({ organizationId: '  ', fact: factOf() })).rejects.toMatchObject({ code: 'INVALID_FACT_INPUT' });
    expect(CUSTOMS_ENTRY_FACT_STORE_BOUNDARY.appendOnly).toBe(true);
    expect(CUSTOMS_ENTRY_FACT_STORE_BOUNDARY.crossTenantRejectedByDb).toBe(true);
    expect(CUSTOMS_ENTRY_FACT_STORE_BOUNDARY.externalWritePerformed).toBe(false);
    expect(CUSTOMS_ENTRY_FACT_STORE_BOUNDARY.credentials).toBe('ABSENT');
  });
});
