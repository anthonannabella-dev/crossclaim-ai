/**
 * MSG-20261002-68 CHANGE B —— Settlement 端到端 account lineage 永久验收（真实 PostgreSQL）。
 * 证明：
 *  1. account-scoped evidence + claim → Settlement 可唯一反查同一 PlatformAccount（provenance 不在 Settlement 层丢失）；
 *  2. Account A 的 Evidence 不能绑定/生成 Account B 的 Settlement lineage（reject）；
 *  3. legacy（两端 accountId 均为 NULL）仍可读且**不会被解释为任意 account**（lineage 结果为 null，不伪造）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();
const uuid = (): string => randomUUID();

let ORG = '';
let ACCOUNT_A = '';
let ACCOUNT_B = '';

/** 服务端 lineage 反查：Settlement → ClaimItem/Evidence → 唯一 PlatformAccount（不得猜测）。 */
async function settlementLineageAccount(settlementId: string): Promise<string | null> {
  const settlement = await prisma.settlement.findFirstOrThrow({
    where: { organizationId: ORG, id: settlementId },
    select: { claimItem: { select: { accountId: true } }, evidence: { select: { accountId: true } } },
  });
  const accounts = new Set(
    [settlement.claimItem?.accountId ?? null, settlement.evidence?.accountId ?? null].filter(
      (value): value is string => value !== null,
    ),
  );
  if (accounts.size === 0) return null;
  if (accounts.size > 1) throw new Error('AMBIGUOUS_SETTLEMENT_LINEAGE');
  return [...accounts][0];
}

async function seedEvidence(accountId: string | null): Promise<string> {
  const created = await prisma.evidenceArtifact.create({
    data: { organizationId: ORG, accountId, kind: 'OTHER', title: 'e ' + uuid().slice(0, 6) },
    select: { id: true },
  });
  return created.id;
}

async function seedClaim(accountId: string | null): Promise<string> {
  const created = await prisma.claimItem.create({
    data: {
      organizationId: ORG,
      accountId,
      platformType: 'AMAZON',
      claimType: 'LOST_INVENTORY',
      platformRef: 'REF-' + uuid().slice(0, 8),
      occurredAt: new Date('2026-09-08T00:00:00.000Z'),
      normalizerVersion: 'v1',
    },
    select: { id: true },
  });
  return created.id;
}

async function seedSettlement(claimItemId: string, evidenceId: string): Promise<string> {
  const created = await prisma.settlement.create({
    data: {
      organizationId: ORG,
      source: 'PLATFORM_CREDIT',
      amount: '120.0000',
      currency: 'USD',
      claimItemId,
      evidenceId,
    },
    select: { id: true },
  });
  return created.id;
}

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Settlement", "ClaimItem", "EvidenceArtifact", "PlatformAccount", "Organization" CASCADE;',
  );
  ORG = uuid();
  await prisma.organization.create({
    data: { id: ORG, name: 'Change B', slug: 'change-b-' + uuid().slice(0, 8) },
  });
  ACCOUNT_A = (
    await prisma.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: 'AMAZON',
        externalAccountId: 'SELLER-A',
        displayName: 'A',
      },
    })
  ).id;
  ACCOUNT_B = (
    await prisma.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: 'AMAZON',
        externalAccountId: 'SELLER-B',
        displayName: 'B',
      },
    })
  ).id;
});

describe('MSG-20261002-68 CHANGE B —— Settlement 端到端 account lineage', () => {
  it('account-scoped evidence + claim → Settlement 唯一反查同一 account', async () => {
    const evidence = await seedEvidence(ACCOUNT_A);
    const claim = await seedClaim(ACCOUNT_A);
    const settlement = await seedSettlement(claim, evidence);
    await expect(settlementLineageAccount(settlement)).resolves.toBe(ACCOUNT_A);
  });

  it('Account A 的 Evidence 不能绑定 Account B 的 Settlement lineage → DB 拒绝', async () => {
    const evidenceB = await seedEvidence(ACCOUNT_B);
    const claimA = await seedClaim(ACCOUNT_A);
    await expect(seedSettlement(claimA, evidenceB)).rejects.toThrow(
      /CROSS_ACCOUNT_SETTLEMENT_LINKAGE|check constraint|P2004/i,
    );
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('legacy（两端 accountId 均为 NULL）仍可读，且 lineage 不被解释为任意 account', async () => {
    const legacyEvidence = await seedEvidence(null);
    const legacyClaim = await seedClaim(null);
    const settlement = await seedSettlement(legacyClaim, legacyEvidence);
    await expect(settlementLineageAccount(settlement)).resolves.toBeNull();
  });
});
