/**
 * TRACK C2 —— PlatformAccount identity immutability（MSG-20261002-67 CHANGE）。
 * 真实 PostgreSQL：
 *   - platform / externalAccountId / identityVersion 三类 post-create mutation → DB 拒绝且原记录不变；
 *   - displayName / status / marketplace / region 仍允许合法更新；
 *   - credential rotation / reconnect 不改变 identity tuple（identityVersion 不变）；
 *   - cross-tenant SourceConnection binding 继续拒绝。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();
const uuid = (): string => randomUUID();

let ORG = '';
let ORG_B = '';
let ACCOUNT = '';
let ACCOUNT_B = '';

async function dbError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as Error).message ?? error);
  }
  throw new Error('EXPECTED_DB_ERROR_BUT_SUCCEEDED');
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "CanonicalFactSource", "CanonicalFact", "SourceTransaction", "ImportBatch", "FileAsset", "SourceConnection", "PlatformAccount", "Organization" CASCADE;',
  );
  ORG = uuid();
  ORG_B = uuid();
  await prisma.organization.create({
    data: { id: ORG, name: 'C2 msg67', slug: 'c2-msg67-' + uuid().slice(0, 8) },
  });
  await prisma.organization.create({
    data: { id: ORG_B, name: 'C2 msg67 b', slug: 'c2-msg67b-' + uuid().slice(0, 8) },
  });
  ACCOUNT = (
    await prisma.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: 'AMAZON',
        externalAccountId: 'SELLER-A1',
        displayName: 'Store A1',
      },
    })
  ).id;
  ACCOUNT_B = (
    await prisma.platformAccount.create({
      data: {
        organizationId: ORG_B,
        platform: 'AMAZON',
        externalAccountId: 'SELLER-B1',
        displayName: 'Store B1',
      },
    })
  ).id;
});

describe('TRACK C2 M2 —— PlatformAccount identity immutability（MSG-20261002-67）', () => {
  it('platform / externalAccountId / identityVersion 三类 post-create mutation → DB 拒绝且原记录不变', async () => {
    const before = await prisma.platformAccount.findFirstOrThrow({ where: { id: ACCOUNT } });

    const platformMessage = await dbError(
      prisma.platformAccount.update({ where: { id: ACCOUNT }, data: { platform: 'WALMART' } }),
    );
    expect(platformMessage).toMatch(/PLATFORM_ACCOUNT_IDENTITY_IMMUTABLE|P2004|check constraint/i);

    const externalMessage = await dbError(
      prisma.platformAccount.update({
        where: { id: ACCOUNT },
        data: { externalAccountId: 'SELLER-X' },
      }),
    );
    expect(externalMessage).toMatch(/PLATFORM_ACCOUNT_IDENTITY_IMMUTABLE|P2004|check constraint/i);

    const identityVersionMessage = await dbError(
      prisma.platformAccount.update({ where: { id: ACCOUNT }, data: { identityVersion: 'v2' } }),
    );
    expect(identityVersionMessage).toMatch(/PLATFORM_ACCOUNT_IDENTITY_IMMUTABLE|P2004|check constraint/i);

    const after = await prisma.platformAccount.findFirstOrThrow({ where: { id: ACCOUNT } });
    expect(after.platform).toBe(before.platform);
    expect(after.externalAccountId).toBe(before.externalAccountId);
    expect(after.identityVersion).toBe(before.identityVersion);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('displayName / status / marketplace / region 仍允许合法更新（identity tuple 不动）', async () => {
    await prisma.platformAccount.update({
      where: { id: ACCOUNT },
      data: { displayName: 'Store A1 (renamed)', status: 'ACTIVE', marketplace: 'US', region: 'NA' },
    });
    const after = await prisma.platformAccount.findFirstOrThrow({ where: { id: ACCOUNT } });
    expect(after.displayName).toBe('Store A1 (renamed)');
    expect(after.status).toBe('ACTIVE');
    expect(after.marketplace).toBe('US');
    expect(after.region).toBe('NA');
    expect(after.platform).toBe('AMAZON');
    expect(after.externalAccountId).toBe('SELLER-A1');
    expect(after.identityVersion).toBe('v1');
  });

  it('credential rotation / reconnect 不改变 identity tuple（identityVersion 不变）', async () => {
    const connection = await prisma.sourceConnection.create({
      data: {
        organizationId: ORG,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        kind: 'API',
        status: 'ACTIVE',
        label: 'conn',
        platformAccountId: ACCOUNT,
        credentialRef: 'CROSSCLAIM_FIXTURE_RO',
      },
    });
    const before = await prisma.platformAccount.findFirstOrThrow({ where: { id: ACCOUNT } });

    await prisma.sourceConnection.update({
      where: { id: connection.id },
      data: { credentialRef: 'CROSSCLAIM_FIXTURE_RO_V2' },
    });
    await prisma.sourceConnection.update({
      where: { id: connection.id },
      data: { status: 'NEEDS_AUTH' },
    });
    await prisma.sourceConnection.update({ where: { id: connection.id }, data: { status: 'ACTIVE' } });

    const after = await prisma.platformAccount.findFirstOrThrow({ where: { id: ACCOUNT } });
    expect([after.platform, after.externalAccountId, after.identityVersion]).toEqual([
      before.platform,
      before.externalAccountId,
      before.identityVersion,
    ]);
    const connectionAfter = await prisma.sourceConnection.findFirstOrThrow({
      where: { id: connection.id },
    });
    expect(connectionAfter.platformAccountId).toBe(ACCOUNT);
  });

  it('cross-tenant SourceConnection binding 继续被拒绝', async () => {
    const message = await dbError(
      prisma.sourceConnection.create({
        data: {
          organizationId: ORG,
          domain: 'PLATFORM',
          channel: 'AMAZON_OTHER',
          kind: 'API',
          status: 'NEEDS_AUTH',
          label: 'cross-tenant',
          platformAccountId: ACCOUNT_B,
        },
      }),
    );
    expect(message).toMatch(/cross-tenant reference blocked|P2004|check constraint/i);
    expect(
      await prisma.sourceConnection.count({ where: { organizationId: ORG, label: 'cross-tenant' } }),
    ).toBe(0);
  });
});
