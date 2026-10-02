/**
 * TRACK C2 slice 2a（MSG-20261002-66 M4–M6）—— account scope 下推 + 事实身份账户作用域。
 * 真实 PostgreSQL；覆盖：
 *   - 同 org / 同平台 / 两个 account + 同一 externalId → 两条独立事实（不合并、不误判冲突）
 *   - accountId 只由服务端从连接上下文派生（客户端提交 → CLIENT_ACCOUNT_FIELD_NOT_TRUSTED）
 *   - 跨租户 account 引用被 DB 拒绝；account 绑定写一次
 *   - legacy（accountId NULL）行仍按 (org, factKey) 唯一；同 externalAccountId 跨 org 允许
 *   - 历史行（accountId NULL）但连接已有 account → 回退派生仍归到该 account
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient, type Channel, type Platform } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { writeCanonicalFactsForTransactions } from '../services/canonical';
import { createPrismaImportRepository } from '../services/ingest';

const prisma = new PrismaClient();
const imports = createPrismaImportRepository(prisma);
const uuid = (): string => randomUUID();

let ORG_A = '';
let ORG_B = '';
let ACCOUNT_A1 = '';
let ACCOUNT_A2 = '';
let ACCOUNT_B1 = '';
let CONN_A1 = '';
let CONN_A2 = '';
let CONN_B1 = '';
let CONN_LEGACY = '';

async function dbError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as Error).message ?? error);
  }
  throw new Error('EXPECTED_DB_ERROR_BUT_SUCCEEDED');
}

async function seedOrg(suffix: string): Promise<string> {
  const id = uuid();
  await prisma.organization.create({
    data: { id, name: 'C2 scope ' + suffix, slug: 'c2-scope-' + suffix + '-' + uuid().slice(0, 8) },
  });
  return id;
}

async function seedAccount(
  organizationId: string,
  platform: Platform,
  externalAccountId: string,
  displayName: string,
): Promise<string> {
  const created = await prisma.platformAccount.create({
    data: { organizationId, platform, externalAccountId, displayName },
  });
  return created.id;
}

async function seedConnection(
  organizationId: string,
  channel: Channel,
  label: string,
  platformAccountId: string | null,
): Promise<string> {
  const created = await prisma.sourceConnection.create({
    data: {
      organizationId,
      domain: 'PLATFORM',
      channel,
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label,
      platformAccountId,
    },
  });
  return created.id;
}

/** 走真实 ingest 仓库：accountId 由服务端派生，客户端只提供业务字段。 */
async function ingestRow(
  organizationId: string,
  connectionId: string,
  externalId: string,
  amount = '100.0000',
): Promise<void> {
  const batch = await prisma.importBatch.create({
    data: {
      organizationId,
      connectionId,
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      status: 'IMPORTED',
    },
  });
  await imports.insertTransactions([
    {
      organizationId,
      connectionId,
      importBatchId: batch.id,
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      externalId,
      referenceType: 'ORDER',
      occurredAt: new Date('2026-09-08T00:00:00.000Z'),
      amount,
      currency: 'USD',
      dedupeKey: uuid(),
      raw: { externalId },
    },
  ]);
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
  ORG_A = await seedOrg('a');
  ORG_B = await seedOrg('b');
  // 同 org、同平台、不同外部账户（Store A1 / A2）
  ACCOUNT_A1 = await seedAccount(ORG_A, 'AMAZON', 'SELLER-A1', 'Store A1');
  ACCOUNT_A2 = await seedAccount(ORG_A, 'AMAZON', 'SELLER-A2', 'Store A2');
  // 另一个 org 里存在**完全相同**的 externalAccountId
  ACCOUNT_B1 = await seedAccount(ORG_B, 'AMAZON', 'SELLER-A1', 'Store B1');

  CONN_A1 = await seedConnection(ORG_A, 'AMAZON_OTHER', 'conn A1', ACCOUNT_A1);
  CONN_A2 = await seedConnection(ORG_A, 'AMAZON_OTHER', 'conn A2', ACCOUNT_A2);
  CONN_B1 = await seedConnection(ORG_B, 'AMAZON_OTHER', 'conn B1', ACCOUNT_B1);
  CONN_LEGACY = await seedConnection(ORG_A, 'AMAZON_OTHER', 'conn legacy', null);
});

describe('TRACK C2 M4/M5 —— account scope 下推与事实身份', () => {
  it('同 org 两个 account 的同一 externalId → 两条独立事实（不合并、不判冲突）', async () => {
    const externalId = 'ORDER-' + uuid().slice(0, 8);
    await ingestRow(ORG_A, CONN_A1, externalId);
    await ingestRow(ORG_A, CONN_A2, externalId);

    const rows = await prisma.sourceTransaction.findMany({
      where: { organizationId: ORG_A, externalId },
      orderBy: { accountId: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.accountId))).toEqual(new Set([ACCOUNT_A1, ACCOUNT_A2]));

    const facts = await prisma.canonicalFact.findMany({
      where: { organizationId: ORG_A, factKey: 'ORDER:' + externalId.toUpperCase() },
    });
    expect(facts).toHaveLength(2);
    expect(new Set(facts.map((fact) => fact.accountId))).toEqual(new Set([ACCOUNT_A1, ACCOUNT_A2]));
    // 同一 externalId 在两个账户里各是一条 ACTIVE 事实，而不是一条 CONFLICT
    expect(facts.every((fact) => fact.status === 'ACTIVE')).toBe(true);
    expect(facts.every((fact) => fact.sourceCount === 1)).toBe(true);
  });

  it('accountId 由服务端从连接上下文派生（客户端提交 → 拒绝）', async () => {
    const externalId = 'ORDER-' + uuid().slice(0, 8);
    await ingestRow(ORG_A, CONN_A1, externalId);
    const row = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG_A, externalId },
    });
    expect(row.accountId).toBe(ACCOUNT_A1);
    expect(row.connectionId).toBe(CONN_A1);

    const batch = await prisma.importBatch.create({
      data: {
        organizationId: ORG_A,
        connectionId: CONN_A1,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        status: 'IMPORTED',
      },
    });
    const message = await dbError(
      imports.insertTransactions([
        {
          organizationId: ORG_A,
          connectionId: CONN_A1,
          importBatchId: batch.id,
          domain: 'PLATFORM',
          channel: 'AMAZON_OTHER',
          externalId: 'ORDER-SPOOF',
          referenceType: 'ORDER',
          occurredAt: null,
          amount: '1.0000',
          currency: 'USD',
          dedupeKey: uuid(),
          raw: {},
          accountId: ACCOUNT_A2,
        } as never,
      ]),
    );
    expect(message).toContain('CLIENT_ACCOUNT_FIELD_NOT_TRUSTED');
    expect(
      await prisma.sourceTransaction.count({
        where: { organizationId: ORG_A, externalId: 'ORDER-SPOOF' },
      }),
    ).toBe(0);
  });

  it('历史行 accountId 为空但连接已有 account → 不得回退派生（MSG-20261002-76 CHANGE B2-A），legacy 行仍可读', async () => {
    const externalId = 'ORDER-' + uuid().slice(0, 8);
    // 直接写原始行（模拟迁移窗口内 accountId 尚未落库的历史行）
    await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG_A,
        connectionId: CONN_A1,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        externalId,
        referenceType: 'ORDER',
        occurredAt: new Date('2026-09-08T00:00:00.000Z'),
        amount: '55.0000',
        currency: 'USD',
        dedupeKey: uuid(),
        raw: { externalId },
      },
    });
    const tx = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG_A, externalId },
    });
    expect(tx.accountId).toBeNull();

    // CONN_A1 当前已绑定 ACCOUNT_A1，但 transaction 自身 stored provenance = NULL：
    // active write 不得据此追溯归属（禁止 implicit backfill / retroactive attribution）。
    await expect(
      prisma.$transaction(async (client) => {
        await writeCanonicalFactsForTransactions(client as never, {
          organizationId: ORG_A,
          domain: 'PLATFORM',
          channel: 'AMAZON_OTHER',
          transactionIds: [tx.id],
          observedAt: new Date('2026-09-09T00:00:00.000Z'),
        });
      }),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);

    // LEGACY READ = ALLOWED：历史行本身仍可读，且不被重新归属
    const reread = await prisma.sourceTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(reread.accountId).toBeNull();

    // LEGACY NEW WRITE CONTINUATION = FORBIDDEN：不得新增 NULL 归因 CanonicalFact
    expect(
      await prisma.canonicalFact.count({
        where: { organizationId: ORG_A, factKey: 'ORDER:' + externalId.toUpperCase() },
      }),
    ).toBe(0);
  });
});

describe('TRACK C2 M4/M5 —— 隔离、不变量与 legacy 兼容', () => {
  it('跨租户 account 引用被拒绝（SourceTransaction / CanonicalFact / ClaimItem）', async () => {
    const extern = 'ORDER-' + uuid().slice(0, 8);
    const txMessage = await dbError(
      prisma.sourceTransaction.create({
        data: {
          organizationId: ORG_A,
          connectionId: CONN_A1,
          accountId: ACCOUNT_B1, // 属于 ORG_B
          domain: 'PLATFORM',
          channel: 'AMAZON_OTHER',
          externalId: extern,
          referenceType: 'ORDER',
          dedupeKey: uuid(),
          raw: {},
        },
      }),
    );
    expect(txMessage).toMatch(/cross-tenant reference blocked|P2004|check constraint/i);

    const factMessage = await dbError(
      prisma.canonicalFact.create({
        data: {
          organizationId: ORG_A,
          accountId: ACCOUNT_B1,
          domain: 'PLATFORM',
          channel: 'AMAZON_OTHER',
          factKey: 'ORDER:' + extern.toUpperCase(),
          referenceType: 'ORDER',
          externalId: extern,
          currency: 'USD',
        },
      }),
    );
    expect(factMessage).toMatch(/cross-tenant reference blocked|P2004|check constraint/i);

    const claimMessage = await dbError(
      prisma.claimItem.create({
        data: {
          organizationId: ORG_A,
          accountId: ACCOUNT_B1,
          platformType: 'AMAZON',
          claimType: 'LOST_INVENTORY',
          platformRef: 'REF-' + uuid().slice(0, 8),
          occurredAt: new Date('2026-09-08T00:00:00.000Z'),
          normalizerVersion: 'v1',
        },
      }),
    );
    expect(claimMessage).toMatch(/cross-tenant reference blocked|P2004|check constraint/i);
  });

  it('account 绑定写一次：SourceConnection.platformAccountId 与 SourceTransaction.accountId 不可改写', async () => {
    const externalId = 'ORDER-' + uuid().slice(0, 8);
    await ingestRow(ORG_A, CONN_A1, externalId);
    const tx = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG_A, externalId },
    });

    const txMessage = await dbError(
      prisma.$executeRawUnsafe(
        'UPDATE "SourceTransaction" SET "accountId" = $1 WHERE "id" = $2',
        ACCOUNT_A2,
        tx.id,
      ),
    );
    expect(txMessage).toContain('ACCOUNT_BINDING_IMMUTABLE');

    const connMessage = await dbError(
      prisma.$executeRawUnsafe(
        'UPDATE "SourceConnection" SET "platformAccountId" = $1 WHERE "id" = $2',
        ACCOUNT_A2,
        CONN_A1,
      ),
    );
    expect(connMessage).toContain('ACCOUNT_BINDING_IMMUTABLE');

    const after = await prisma.sourceTransaction.findFirstOrThrow({ where: { id: tx.id } });
    expect(after.accountId).toBe(ACCOUNT_A1);
    const conn = await prisma.sourceConnection.findFirstOrThrow({ where: { id: CONN_A1 } });
    expect(conn.platformAccountId).toBe(ACCOUNT_A1);
  });

  it('legacy（accountId IS NULL）仍按 (org, factKey) 唯一：第二条 NULL 事实被拒绝', async () => {
    const externalId = 'LEGACY-' + uuid().slice(0, 8);
    const factKey = 'ORDER:' + externalId.toUpperCase();
    // 未绑定 account 的连接 → 事实保持 legacy（accountId NULL）
    // TRACK B BATCH 1：unbound 连接已不能通过 ingest 写入（Account Lineage Runtime Gate fail-closed），
    // 因此 legacy NULL 事实改为直接落库模拟历史数据；DB 层 partial unique 仍是防重复 correctness boundary。
    await prisma.canonicalFact.create({
      data: {
        organizationId: ORG_A,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        factKey,
        referenceType: 'ORDER',
        externalId,
        currency: 'USD',
      },
    });
    const legacy = await prisma.canonicalFact.findFirstOrThrow({
      where: { organizationId: ORG_A, factKey },
    });
    expect(legacy.accountId).toBeNull();

    // 同时验证：legacy unbound 连接仍可读，但不得再启动新的 ingest（TRACK B BATCH 1 gate）。
    const legacyConnection = await prisma.sourceConnection.findFirstOrThrow({
      where: { id: CONN_LEGACY, organizationId: ORG_A },
      select: { platformAccountId: true },
    });
    expect(legacyConnection.platformAccountId).toBeNull();
    await expect(ingestRow(ORG_A, CONN_LEGACY, externalId + '-blocked')).rejects.toThrow(
      /PLATFORM_ACCOUNT_REQUIRED/,
    );

    // 绕过应用层直接写第二条同 (org, factKey) 的 legacy 事实 → partial unique index 拒绝
    // （应用层对同作用域同 factKey 是幂等合并，DB 层才是防重复 correctness boundary）
    const message = await dbError(
      prisma.canonicalFact.create({
        data: {
          organizationId: ORG_A,
          domain: 'PLATFORM',
          channel: 'AMAZON_OTHER',
          factKey,
          referenceType: 'ORDER',
          externalId,
          currency: 'USD',
        },
      }),
    );
    expect(message).toMatch(/Unique constraint|P2002|duplicate key/i);

    // 同一 factKey 落在**不同 account** 下是允许的（结构化账户作用域）
    await ingestRow(ORG_A, CONN_A1, externalId);
    expect(await prisma.canonicalFact.count({ where: { organizationId: ORG_A, factKey } })).toBe(2);
  });

  it('同一 externalAccountId 在两个 organization 下允许（org-scoped identity）', async () => {
    const a1 = await prisma.platformAccount.findFirstOrThrow({ where: { id: ACCOUNT_A1 } });
    const b1 = await prisma.platformAccount.findFirstOrThrow({ where: { id: ACCOUNT_B1 } });
    expect(a1.externalAccountId).toBe(b1.externalAccountId);
    expect(a1.organizationId).not.toBe(b1.organizationId);

    // 同一 externalId 分别经两个 org 各自的 account 进入系统 → 事实互不干扰
    const externalId = 'ORDER-' + uuid().slice(0, 8);
    await ingestRow(ORG_A, CONN_A1, externalId);
    await ingestRow(ORG_B, CONN_B1, externalId);
    const factsA = await prisma.canonicalFact.findMany({
      where: { organizationId: ORG_A, factKey: 'ORDER:' + externalId.toUpperCase() },
    });
    const factsB = await prisma.canonicalFact.findMany({
      where: { organizationId: ORG_B, factKey: 'ORDER:' + externalId.toUpperCase() },
    });
    expect(factsA).toHaveLength(1);
    expect(factsB).toHaveLength(1);
    expect(factsA[0].accountId).toBe(ACCOUNT_A1);
    expect(factsB[0].accountId).toBe(ACCOUNT_B1);
    expect(factsA[0].id).not.toBe(factsB[0].id);

    // 同 org + 同 platform + 同 externalAccountId + 同 identityVersion → 拒绝
    const message = await dbError(
      prisma.platformAccount.create({
        data: {
          organizationId: ORG_A,
          platform: 'AMAZON',
          externalAccountId: 'SELLER-A1',
          displayName: 'duplicate',
        },
      }),
    );
    expect(message).toMatch(/Unique constraint|P2002|duplicate key/i);
  });

  it('credential rotation 不产生新的 account identity（identityVersion 不变）', async () => {
    const before = await prisma.platformAccount.findFirstOrThrow({ where: { id: ACCOUNT_A1 } });
    await prisma.sourceConnection.update({
      where: { id: CONN_A1 },
      data: { credentialRef: 'CROSSCLAIM_FIXTURE_RO_V2' },
    });
    const after = await prisma.platformAccount.findFirstOrThrow({ where: { id: ACCOUNT_A1 } });
    expect(after.identityVersion).toBe(before.identityVersion);
    expect(after.externalAccountId).toBe(before.externalAccountId);
    expect(
      await prisma.platformAccount.count({ where: { organizationId: ORG_A, platform: 'AMAZON' } }),
    ).toBe(2);
  });
});
