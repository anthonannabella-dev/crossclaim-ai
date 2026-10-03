/** P0-1 — Return/Export/Destruction 事实 append-only 持久化：真实 PostgreSQL 验收。 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CustomsReturnMatchError, matchCustomsLinesToReturns, normalizeCustomsReturnFact } from '../services/customs/customs-return-matching';
import { createPrismaCustomsReturnFactStore } from '../services/customs/customs-return-fact-store';

const prisma = new PrismaClient();
const ORG = 'cc220000-0000-4000-8000-000000000001';
const ORG_B = 'cc220000-0000-4000-8000-000000000009';
const ACCOUNT = 'acct-p0-1';

function fact(overrides: Record<string, unknown> = {}) {
  return normalizeCustomsReturnFact({
    organizationId: ORG,
    platformAccountId: ACCOUNT,
    entryNumber: 'ABI-2026-000123',
    htsCode: '9901.00.10',
    sku: 'SKU-1',
    kind: 'RETURN',
    quantity: '100.00',
    currency: 'USD',
    jurisdiction: 'US',
    importerOfRecordRef: 'ior_1',
    source: 'BROKER_DOCUMENT',
    rawReference: 'ret:1',
    observedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as never);
}

const line = {
  organizationId: ORG,
  platformAccountId: ACCOUNT,
  lineOrdinal: 0,
  htsCode: '9901.00.10',
  sku: 'SKU-1',
  quantity: '100.00',
  currency: 'USD',
  jurisdiction: 'US',
};
const POLICY = { policyId: 'customs-return-2026', policyVersion: '1.0.0', requireHtsMatch: true, requireSkuMatchWhenPresent: true };

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CustomsReturnFactRecord", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'P0-1 租户', slug: 'p01-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'P0-1 租户B', slug: 'p01-org-b' } });
});

describe('P0-1 — customs return fact persistence (PostgreSQL)', () => {
  it('重复 ingest → exactly one fact；可读回并按 observedAt/id 确定性排序', async () => {
    const store = createPrismaCustomsReturnFactStore(prisma);
    const first = await store.recordReturnFact({ organizationId: ORG, fact: fact() });
    const second = await store.recordReturnFact({ organizationId: ORG, fact: fact() });
    expect(first.status).toBe('RECORDED');
    expect(second.status).toBe('ALREADY_RECORDED');
    expect(second.returnFactId).toBe(first.returnFactId);
    expect(await prisma.customsReturnFactRecord.count()).toBe(1);
    const listed = await store.listReturnFactsForEntry({ organizationId: ORG, entryNumber: 'ABI-2026-000123' });
    expect(listed).toHaveLength(1);
    expect(listed[0].quantity).toBe('100.000000');
  });

  it('digest 相同但 immutable payload 不同 → fail-closed', async () => {
    const store = createPrismaCustomsReturnFactStore(prisma);
    await store.recordReturnFact({ organizationId: ORG, fact: fact() });
    const tampered = { ...fact(), quantity: '999.000000', contentDigest: fact().contentDigest };
    await expect(store.recordReturnFact({ organizationId: ORG, fact: tampered })).rejects.toBeInstanceOf(CustomsReturnMatchError);
    expect(await prisma.customsReturnFactRecord.count()).toBe(1);
  });

  it('UPDATE / DELETE append-only fact → DB 触发器拒绝', async () => {
    const store = createPrismaCustomsReturnFactStore(prisma);
    const recorded = await store.recordReturnFact({ organizationId: ORG, fact: fact() });
    await expect(
      prisma.$executeRawUnsafe('UPDATE "CustomsReturnFactRecord" SET "htsCode" = \'X\' WHERE "id" = $1', recorded.returnFactId),
    ).rejects.toThrow(/CUSTOMS_RETURN_FACT_APPEND_ONLY/);
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM "CustomsReturnFactRecord" WHERE "id" = $1', recorded.returnFactId),
    ).rejects.toThrow(/CUSTOMS_RETURN_FACT_APPEND_ONLY/);
    expect(await prisma.customsReturnFactRecord.count()).toBe(1);
  });

  it('跨租户写入 / 跨租户读取 → 拒绝且不可见（tenant-scoped）', async () => {
    const store = createPrismaCustomsReturnFactStore(prisma);
    await store.recordReturnFact({ organizationId: ORG, fact: fact() });
    await expect(
      store.recordReturnFact({ organizationId: ORG, fact: fact({ organizationId: ORG_B }) }),
    ).rejects.toMatchObject({ code: 'CROSS_TENANT_LINEAGE' });
    const otherTenant = await store.listReturnFactsForEntry({ organizationId: ORG_B, entryNumber: 'ABI-2026-000123' });
    expect(otherTenant).toHaveLength(0);
  });

  it('持久化事实 → 匹配链端到端：EXACT 且 eligible quantity 正确；确定性重跑一致', async () => {
    const store = createPrismaCustomsReturnFactStore(prisma);
    await store.recordReturnFact({ organizationId: ORG, fact: fact() });
    const facts = await store.listReturnFactsForEntry({ organizationId: ORG, entryNumber: 'ABI-2026-000123' });
    const first = matchCustomsLinesToReturns({ entryLines: [line], returnFacts: facts, policy: POLICY });
    const second = matchCustomsLinesToReturns({ entryLines: [line], returnFacts: facts, policy: POLICY });
    expect(first.lines[0].status).toBe('EXACT');
    expect(first.lines[0].eligibleQuantity).toBe('100.000000');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.autoFiling).toBe(false);
  });
});
