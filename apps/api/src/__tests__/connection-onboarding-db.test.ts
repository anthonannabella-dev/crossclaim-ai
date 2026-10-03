/**
 * TRACK B BATCH 3 —— Connection Onboarding / Explicit Rebind 验收（真实 PostgreSQL）
 * MSG-20261002-77 ③ BATCH 3 / B3-1 · B3-2 · B3-3 · B3-4 · B3-5 · B3-6
 *
 * 覆盖（架构方指定验收标准）：
 *   1. new active connection without account → reject
 *   2. new connection bind existing Account A → PASS
 *   3. create-and-bind new PlatformAccount → PASS
 *   4. foreign tenant PlatformAccount → reject
 *   5. legacy unbound connection remains readable
 *   6. legacy unbound before rebind → ingest reject
 *   7. explicit rebind NULL → A → PASS
 *   8. rebind 后新 ingest → SourceTransaction.accountId = A
 *   9. rebind 不修改历史 NULL SourceTransaction
 *  10. rebind 不修改历史 NULL CanonicalFact
 *  11. rebind 不修改历史 NULL RecoveryOpportunity / ClaimItem
 *  12. second rebind A → B → reject（ACCOUNT_BINDING_IMMUTABLE）
 *  13. credential rotation 后 identityVersion 不变
 *  14. audit record 存在且不含 secret / credential body
 *  15. client 提供的 account 不能冒充 CREATE_AND_BIND 的 identity
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient, type Channel, type Platform } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaImportRepository } from '../services/ingest';
import { rotateConnectionCredentialRef } from '../services/workflow/connection-management';
import {
  assertConnectionUsableForActiveFacts,
  connectionAccountState,
  connectionCapabilities,
  createAccountScopedConnection,
  createVerifiedAccountScopedConnection,
  rebindLegacyConnection,
} from '../services/workflow/connection-onboarding';

const prisma = new PrismaClient();
const imports = createPrismaImportRepository(prisma);
const uuid = (): string => randomUUID();

const NOW = new Date('2026-09-08T00:00:00.000Z');

let ORG_A = '';
let ORG_B = '';
let ACCOUNT_A = '';
let ACCOUNT_B = '';
let ACTOR_ID = '';

async function seedOrg(suffix: string): Promise<string> {
  const id = uuid();
  await prisma.organization.create({
    data: { id, name: 'B3 ' + suffix, slug: 'b3-' + suffix + '-' + uuid().slice(0, 8) },
  });
  return id;
}

async function seedAccount(
  organizationId: string,
  platform: Platform,
  externalAccountId: string,
): Promise<string> {
  const created = await prisma.platformAccount.create({
    data: { organizationId, platform, externalAccountId, displayName: 'acct ' + externalAccountId },
  });
  return created.id;
}

/** legacy unbound：历史遗留连接，platformAccountId = NULL，只读冻结（不得 ACTIVE）。 */
async function seedLegacyUnboundConnection(
  organizationId: string,
  channel: Channel,
  label: string,
): Promise<string> {
  const created = await prisma.sourceConnection.create({
    data: {
      organizationId,
      domain: 'PLATFORM',
      channel,
      kind: 'FILE_UPLOAD',
      status: 'NEEDS_AUTH',
      label,
      platformAccountId: null,
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

const actor = () => ({ organizationId: ORG_A, actorUserId: ACTOR_ID, role: 'OWNER' });

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "ClaimItem", "Case", "RecoveryOpportunity", "CanonicalFactSource", "CanonicalFact", "SourceTransaction", "ImportBatch", "SourceConnection", "PlatformAccount", "Membership", "User", "Organization" CASCADE;',
  );
  ORG_A = await seedOrg('a');
  ORG_B = await seedOrg('b');
  ACCOUNT_A = await seedAccount(ORG_A, 'AMAZON', 'SELLER-A');
  ACCOUNT_B = await seedAccount(ORG_B, 'AMAZON', 'SELLER-B');
  const user = await prisma.user.create({
    data: { email: 'b3-actor-' + ORG_A + '@example.com', displayName: 'b3 actor', status: 'ACTIVE' },
  });
  ACTOR_ID = user.id;
  await prisma.membership.create({
    data: { organizationId: ORG_A, userId: user.id, role: 'OWNER', isActive: true },
  });
});

describe('TRACK B BATCH 3 — B3-1 / B3-4 创建侧不变量', () => {
  it('未提供 account 绑定 → PLATFORM_ACCOUNT_REQUIRED，且零连接', async () => {
    await expect(
      createAccountScopedConnection(prisma, {
        ...actor(),
        label: 'no-binding',
        kind: 'FILE_UPLOAD',
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        account: {},
      }),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await prisma.sourceConnection.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('DB 层拒绝 ACTIVE + platformAccountId = NULL（B3-1 的 DB safety）', async () => {
    await expect(
      prisma.sourceConnection.create({
        data: {
          organizationId: ORG_A,
          domain: 'PLATFORM',
          channel: 'AMAZON_OTHER',
          kind: 'FILE_UPLOAD',
          status: 'ACTIVE',
          label: 'db-active-unbound',
          platformAccountId: null,
        },
      }),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
  });

  it('BIND_EXISTING 已存在账户 → PASS，连接绑定该账户', async () => {
    const created = await createAccountScopedConnection(prisma, {
      ...actor(),
      label: 'bind-existing',
      kind: 'FILE_UPLOAD',
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      account: { mode: 'BIND_EXISTING', platformAccountId: ACCOUNT_A },
    });
    expect(created.platformAccountId).toBe(ACCOUNT_A);
    expect(created.platformAccountCreated).toBe(false);
    const stored = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.platformAccountId).toBe(ACCOUNT_A);
    expect(connectionAccountState(stored)).toBe('BOUND_ACTIVE');
    const capabilities = connectionCapabilities(stored);
    expect(capabilities).toEqual({
      platformAccountId: ACCOUNT_A,
      accountState: 'BOUND_ACTIVE',
      canIngest: true,
      canSync: true,
    });
  });

  it('server-verified create-and-bind 新 PlatformAccount → PASS，identity 来自 platform + externalAccountId + identityVersion', async () => {
    const created = await createVerifiedAccountScopedConnection(prisma, {
      ...actor(),
      label: 'create-and-bind',
      kind: 'FILE_UPLOAD',
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      verification: {
        source: 'ADAPTER_MOCK',
        evidenceRef: 'mock:amazon:onboard-1',
        verifiedAt: NOW,
        identity: {
          platform: 'AMAZON',
          externalAccountId: 'SELLER-NEW',
          displayName: '展示名（非 identity）',
        },
      },
    });
    expect(created.platformAccountCreated).toBe(true);
    const account = await prisma.platformAccount.findUniqueOrThrow({ where: { id: created.platformAccountId } });
    expect(account.organizationId).toBe(ORG_A);
    expect(account.platform).toBe('AMAZON');
    expect(account.externalAccountId).toBe('SELLER-NEW');
    expect(account.identityVersion).toBe('v1');
  });

  it('跨租户 PlatformAccount → reject，且零连接', async () => {
    await expect(
      createAccountScopedConnection(prisma, {
        ...actor(),
        label: 'cross-tenant',
        kind: 'FILE_UPLOAD',
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        account: { mode: 'BIND_EXISTING', platformAccountId: ACCOUNT_B },
      }),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await prisma.sourceConnection.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('client 直接提交 CREATE_AND_BIND canonical identity → UNVERIFIED_PLATFORM_IDENTITY（B3/T1）', async () => {
    await expect(
      createAccountScopedConnection(prisma, {
        ...actor(),
        label: 'spoofed',
        kind: 'FILE_UPLOAD',
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        account: {
          mode: 'CREATE_AND_BIND',
          platform: 'AMAZON',
          externalAccountId: 'SELLER-SPOOF',
          displayName: 'spoof attempt',
          platformAccountId: ACCOUNT_B,
        },
      }),
    ).rejects.toThrow(/UNVERIFIED_PLATFORM_IDENTITY/);
    expect(await prisma.sourceConnection.count({ where: { organizationId: ORG_A } })).toBe(0);

    // 同一 identity 经 server-verified transport 才会被接受，且 identity 取自 verification
    const verified = await createVerifiedAccountScopedConnection(prisma, {
      ...actor(),
      label: 'verified-spoof-proof',
      kind: 'FILE_UPLOAD',
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      verification: {
        source: 'ADAPTER_MOCK',
        evidenceRef: 'mock:amazon:onboard-2',
        verifiedAt: NOW,
        identity: { platform: 'AMAZON', externalAccountId: 'SELLER-SPOOF', displayName: 'verified' },
      },
    });
    expect(verified.platformAccountId).not.toBe(ACCOUNT_B);
    const account = await prisma.platformAccount.findUniqueOrThrow({ where: { id: verified.platformAccountId } });
    expect(account.organizationId).toBe(ORG_A);
    expect(account.externalAccountId).toBe('SELLER-SPOOF');
  });

  it('缺少 / 空 evidenceRef 的 verification → UNVERIFIED_PLATFORM_IDENTITY', async () => {
    await expect(
      createVerifiedAccountScopedConnection(prisma, {
        ...actor(),
        label: 'bad-verification',
        kind: 'FILE_UPLOAD',
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        verification: {
          source: 'ADAPTER_MOCK',
          evidenceRef: '   ',
          verifiedAt: NOW,
          identity: { platform: 'AMAZON', externalAccountId: 'SELLER-X', displayName: 'x' },
        },
      }),
    ).rejects.toThrow(/UNVERIFIED_PLATFORM_IDENTITY/);
  });
});

describe('TRACK B BATCH 3 — B3-2 / B3-5 / B3-6 legacy 显式 rebind', () => {
  it('legacy unbound 仍可读；rebind 前 ingest reject（零 SourceTransaction）', async () => {
    const connectionId = await seedLegacyUnboundConnection(ORG_A, 'AMAZON_OTHER', 'legacy-read-only');
    const readable = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(readable.platformAccountId).toBeNull();
    expect(connectionAccountState(readable)).toBe('UNBOUND');
    expect(() => assertConnectionUsableForActiveFacts(readable)).toThrow(/PLATFORM_ACCOUNT_REQUIRED/);

    const batchId = await newBatch(ORG_A, connectionId);
    await expect(
      imports.insertTransactions([row(ORG_A, connectionId, batchId, 'ORDER-LEGACY-PRE')]),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('rebind NULL → A → PASS；新 ingest 使用 A；历史 NULL 事实零改动', async () => {
    const connectionId = await seedLegacyUnboundConnection(ORG_A, 'AMAZON_OTHER', 'legacy-rebind');
    const legacyTx = await prisma.sourceTransaction.create({
      data: {
        organizationId: ORG_A,
        connectionId,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        externalId: 'ORDER-HISTORY',
        referenceType: 'ORDER',
        occurredAt: new Date('2026-09-01T00:00:00.000Z'),
        amount: '10.0000',
        currency: 'USD',
        dedupeKey: uuid(),
        raw: {},
      },
      select: { id: true },
    });
    const legacyFact = await prisma.canonicalFact.create({
      data: {
        organizationId: ORG_A,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        referenceType: 'ORDER',
        externalId: 'ORDER-HISTORY-FACT',
        factKey: 'ORDER:ORDER-HISTORY-FACT',
        currency: 'USD',
      },
      select: { id: true },
    });
    const legacyOpportunity = await prisma.recoveryOpportunity.create({
      data: {
        organizationId: ORG_A,
        domain: 'LOGISTICS',
        channel: 'AMAZON_OTHER',
        opportunityType: 'FREIGHT_RATE_OVERCHARGE',
        title: 'legacy null opportunity',
        amountExpected: '10.0000',
        amountActual: '12.0000',
        recoverableAmount: '2.0000',
        currency: 'USD',
        status: 'QUALIFIED',
      },
      select: { id: true },
    });
    const legacyClaim = await prisma.claimItem.create({
      data: {
        organizationId: ORG_A,
        platformType: 'AMAZON',
        claimType: 'FBA_LOSS_LEGACY',
        occurredAt: new Date('2026-09-01T00:00:00.000Z'),
        status: 'DISCOVERED',
        normalizerVersion: 'normalizer-1.0.0',
      },
      select: { id: true },
    });

    const rebound = await rebindLegacyConnection(prisma, {
      ...actor(),
      connectionId,
      targetPlatformAccountId: ACCOUNT_A,
      reason: '客户确认该历史连接归属 SELLER-A',
    });
    expect(rebound.platformAccountId).toBe(ACCOUNT_A);
    const stored = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(stored.platformAccountId).toBe(ACCOUNT_A);

    // rebind 只改变未来行为：历史 NULL 事实必须原样保留
    expect((await prisma.sourceTransaction.findUniqueOrThrow({ where: { id: legacyTx.id } })).accountId).toBeNull();
    expect((await prisma.canonicalFact.findUniqueOrThrow({ where: { id: legacyFact.id } })).accountId).toBeNull();
    expect(
      (await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: legacyOpportunity.id } })).accountId,
    ).toBeNull();
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: legacyClaim.id } })).accountId).toBeNull();

    // rebind 之后，新的 ingest 使用追认后的账户
    const batchId = await newBatch(ORG_A, connectionId);
    const result = await imports.insertTransactions([row(ORG_A, connectionId, batchId, 'ORDER-AFTER-REBIND')]);
    expect(result.inserted).toBe(1);
    const created = await prisma.sourceTransaction.findFirstOrThrow({
      where: { organizationId: ORG_A, externalId: 'ORDER-AFTER-REBIND' },
    });
    expect(created.accountId).toBe(ACCOUNT_A);
  });

  it('second rebind（已绑定 → 另一账户）→ ACCOUNT_BINDING_IMMUTABLE', async () => {
    const connectionId = await seedLegacyUnboundConnection(ORG_A, 'AMAZON_OTHER', 'legacy-second');
    await rebindLegacyConnection(prisma, {
      ...actor(),
      connectionId,
      targetPlatformAccountId: ACCOUNT_A,
    });
    const otherAccount = await seedAccount(ORG_A, 'AMAZON', 'SELLER-A2');
    await expect(
      rebindLegacyConnection(prisma, {
        ...actor(),
        connectionId,
        targetPlatformAccountId: otherAccount,
      }),
    ).rejects.toThrow(/ACCOUNT_BINDING_IMMUTABLE/);
    expect((await prisma.sourceConnection.findUniqueOrThrow({ where: { id: connectionId } })).platformAccountId).toBe(
      ACCOUNT_A,
    );
  });

  it('rebind 到跨租户 PlatformAccount → reject，绑定保持 NULL', async () => {
    const connectionId = await seedLegacyUnboundConnection(ORG_A, 'AMAZON_OTHER', 'legacy-cross');
    await expect(
      rebindLegacyConnection(prisma, {
        ...actor(),
        connectionId,
        targetPlatformAccountId: ACCOUNT_B,
      }),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(
      (await prisma.sourceConnection.findUniqueOrThrow({ where: { id: connectionId } })).platformAccountId,
    ).toBeNull();
  });

  it('audit record 存在（bound_to_platform_account）且不含 credential 值', async () => {
    const created = await createAccountScopedConnection(prisma, {
      ...actor(),
      label: 'audited',
      kind: 'API',
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      platform: 'AMAZON',
      credentialRef: 'amazon-prod-key-ref-01',
      account: { mode: 'BIND_EXISTING', platformAccountId: ACCOUNT_A },
    }, { registeredPlatforms: ['AMAZON'] });

    const boundEvents = await prisma.auditLog.findMany({
      where: { organizationId: ORG_A, action: 'source_connection.bound_to_platform_account', entityId: created.id },
    });
    expect(boundEvents).toHaveLength(1);
    const payload = JSON.stringify(boundEvents[0].changes);
    expect(payload).toContain(ACCOUNT_A);
    expect(payload).toContain('"previousBinding":null');
    expect(payload).not.toContain('amazon-prod-key-ref-01');

    const allAudit = await prisma.auditLog.findMany({ where: { organizationId: ORG_A } });
    for (const entry of allAudit) {
      expect(JSON.stringify(entry.changes)).not.toContain('amazon-prod-key-ref-01');
    }
  });
});

describe('TRACK B BATCH 3 — B3-3 / B3-4 身份与状态语义', () => {
  it('credential rotation 不改变 PlatformAccount identityVersion', async () => {
    const created = await createVerifiedAccountScopedConnection(
      prisma,
      {
        ...actor(),
        label: 'rotate-me',
        kind: 'API',
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        platform: 'AMAZON',
        credentialRef: 'ref-before',
        verification: {
          source: 'ADAPTER_MOCK',
          evidenceRef: 'mock:amazon:rotate',
          verifiedAt: NOW,
          identity: {
            platform: 'AMAZON',
            externalAccountId: 'SELLER-ROTATE',
            displayName: 'rotate identity',
            identityVersion: 'v1',
          },
        },
      },
      { registeredPlatforms: ['AMAZON'] },
    );

    await rotateConnectionCredentialRef(prisma, {
      ...actor(),
      connectionId: created.id,
      credentialRef: 'ref-after',
    });

    const account = await prisma.platformAccount.findUniqueOrThrow({ where: { id: created.platformAccountId } });
    expect(account.identityVersion).toBe('v1');
    expect(account.externalAccountId).toBe('SELLER-ROTATE');
    const connection = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(connection.platformAccountId).toBe(created.platformAccountId);
  });

  it('connectionAccountState / assertConnectionUsableForActiveFacts 语义', () => {
    expect(connectionAccountState({ status: 'ACTIVE', platformAccountId: 'A' })).toBe('BOUND_ACTIVE');
    expect(connectionAccountState({ status: 'PAUSED', platformAccountId: 'A' })).toBe('BOUND_INACTIVE');
    expect(connectionAccountState({ status: 'NEEDS_AUTH', platformAccountId: null })).toBe('UNBOUND');
    expect(
      assertConnectionUsableForActiveFacts({ status: 'ACTIVE', platformAccountId: 'A' }),
    ).toBe('A');
    expect(() =>
      assertConnectionUsableForActiveFacts({ status: 'NEEDS_AUTH', platformAccountId: null }),
    ).toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(() =>
      assertConnectionUsableForActiveFacts({ status: 'PAUSED', platformAccountId: 'A' }),
    ).toThrow(/CONNECTION_NOT_ACTIVE/);
  });
});
