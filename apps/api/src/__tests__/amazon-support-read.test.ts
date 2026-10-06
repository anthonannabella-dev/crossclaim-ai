// PROVIDER FOLLOW-UP INTELLIGENCE / P2 —— Amazon Support 只读 adapter 契约回归（无数据库、无网络）

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  AMAZON_SUPPORT_ADAPTER_ID,
  AMAZON_SUPPORT_ADAPTER_VERSION,
  AMAZON_SUPPORT_READ_OPERATIONS,
  PROVIDER_SUPPORT_BOUNDARY,
  ProviderSupportError,
  assertAmazonSupportWriteForbidden,
  assertProviderReadScope,
  createAmazonSupportCaseAdapter,
  createAmazonSupportFixtureTransport,
  defaultAmazonSupportFixture,
  readAllAmazonSupportContacts,
  safeCredentialLabel,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T06:30:00.000Z');
const SCOPE = {
  organizationId: 'org-1',
  platformAccountId: 'acct-A',
  credentialRef: 'cred-amazon-A',
  connectionRef: 'conn-amazon-A',
} as const;

function adapter(options: Parameters<typeof createAmazonSupportFixtureTransport>[0]) {
  return createAmazonSupportCaseAdapter({
    transport: createAmazonSupportFixtureTransport(options),
    now: () => NOW,
  });
}

describe('P2 Amazon Support · 只读映射', () => {
  it('listCases → 统一 ProviderCase（状态归一、附件计数、来源可追溯）', async () => {
    const port = adapter(defaultAmazonSupportFixture());
    const page = await port.listCases({ ...SCOPE });
    expect(page.items).toHaveLength(2); // fixture pageSize = 2
    const first = page.items[0];
    expect(first.ref).toEqual({
      organizationId: 'org-1',
      platformAccountId: 'acct-A',
      platform: 'AMAZON',
      providerCaseId: 'case-1001',
    });
    expect(first.status).toBe('PENDING_MERCHANT_ACTION');
    expect(first.attachmentCount).toBe(1);
    expect(first.contactKinds).toEqual(['EMAIL']);
    expect(first.source.adapterId).toBe(AMAZON_SUPPORT_ADAPTER_ID);
    expect(first.source.adapterVersion).toBe(AMAZON_SUPPORT_ADAPTER_VERSION);
    expect(first.source.credentialRef).toBe('cred-amazon-A');
    expect(first.source.fetchedAt).toBe(NOW.toISOString());
    expect(page.nextToken).toBe('2');

    const second = await port.listCases({ ...SCOPE, nextToken: page.nextToken });
    expect(second.items.map((c) => c.ref.providerCaseId)).toEqual(['case-1003']);
    expect(second.nextToken).toBeUndefined();
  });

  it('getCase → ProviderCase；未知 case → NOT_FOUND（不猜测）', async () => {
    const port = adapter(defaultAmazonSupportFixture());
    const found = await port.getCase({ ...SCOPE, caseId: 'case-1002' });
    expect(found?.ref.providerCaseId).toBe('case-1002');
    expect(found?.contactKinds).toEqual(['EMAIL', 'CHAT']);
    await expect(port.getCase({ ...SCOPE, caseId: 'case-nope' })).rejects.toMatchObject({
      code: 'PROVIDER_SUPPORT_NOT_FOUND',
    });
  });

  it('listContacts → ProviderContact（kind/direction/bodyDigest + 附件只读引用）', async () => {
    const port = adapter(defaultAmazonSupportFixture());
    const page = await port.listContacts({ ...SCOPE, caseId: 'case-1002' });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      contactId: 'ct-2',
      providerCaseId: 'case-1002',
      kind: 'EMAIL',
      direction: 'INBOUND',
    });
    expect(page.items[0].bodyText).toContain('commercial invoice');
    expect(page.items[0].bodyDigest).toHaveLength(64);
    expect(page.items[1]).toMatchObject({ kind: 'CHAT', direction: 'OUTBOUND' });
  });

  it('getAttachmentMetadata 只返回引用（referenceOnly，不含内容/下载）', async () => {
    const port = adapter(defaultAmazonSupportFixture());
    const meta = await port.getAttachmentMetadata({ ...SCOPE, caseId: 'case-1001', attachmentId: 'att-1' });
    expect(meta).toMatchObject({
      attachmentId: 'att-1',
      providerCaseId: 'case-1001',
      filename: 'case-summary.pdf',
      contentType: 'application/pdf',
      byteSize: 20480,
      referenceOnly: true,
    });
    expect(Object.keys(meta ?? {})).not.toContain('content');
    expect(
      await port.getAttachmentMetadata({ ...SCOPE, caseId: 'case-1001', attachmentId: 'att-missing' }),
    ).toBeNull();
  });

  it('分页：readAllAmazonSupportContacts 受 maxPages 约束，超限 fail-closed', async () => {
    const port = adapter(defaultAmazonSupportFixture());
    const contacts = await readAllAmazonSupportContacts(port, { ...SCOPE, caseId: 'case-1002', pageSize: 1 });
    expect(contacts.map((c) => c.contactId)).toEqual(['ct-2', 'ct-3']);

    await expect(
      readAllAmazonSupportContacts(port, { ...SCOPE, caseId: 'case-1002', pageSize: 1, maxPages: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_PAGINATION_INVALID' });
  });
});

describe('P2 Amazon Support · 归属隔离与凭据边界', () => {
  it('scope 必填：缺 organizationId / platformAccountId / credentialRef → fail-closed', async () => {
    const port = adapter(defaultAmazonSupportFixture());
    await expect(
      port.listCases({ organizationId: '', platformAccountId: 'acct-A', credentialRef: 'c' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_SCOPE_REQUIRED' });
    await expect(
      port.listCases({ organizationId: 'org-1', platformAccountId: '', credentialRef: 'c' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_SCOPE_REQUIRED' });
    await expect(
      port.listCases({ organizationId: 'org-1', platformAccountId: 'acct-A', credentialRef: '  ' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_SCOPE_REQUIRED' });
    expect(() => assertProviderReadScope(SCOPE)).not.toThrow();
  });

  it('account 隔离：其他 account 看不到本 account 的 case（fixture 分片）', async () => {
    const port = adapter(defaultAmazonSupportFixture());
    await expect(
      port.getCase({ ...SCOPE, platformAccountId: 'acct-B', caseId: 'case-1001' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_NOT_FOUND' });
    const other = await port.listCases({ ...SCOPE, platformAccountId: 'acct-B' });
    expect(other.items.map((c) => c.ref.providerCaseId)).toEqual(['case-2001']);
    expect(other.items[0].ref.platformAccountId).toBe('acct-B');
  });

  it('归属来自调用方：payload 无法改写 organizationId/platformAccountId', async () => {
    const port = adapter(defaultAmazonSupportFixture());
    const page = await port.listCases({ ...SCOPE, organizationId: 'org-2' });
    expect(page.items.every((c) => c.ref.organizationId === 'org-2')).toBe(true);
    expect(page.items.every((c) => c.ref.platformAccountId === 'acct-A')).toBe(true);
  });

  it('凭据绝不进入错误信息（只在内部以 credentialRef 形式使用）', async () => {
    const secretLike = 'cred-amazon-SUPER-SECRET';
    const port = adapter({ ...defaultAmazonSupportFixture(), forceStatus: 403 });
    try {
      await port.listCases({ ...SCOPE, credentialRef: secretLike });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSupportError);
      const message = (error as Error).message;
      expect(message).not.toContain(secretLike);
      expect(message).toContain('credentialRef#cred***');
      expect((error as ProviderSupportError).code).toBe('PROVIDER_SUPPORT_CREDENTIAL_REVOKED');
    }
    expect(safeCredentialLabel(secretLike)).toBe('credentialRef#cred***');
    expect(safeCredentialLabel('')).toBe('<missing>');
  });

  it('stale credential(401) / transport 5xx / 异常 transport → 各自 fail-closed 语义', async () => {
    await expect(
      adapter({ ...defaultAmazonSupportFixture(), forceStatus: 401 }).listCases({ ...SCOPE }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_CREDENTIAL_UNAVAILABLE' });
    await expect(
      adapter({ ...defaultAmazonSupportFixture(), forceStatus: 503 }).listCases({ ...SCOPE }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_TRANSPORT_FAILED' });

    const throwing = createAmazonSupportCaseAdapter({
      transport: {
        async get() {
          throw new Error('socket hang up');
        },
      },
      now: () => NOW,
    });
    await expect(throwing.listCases({ ...SCOPE })).rejects.toMatchObject({
      code: 'PROVIDER_SUPPORT_TRANSPORT_FAILED',
    });
  });

  it('malformed provider payload / 非法 pageSize → fail-closed', async () => {
    await expect(
      adapter({ ...defaultAmazonSupportFixture(), malformed: true }).listCases({ ...SCOPE }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SUPPORT_MALFORMED_PAYLOAD' });
    const port = adapter(defaultAmazonSupportFixture());
    await expect(port.listCases({ ...SCOPE, pageSize: 0 })).rejects.toMatchObject({
      code: 'PROVIDER_SUPPORT_PAGINATION_INVALID',
    });
    await expect(port.listCases({ ...SCOPE, pageSize: 999 })).rejects.toMatchObject({
      code: 'PROVIDER_SUPPORT_PAGINATION_INVALID',
    });
    await expect(port.getCase({ ...SCOPE, caseId: '' })).rejects.toMatchObject({
      code: 'PROVIDER_SUPPORT_MALFORMED_PAYLOAD',
    });
  });
});

describe('P2 Amazon Support · 只读边界断言（长期安全）', () => {
  it('只暴露读取能力：模块导出不含任何 write / create / reply / upload 入口', () => {
    const exported = Object.keys(providerSupport);
    for (const name of exported) {
      expect(name).not.toMatch(/createSellerSupportCase|submitFbaReimbursementClaim|replyCase|uploadFollowUpEvidence/i);
    }
    expect(AMAZON_SUPPORT_READ_OPERATIONS).toEqual(['listCases', 'getCase', 'listContacts', 'getAttachmentMetadata']);
    expect(PROVIDER_SUPPORT_BOUNDARY.readOnly).toBe(true);
    expect(PROVIDER_SUPPORT_BOUNDARY.forbidden).toContain('replyCase');
    expect(PROVIDER_SUPPORT_BOUNDARY.forbidden).toContain('uploadFollowUpEvidence');
    expect(PROVIDER_SUPPORT_BOUNDARY.noCredentialLogging).toBe(true);
    expect(PROVIDER_SUPPORT_BOUNDARY.providerAssertedOrganizationIsNotAuthoritative).toBe(true);
  });

  it('任何写操作调用（create/reply/upload）都 fail-closed', () => {
    for (const operation of ['createSellerSupportCase', 'replyCase', 'uploadFollowUpEvidence']) {
      expect(() => assertAmazonSupportWriteForbidden(operation)).toThrow(ProviderSupportError);
      try {
        assertAmazonSupportWriteForbidden(operation);
      } catch (error) {
        expect((error as ProviderSupportError).code).toBe('PROVIDER_SUPPORT_WRITE_FORBIDDEN');
      }
    }
  });

  it('adapter 实例只带 4 个读取入口（不泄漏 transport）', () => {
    const port = adapter(defaultAmazonSupportFixture());
    expect(Object.keys(port).sort()).toEqual(['getAttachmentMetadata', 'getCase', 'listCases', 'listContacts']);
  });
});
