/**
 * TRACK C2 FINAL —— 最低验收矩阵中「尚未被其它 C2 套件覆盖」的三项（真实 PostgreSQL）：
 *   #2  1 org / Amazon + TikTok（同 externalId 不跨平台合并）
 *   #10 account 级并发幂等（同 account 同 factKey 并发写入 → 恒为一条事实）
 *   #11 organization 级聚合视图仍可行（跨 account 汇总）
 * 其余项见 docs/releases/TRACK-C2-FINAL-CHECKPOINT.md 的映射表。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { writeCanonicalFactsForTransactions } from '../services/canonical';
import { createPrismaImportRepository } from '../services/ingest';

const prisma = new PrismaClient();
const imports = createPrismaImportRepository(prisma);
const uuid = (): string => randomUUID();

let ORG = '';
let AMAZON_ACCOUNT = '';
let TIKTOK_ACCOUNT = '';
let AMAZON_CONN = '';
let TIKTOK_CONN = '';

async function seedConnection(
  label: string,
  platformAccountId: string,
): Promise<string> {
  const created = await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label,
      platformAccountId,
    },
  });
  return created.id;
}

async function ingestRow(connectionId: string, externalId: string): Promise<void> {
  const batch = await prisma.importBatch.create({
    data: {
      organizationId: ORG,
      connectionId,
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      status: 'IMPORTED',
    },
  });
  await imports.insertTransactions([
    {
      organizationId: ORG,
      connectionId,
      importBatchId: batch.id,
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      externalId,
      referenceType: 'ORDER',
      occurredAt: new Date('2026-09-08T00:00:00.000Z'),
      amount: '100.0000',
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
  ORG = uuid();
  await prisma.organization.create({
    data: { id: ORG, name: 'C2 matrix', slug: 'c2-matrix-' + uuid().slice(0, 8) },
  });
  AMAZON_ACCOUNT = (
    await prisma.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: 'AMAZON',
        externalAccountId: 'SELLER-AMZ',
        displayName: 'Amazon store',
      },
    })
  ).id;
  TIKTOK_ACCOUNT = (
    await prisma.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: 'TIKTOK_SHOP',
        externalAccountId: 'SELLER-TT',
        displayName: 'TikTok shop',
      },
    })
  ).id;
  AMAZON_CONN = await seedConnection('conn amazon', AMAZON_ACCOUNT);
  TIKTOK_CONN = await seedConnection('conn tiktok', TIKTOK_ACCOUNT);
});

describe('TRACK C2 FINAL —— 最低验收矩阵补充项', () => {
  it('#2 1 org / Amazon + TikTok：同一 externalId 不跨平台合并，且各自可追溯到自己的 account', async () => {
    const externalId = 'ORDER-' + uuid().slice(0, 8);
    await ingestRow(AMAZON_CONN, externalId);
    await ingestRow(TIKTOK_CONN, externalId);

    const facts = await prisma.canonicalFact.findMany({
      where: { organizationId: ORG, factKey: 'ORDER:' + externalId.toUpperCase() },
    });
    expect(facts).toHaveLength(2);
    expect(new Set(facts.map((f) => f.accountId))).toEqual(new Set([AMAZON_ACCOUNT, TIKTOK_ACCOUNT]));

    const platforms = await prisma.platformAccount.findMany({
      where: { id: { in: facts.map((f) => f.accountId as string) } },
      select: { platform: true },
      orderBy: { platform: 'asc' },
    });
    expect(platforms.map((p) => p.platform)).toEqual(['AMAZON', 'TIKTOK_SHOP']);
  });

  it('#10 account 级并发幂等：同 account 同 factKey 并发写入 → 恒为一条事实', async () => {
    const externalId = 'ORDER-' + uuid().slice(0, 8);
    await ingestRow(AMAZON_CONN, externalId);
    const tx = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG, externalId },
    });

    const run = async (): Promise<void> => {
      try {
        await prisma.$transaction(async (client) => {
          await writeCanonicalFactsForTransactions(client as never, {
            organizationId: ORG,
            domain: 'PLATFORM',
            channel: 'AMAZON_OTHER',
            transactionIds: [tx.id],
            observedAt: new Date('2026-09-09T00:00:00.000Z'),
          });
        });
      } catch {
        // 并发下允许 loser 以域错误退出；correctness source 是唯一索引，不是任一次调用成功
      }
    };

    await Promise.all([run(), run(), run()]);

    const facts = await prisma.canonicalFact.findMany({
      where: { organizationId: ORG, factKey: 'ORDER:' + externalId.toUpperCase() },
    });
    expect(facts).toHaveLength(1);
    expect(facts[0].accountId).toBe(AMAZON_ACCOUNT);
    expect(facts[0].sourceCount).toBe(1);
  });

  it('#11 organization 级聚合视图仍可行：跨 account 事实可按 org 汇总', async () => {
    const externalId = 'ORDER-' + uuid().slice(0, 8);
    await ingestRow(AMAZON_CONN, externalId);
    await ingestRow(TIKTOK_CONN, externalId);

    const byOrg = await prisma.canonicalFact.count({ where: { organizationId: ORG } });
    const byAccount = await prisma.canonicalFact.groupBy({
      by: ['accountId'],
      where: { organizationId: ORG },
      _count: { _all: true },
    });

    expect(byOrg).toBe(2);
    expect(byAccount).toHaveLength(2);
    expect(byAccount.reduce((sum, row) => sum + row._count._all, 0)).toBe(byOrg);
  });
});
