/**
 * TRACK C2 slice 2b —— 跨账户一致性守卫（account scope 下推之后的 correctness boundary）。
 *   - ClaimItem.accountId 必须与其 RecoveryOpportunity.accountId 一致；
 *   - ClaimItemEvidence 两端 account 必须一致（cross-account evidence binding → reject）；
 *   - Settlement 的 claimItem 与 evidence 必须同 account（cross-account settlement linkage → reject）；
 *   - 证据 port 从连接上下文服务端派生 accountId。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaEvidencePromotionPorts } from '../services/evidence/prisma-ports';

const prisma = new PrismaClient();
const ports = createPrismaEvidencePromotionPorts(prisma);
const uuid = (): string => randomUUID();

let ORG = '';
let ACCOUNT_A = '';
let ACCOUNT_B = '';

async function dbError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as Error).message ?? error);
  }
  throw new Error('EXPECTED_DB_ERROR_BUT_SUCCEEDED');
}

async function seedOpportunity(accountId: string | null): Promise<string> {
  const created = await prisma.recoveryOpportunity.create({
    data: {
      organizationId: ORG,
      accountId,
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      opportunityType: 'LOST_INVENTORY',
      title: 'op ' + uuid().slice(0, 6),
      currency: 'USD',
    },
    select: { id: true },
  });
  return created.id;
}

async function seedClaimItem(accountId: string | null, opportunityId: string | null): Promise<string> {
  const created = await prisma.claimItem.create({
    data: {
      organizationId: ORG,
      accountId,
      opportunityId,
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

async function seedEvidence(accountId: string | null): Promise<string> {
  const created = await prisma.evidenceArtifact.create({
    data: { organizationId: ORG, accountId, kind: 'OTHER', title: 'e ' + uuid().slice(0, 6) },
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
    'TRUNCATE TABLE "AuditLog", "ClaimItemEvidence", "Settlement", "ClaimItem", "RecoveryOpportunity", "EvidenceArtifact", "CaseEvidence", "Case", "SourceConnection", "PlatformAccount", "Organization" CASCADE;',
  );
  ORG = uuid();
  await prisma.organization.create({
    data: { id: ORG, name: 'C2 cross-account', slug: 'c2-xacct-' + uuid().slice(0, 8) },
  });
  ACCOUNT_A = (
    await prisma.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: 'AMAZON',
        externalAccountId: 'SELLER-A',
        displayName: 'Store A',
      },
    })
  ).id;
  ACCOUNT_B = (
    await prisma.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: 'AMAZON',
        externalAccountId: 'SELLER-B',
        displayName: 'Store B',
      },
    })
  ).id;
});

describe('TRACK C2 slice 2b —— 跨账户一致性守卫', () => {
  it('ClaimItem.accountId 与 opportunity.accountId 不一致 → DB 拒绝；一致 → 允许', async () => {
    const opportunity = await seedOpportunity(ACCOUNT_A);

    const message = await dbError(seedClaimItem(ACCOUNT_B, opportunity));
    expect(message).toMatch(/CROSS_ACCOUNT_CLAIM_ITEM|P2004|check constraint/i);
    expect(
      await prisma.claimItem.count({ where: { organizationId: ORG, accountId: ACCOUNT_B } }),
    ).toBe(0);

    const claim = await seedClaimItem(ACCOUNT_A, opportunity);
    const created = await prisma.claimItem.findFirstOrThrow({ where: { id: claim } });
    expect(created.accountId).toBe(ACCOUNT_A);
  });

  it('cross-account evidence binding（ClaimItemEvidence）→ DB 拒绝；同账户 → 允许', async () => {
    const opportunity = await seedOpportunity(ACCOUNT_A);
    const claim = await seedClaimItem(ACCOUNT_A, opportunity);
    const foreignEvidence = await seedEvidence(ACCOUNT_B);
    const ownEvidence = await seedEvidence(ACCOUNT_A);

    const message = await dbError(
      prisma.claimItemEvidence.create({
        data: { organizationId: ORG, claimItemId: claim, evidenceId: foreignEvidence },
      }),
    );
    expect(message).toMatch(/CROSS_ACCOUNT_EVIDENCE_BINDING|P2004|check constraint/i);
    expect(await prisma.claimItemEvidence.count({ where: { organizationId: ORG } })).toBe(0);

    await prisma.claimItemEvidence.create({
      data: { organizationId: ORG, claimItemId: claim, evidenceId: ownEvidence },
    });
    expect(await prisma.claimItemEvidence.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('cross-account settlement linkage（claimItem ↔ evidence）→ DB 拒绝；同账户 → 允许', async () => {
    const opportunity = await seedOpportunity(ACCOUNT_A);
    const claim = await seedClaimItem(ACCOUNT_A, opportunity);
    const foreignEvidence = await seedEvidence(ACCOUNT_B);
    const ownEvidence = await seedEvidence(ACCOUNT_A);

    const message = await dbError(
      prisma.settlement.create({
        data: {
          organizationId: ORG,
          source: 'PLATFORM_CREDIT',
          amount: '120.0000',
          currency: 'USD',
          claimItemId: claim,
          evidenceId: foreignEvidence,
        },
      }),
    );
    expect(message).toMatch(/CROSS_ACCOUNT_SETTLEMENT_LINKAGE|P2004|check constraint/i);
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(0);

    await prisma.settlement.create({
      data: {
        organizationId: ORG,
        source: 'PLATFORM_CREDIT',
        amount: '120.0000',
        currency: 'USD',
        claimItemId: claim,
        evidenceId: ownEvidence,
      },
    });
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('证据 port 从连接上下文服务端派生 accountId（客户端不提交 account）', async () => {
    const connection = await prisma.sourceConnection.create({
      data: {
        organizationId: ORG,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        kind: 'FILE_UPLOAD',
        status: 'ACTIVE',
        label: 'conn A',
        platformAccountId: ACCOUNT_A,
      },
    });

    const created = await ports.evidence.create({
      organizationId: ORG,
      kind: 'OTHER',
      fileAssetId: null,
      connectionId: connection.id,
      externalUrl: null,
      title: 'derived evidence',
      description: null,
      capturedAt: new Date('2026-09-08T00:00:00.000Z'),
    });
    const evidence = await prisma.evidenceArtifact.findFirstOrThrow({ where: { id: created.id } });
    expect(evidence.accountId).toBe(ACCOUNT_A);
    expect(evidence.connectionId).toBe(connection.id);
  });
});
