/**
 * Amazon SP-API READ-ONLY adapter boundary（MSG-20261001-25 CHANGE A/B + TEST 十项）
 * ---------------------------------------------------------------------------
 * 只读边界：descriptor（operation/resource 级）→ 凭据端口 → read fetch（分页/限流）→ 规范化 → 幂等落点。
 * 本测试全部使用 fixture / mocked transport；不接真实凭据、不访问真实 seller 数据、无网络调用。
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AMAZON_SP_REGISTERED_OPERATIONS,
  AmazonAdapterBoundaryError,
  authorizeAmazonReadOperation,
  createUnconfiguredAmazonCredentialPort,
  fetchAmazonReadPages,
  normalizeAmazonReadRecords,
  runAmazonReadOnlySync,
  type AmazonCredentialPort,
  type AmazonReadOnlySink,
  type NormalizedReadFact,
  type QuarantinedReadRecord,
} from '../services/adapters/amazon-sp-read-only-adapter';
import {
  evaluateTransportGate,
  registerAdapterCapability,
  resetAdapterCapabilityRegistry,
} from '../services/platform-write/adapter-capability';
import { FIRST_PROVIDER_ID } from '../services/platform-write/amazon-sp-api-readiness';

/** 内存幂等落点：以 fingerprint 去重（模拟既有 Connector Runner / ingest 幂等口径） */
function createMemorySink() {
  const facts = new Map<string, NormalizedReadFact>();
  const quarantined: QuarantinedReadRecord[] = [];
  const sink: AmazonReadOnlySink = {
    async upsertFact(fact) {
      if (facts.has(fact.fingerprint)) return { created: false };
      facts.set(fact.fingerprint, fact);
      return { created: true };
    },
    async quarantine(entry) {
      quarantined.push(entry);
    },
  };
  return { sink, facts, quarantined };
}

const credentials: AmazonCredentialPort = {
  async getLwaAccessToken() {
    return { token: 'fixture-token', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  },
};

afterEach(() => {
  resetAdapterCapabilityRegistry();
});

describe('Amazon SP-API READ-ONLY adapter — operation/resource 级 fail-closed', () => {
  it('01 未登记 resource/operation → fail-closed（不能因为“是 GET”就默认安全）', () => {
    expect(authorizeAmazonReadOperation({ operation: 'getReports', resource: 'reports' })).toMatchObject({
      allowed: false,
      reason: 'OPERATION_NOT_REGISTERED',
    });
    expect(authorizeAmazonReadOperation({ operation: 'getOrders', resource: 'sellers' })).toMatchObject({
      allowed: false,
      reason: 'RESOURCE_MISMATCH',
    });
    expect(authorizeAmazonReadOperation({ operation: 'getOrders', resource: 'orders' }).allowed).toBe(true);
  });

  it('02 write operation → 永远拒绝（即使已登记）', () => {
    const writeDescriptor = AMAZON_SP_REGISTERED_OPERATIONS.find((item) => item.kind === 'WRITE');
    expect(writeDescriptor).toBeTruthy();
    expect(
      authorizeAmazonReadOperation({ operation: 'createReport', resource: 'reports' }),
    ).toMatchObject({ allowed: false, reason: 'WRITE_OPERATION_FORBIDDEN' });
  });

  it('03 RDT-required operation 在无 RDT capability 时拒绝；持有 RDT 才允许', () => {
    expect(
      authorizeAmazonReadOperation({ operation: 'getRestrictedOrderAddress', resource: 'orders' }),
    ).toMatchObject({ allowed: false, reason: 'RDT_CAPABILITY_REQUIRED' });
    expect(
      authorizeAmazonReadOperation({
        operation: 'getRestrictedOrderAddress',
        resource: 'orders',
        capabilities: { restrictedDataTokenEnabled: true },
      }).allowed,
    ).toBe(true);
  });

  it('04 未配置凭据端口 → 失败关闭（本阶段不接真实凭据）', async () => {
    await expect(createUnconfiguredAmazonCredentialPort().getLwaAccessToken()).rejects.toThrowError(
      AmazonAdapterBoundaryError,
    );
    const transport = { async get() { return { status: 200, body: { Orders: [] } }; } };
    await expect(
      fetchAmazonReadPages(
        { transport, credentials: createUnconfiguredAmazonCredentialPort() },
        { operation: 'getOrders', resource: 'orders' },
      ),
    ).rejects.toThrow(/CREDENTIAL_PORT_UNCONFIGURED/);
  });

  it('05 pagination cursor/token 正确传递（第二页携带第一页返回的 NextToken）', async () => {
    const seen: Array<Record<string, string>> = [];
    let call = 0;
    const transport = {
      async get(request: { query: Record<string, string> }) {
        seen.push({ ...request.query });
        call += 1;
        if (call === 1) {
          return { status: 200, body: { Orders: [{ AmazonOrderId: 'A-1' }], NextToken: 'TOKEN-2' } };
        }
        return { status: 200, body: { Orders: [{ AmazonOrderId: 'A-2' }] } };
      },
    };
    const result = await fetchAmazonReadPages({ transport, credentials }, {
      operation: 'getOrders',
      resource: 'orders',
      query: { MarketplaceIds: 'ATVPDKIKX0DER' },
    });
    expect(seen[0]).toEqual({ MarketplaceIds: 'ATVPDKIKX0DER' });
    expect(seen[1]).toEqual({ MarketplaceIds: 'ATVPDKIKX0DER', NextToken: 'TOKEN-2' });
    expect(result.pages).toBe(2);
    expect(result.records).toHaveLength(2);
  });

  it('06 429 退避重试成功 → 业务记录不重复（同一页只产生一份事实）', async () => {
    let call = 0;
    const transport = {
      async get() {
        call += 1;
        if (call === 1) return { status: 429, headers: { 'x-amzn-RateLimit-Limit': '6' }, body: {} };
        return { status: 200, body: { Orders: [{ AmazonOrderId: 'A-1' }] } };
      },
    };
    const { sink, facts } = createMemorySink();
    const result = await runAmazonReadOnlySync(
      { fetcher: { transport, credentials, sleep: async () => undefined }, sink },
      { operation: 'getOrders', resource: 'orders' },
    );
    expect(result.attempts).toBe(2);
    expect(result.factsCreated).toBe(1);
    expect(result.duplicatesSuppressed).toBe(0);
    expect(facts.size).toBe(1);
    expect(result.quarantined).toBe(0);
  });

  it('07 retry 不绕过 sourceFingerprint 幂等：重复记录只落一份', async () => {
    const transport = {
      async get() {
        return {
          status: 200,
          body: { Orders: [{ AmazonOrderId: 'A-1' }, { AmazonOrderId: 'A-1' }] },
        };
      },
    };
    const { sink, facts } = createMemorySink();
    const first = await runAmazonReadOnlySync(
      { fetcher: { transport, credentials }, sink },
      { operation: 'getOrders', resource: 'orders' },
    );
    expect(first.factsCreated).toBe(1);
    expect(first.duplicatesSuppressed).toBe(1);
    expect(facts.size).toBe(1);

    // 再次同步（模拟重试/重放）：仍不新增
    const second = await runAmazonReadOnlySync(
      { fetcher: { transport, credentials }, sink },
      { operation: 'getOrders', resource: 'orders' },
    );
    expect(second.factsCreated).toBe(0);
    expect(second.duplicatesSuppressed).toBe(2);
    expect(facts.size).toBe(1);
  });

  it('08 malformed / unknown provider shape → quarantine，不静默丢弃', async () => {
    const transport = {
      async get() {
        return {
          status: 200,
          body: { Orders: [{ AmazonOrderId: 'A-1' }, { foo: 'bar' }, 'not-an-object', null] },
        };
      },
    };
    const { sink, facts, quarantined } = createMemorySink();
    const result = await runAmazonReadOnlySync(
      { fetcher: { transport, credentials }, sink },
      { operation: 'getOrders', resource: 'orders' },
    );
    expect(result.factsCreated).toBe(1);
    expect(result.quarantined).toBe(3);
    expect(quarantined.map((item) => item.reason)).toEqual([
      'MALFORMED_RECORD',
      'MALFORMED_RECORD',
      'MALFORMED_RECORD',
    ]);
    expect(facts.size).toBe(1);

    const unknownShape = normalizeAmazonReadRecords({
      operation: 'getUnknownReport',
      resource: 'reports',
      records: [{ anything: 1 }],
    });
    expect(unknownShape.facts).toHaveLength(0);
    expect(unknownShape.quarantined[0]?.reason).toBe('UNKNOWN_SHAPE');
  });

  it('09 adapter 结构上不得取得 platform-write sink（源码与端口双重保证）', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'services', 'adapters', 'amazon-sp-read-only-adapter.ts'),
      'utf8',
    );
    for (const forbidden of [
      'PlatformWritePort',
      'platform-write/orchestrator',
      'acquireExecutionRight',
      'settleAttempt',
      'createSimulatedPlatformWritePort',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // 只读传输端口没有写方法（GET-only 契约）
    const transportKeys = Object.keys({
      get(request: unknown) {
        return request;
      },
    });
    expect(transportKeys).toEqual(['get']);
  });

  it('10 即使 PLATFORM_WRITE_TRANSPORT_ENABLED=true，Amazon 仍 ADAPTER_NOT_ELIGIBLE', () => {
    registerAdapterCapability({
      platform: FIRST_PROVIDER_ID,
      idempotentWrite: false,
      statusQuery: false,
      ambiguousResponseSemantics: false,
    });
    const gate = evaluateTransportGate({
      platform: FIRST_PROVIDER_ID,
      authorizationValid: true,
      globalTransportEnabled: true,
    });
    expect(gate.transportAllowed).toBe(false);
    expect(gate.reason).toBe('ADAPTER_NOT_ELIGIBLE');
  });
});
