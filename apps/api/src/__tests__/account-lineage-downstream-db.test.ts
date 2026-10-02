/**
 * TRACK B BATCH 2 — Downstream Active Fact Lineage Hardening 验收（真实 PostgreSQL）
 * MSG-20261002-75 ⑤ BATCH 2 / B2-1 · B2-2 · B2-3
 * CanonicalFact: account-scoped → 同账户; 未归因/多账户不一致 → reject; legacy NULL 可读; active writer 不能建 NULL。
 * RecoveryOpportunity: lineage 唯一一致 → PASS; 缺失 / canonical A + transaction B → reject 且零 Opportunity。
 * ClaimItem: opportunity 已归因 → PASS（caller 不能伪装）; Opportunity NULL / 跨租户 / 缺 opportunity → reject; legacy NULL 可读。
 */

import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveOpportunityAccount } from '../services/account-lineage/policy';
import { writeCanonicalFactsForTransactions } from '../services/canonical';
import { createClaimItem } from '../services/claim/claim-items';

const prisma = new PrismaClient();
const uuid = (): string => randomUUID();

let ORG = '';
let ORG_B = '';
let ACCOUNT_A = '';
let ACCOUNT_B = '';
let CONN_BOUND = '';
let CONN_UNBOUND = '';
let ACTOR_ID = '';

async function seedOrg(suffix: string): Promise<string> {
  const id = uuid();
  await prisma.organization.create({
    data: { id, name: 'X1 B2 ' + suffix, slug: 'x1-b2-' + suffix + '-' + uuid().slice(0, 8) },
  });
  return id;
}

async function seedAccount(organizationId: string, externalAccountId: string): Promise<string> {
  const created = await prisma.platformAccount.create({
    data: {
      organizationId,
      platform: 'AMAZON',
      externalAccountId,
      displayName: 'acct ' + externalAccountId,
    },
  });
  return created.id;
}

async function seedConnection(organizationId: string, platformAccountId: string | null): Promise<string> {
  const created = await prisma.sourceConnection.create({
    data: {
      organizationId,
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'conn ' + (platformAccountId ? 'bound ' : 'unbound ') + uuid().slice(0, 8),
      platformAccountId,
    },
  });
  return created.id;
}

async function seedTransaction(input: {
  organizationId: string;
  connectionId: string | null;
  accountId: string | null;
  externalId: string;
}): Promise<string> {
  const created = await prisma.sourceTransaction.create({
    data: {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      accountId: input.accountId,
      domain: 'PLATFORM',
      channel: 'AMAZON_OTHER',
      externalId: input.externalId,
      referenceType: 'ORDER',
      occurredAt: new Date('2026-09-08T00:00:00.000Z'),
      amount: new Prisma.Decimal('100.0000'),
      currency: 'USD',
      dedupeKey: uuid(),
      raw: { externalId: input.externalId },
    },
  });
  return created.id;
}

const writeFacts = (transactionIds: string[]) =>
  writeCanonicalFactsForTransactions(prisma as never, {
    organizationId: ORG,
    domain: 'PLATFORM',
    channel: 'AMAZON_OTHER',
    transactionIds,
    observedAt: new Date('2026-09-08T00:00:00.000Z'),
  });

async function seedOpportunity(organizationId: string, accountId: string | null): Promise<string> {
  const created = await prisma.recoveryOpportunity.create({
    data: {
      organizationId,
      accountId,
      domain: 'LOGISTICS',
      channel: 'AMAZON_OTHER',
      opportunityType: 'FREIGHT_RATE_OVERCHARGE',
      title: 'b2 fixture opportunity',
      amountExpected: new Prisma.Decimal('100.0000'),
      amountActual: new Prisma.Decimal('120.0000'),
      recoverableAmount: new Prisma.Decimal('20.0000'),
      currency: 'USD',
      status: 'QUALIFIED',
    },
  });
  return created.id;
}

const NOW = new Date('2026-09-08T00:00:00.000Z');

function claimInput(overrides: Record<string, unknown>) {
  return {
    organizationId: ORG,
    actorUserId: ACTOR_ID,
    role: 'OWNER' as const,
    platformType: 'AMAZON' as const,
    claimType: 'FBA_LOSS',
    platformRef: 'ref-' + uuid().slice(0, 8),
    occurredAt: NOW,
    normalizerVersion: 'normalizer-1.0.0',
    ...overrides,
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
    'TRUNCATE TABLE "AuditLog", "ClaimItemEvidence", "ClaimItem", "CaseEvidence", "CaseOpportunity", "Case", "RecoveryOpportunity", "CanonicalFactSource", "CanonicalFact", "SourceTransaction", "ImportBatch", "SourceConnection", "PlatformAccount", "Membership", "User", "Organization" CASCADE;',
  );
  ORG = await seedOrg('a');
  ORG_B = await seedOrg('b');
  ACCOUNT_A = await seedAccount(ORG, 'SELLER-A');
  ACCOUNT_B = await seedAccount(ORG, 'SELLER-B');
  CONN_BOUND = await seedConnection(ORG, ACCOUNT_A);
  CONN_UNBOUND = await seedConnection(ORG, null);
  const actor = await prisma.user.create({
    data: { email: 'b2-actor-' + ORG + '@example.com', displayName: 'b2 actor', status: 'ACTIVE' },
  });
  ACTOR_ID = actor.id;
  await prisma.membership.create({
    data: { organizationId: ORG, userId: actor.id, role: 'OWNER', isActive: true },
  });
});

describe('TRACK B BATCH 2 — CanonicalFact lineage (B2-1)', () => {
  it('account-scoped transaction → CanonicalFact 同账户 PASS', async () => {
    const txId = await seedTransaction({
      organizationId: ORG,
      connectionId: CONN_BOUND,
      accountId: ACCOUNT_A,
      externalId: 'ORDER-A',
    });
    const result = await writeFacts([txId]);
    expect(result.factsWritten).toBe(1);

    const facts = await prisma.canonicalFact.findMany({ where: { organizationId: ORG } });
    expect(facts).toHaveLength(1);
    expect(facts[0].accountId).toBe(ACCOUNT_A);
  });

  it('transaction 未归因（accountId NULL + 未绑定连接）→ reject 且零 CanonicalFact', async () => {
    const txId = await seedTransaction({
      organizationId: ORG,
      connectionId: CONN_UNBOUND,
      accountId: null,
      externalId: 'ORDER-UNATTRIBUTED',
    });
    await expect(writeFacts([txId])).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await prisma.canonicalFact.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('多来源账户不一致（A / B）→ reject 且零 CanonicalFact', async () => {
    const txA = await seedTransaction({
      organizationId: ORG,
      connectionId: CONN_BOUND,
      accountId: ACCOUNT_A,
      externalId: 'ORDER-SAME',
    });
    const connB = await seedConnection(ORG, ACCOUNT_B);
    const txB = await seedTransaction({
      organizationId: ORG,
      connectionId: connB,
      accountId: ACCOUNT_B,
      externalId: 'ORDER-SAME',
    });
    await expect(writeFacts([txA, txB])).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await prisma.canonicalFact.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('legacy NULL CanonicalFact 仍可读（不参与新写入）', async () => {
    const legacy = await prisma.canonicalFact.create({
      data: {
        organizationId: ORG,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        referenceType: 'ORDER',
        externalId: 'ORDER-LEGACY',
        factKey: 'ORDER:ORDER-LEGACY',
        currency: 'USD',
      },
    });
    const read = await prisma.canonicalFact.findFirstOrThrow({ where: { id: legacy.id } });
    expect(read.accountId).toBeNull();
  });
});

describe('TRACK B BATCH 2 — RecoveryOpportunity lineage (B2-2)', () => {
  it('source lineage Account A → Opportunity A PASS', async () => {
    const txId = await seedTransaction({
      organizationId: ORG,
      connectionId: CONN_BOUND,
      accountId: ACCOUNT_A,
      externalId: 'ORDER-OPP-A',
    });
    const accountId = await resolveOpportunityAccount(prisma as never, {
      organizationId: ORG,
      sourceTransactionId: txId,
    });
    expect(accountId).toBe(ACCOUNT_A);
  });

  it('缺失归因 → reject 且零 Opportunity', async () => {
    const txId = await seedTransaction({
      organizationId: ORG,
      connectionId: CONN_UNBOUND,
      accountId: null,
      externalId: 'ORDER-OPP-MISSING',
    });
    await expect(
      resolveOpportunityAccount(prisma as never, { organizationId: ORG, sourceTransactionId: txId }),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('canonical A + transaction B → reject 且零 Opportunity', async () => {
    const fact = await prisma.canonicalFact.create({
      data: {
        organizationId: ORG,
        accountId: ACCOUNT_A,
        domain: 'PLATFORM',
        channel: 'AMAZON_OTHER',
        referenceType: 'ORDER',
        externalId: 'ORDER-OPP-MIX',
        factKey: 'ORDER:ORDER-OPP-MIX',
        currency: 'USD',
      },
    });
    const connB = await seedConnection(ORG, ACCOUNT_B);
    const txB = await seedTransaction({
      organizationId: ORG,
      connectionId: connB,
      accountId: ACCOUNT_B,
      externalId: 'ORDER-OPP-MIX',
    });
    await expect(
      resolveOpportunityAccount(prisma as never, {
        organizationId: ORG,
        canonicalFactId: fact.id,
        sourceTransactionId: txB,
      }),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(0);
  });
});

describe('TRACK B BATCH 2 — ClaimItem lineage (B2-3)', () => {
  it('opportunity 已归因 → ClaimItem 同账户 PASS；caller 不能伪装 account', async () => {
    const opportunityId = await seedOpportunity(ORG, ACCOUNT_A);
    const result = await createClaimItem(
      prisma,
      claimInput({ opportunityId, accountId: ACCOUNT_B }) as never,
      { now: () => NOW },
    );
    expect(result.created).toBe(true);
    const created = await prisma.claimItem.findUniqueOrThrow({ where: { id: result.id } });
    expect(created.accountId).toBe(ACCOUNT_A);
  });

  it('Opportunity 未归因（accountId NULL）→ reject 且零 ClaimItem', async () => {
    const opportunityId = await seedOpportunity(ORG, null);
    await expect(
      createClaimItem(prisma, claimInput({ opportunityId }), { now: () => NOW }),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await prisma.claimItem.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('跨租户 Opportunity → reject 且零 ClaimItem', async () => {
    const foreignAccount = await seedAccount(ORG_B, 'SELLER-B-TENANT');
    const foreignOpportunityId = await seedOpportunity(ORG_B, foreignAccount);
    await expect(
      createClaimItem(prisma, claimInput({ opportunityId: foreignOpportunityId }), { now: () => NOW }),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect(await prisma.claimItem.count()).toBe(0);
  });

  it('缺少 opportunity 上下文（manual staging）→ reject；legacy NULL ClaimItem 仍可读', async () => {
    await expect(createClaimItem(prisma, claimInput({}), { now: () => NOW })).rejects.toThrow(
      /PLATFORM_ACCOUNT_REQUIRED/,
    );
    expect(await prisma.claimItem.count({ where: { organizationId: ORG } })).toBe(0);

    const legacy = await prisma.claimItem.create({
      data: {
        organizationId: ORG,
        platformType: 'AMAZON',
        claimType: 'FBA_LOSS_LEGACY',
        occurredAt: NOW,
        status: 'DISCOVERED',
        normalizerVersion: 'normalizer-1.0.0',
      },
    });
    const read = await prisma.claimItem.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(read.accountId).toBeNull();
  });
});

describe(
  'TRACK B BATCH 2 R1 —— MSG-20261002-76 永久负路径（B2-A1 / B2-B1 / B2-C1）',
  () => {
    it('B2-A1 transaction.accountId=NULL 但 connection 已绑定 A → CanonicalFact 仍 reject 且零事实', async () => {
      const txId = await seedTransaction({
        organizationId: ORG,
        connectionId: CONN_BOUND, // connection 当前绑定 ACCOUNT_A
        accountId: null, // transaction 自身 stored provenance = NULL
        externalId: 'ORDER-NULL-TX-BOUND-CONN',
      });
      await expect(writeFacts([txId])).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
      expect(await prisma.canonicalFact.count({ where: { organizationId: ORG } })).toBe(0);
    });

    it('B2-B1 同构造 → Opportunity lineage 仍 reject 且零 Opportunity（不得追溯 connection binding）', async () => {
      const txId = await seedTransaction({
        organizationId: ORG,
        connectionId: CONN_BOUND,
        accountId: null,
        externalId: 'ORDER-OPP-NULL-TX-BOUND-CONN',
      });
      await expect(
        resolveOpportunityAccount(prisma as never, { organizationId: ORG, sourceTransactionId: txId }),
      ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
      expect(await prisma.recoveryOpportunity.count({ where: { organizationId: ORG } })).toBe(0);
    });

    it('B2-C1 Opportunity A + trustedConnection B → reject 且零 ClaimItem（禁止 priority winner）', async () => {
      const opportunityId = await seedOpportunity(ORG, ACCOUNT_A);
      const connToB = await seedConnection(ORG, ACCOUNT_B);
      await expect(
        createClaimItem(
          prisma,
          claimInput({ opportunityId, trustedConnectionId: connToB }),
          { now: () => NOW },
        ),
      ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
      expect(await prisma.claimItem.count({ where: { organizationId: ORG } })).toBe(0);
    });

    it('B2-C2 正路径 Opportunity A + trustedConnection A → ClaimItem A PASS（一致性校验不误伤合法路径）', async () => {
      const opportunityId = await seedOpportunity(ORG, ACCOUNT_A);
      const result = await createClaimItem(
        prisma,
        claimInput({ opportunityId, trustedConnectionId: CONN_BOUND }),
        { now: () => NOW },
      );
      expect(result.created).toBe(true);
      const created = await prisma.claimItem.findUniqueOrThrow({ where: { id: result.id } });
      expect(created.accountId).toBe(ACCOUNT_A);
    });

    it('B2-C3 connector 路径（仅 trustedConnectionId，无 opportunity）→ ClaimItem 使用连接绑定账户', async () => {
      const result = await createClaimItem(prisma, claimInput({ trustedConnectionId: CONN_BOUND }), {
        now: () => NOW,
      });
      expect(result.created).toBe(true);
      const created = await prisma.claimItem.findUniqueOrThrow({ where: { id: result.id } });
      expect(created.accountId).toBe(ACCOUNT_A);
    });
  },
);
