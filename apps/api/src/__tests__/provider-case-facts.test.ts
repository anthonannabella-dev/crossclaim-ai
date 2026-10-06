// PROVIDER FOLLOW-UP INTELLIGENCE / P3 —— 事实归一 + projection 纯决策回归（无数据库）

import { describe, expect, it } from 'vitest';

import {
  createAmazonSupportCaseAdapter,
  createAmazonSupportFixtureTransport,
  decideProviderFactAppend,
  defaultAmazonSupportFixture,
  projectProviderCase,
  providerCaseFactDigest,
  providerContactFactDigest,
  toProviderCaseFactRecord,
  toProviderContactFactRecord,
  type ProviderCaseFactInput,
  type ProviderContactFactInput,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T07:00:00.000Z');
const SCOPE = {
  organizationId: 'org-1',
  platformAccountId: 'acct-A',
  credentialRef: 'cred-ref',
} as const;

async function readFixture() {
  const port = createAmazonSupportCaseAdapter({
    transport: createAmazonSupportFixtureTransport(defaultAmazonSupportFixture()),
    now: () => NOW,
  });
  const casePage = await port.listCases({ ...SCOPE, pageSize: 3 });
  const caseItem = casePage.items.find((c) => c.ref.providerCaseId === 'case-1002');
  const contacts = (await port.listContacts({ ...SCOPE, caseId: 'case-1002' })).items;
  if (!caseItem) throw new Error('fixture case 缺失');
  return { caseItem, contacts };
}

describe('P3 事实层 · 摘要与幂等判定', () => {
  it('case 事实摘要只绑定归一化事实内容（fetch 时间不进入摘要；内容变化即变化）', async () => {
    const { caseItem } = await readFixture();
    const digest1 = providerCaseFactDigest(caseItem);
    const digest2 = providerCaseFactDigest({
      ...caseItem,
      source: { ...caseItem.source, fetchedAt: NOW.toISOString() },
    });
    expect(digest1).toBe(digest2);
    expect(digest1).not.toBe(providerCaseFactDigest({ ...caseItem, status: 'RESOLVED' }));
    expect(digest1).not.toBe(providerCaseFactDigest({ ...caseItem, subject: 'changed' }));
  });

  it('contact 事实摘要绑定 contact 内容（kind/body/附件参与）', async () => {
    const { contacts } = await readFixture();
    const contact = contacts[0];
    const base = providerContactFactDigest(contact);
    expect(base).toBe(
      providerContactFactDigest({ ...contact, source: { ...contact.source, fetchedAt: NOW.toISOString() } }),
    );
    expect(base).not.toBe(providerContactFactDigest({ ...contact, kind: 'CHAT' }));
    expect(base).not.toBe(providerContactFactDigest({ ...contact, bodyDigest: 'other' }));
  });

  it('同摘要 → REUSE（不产生第二条事实）；新摘要 → APPEND', () => {
    expect(decideProviderFactAppend(['d1', 'd2'], 'd1')).toEqual({
      kind: 'REUSE',
      reason: 'IDENTICAL_FACT_DIGEST',
    });
    expect(decideProviderFactAppend(['d1'], 'd3')).toEqual({ kind: 'APPEND' });
    expect(decideProviderFactAppend([], 'd1')).toEqual({ kind: 'APPEND' });
  });

  it('事实记录保留 provenance，且 snapshot 不含凭据内容', async () => {
    const { caseItem, contacts } = await readFixture();
    const caseRecord = toProviderCaseFactRecord(caseItem);
    expect(caseRecord.adapterId).toBe('amazon-support-read');
    expect(caseRecord.adapterVersion).toBe('amazon-support-read/v1');
    expect(caseRecord.credentialRef).toBe('cred-ref');
    expect(caseRecord.fetchedAt).toBe(NOW.toISOString());
    expect(caseRecord.snapshot).not.toContain('cred-ref');

    const contactRecord = toProviderContactFactRecord(contacts[0], SCOPE);
    expect(contactRecord.organizationId).toBe('org-1');
    expect(contactRecord.platformAccountId).toBe('acct-A');
    expect(contactRecord.bodyDigest).toHaveLength(64);
  });
});

describe('P3 projection · 只由事实派生', () => {
  const caseFact = (overrides: Partial<ProviderCaseFactInput> = {}): ProviderCaseFactInput => ({
    organizationId: 'org-1',
    platformAccountId: 'acct-A',
    providerCaseId: 'case-1',
    factDigest: 'case-digest-1',
    status: 'PENDING_MERCHANT_ACTION',
    subject: 'need POD',
    lastContactAt: null,
    attachmentCount: 1,
    contactKinds: ['EMAIL'],
    fetchedAt: NOW.toISOString(),
    ...overrides,
  });

  const contactFact = (overrides: Partial<ProviderContactFactInput> = {}): ProviderContactFactInput => ({
    organizationId: 'org-1',
    platformAccountId: 'acct-A',
    providerCaseId: 'case-1',
    contactId: 'ct-1',
    factDigest: 'ct-digest-1',
    kind: 'EMAIL',
    direction: 'INBOUND',
    occurredAt: '2026-10-05T09:00:00.000Z',
    attachmentCount: 0,
    ...overrides,
  });

  it('首次投影：generation=1，计数/种类/lastContactAt 来自事实', () => {
    const projection = projectProviderCase({
      previous: null,
      caseFact: caseFact(),
      contactFacts: [
        contactFact(),
        contactFact({ contactId: 'ct-2', kind: 'CHAT', occurredAt: '2026-10-05T11:00:00.000Z' }),
      ],
      now: NOW,
    });
    expect(projection).toMatchObject({
      status: 'PENDING_MERCHANT_ACTION',
      contactCount: 2,
      attachmentCount: 1,
      contactKinds: 'CHAT,EMAIL',
      generation: 1,
      lastFactDigest: 'case-digest-1',
    });
    expect(projection.lastContactAt).toBe('2026-10-05T11:00:00.000Z');
  });

  it('同 contactId 的多次事实只计一个联系人；附件计数累加', () => {
    const projection = projectProviderCase({
      previous: null,
      caseFact: caseFact({ attachmentCount: 2 }),
      contactFacts: [
        contactFact({ factDigest: 'v1', attachmentCount: 1 }),
        contactFact({ factDigest: 'v2', attachmentCount: 1 }),
      ],
      now: NOW,
    });
    expect(projection.contactCount).toBe(1);
    expect(projection.attachmentCount).toBe(4);
  });

  it('其它 tenant / account 的 contact 事实被忽略（不串线）', () => {
    const projection = projectProviderCase({
      previous: null,
      caseFact: caseFact(),
      contactFacts: [
        contactFact(),
        contactFact({ organizationId: 'org-2', contactId: 'ct-other-org' }),
        contactFact({ platformAccountId: 'acct-B', contactId: 'ct-other-account' }),
      ],
      now: NOW,
    });
    expect(projection.contactCount).toBe(1);
  });

  it('事实推进：generation 单调 +1、firstFactAt 保持；无联系人时沿用 case 事实的 lastContactAt', () => {
    const first = projectProviderCase({ previous: null, caseFact: caseFact(), contactFacts: [], now: NOW });
    const second = projectProviderCase({
      previous: first,
      caseFact: caseFact({
        factDigest: 'case-digest-2',
        status: 'RESOLVED',
        lastContactAt: '2026-10-06T01:00:00.000Z',
      }),
      contactFacts: [],
      now: NOW,
    });
    expect(second.generation).toBe(2);
    expect(second.status).toBe('RESOLVED');
    expect(second.firstFactAt).toBe(first.firstFactAt);
    expect(second.lastContactAt).toBe('2026-10-06T01:00:00.000Z');
  });
});
