/**
 * MSG-20261002-68 CHANGE A —— account provenance 解析器（真实 PostgreSQL）。
 * 覆盖：连接派生成功 / 缺连接 fail-closed / 连接未绑定 fail-closed /
 *      case 唯一主张账户派生成功 / 无主张·多账户·含 NULL → fail-closed。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PlatformAccountRequiredError,
  resolveAccountIdFromCase,
  resolveAccountIdFromConnection,
} from '../services/evidence/account-scope';

const prisma = new PrismaClient();
const uuid = (): string => randomUUID();

let ORG = '';
let ACCOUNT_A = '';
let ACCOUNT_B = '';
let CONNECTION = '';

async function expectRequired(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toBeInstanceOf(PlatformAccountRequiredError);
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ClaimItem", "Case", "SourceConnection", "PlatformAccount", "Organization" CASCADE;',
  );
  ORG = uuid();
  await prisma.organization.create({
    data: { id: ORG, name: 'Change A', slug: 'change-a-' + uuid().slice(0, 8) },
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
  CONNECTION = (
    await prisma.sourceConnection.create({
      data: {
        organizationId: ORG,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        kind: 'FILE_UPLOAD',
        status: 'ACTIVE',
        label: 'conn',
        platformAccountId: ACCOUNT_A,
      },
    })
  ).id;
});

async function seedCaseWithClaims(accountIds: (string | null)[]): Promise<string> {
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

describe('MSG-20261002-68 CHANGE A —— account provenance 解析', () => {
  it('连接已绑定 PlatformAccount → 服务端派生成功', async () => {
    await expect(
      resolveAccountIdFromConnection(prisma as never, { organizationId: ORG, connectionId: CONNECTION }),
    ).resolves.toBe(ACCOUNT_A);
  });

  it('缺连接上下文 / 连接未绑定账户 → PLATFORM_ACCOUNT_REQUIRED', async () => {
    await expectRequired(() =>
      resolveAccountIdFromConnection(prisma as never, { organizationId: ORG, connectionId: null }),
    );
    const orphan = await prisma.sourceConnection.create({
      data: {
        organizationId: ORG,
        domain: 'PLATFORM',
        channel: 'AMAZON_FBA',
        kind: 'FILE_UPLOAD',
        // MSG-20261002-77：未绑定账户的连接不得是 ACTIVE。
        status: 'NEEDS_AUTH',
        label: 'orphan',
      },
    });
    await expectRequired(() =>
      resolveAccountIdFromConnection(prisma as never, { organizationId: ORG, connectionId: orphan.id }),
    );
  });

  it('case 主张链同属一个账户 → 派生成功；无主张 / 多账户 / 含 NULL → fail-closed', async () => {
    const single = await seedCaseWithClaims([ACCOUNT_A, ACCOUNT_A]);
    await expect(
      resolveAccountIdFromCase(prisma as never, { organizationId: ORG, caseId: single }),
    ).resolves.toBe(ACCOUNT_A);

    const empty = await seedCaseWithClaims([]);
    await expectRequired(() => resolveAccountIdFromCase(prisma as never, { organizationId: ORG, caseId: empty }));

    const mixed = await seedCaseWithClaims([ACCOUNT_A, ACCOUNT_B]);
    await expectRequired(() => resolveAccountIdFromCase(prisma as never, { organizationId: ORG, caseId: mixed }));

    const legacy = await seedCaseWithClaims([ACCOUNT_A, null]);
    await expectRequired(() => resolveAccountIdFromCase(prisma as never, { organizationId: ORG, caseId: legacy }));
  });
});
