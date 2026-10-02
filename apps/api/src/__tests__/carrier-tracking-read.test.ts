/**
 * CARRIER QUEUE #4（MSG-20261003-107 ⑲–㉞）— Tracking Read Adapter 回归。
 * 断言：未知 carrier fail-closed；credentialRef / trackingNumber / tenant 必需；account lineage 必须 provider-verified 且不可跨租户；
 * UPS / FedEx 各自 raw → normalized；raw status 保留；事件确定性排序 + 去重；失败原因分类稳定；
 * 无明文凭据 / 无 raw payload 外泄 / 无真实请求；platformWrite=false / TRANSPORT=false / production credentials ABSENT。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CarrierProviderReadError,
  createInMemoryCarrierVerifiedAccountRegistry,
  createSandboxCarrierTrackingReadPort,
  normalizeCarrierTracking,
  readCarrierTracking,
  resolveCarrierTrackingAdapter,
  type CarrierRawTrackingRecord,
  type CarrierTrackingReadInput,
  type CarrierTrackingReadPort,
  type InMemoryCarrierVerifiedAccountRegistry,
} from '../services/carriers/carrier-tracking-read';

const NOW = new Date('2026-10-02T00:00:00.000Z');
const UPS_TRACKING = '1Z999AA10123456784';
const FEDEX_TRACKING = '7712 3456 7890';

const UPS_RAW: CarrierRawTrackingRecord = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  trackingNumber: UPS_TRACKING,
  rawStatusCode: 'D',
  statusText: 'Delivered',
  serviceLevel: 'GROUND',
  origin: 'US-KY',
  destination: 'US-TX',
  shipDate: '2026-09-28',
  estimatedDeliveryAt: '2026-10-01T12:00:00.000Z',
  deliveredAt: '2026-10-01T14:00:00.000Z',
  events: [
    { occurredAt: '2026-10-01T14:00:00.000Z', rawStatusCode: 'D', description: 'Delivered', location: 'Austin, TX' },
    { occurredAt: '2026-09-28T10:00:00.000Z', rawStatusCode: 'M', description: 'Label created', location: 'Louisville, KY' },
    { occurredAt: '2026-10-01T14:00:00.000Z', rawStatusCode: 'D', description: 'Duplicate scan row', location: 'Austin, TX', source: 'PROVIDER_SCAN' },
  ],
  rawReference: 'sha256:ups-raw-1',
};

const FEDEX_RAW: CarrierRawTrackingRecord = {
  provider: 'FEDEX',
  externalAccountId: 'FDX-ACCT-9',
  trackingNumber: FEDEX_TRACKING,
  rawStatusCode: 'IT',
  statusText: 'In transit',
  serviceLevel: 'FEDEX_GROUND',
  origin: 'US-CA',
  destination: 'US-NY',
  estimatedDeliveryAt: '2026-10-03T18:00:00.000Z',
  events: [
    { occurredAt: '2026-10-01T08:00:00.000Z', rawStatusCode: 'PU', description: 'Picked up', location: 'Oakland, CA' },
    { occurredAt: '2026-10-02T09:00:00.000Z', rawStatusCode: 'IT', description: 'In transit', location: 'Reno, NV' },
  ],
  rawReference: 'sha256:fedex-raw-9',
};

function baseInput(overrides: Partial<CarrierTrackingReadInput> = {}): CarrierTrackingReadInput {
  return {
    provider: 'UPS',
    credentialRef: 'SANDBOX:UPS:cred-1',
    externalAccountId: 'UPS-ACCT-1',
    trackingNumber: UPS_TRACKING,
    organizationId: 'org-a',
    ...overrides,
  };
}

function upsRegistry(): InMemoryCarrierVerifiedAccountRegistry {
  const accounts = createInMemoryCarrierVerifiedAccountRegistry();
  accounts.record({
    provider: 'UPS',
    credentialRef: 'SANDBOX:UPS:cred-1',
    externalAccountId: 'UPS-ACCT-1',
    organizationId: 'org-a',
    identitySource: 'PROVIDER_DISCOVERY',
  });
  accounts.record({
    provider: 'FEDEX',
    credentialRef: 'SANDBOX:FEDEX:registration:fdx-acct-9',
    externalAccountId: 'FDX-ACCT-9',
    organizationId: 'org-a',
    identitySource: 'PROVIDER_VERIFIED_REGISTRATION',
  });
  return accounts;
}

const UPS_PORT = createSandboxCarrierTrackingReadPort({ UPS: { [UPS_TRACKING]: UPS_RAW } });
const FEDEX_PORT = createSandboxCarrierTrackingReadPort({ FEDEX: { [FEDEX_TRACKING]: FEDEX_RAW } });

function spyPort(handler: (input: Parameters<CarrierTrackingReadPort['getTracking']>[0]) => Promise<CarrierRawTrackingRecord>) {
  const calls: Array<Parameters<CarrierTrackingReadPort['getTracking']>[0]> = [];
  const port: CarrierTrackingReadPort = {
    async getTracking(input) {
      calls.push(input);
      return handler(input);
    },
  };
  return { port, calls };
}

describe('CARRIER QUEUE #4 — tracking read fail-closed + account lineage', () => {
  it('unknown carrier fail-closed，且端口不被调用', async () => {
    const spy = spyPort(async () => UPS_RAW);
    const outcome = await readCarrierTracking(
      { port: spy.port, accounts: upsRegistry(), now: () => NOW },
      baseInput({ provider: 'DHL' }),
    );
    expect(outcome.ok ? null : outcome.reason).toBe('UNKNOWN_CARRIER');
    expect(spy.calls).toHaveLength(0);
  });

  it('缺 credentialRef / trackingNumber / tenant context 分别 fail-closed（端口不被调用）', async () => {
    for (const [override, reason] of [
      [{ credentialRef: '   ' }, 'CREDENTIAL_REF_REQUIRED'],
      [{ trackingNumber: '' }, 'TRACKING_NUMBER_REQUIRED'],
      [{ organizationId: null }, 'TENANT_CONTEXT_REQUIRED'],
    ] as const) {
      const spy = spyPort(async () => UPS_RAW);
      const outcome = await readCarrierTracking({ port: spy.port, accounts: upsRegistry() }, baseInput(override));
      expect(outcome.ok ? null : outcome.reason).toBe(reason);
      expect(spy.calls).toHaveLength(0);
    }
  });

  it('明文凭据输入不受支持', async () => {
    const spy = spyPort(async () => UPS_RAW);
    const input = { ...baseInput(), accessToken: 'PLAINTEXT-VALUE-XYZ' } as unknown as CarrierTrackingReadInput;
    const outcome = await readCarrierTracking({ port: spy.port, accounts: upsRegistry() }, input);
    expect(outcome.ok ? null : outcome.reason).toBe('PLAINTEXT_CREDENTIAL_NOT_SUPPORTED');
    expect(spy.calls).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain('PLAINTEXT-VALUE-XYZ');
  });

  it('未登记（未 provider-verified）account lineage → UNVERIFIED_ACCOUNT_LINEAGE', async () => {
    const spy = spyPort(async () => UPS_RAW);
    const outcome = await readCarrierTracking(
      { port: spy.port, accounts: createInMemoryCarrierVerifiedAccountRegistry() },
      baseInput(),
    );
    expect(outcome.ok ? null : outcome.reason).toBe('UNVERIFIED_ACCOUNT_LINEAGE');
    expect(spy.calls).toHaveLength(0);
  });

  it('provider / account mismatch → PROVIDER_ACCOUNT_MISMATCH', async () => {
    const spy = spyPort(async () => UPS_RAW);
    const outcome = await readCarrierTracking(
      { port: spy.port, accounts: upsRegistry() },
      baseInput({ provider: 'FEDEX' }),
    );
    expect(outcome.ok ? null : outcome.reason).toBe('PROVIDER_ACCOUNT_MISMATCH');
    expect(spy.calls).toHaveLength(0);
  });

  it('同一 tracking number 不能跨租户命中：换 organization → CROSS_TENANT_ACCOUNT', async () => {
    const spy = spyPort(async () => UPS_RAW);
    const outcome = await readCarrierTracking(
      { port: spy.port, accounts: upsRegistry() },
      baseInput({ organizationId: 'org-b' }),
    );
    expect(outcome.ok ? null : outcome.reason).toBe('CROSS_TENANT_ACCOUNT');
    expect(spy.calls).toHaveLength(0);
  });

  it('tracking number 单独出现不能建立归属（缺 externalAccountId → UNVERIFIED_ACCOUNT_LINEAGE）', async () => {
    const spy = spyPort(async () => UPS_RAW);
    const outcome = await readCarrierTracking(
      { port: spy.port, accounts: upsRegistry() },
      baseInput({ externalAccountId: null }),
    );
    expect(outcome.ok ? null : outcome.reason).toBe('UNVERIFIED_ACCOUNT_LINEAGE');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('CARRIER QUEUE #4 — normalization', () => {
  it('UPS raw → normalized snapshot（status / raw status / SLA 前置字段）', async () => {
    const outcome = await readCarrierTracking(
      { port: UPS_PORT, accounts: upsRegistry(), now: () => NOW },
      baseInput(),
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.snapshot.provider).toBe('UPS');
    expect(outcome.snapshot.shipmentStatus).toBe('DELIVERED');
    expect(outcome.snapshot.carrierStatusCode).toBe('D');
    expect(outcome.snapshot.serviceLevel).toBe('GROUND');
    expect(outcome.snapshot.estimatedDeliveryAt).toBe('2026-10-01T12:00:00.000Z');
    expect(outcome.snapshot.deliveredAt).toBe('2026-10-01T14:00:00.000Z');
    expect(outcome.snapshot.lastEventAt).toBe('2026-10-01T14:00:00.000Z');
    expect(outcome.snapshot.events).toHaveLength(2);
    expect(outcome.snapshot.observedAt).toBe(NOW.toISOString());
    expect(outcome.snapshot.rawReference).toBe('sha256:ups-raw-1');
  });

  it('FedEx raw → normalized snapshot（provider adapter 独立）', async () => {
    const outcome = await readCarrierTracking(
      { port: FEDEX_PORT, accounts: upsRegistry(), now: () => NOW },
      baseInput({
        provider: 'FEDEX',
        credentialRef: 'SANDBOX:FEDEX:registration:fdx-acct-9',
        externalAccountId: 'FDX-ACCT-9',
        trackingNumber: FEDEX_TRACKING,
      }),
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.snapshot.provider).toBe('FEDEX');
    expect(outcome.snapshot.shipmentStatus).toBe('IN_TRANSIT');
    expect(outcome.snapshot.carrierStatusCode).toBe('IT');
    expect(outcome.snapshot.events.map((event) => event.status)).toEqual(['PICKED_UP', 'IN_TRANSIT']);
  });

  it('raw provider status 保留：总状态码与每条事件 rawStatusCode 都在', async () => {
    const outcome = await readCarrierTracking({ port: UPS_PORT, accounts: upsRegistry(), now: () => NOW }, baseInput());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.snapshot.carrierStatusCode).toBe('D');
    expect(outcome.snapshot.events.map((event) => event.rawStatusCode)).toEqual(['M', 'D']);
  });

  it('normalized status 确定性：未登记 raw code → UNKNOWN（不猜）', async () => {
    const adapter = resolveCarrierTrackingAdapter('UPS');
    expect(adapter?.parseStatus('D')).toBe('DELIVERED');
    expect(adapter?.parseStatus('ZZ')).toBe('UNKNOWN');
    expect(resolveCarrierTrackingAdapter('DHL')).toBeNull();
  });

  it('events 确定性排序（乱序输入 → 时间序）且重复归一化结果一致', async () => {
    const adapter = resolveCarrierTrackingAdapter('UPS')!;
    const first = normalizeCarrierTracking(adapter, UPS_RAW, NOW);
    const second = normalizeCarrierTracking(adapter, UPS_RAW, NOW);
    expect(first?.events.map((event) => event.occurredAt)).toEqual(['2026-09-28T10:00:00.000Z', '2026-10-01T14:00:00.000Z']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('duplicate events 去重：同一 provider+tracking+occurredAt+rawCode+location 只保留一条', async () => {
    const adapter = resolveCarrierTrackingAdapter('UPS')!;
    const snapshot = normalizeCarrierTracking(adapter, UPS_RAW, NOW);
    expect(snapshot?.events).toHaveLength(2);
    expect(new Set(snapshot?.events.map((event) => event.eventKey)).size).toBe(2);
  });
});

describe('CARRIER QUEUE #4 — failure taxonomy + boundaries', () => {
  it('NOT_FOUND / NOT_AUTHORIZED / RATE_LIMITED / TEMPORARILY_UNAVAILABLE 分类稳定（不压成 TRACKING_FAILED）', async () => {
    for (const code of [
      'NOT_FOUND',
      'NOT_AUTHORIZED',
      'RATE_LIMITED',
      'TEMPORARILY_UNAVAILABLE',
      'ACCOUNT_MISMATCH',
    ] as const) {
      const spy = spyPort(async () => {
        throw new CarrierProviderReadError(code);
      });
      const outcome = await readCarrierTracking({ port: spy.port, accounts: upsRegistry() }, baseInput());
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? null : outcome.reason).toBe(code);
    }
  });

  it('未知 provider 异常 → PROVIDER_ERROR（不泄漏上游细节）', async () => {
    const spy = spyPort(async () => {
      throw new Error('UPS_UPSTREAM_BOOM');
    });
    const outcome = await readCarrierTracking({ port: spy.port, accounts: upsRegistry() }, baseInput());
    expect(outcome.ok ? null : outcome.reason).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(outcome)).not.toContain('UPS_UPSTREAM_BOOM');
  });

  it('缺 rawReference / 未声明 raw 字段 → RAW_PAYLOAD_INVALID，且不外泄 payload', async () => {
    const adapter = resolveCarrierTrackingAdapter('UPS')!;
    expect(normalizeCarrierTracking(adapter, { ...UPS_RAW, rawReference: '' }, NOW)).toBeNull();
    const unsafe = { ...UPS_RAW, payload: 'PRIVATE-RAW-PAYLOAD' } as unknown as CarrierRawTrackingRecord;
    expect(normalizeCarrierTracking(adapter, unsafe, NOW)).toBeNull();
    const spy = spyPort(async () => unsafe);
    const outcome = await readCarrierTracking({ port: spy.port, accounts: upsRegistry() }, baseInput());
    expect(outcome.ok ? null : outcome.reason).toBe('RAW_PAYLOAD_INVALID');
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE-RAW-PAYLOAD');
  });

  it('不回传明文凭据 / provider secret：snapshot 只带 safe rawReference', async () => {
    const outcome = await readCarrierTracking({ port: UPS_PORT, accounts: upsRegistry(), now: () => NOW }, baseInput());
    if (!outcome.ok) throw new Error('expected ok');
    const serialized = JSON.stringify(outcome);
    for (const forbidden of ['accessToken', 'refreshToken', 'clientSecret', 'payload']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(outcome.snapshot.rawReference).toBe('sha256:ups-raw-1');
  });

  it('read-only 边界：platformWrite=false / TRANSPORT=false / production credentials ABSENT', async () => {
    const outcome = await readCarrierTracking({ port: UPS_PORT, accounts: upsRegistry(), now: () => NOW }, baseInput());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.readOnly).toBe(true);
    expect(outcome.transportEnabled).toBe(false);
    expect(outcome.platformWriteEnabled).toBe(false);
    expect(outcome.productionCredentials).toBe('ABSENT');
  });

  it('无真实 provider 请求（UPS 与 FedEx 两条路径都不触发网络）', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const ups = await readCarrierTracking({ port: UPS_PORT, accounts: upsRegistry() }, baseInput());
    const fedex = await readCarrierTracking(
      { port: FEDEX_PORT, accounts: upsRegistry() },
      baseInput({
        provider: 'FEDEX',
        credentialRef: 'SANDBOX:FEDEX:registration:fdx-acct-9',
        externalAccountId: 'FDX-ACCT-9',
        trackingNumber: FEDEX_TRACKING,
      }),
    );
    expect(ups.ok).toBe(true);
    expect(fedex.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('CARRIER QUEUE #4 FINAL — provider response identity binding', () => {
  it('requested account A / raw account B → ACCOUNT_MISMATCH（无 snapshot，且不泄漏返回的 raw identity）', async () => {
    const spy = spyPort(async () => ({ ...UPS_RAW, externalAccountId: 'UPS-ACCT-OTHER' }));
    const outcome = await readCarrierTracking({ port: spy.port, accounts: upsRegistry(), now: () => NOW }, baseInput());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reason).toBe('ACCOUNT_MISMATCH');
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('UPS-ACCT-OTHER');
    expect(serialized).not.toContain('snapshot');
  });

  it('requested tracking A / raw tracking B → TRACKING_IDENTITY_MISMATCH（无 snapshot，且不泄漏返回单号）', async () => {
    const spy = spyPort(async () => ({ ...UPS_RAW, trackingNumber: '1Z999AA10123456799' }));
    const outcome = await readCarrierTracking({ port: spy.port, accounts: upsRegistry(), now: () => NOW }, baseInput());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reason).toBe('TRACKING_IDENTITY_MISMATCH');
    expect(JSON.stringify(outcome)).not.toContain('1Z999AA10123456799');
    expect(JSON.stringify(outcome)).not.toContain('snapshot');
  });

  it('不采用「用请求值覆盖 provider 返回值」的做法：返回账号不符时绝不返回 snapshot', async () => {
    const spy = spyPort(async () => ({ ...UPS_RAW, externalAccountId: 'FEDEX-ACCT-X', provider: 'UPS' }));
    const outcome = await readCarrierTracking({ port: spy.port, accounts: upsRegistry(), now: () => NOW }, baseInput());
    expect(outcome.ok ? null : outcome.reason).toBe('ACCOUNT_MISMATCH');
    expect(Object.prototype.hasOwnProperty.call(outcome, 'snapshot')).toBe(false);
  });

  it('正确 account + 正确 tracking → 既有成功路径不变', async () => {
    const outcome = await readCarrierTracking({ port: UPS_PORT, accounts: upsRegistry(), now: () => NOW }, baseInput());
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.snapshot.externalAccountId).toBe('UPS-ACCT-1');
    expect(outcome.snapshot.trackingNumber).toBe(UPS_TRACKING);
    expect(outcome.snapshot.shipmentStatus).toBe('DELIVERED');
  });

  it('㉑ event 内部额外字段（尤其 credential-like）fail-closed', async () => {
    const adapter = resolveCarrierTrackingAdapter('UPS')!;
    const tampered = {
      ...UPS_RAW,
      events: [{ ...UPS_RAW.events![0], accessToken: 'PRIVATE-EVENT-TOKEN' }],
    } as unknown as CarrierRawTrackingRecord;
    expect(normalizeCarrierTracking(adapter, tampered, NOW)).toBeNull();
    const spy = spyPort(async () => tampered);
    const outcome = await readCarrierTracking({ port: spy.port, accounts: upsRegistry() }, baseInput());
    expect(outcome.ok ? null : outcome.reason).toBe('RAW_PAYLOAD_INVALID');
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE-EVENT-TOKEN');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
