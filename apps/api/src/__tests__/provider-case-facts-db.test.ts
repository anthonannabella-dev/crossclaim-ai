// PROVIDER FOLLOW-UP INTELLIGENCE / P3 —— 真实 PostgreSQL 验收（append-only 事实 + projection 派生）

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createAmazonSupportCaseAdapter,
  createAmazonSupportFixtureTransport,
  defaultAmazonSupportFixture,
  listProviderCaseFacts,
  listProviderContactFacts,
  readProviderCaseProjection,
  recordProviderCaseSnapshot,
  type ProviderCase,
  type ProviderContact,
} from '../services/provider-support';

const prisma = new PrismaClient();
const NOW = new Date('2026-10-06T07:30:00.000Z');
const SCOPE = {
  organizationId: 'org-facts-1',
  platformAccountId: 'acct-A',
  credentialRef: 'cred-ref',
} as const;

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ProviderCaseProjection", "ProviderContactFact", "ProviderCaseFact" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncate();
});

afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

async function fixturePair(
  caseId = 'case-1002',
  mutate?: (caseItem: ProviderCase, contacts: ProviderContact[]) => void,
): Promise<{ caseItem: ProviderCase; contacts: ProviderContact[] }> {
  const port = createAmazonSupportCaseAdapter({
    transport: createAmazonSupportFixtureTransport(defaultAmazonSupportFixture()),
    now: () => NOW,
  });
  const caseItem = (await port.listCases({ ...SCOPE, pageSize: 3 })).items.find(
    (c) => c.ref.providerCaseId === caseId,
  );
  if (!caseItem) throw new Error('fixture case 缺失');
  const contacts = (await port.listContacts({ ...SCOPE, caseId })).items;
  mutate?.(caseItem, contacts);
  return { caseItem, contacts };
}

describe('P3 事实层 · 落库 / 幂等 / 投影', () => {
  it('PG-F1 首次写入：case 事实 1 条 + contact 事实 N 条 + 投影 generation=1', async () => {
    const { caseItem, contacts } = await fixturePair();
    const result = await recordProviderCaseSnapshot(prisma, { scope: SCOPE, caseItem, contacts, now: NOW });
    expect(result.caseFact.kind).toBe('APPENDED');
    expect(result.contactFacts.every((c) => c.kind === 'APPENDED')).toBe(true);
    expect(result.projectionAdvanced).toBe(true);
    expect(result.projection).toMatchObject({
      providerCaseId: 'case-1002',
      generation: 1,
      contactCount: 2,
      status: 'PENDING_MERCHANT_ACTION',
    });
    expect(await prisma.providerCaseFact.count()).toBe(1);
    expect(await prisma.providerContactFact.count()).toBe(2);
    expect(await prisma.providerCaseProjection.count()).toBe(1);
  });

  it('PG-F2 重复读取同一快照：全部 REUSE，projection 不推进（幂等）', async () => {
    const first = await fixturePair();
    await recordProviderCaseSnapshot(prisma, {
      scope: SCOPE,
      caseItem: first.caseItem,
      contacts: first.contacts,
      now: NOW,
    });
    const second = await fixturePair();
    const result = await recordProviderCaseSnapshot(prisma, {
      scope: SCOPE,
      caseItem: second.caseItem,
      contacts: second.contacts,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(result.caseFact.kind).toBe('REUSED');
    expect(result.contactFacts.every((c) => c.kind === 'REUSED')).toBe(true);
    expect(result.projectionAdvanced).toBe(false);
    expect(result.projection.generation).toBe(1);
    expect(await prisma.providerCaseFact.count()).toBe(1);
    expect(await prisma.providerContactFact.count()).toBe(2);
  });

  it('PG-F3 状态推进：新增事实（历史保留）+ projection generation=2 + lastFactDigest 更新', async () => {
    const first = await fixturePair();
    const firstResult = await recordProviderCaseSnapshot(prisma, {
      scope: SCOPE,
      caseItem: first.caseItem,
      contacts: first.contacts,
      now: NOW,
    });
    const changed = await fixturePair('case-1002', (caseItem, contacts) => {
      caseItem.status = 'RESOLVED';
      contacts.push({
        contactId: 'ct-9',
        providerCaseId: 'case-1002',
        kind: 'EMAIL',
        direction: 'INBOUND',
        occurredAt: '2026-10-06T07:00:00.000Z',
        bodyText: 'Reimbursement approved.',
        bodyDigest: 'digest-9',
        attachments: [],
        source: caseItem.source,
      });
    });
    const secondResult = await recordProviderCaseSnapshot(prisma, {
      scope: SCOPE,
      caseItem: changed.caseItem,
      contacts: changed.contacts,
      now: new Date(NOW.getTime() + 3_600_000),
    });
    expect(secondResult.caseFact.kind).toBe('APPENDED');
    expect(secondResult.projection.generation).toBe(2);
    expect(secondResult.projection.status).toBe('RESOLVED');
    expect(secondResult.projection.lastFactDigest).not.toBe(firstResult.projection.lastFactDigest);
    expect(await listProviderCaseFacts(prisma, { ...SCOPE, providerCaseId: 'case-1002' })).toHaveLength(2);
    expect(await listProviderContactFacts(prisma, { ...SCOPE, providerCaseId: 'case-1002' })).toHaveLength(3);
  });

  it('PG-F4 事实 append-only：UPDATE / DELETE 一律拒绝', async () => {
    const { caseItem, contacts } = await fixturePair();
    await recordProviderCaseSnapshot(prisma, { scope: SCOPE, caseItem, contacts, now: NOW });
    await expect(
      prisma.$executeRawUnsafe('UPDATE "ProviderCaseFact" SET "status" = $1', 'CLOSED'),
    ).rejects.toThrow(/PROVIDER_CASE_FACT_APPEND_ONLY/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM "ProviderContactFact"')).rejects.toThrow(
      /PROVIDER_CASE_FACT_APPEND_ONLY/,
    );
  });

  it('PG-F5 归属隔离：其它 account / tenant 看不到本 account 的事实与投影', async () => {
    const { caseItem, contacts } = await fixturePair();
    await recordProviderCaseSnapshot(prisma, { scope: SCOPE, caseItem, contacts, now: NOW });
    expect(
      await readProviderCaseProjection(prisma, {
        ...SCOPE,
        platformAccountId: 'acct-B',
        providerCaseId: 'case-1002',
      }),
    ).toBeNull();
    expect(
      await readProviderCaseProjection(prisma, {
        ...SCOPE,
        organizationId: 'org-other',
        providerCaseId: 'case-1002',
      }),
    ).toBeNull();
    expect(
      await listProviderCaseFacts(prisma, { ...SCOPE, platformAccountId: 'acct-B', providerCaseId: 'case-1002' }),
    ).toHaveLength(0);
  });

  it('PG-F6 跨归属写入被拒：scope 与 case 不一致 / contact 与 case 不一致 → fail-closed', async () => {
    const { caseItem, contacts } = await fixturePair();
    await expect(
      recordProviderCaseSnapshot(prisma, {
        scope: SCOPE,
        caseItem: { ...caseItem, ref: { ...caseItem.ref, organizationId: 'org-other' } },
        contacts,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_SCOPE_REQUIRED' });
    await expect(
      recordProviderCaseSnapshot(prisma, {
        scope: SCOPE,
        caseItem,
        contacts: [{ ...contacts[0], providerCaseId: 'case-9999' }],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_SCOPE_REQUIRED' });
  });

  it('PG-F7 projection 身份不可改写 / generation 不得回退 / 事实不可改写', async () => {
    const { caseItem, contacts } = await fixturePair();
    const result = await recordProviderCaseSnapshot(prisma, {
      scope: SCOPE,
      caseItem,
      contacts,
      now: NOW,
    });
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ProviderCaseProjection" SET "organizationId" = $1 WHERE "providerCaseId" = $2',
        'org-other',
        result.projection.providerCaseId,
      ),
    ).rejects.toThrow(/PROVIDER_CASE_PROJECTION_IDENTITY_IMMUTABLE|tenant/i);
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ProviderCaseProjection" SET "generation" = $1 WHERE "providerCaseId" = $2',
        0,
        result.projection.providerCaseId,
      ),
    ).rejects.toThrow(/PROVIDER_CASE_PROJECTION_IDENTITY_IMMUTABLE/);
    await expect(
      prisma.$executeRawUnsafe('UPDATE "ProviderCaseFact" SET "factDigest" = $1', 'tampered'),
    ).rejects.toThrow(/APPEND_ONLY|IMMUTABLE/);
  });
});
