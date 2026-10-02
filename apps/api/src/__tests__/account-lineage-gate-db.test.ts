/**
 * TRACK B BATCH 1 —— Account Lineage Runtime Gate 验收（真实 PostgreSQL）
 * MSG-20261002-74 ③ BATCH 1 / B1-2 · B1-3 · B1-4
 *
 * 覆盖（架构方指定验收标准）：
 *   1. unbound connection ingest → stable reject（PLATFORM_ACCOUNT_REQUIRED）+ 0 SourceTransaction
 *   2. failed ingest → 0 CanonicalFact / 0 RecoveryOpportunity / 0 ClaimItem
 *   3. bound connection ingest → PASS，且 SourceTransaction.accountId = bound PlatformAccount
 *   4. 缺少连接上下文（connectionId = null）→ fail-closed，0 写入
 *   5. 跨租户连接（connection 属于另一 organization）→ fail-closed，0 写入
 *   6. client 提交 accountId → CLIENT_ACCOUNT_FIELD_NOT_TRUSTED，绝不作为可信 lineage
 *   7. legacy unbound connection 仍可读取（读路径不受影响），但不得启动新的 ingest
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient, type Channel, type Platform } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaImportRepository } from '../services/ingest';

const prisma = new PrismaClient();
const imports = createPrismaImportRepository(prisma);
const uuid = (): string => randomUUID();

let ORG_A = '';
let ORG_B = '';
let ACCOUNT_A = '';
let ACCOUNT_B = '';
let CONN_BOUND = '';
let CONN_UNBOUND = '';
let CONN_ORG_B = '';

async function seedOrg(suffix: string): Promise<string> {
  const id = uuid();
  await prisma.organization.create({
    data: { id, name: 'X1 gate ' + suffix, slug: 'x1-gate-' + suffix + '-' + uuid().slice(0, 8) },
  });
  return id;
}

async function seedAccount(organizationId: string, platform: Platform, externalAccountId: string): Promise<string> {
  const created = await prisma.platformAccount.create({
    data: { organizationId, platform, externalAccountId, displayName: 'acct ' + externalAccountId },
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

async function newBatch(organizationId: string, connectionId: string | null): Promise<string> {
  const batch = await prisma.importBatch.create({
    data: {
      organizationId,
      connectionId,
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      status: 'PENDING',
    },
  });
  return batch.id;
}

function row(organizationId: string, connectionId: string | null, batchId: string, externalId: string) {
  return {
    organizationId,
    connectionId,
    importBatchId: batchId,
    domain: 'PLATFORM' as const,
    channel: 'AMAZON_OTHER' as const,
    externalId,
    referenceType: 'ORDER' as const,
    occurredAt: new Date('2026-09-08T00:00:00.000Z'),
    amount: '100.0000',
    currency: 'USD',
    dedupeKey: uuid(),
    raw: { externalId },
  };
}

async function counts(organizationId: string) {
  return {
    transactions: await prisma.sourceTransaction.count({ where: { organizationId } }),
    facts: await prisma.canonicalFact.count({ where: { organizationId } }),
    opportunities: await prisma.recoveryOpportunity.count({ where: { organizationId } }),
    claimItems: await prisma.claimItem.count({ where: { organizationId } }),
  };
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
  ACCOUNT_A = await seedAccount(ORG_A, 'AMAZON', 'SELLER-A');
  ACCOUNT_B = await seedAccount(ORG_B, 'AMAZON', 'SELLER-B');
  CONN_BOUND = await seedConnection(ORG_A, 'AMAZON_OTHER', 'bound A', ACCOUNT_A);
  CONN_UNBOUND = await seedConnection(ORG_A, 'AMAZON_OTHER', 'legacy unbound A', null);
  CONN_ORG_B = await seedConnection(ORG_B, 'AMAZON_OTHER', 'bound B', ACCOUNT_B);
});

describe('TRACK B BATCH 1 — Account Lineage Runtime Gate', () => {
  it('unbound connection ingest → stable reject（PLATFORM_ACCOUNT_REQUIRED），零写入', async () => {
    const batch = await newBatch(ORG_A, CONN_UNBOUND);
    await expect(
      imports.insertTransactions([row(ORG_A, CONN_UNBOUND, batch, 'ORDER-UNBOUND')]),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);

    expect(await counts(ORG_A)).toEqual({
      transactions: 0,
      facts: 0,
      opportunities: 0,
      claimItems: 0,
    });
  });

  it('bound connection ingest → PASS，且 SourceTransaction / CanonicalFact 均为绑定的 PlatformAccount', async () => {
    const batch = await newBatch(ORG_A, CONN_BOUND);
    const result = await imports.insertTransactions([row(ORG_A, CONN_BOUND, batch, 'ORDER-BOUND')]);
    expect(result.inserted).toBe(1);

    const transaction = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG_A, externalId: 'ORDER-BOUND' },
    });
    expect(transaction.accountId).toBe(ACCOUNT_A);

    const facts = await prisma.canonicalFact.findMany({ where: { organizationId: ORG_A } });
    expect(facts).toHaveLength(1);
    expect(facts[0].accountId).toBe(ACCOUNT_A);
    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('缺少连接上下文（connectionId = null）→ fail-closed，零写入', async () => {
    const batch = await newBatch(ORG_A, null);
    await expect(
      imports.insertTransactions([row(ORG_A, null, batch, 'ORDER-NO-CONN')]),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await counts(ORG_A)).toEqual({ transactions: 0, facts: 0, opportunities: 0, claimItems: 0 });
  });

  it('跨租户连接（Org B 的连接用于 Org A ingest）→ fail-closed，零写入', async () => {
    // 注意：ImportBatch 自身也受 cc_tenant_ImportBatch 保护（跨租户连接无法开批次），
    // 因此这里用 Org A 的批次（connectionId = null）+ 外来 connectionId 直接打 ingest 门禁，
    // 验证 Account Lineage Runtime Gate 本身不会跨租户解析出 Org B 的 account。
    const batch = await newBatch(ORG_A, null);
    await expect(
      imports.insertTransactions([row(ORG_A, CONN_ORG_B, batch, 'ORDER-CROSS-TENANT')]),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await counts(ORG_A)).toEqual({ transactions: 0, facts: 0, opportunities: 0, claimItems: 0 });
    expect(await counts(ORG_B)).toEqual({ transactions: 0, facts: 0, opportunities: 0, claimItems: 0 });
  });

  it('client 提交 accountId → CLIENT_ACCOUNT_FIELD_NOT_TRUSTED，绝不作为可信 lineage', async () => {
    const batch = await newBatch(ORG_A, CONN_BOUND);
    const spoofed = { ...row(ORG_A, CONN_BOUND, batch, 'ORDER-SPOOF'), accountId: ACCOUNT_B };
    await expect(imports.insertTransactions([spoofed as never])).rejects.toThrow(
      /CLIENT_ACCOUNT_FIELD_NOT_TRUSTED/,
    );
    expect(await counts(ORG_A)).toEqual({ transactions: 0, facts: 0, opportunities: 0, claimItems: 0 });
  });

  it('legacy unbound connection 仍可读取，但不可启动新的 ingest', async () => {
    const readable = await prisma.sourceConnection.findFirstOrThrow({
      where: { id: CONN_UNBOUND, organizationId: ORG_A },
      select: { id: true, platformAccountId: true },
    });
    expect(readable.platformAccountId).toBeNull();

    const batch = await newBatch(ORG_A, CONN_UNBOUND);
    await expect(
      imports.insertTransactions([row(ORG_A, CONN_UNBOUND, batch, 'ORDER-LEGACY')]),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await counts(ORG_A)).toEqual({ transactions: 0, facts: 0, opportunities: 0, claimItems: 0 });
  });
});
