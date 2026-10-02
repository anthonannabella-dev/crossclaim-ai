/**
 * MSG-20261002-69 CHANGE C2-FINAL-2-A —— 共享 resolver 的多上下文一致性（真实 PostgreSQL）。
 * 1) connection=A + case=A → PASS
 * 2) connection=A + case=B → stable fail-closed（且零 Evidence / 零 link 副作用）
 * 3) connection-only → PASS
 * 4) case-only → PASS
 * 5) case lineage：多账户 / NULL 混杂 / 全 NULL / 无 lineage → fail-closed
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PlatformAccountRequiredError,
  resolveEvidenceAccountId,
} from '../services/evidence/account-scope';

const prisma = new PrismaClient();
const uuid = (): string => randomUUID();

let ORG = '';
let ACCOUNT_A = '';
let ACCOUNT_B = '';
let CONNECTION_A = '';
let CONNECTION_B = '';

async function expectRequired(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toBeInstanceOf(PlatformAccountRequiredError);
}

async function seedCase(accountIds: (string | null)[]): Promise<string> {
  const kase = await prisma.case.create({
    data: { organizationId: ORG, caseNo: 'CASE-' + uuid().slice(0, 6), title: 't', domain: 'PLATFORM' },
  });
  for (const accountId of accountIds) {
    await prisma.claimItem.create({
      data: {
        organizationId: ORG,
        accountId,
        caseId: kase.id,
        platformType: 'AMAZON',
        claimType: 'LOST_INVENTORY',
        platformRef: 'REF-' + uuid().slice(0, 8),
        occurredAt: new Date('2026-09-08T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
    });
  }
  return kase.id;
}

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ClaimItem", "Case", "EvidenceArtifact", "SourceConnection", "PlatformAccount", "Organization" CASCADE;',
  );
  ORG = uuid();
  await prisma.organization.create({
    data: { id: ORG, name: 'Dual ctx', slug: 'dual-' + uuid().slice(0, 8) },
  });
  const makeAccount = async (externalAccountId: string): Promise<string> =>
    (
      await prisma.platformAccount.create({
        data: { organizationId: ORG, platform: 'AMAZON', externalAccountId, displayName: externalAccountId },
      })
    ).id;
  ACCOUNT_A = await makeAccount('SELLER-A');
  ACCOUNT_B = await makeAccount('SELLER-B');
  const makeConnection = async (label: string, platformAccountId: string): Promise<string> =>
    (
      await prisma.sourceConnection.create({
        data: {
          organizationId: ORG,
          domain: 'PLATFORM',
          channel: label === 'conn-a' ? 'AMAZON_OTHER' : 'AMAZON_FBA',
          kind: 'FILE_UPLOAD',
          status: 'ACTIVE',
          label,
          platformAccountId,
        },
      })
    ).id;
  CONNECTION_A = await makeConnection('conn-a', ACCOUNT_A);
  CONNECTION_B = await makeConnection('conn-b', ACCOUNT_B);
});

describe('MSG-20261002-69 —— resolver 多上下文一致性', () => {
  it('connection=A + case=A → PASS（一致时返回该 account）', async () => {
    const kase = await seedCase([ACCOUNT_A]);
    await expect(
      resolveEvidenceAccountId(prisma as never, {
        organizationId: ORG,
        connectionId: CONNECTION_A,
        caseId: kase,
      }),
    ).resolves.toBe(ACCOUNT_A);
  });

  it('connection=A + case=B → stable fail-closed，且不产生任何副作用', async () => {
    const kase = await seedCase([ACCOUNT_B]);
    await expectRequired(() =>
      resolveEvidenceAccountId(prisma as never, {
        organizationId: ORG,
        connectionId: CONNECTION_A,
        caseId: kase,
      }),
    );
    expect(await prisma.evidenceArtifact.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.caseEvidence.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('connection-only 与 case-only 均可独立解析', async () => {
    await expect(
      resolveEvidenceAccountId(prisma as never, { organizationId: ORG, connectionId: CONNECTION_B }),
    ).resolves.toBe(ACCOUNT_B);

    const kase = await seedCase([ACCOUNT_A]);
    await expect(
      resolveEvidenceAccountId(prisma as never, { organizationId: ORG, caseId: kase }),
    ).resolves.toBe(ACCOUNT_A);
  });

  it('case lineage 多账户 / NULL 混杂 / 全 NULL / 无 lineage → 全部 fail-closed', async () => {
    const multi = await seedCase([ACCOUNT_A, ACCOUNT_B]);
    await expectRequired(() =>
      resolveEvidenceAccountId(prisma as never, { organizationId: ORG, caseId: multi }),
    );

    const mixed = await seedCase([ACCOUNT_A, null]);
    await expectRequired(() =>
      resolveEvidenceAccountId(prisma as never, { organizationId: ORG, caseId: mixed }),
    );

    const allNull = await seedCase([null, null]);
    await expectRequired(() =>
      resolveEvidenceAccountId(prisma as never, { organizationId: ORG, caseId: allNull }),
    );

    const empty = await seedCase([]);
    await expectRequired(() =>
      resolveEvidenceAccountId(prisma as never, { organizationId: ORG, caseId: empty }),
    );
  });
});
