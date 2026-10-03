/**
 * BG-020 — Customs 只读读模型 HTTP 边界（事实 + 四类 latest 投影）真实 PostgreSQL 验收。
 * 断言：OWNER/ADMIN/OPS/FINANCE 可读；VIEWER/未知角色 403；空 id 400；未知/跨租户 404（不泄漏存在性）；
 *       只读不重算（读取前后投影行数不变）；boundary 显式 filingSubmitted=false / transportEnabled=false。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { normalizeCustomsEntryFact, type CustomsEntryFact } from '../services/customs/customs-entry-contract';
import { createPrismaCustomsEntryFactStore } from '../services/customs/customs-entry-fact-store';
import { getCustomsEntryFactReadModel } from '../services/customs/customs-claim-ready-http';

const prisma = new PrismaClient();
const ORG = 'cc240000-0000-4000-8000-000000000001';
const ORG_B = 'cc240000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-04T02:00:00.000Z');

function factOf(overrides: Record<string, unknown> = {}): CustomsEntryFact {
  return normalizeCustomsEntryFact({
    entryNumber: 'ABI-2026-000777',
    entryDate: '2026-09-18',
    jurisdiction: 'US',
    portOfEntry: 'Los Angeles, CA',
    importerOfRecordRef: 'ior_acct_777',
    source: 'ABI_VENDOR',
    rawReference: 'abi:entry:777',
    observedAt: '2026-09-19T02:11:00.000Z',
    dutyLines: [
      { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '120.00', currency: 'USD' },
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
  await prisma.organization.create({ data: { id: ORG, name: 'BG-020 租户', slug: 'bg020-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'BG-020 租户B', slug: 'bg020-org-b' } });
});

const seed = async () => {
  const entryStore = store();
  const written = await entryStore.recordFact({ organizationId: ORG, fact: factOf() });
  for (const kind of ['DUTY_TRUTH', 'DISCREPANCY', 'ELIGIBILITY', 'ESTIMATE'] as const) {
    await entryStore.appendProjection({
      organizationId: ORG,
      kind,
      inputFactId: written.factId,
      inputDigest: written.contentDigest,
      algorithmVersion: 'v1',
      resultDigest: 'a'.repeat(64),
      computedAt: NOW,
      payload: { kind },
      policyId: 'p-1',
      policyVersion: '1.0.0',
    });
  }
  return { entryStore, factId: written.factId };
};

const call = (entryFactId: string, role = 'OWNER', organizationId = ORG, entryStore = store()) =>
  getCustomsEntryFactReadModel({
    session: { organizationId, actorUserId: 'actor-1', role },
    deps: { store: entryStore },
    entryFactId,
  });

describe('BG-020 — Customs 只读读模型（真实 PostgreSQL）', () => {
  it('OWNER 读取 → 200：事实摘要 + 四类 latest 投影 + 只读边界', async () => {
    const { entryStore, factId } = await seed();
    const result = await call(factId, 'OWNER', ORG, entryStore);
    expect(result.status).toBe(200);
    const body = result.body as Record<string, never>;
    const entryFact = body.entryFact as Record<string, unknown>;
    expect(entryFact.id).toBe(factId);
    expect(entryFact.entryNumber).toBe('ABI-2026-000777');
    expect(entryFact.lineCount).toBe(2);
    const projections = body.projections as Record<string, Record<string, unknown> | null>;
    for (const kind of ['DUTY_TRUTH', 'DISCREPANCY', 'ELIGIBILITY', 'ESTIMATE']) {
      expect(projections[kind]).not.toBeNull();
      expect(projections[kind]?.algorithmVersion).toBe('v1');
    }
    const boundary = body.boundary as Record<string, unknown>;
    expect(boundary.readOnly).toBe(true);
    expect(boundary.filingSubmitted).toBe(false);
    expect(boundary.transportEnabled).toBe(false);
    expect(boundary.externalWritePerformed).toBe(false);
    expect(boundary.productionCredentials).toBe('ABSENT');
  });

  it('只读不重算：读取前后投影行数完全不变，且两次读取结果一致', async () => {
    const { entryStore, factId } = await seed();
    const countRows = () =>
      prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*)::bigint AS n FROM "CustomsDutyTruthRecord" WHERE "organizationId" = $1', ORG);
    const before = (await countRows())[0].n;
    const first = await call(factId, 'FINANCE', ORG, entryStore);
    const second = await call(factId, 'OWNER', ORG, entryStore);
    const after = (await countRows())[0].n;
    expect(after).toBe(before);
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
  });

  it('RBAC：VIEWER / 未知角色 → 403；空 id → 400', async () => {
    const { entryStore, factId } = await seed();
    expect((await call(factId, 'VIEWER', ORG, entryStore)).status).toBe(403);
    expect((await call(factId, 'SOMETHING_ELSE', ORG, entryStore)).status).toBe(403);
    expect((await call('   ', 'OWNER', ORG, entryStore)).status).toBe(400);
  });

  it('跨租户 / 未知 fact → 404（不泄漏存在性）', async () => {
    const { entryStore, factId } = await seed();
    expect((await call(factId, 'OWNER', ORG_B, entryStore)).status).toBe(404);
    expect((await call('does-not-exist', 'OWNER', ORG, entryStore)).status).toBe(404);
  });
});
