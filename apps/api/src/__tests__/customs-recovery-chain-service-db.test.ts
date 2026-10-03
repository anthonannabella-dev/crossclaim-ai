/**
 * G11 — Customs 恢复链服务层（真实 PostgreSQL）：从持久化事实重算 C1→C6 并 append 计算投影。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { normalizeCustomsEntryFact, type CustomsEntryFact } from '../services/customs/customs-entry-contract';
import { createPrismaCustomsEntryFactStore } from '../services/customs/customs-entry-fact-store';
import {
  CustomsChainServiceError,
  runCustomsRecoveryChain,
} from '../services/customs/customs-recovery-chain-service';

const prisma = new PrismaClient();
const ORG = 'cc210000-0000-4000-8000-000000000001';
const ORG_B = 'cc210000-0000-4000-8000-000000000009';
const NOW = new Date('2026-10-03T12:40:00.000Z');
const LATER = new Date('2026-10-03T12:55:00.000Z');

function fact(amount: string): CustomsEntryFact {
  return normalizeCustomsEntryFact({
    entryNumber: 'ABI-2026-000777',
    entryDate: '2026-09-18',
    jurisdiction: 'US',
    portOfEntry: 'Los Angeles, CA',
    importerOfRecordRef: 'ior_acct_777',
    source: 'ABI_VENDOR',
    rawReference: 'abi:entry:777',
    observedAt: '2026-09-19T02:11:00.000Z',
    dutyLines: [{ kind: 'DUTY', rawCode: 'DUTY-9901', amount, currency: 'USD' }],
  });
}

const EXPECTATIONS = [
  {
    lineRawCode: 'DUTY-9901',
    htsCode: '9901.00.10',
    expectedKind: 'DUTY' as const,
    expectedAmount: '100.00',
    currency: 'USD',
    source: 'RATE_TABLE' as const,
    reference: 'rate-table:2026-Q3',
  },
];
const POLICIES = {
  eligibility: {
    policyId: 'customs-us-2026',
    policyVersion: '1.0.0',
    jurisdiction: 'US',
    allowedSources: ['ABI_VENDOR'] as const,
    maxEntryAgeDays: 365,
    requiredDiscrepancyCodes: ['AMOUNT_MISMATCH'] as const,
    minDisputedAmountByCurrency: { USD: '10.00' },
    allowOtherKindLines: true,
  },
  estimate: {
    policyId: 'customs-estimate-2026',
    policyVersion: '1.0.0',
    ratioByCurrency: { USD: '1.00' },
    capByCurrency: { USD: '10000.00' },
    minEstimateByCurrency: { USD: '1.00' },
  },
};
const EVIDENCE = [{ kind: 'ENTRY_DOCUMENT' as const, reference: 'abi:entry:777', digest: null }];

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
  await prisma.organization.create({ data: { id: ORG, name: 'G11 租户', slug: 'g11-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'G11 租户B', slug: 'g11-org-b' } });
});

describe('G11 — customs recovery chain service (PostgreSQL)', () => {
  it('从持久化事实重算：READY package + 四类投影各 append 一条', async () => {
    const store = createPrismaCustomsEntryFactStore(prisma);
    const recorded = await store.recordFact({ organizationId: ORG, fact: fact('120.00') });
    const run = await runCustomsRecoveryChain({
      store,
      organizationId: ORG,
      factId: recorded.factId,
      expectations: EXPECTATIONS,
      policies: POLICIES,
      evidenceReferences: EVIDENCE,
      algorithmVersion: 'g11-v1',
      computedAt: NOW,
    });
    expect(run.package.readiness).toBe('READY');
    expect(run.package.eligibility.overpaymentCandidateByCurrency).toEqual({ USD: '20.00' });
    expect(run.package.estimate.byCurrency).toEqual([{ currency: 'USD', estimatedAmount: '20.00' }]);
    expect(run.projections.map((row) => row.kind)).toEqual(['DUTY_TRUTH', 'DISCREPANCY', 'ELIGIBILITY', 'ESTIMATE']);
    expect(run.projections.every((row) => row.status === 'APPENDED')).toBe(true);
    expect(await prisma.customsDutyTruthRecord.count()).toBe(1);
    expect(await prisma.customsRecoveryEstimateRecord.count()).toBe(1);
    const latest = await store.loadLatestProjection({ organizationId: ORG, inputFactId: recorded.factId, kind: 'ELIGIBILITY' });
    expect(latest?.computedAt).toBe(NOW.toISOString());
  });

  it('重算（更晚 computedAt）→ 追加历史，旧投影仍在，latest 指向新记录', async () => {
    const store = createPrismaCustomsEntryFactStore(prisma);
    const recorded = await store.recordFact({ organizationId: ORG, fact: fact('120.00') });
    const base = {
      store,
      organizationId: ORG,
      factId: recorded.factId,
      expectations: EXPECTATIONS,
      policies: POLICIES,
      evidenceReferences: EVIDENCE,
      algorithmVersion: 'g11-v1',
    };
    await runCustomsRecoveryChain({ ...base, computedAt: NOW });
    const second = await runCustomsRecoveryChain({ ...base, algorithmVersion: 'g11-v2', computedAt: LATER });
    expect(second.package.readiness).toBe('READY');
    expect(await prisma.customsEligibilityRecord.count()).toBe(2);
    const history = await store.listProjections({ organizationId: ORG, inputFactId: recorded.factId, kind: 'ELIGIBILITY' });
    expect(history).toHaveLength(2);
    expect(history[0].computedAt).toBe(LATER.toISOString());
    expect(history[0].algorithmVersion).toBe('g11-v2');
    expect(history[1].algorithmVersion).toBe('g11-v1');
  });

  it('少缴方向 → package NOT_READY 且估算为空（方向语义在服务层保持一致）', async () => {
    const store = createPrismaCustomsEntryFactStore(prisma);
    const recorded = await store.recordFact({ organizationId: ORG, fact: fact('80.00') });
    const run = await runCustomsRecoveryChain({
      store,
      organizationId: ORG,
      factId: recorded.factId,
      expectations: EXPECTATIONS,
      policies: POLICIES,
      evidenceReferences: EVIDENCE,
      algorithmVersion: 'g11-v1',
      computedAt: NOW,
    });
    expect(run.package.readiness).toBe('NOT_READY');
    expect(run.package.estimate.byCurrency).toEqual([]);
    expect(run.package.gaps).toContain('ELIGIBILITY_NOT_ELIGIBLE');
  });

  it('事实不存在 / 跨租户 → FACT_NOT_FOUND（不泄漏存在性）', async () => {
    const store = createPrismaCustomsEntryFactStore(prisma);
    const recorded = await store.recordFact({ organizationId: ORG, fact: fact('120.00') });
    const run = (organizationId: string) =>
      runCustomsRecoveryChain({
        store,
        organizationId,
        factId: recorded.factId,
        expectations: EXPECTATIONS,
        policies: POLICIES,
        evidenceReferences: EVIDENCE,
        algorithmVersion: 'g11-v1',
        computedAt: NOW,
      });
    await expect(run(ORG_B)).rejects.toBeInstanceOf(CustomsChainServiceError);
    await expect(run(ORG_B)).rejects.toMatchObject({ code: 'FACT_NOT_FOUND' });
    await expect(
      runCustomsRecoveryChain({
        store,
        organizationId: ORG,
        factId: 'no-such-fact',
        expectations: EXPECTATIONS,
        policies: POLICIES,
        evidenceReferences: EVIDENCE,
        algorithmVersion: 'g11-v1',
        computedAt: NOW,
      }),
    ).rejects.toMatchObject({ code: 'FACT_NOT_FOUND' });
  });
});
