/** P0-1 收尾 — Return→matching→evidence→qualification→claim-ready evidence：真实 PostgreSQL E2E。 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { normalizeCustomsEntryFact } from '../services/customs/customs-entry-contract';
import { createPrismaCustomsEntryFactStore } from '../services/customs/customs-entry-fact-store';
import { normalizeCustomsReturnFact } from '../services/customs/customs-return-matching';
import { createPrismaCustomsReturnFactStore } from '../services/customs/customs-return-fact-store';
import {
  createPrismaReturnClaimEvidenceWriter,
  postReturnClaimEvidence,
  runReturnClaimEvidence,
} from '../services/customs/customs-return-claim-evidence';
import { evaluateCustomerQualification } from '../services/commercial/customer-qualification-gate';

const prisma = new PrismaClient();
const ORG = 'cc240000-0000-4000-8000-000000000001';
const ORG_B = 'cc240000-0000-4000-8000-000000000009';
const ACCOUNT = 'acct-e2e';
const ENTRY = 'ABI-2026-000900';

const MATCH_POLICY = { policyId: 'customs-return-2026', policyVersion: '1.0.0', requireHtsMatch: true, requireSkuMatchWhenPresent: true };
const ECON_POLICY = {
  policyId: 'recovery-economics-2026',
  policyVersion: '1.0.0',
  currency: 'USD',
  minimumRecoveryThreshold: '10.00',
  highValueThreshold: '100000.00',
  maxCostRatio: '0.50',
  minimumDataCompleteness: '0.80',
};

const readiness = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  platformAccountId: ACCOUNT,
  verifiedDataAvailable: true,
  importHistoryAvailable: true,
  returnExportDestructionEvidenceAvailable: true,
  lineageCompleteness: 'COMPLETE' as const,
  dataCompletenessScore: '0.95',
  riskLevel: 'LOW' as const,
  checkedAt: '2026-10-03T13:00:00.000Z',
  ...overrides,
});

const qualification = (overrides: Record<string, unknown> = {}) =>
  evaluateCustomerQualification({
    readiness: readiness(),
    estimatedRecoveryAmount: '100.00',
    estimatedExternalApiCost: '5.00',
    estimatedBrokerCost: '5.00',
    policy: ECON_POLICY,
    computedAt: '2026-10-03T13:05:00.000Z',
    ...overrides,
  } as never);

function entryFact() {
  return normalizeCustomsEntryFact({
    entryNumber: ENTRY,
    entryDate: '2026-09-18',
    jurisdiction: 'US',
    portOfEntry: 'Los Angeles, CA',
    importerOfRecordRef: 'ior_9',
    source: 'ABI_VENDOR',
    rawReference: 'abi:entry:900',
    observedAt: '2026-09-19T02:11:00.000Z',
    dutyLines: [{ kind: 'DUTY', rawCode: 'DUTY-9901', amount: '200.00', currency: 'USD' }],
  });
}

function returnFact(overrides: Record<string, unknown> = {}) {
  return normalizeCustomsReturnFact({
    organizationId: ORG,
    platformAccountId: ACCOUNT,
    entryNumber: ENTRY,
    htsCode: '9901.00.10',
    sku: 'SKU-9',
    kind: 'RETURN',
    quantity: '10.00',
    currency: 'USD',
    jurisdiction: 'US',
    importerOfRecordRef: 'ior_9',
    source: 'BROKER_DOCUMENT',
    rawReference: 'ret:9',
    observedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as never);
}

const line = {
  organizationId: ORG,
  platformAccountId: ACCOUNT,
  lineOrdinal: 0,
  htsCode: '9901.00.10',
  sku: 'SKU-9',
  quantity: '10.00',
  currency: 'USD',
  jurisdiction: 'US',
  dutyAmount: '200.00',
};

async function run(overrides: Record<string, unknown> = {}) {
  const entryStore = createPrismaCustomsEntryFactStore(prisma);
  const returnStore = createPrismaCustomsReturnFactStore(prisma);
  const recorded = await entryStore.recordFact({ organizationId: ORG, fact: entryFact() });
  return runReturnClaimEvidence({
    entryFactStore: entryStore,
    returnFactStore: returnStore,
    writer: createPrismaReturnClaimEvidenceWriter(prisma),
    organizationId: ORG,
    entryFactId: recorded.factId,
    entryNumber: ENTRY,
    entryLines: [line],
    matchPolicy: MATCH_POLICY,
    qualification: qualification(),
    algorithmVersion: 'p0-1-e2e-v1',
    computedAt: '2026-10-03T13:10:00.000Z',
    ...overrides,
  } as never);
}

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CustomsReturnClaimEvidenceRecord", "CustomsReturnFactRecord", "CustomsEntryDutyLineRecord", "CustomsEntryFactRecord", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'P0-1 E2E 租户', slug: 'p01e2e' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'P0-1 E2E 租户B', slug: 'p01e2e-b' } });
});

describe('P0-1 E2E — return claim evidence (PostgreSQL)', () => {
  it('合格 + EXACT 匹配 → READY，confirmed amount 仅按已匹配部分（10×200/10=200）', async () => {
    await createPrismaCustomsReturnFactStore(prisma).recordReturnFact({ organizationId: ORG, fact: returnFact() });
    const result = await run();
    expect(result.status).toBe('READY');
    expect(result.confirmedRecoverableAmountByCurrency).toEqual({ USD: '200.000000' });
    expect(result.eligibleQuantityByLine[0].status).toBe('EXACT');
    const persisted = await createPrismaReturnClaimEvidenceWriter(prisma).latest({ organizationId: ORG, entryFactId: result.evidenceId ? (await latestEntryFactId()) : '' });
    expect(persisted?.status).toBe('READY');
  });

  it('PARTIAL 匹配 → 只按匹配部分计入（4×200/10=80），不放大', async () => {
    await createPrismaCustomsReturnFactStore(prisma).recordReturnFact({ organizationId: ORG, fact: returnFact({ quantity: '4.00' }) });
    const result = await run();
    expect(result.status).toBe('READY');
    expect(result.confirmedRecoverableAmountByCurrency).toEqual({ USD: '80.000000' });
    expect(result.eligibleQuantityByLine[0].status).toBe('PARTIAL');
  });

  it('AMBIGUOUS / NO_MATCH → NOT_READY 且 confirmed amount = 0（不得进入 claim-ready）', async () => {
    const store = createPrismaCustomsReturnFactStore(prisma);
    await store.recordReturnFact({ organizationId: ORG, fact: returnFact({ quantity: '10.00', rawReference: 'ret:9a' }) });
    await store.recordReturnFact({ organizationId: ORG, fact: returnFact({ quantity: '3.00', rawReference: 'ret:9b' }) });
    const ambiguous = await run();
    expect(ambiguous.status).toBe('NOT_READY');
    expect(ambiguous.confirmedRecoverableAmountByCurrency).toEqual({});
    expect(ambiguous.status_reasons.join(',')).toContain('AMBIGUOUS');
  });

  it('tapered digest / 事实被篡改 → RECONCILIATION_REQUIRED 且零计入', async () => {
    await createPrismaCustomsReturnFactStore(prisma).recordReturnFact({ organizationId: ORG, fact: returnFact() });
    await prisma.$executeRawUnsafe('ALTER TABLE "CustomsReturnFactRecord" DISABLE TRIGGER "cc_append_only__CustomsReturnFactRecord"');
    await prisma.$executeRawUnsafe('UPDATE "CustomsReturnFactRecord" SET "quantity" = 999 WHERE "entryNumber" = $1', ENTRY);
    await prisma.$executeRawUnsafe('ALTER TABLE "CustomsReturnFactRecord" ENABLE TRIGGER "cc_append_only__CustomsReturnFactRecord"');
    const result = await run();
    expect(result.status).toBe('RECONCILIATION_REQUIRED');
    expect(result.confirmedRecoverableAmountByCurrency).toEqual({});
    expect(result.status_reasons).toContain('DIGEST_MISMATCH_RECONCILIATION_REQUIRED');
  });

  it('qualification 未通过 → NOT_READY（后端强制 Gate；HTTP 409）', async () => {
    await createPrismaCustomsReturnFactStore(prisma).recordReturnFact({ organizationId: ORG, fact: returnFact() });
    const notQualified = qualification({ readiness: readiness({ returnExportDestructionEvidenceAvailable: false }) });
    const result = await run({ qualification: notQualified });
    expect(result.status).toBe('NOT_READY');
    expect(result.status_reasons).toContain('QUALIFICATION_INDETERMINATE');
    const http = await postReturnClaimEvidence({
      session: { organizationId: ORG, actorUserId: 'u1', role: 'OWNER' },
      run: async () => result,
    });
    expect(http.status).toBe(409);
    expect((http.body.boundary as Record<string, unknown>).filingSubmitted).toBe(false);
  });

  it('前端绕过（VIEWER 直接调用）→ 403；READY 情况 → 200', async () => {
    await createPrismaCustomsReturnFactStore(prisma).recordReturnFact({ organizationId: ORG, fact: returnFact() });
    const ready = await run();
    expect((await postReturnClaimEvidence({ session: { organizationId: ORG, actorUserId: 'u1', role: 'VIEWER' }, run: async () => ready })).status).toBe(403);
    expect((await postReturnClaimEvidence({ session: { organizationId: ORG, actorUserId: 'u1', role: 'OWNER' }, run: async () => ready })).status).toBe(200);
  });

  it('policyVersion 变化 → 新 assessment 生效（latest 判定为准）', async () => {
    await createPrismaCustomsReturnFactStore(prisma).recordReturnFact({ organizationId: ORG, fact: returnFact() });
    const first = await run();
    const second = await run({
      matchPolicy: { ...MATCH_POLICY, policyVersion: '1.1.0' },
      computedAt: '2026-10-03T13:40:00.000Z',
    });
    expect(first.evidenceId).not.toBe(second.evidenceId);
    const entryFactId = (await latestEntryFactId());
    const latest = await createPrismaReturnClaimEvidenceWriter(prisma).latest({ organizationId: ORG, entryFactId });
    expect((latest?.policyVersion as string)).toBe('1.1.0');
  });

  it('跨租户：B 租户读不到 A 的证据（tenant-scoped）', async () => {
    await createPrismaCustomsReturnFactStore(prisma).recordReturnFact({ organizationId: ORG, fact: returnFact() });
    const result = await run();
    const entryFactId = await latestEntryFactId();
    const other = await createPrismaReturnClaimEvidenceWriter(prisma).latest({ organizationId: ORG_B, entryFactId });
    expect(other).toBeNull();
    expect(result.status).toBe('READY');
  });
});

async function latestEntryFactId(): Promise<string> {
  const row = await prisma.customsEntryFactRecord.findFirstOrThrow({ where: { organizationId: ORG } });
  return row.id;
}
