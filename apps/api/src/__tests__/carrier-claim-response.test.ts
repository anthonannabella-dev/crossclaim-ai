/**
 * CARRIER QUEUE #10（MSG-20261003-121 ⑬–㉑）— CARRIER RESPONSE / STATUS READ MODEL 契约层验收。
 * 断言：status 与 provenance 分离；user-reported 永远 UNVERIFIED；provider 来源需可信路径；
 *       APPROVED != PAID != recovered cash；append-only；幂等；投影确定性；无资金/无外写/无网络。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CARRIER_CLAIM_RESPONSE_CAPABILITY,
  CARRIER_CLAIM_RESPONSE_MONEY_BOUNDARY,
  createInMemoryCarrierClaimResponseStore,
  projectCarrierClaimResponse,
  recordCarrierClaimResponse,
  verificationLevelForSource,
  type CarrierClaimResponseContext,
  type CarrierClaimResponseDeps,
  type CarrierClaimResponseFact,
  type CarrierClaimResponseSource,
} from '../services/carriers/carrier-claim-response';

const ORG = 'ccaa0000-0000-4000-8000-0000000000c1';
const ORG_B = 'ccaa0000-0000-4000-8000-0000000000c2';
const USER = 'ccaa0000-0000-4000-8000-0000000000c3';
const PACKAGE_ID = 'carrier-claim-package|bundle-1|eligibility@1.0.1|estimate@1.0.0|USD:ESTIMATED:35.00:COMPLETE_RULE_BASIS';
const NOW = new Date('2026-10-03T08:00:00.000Z');

function contextFor(overrides: Partial<CarrierClaimResponseContext> = {}): CarrierClaimResponseContext {
  return {
    organizationId: ORG,
    actorUserId: USER,
    actorCapabilities: [CARRIER_CLAIM_RESPONSE_CAPABILITY],
    ...overrides,
  };
}

function depsFor(overrides: Partial<CarrierClaimResponseDeps> = {}): CarrierClaimResponseDeps {
  return {
    submissions: {
      async load(organizationId, packageId) {
        if (organizationId !== ORG || packageId !== PACKAGE_ID) return null;
        return {
          packageId: PACKAGE_ID,
          submissionRecordId: 'ccbf2000-0000-4000-8000-0000000000a1',
          provider: 'UPS' as const,
          externalAccountId: 'UPS-ACCT-1',
          trackingNumber: '1Z999AA10123456784',
        };
      },
    },
    store: createInMemoryCarrierClaimResponseStore(),
    now: () => NOW,
    ...overrides,
  };
}

async function record(
  request: Parameters<typeof recordCarrierClaimResponse>[0]['request'],
  deps = depsFor(),
  context = contextFor(),
) {
  return recordCarrierClaimResponse({ packageId: PACKAGE_ID, request, context }, deps);
}

describe('CARRIER QUEUE #10 — carrier response / status read model', () => {
  it('USER_REPORTED APPROVED → 事实被记录，但 verificationLevel 恒为 UNVERIFIED', async () => {
    const outcome = await record({ status: 'APPROVED', source: 'USER_REPORTED' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe('RECORDED');
    expect(outcome.fact.status).toBe('APPROVED');
    expect(outcome.fact.verificationLevel).toBe('UNVERIFIED');
  });

  it('status 与 provenance 正交：APPROVED + USER_REPORTED 不构成 provider 已验证', async () => {
    const outcome = await record({ status: 'APPROVED', source: 'USER_REPORTED', providerReference: 'UPS-CASE-9' });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.fact.providerReference).toBe('UPS-CASE-9');
    expect(outcome.fact.verificationLevel).toBe('UNVERIFIED');
  });

  it('provider reference 本身不升级 verificationLevel（verificationLevelForSource 纯函数契约）', () => {
    expect(verificationLevelForSource('USER_REPORTED', ['PROVIDER_API'])).toBe('UNVERIFIED');
    expect(verificationLevelForSource('PROVIDER_API', [])).toBe('UNVERIFIED');
    expect(verificationLevelForSource('PROVIDER_WEBHOOK', ['PROVIDER_WEBHOOK'])).toBe('PROVIDER_VERIFIED');
  });

  it('PROVIDER_VERIFIED 需要可信来源路径：未登记 → fail-closed 拒绝', async () => {
    const outcome = await record({ status: 'APPROVED', source: 'PROVIDER_API', providerReference: 'CASE-1' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('PROVIDER_SOURCE_NOT_TRUSTED');
  });

  it('已登记可信来源 + provider reference → PROVIDER_VERIFIED', async () => {
    const outcome = await record(
      { status: 'APPROVED', source: 'PROVIDER_WEBHOOK', providerReference: 'CASE-2' },
      depsFor({ trustedProviderSources: ['PROVIDER_WEBHOOK'] }),
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.fact.verificationLevel).toBe('PROVIDER_VERIFIED');
  });

  it('provider 来源缺少 providerReference → PROVIDER_REFERENCE_REQUIRED', async () => {
    const outcome = await record(
      { status: 'PAID', source: 'PROVIDER_DOCUMENT' },
      depsFor({ trustedProviderSources: ['PROVIDER_DOCUMENT'] }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('PROVIDER_REFERENCE_REQUIRED');
  });

  it('未知 package / 跨租户 → SUBMISSION_NOT_FOUND 且零事实', async () => {
    const deps = depsFor();
    const crossTenant = await record(
      { status: 'APPROVED', source: 'USER_REPORTED' },
      deps,
      contextFor({ organizationId: ORG_B }),
    );
    expect(crossTenant.ok).toBe(false);
    if (!crossTenant.ok) expect(crossTenant.reason).toBe('SUBMISSION_NOT_FOUND');
    const unknownPackage = await recordCarrierClaimResponse(
      { packageId: 'pkg-unknown', request: { status: 'APPROVED', source: 'USER_REPORTED' }, context: contextFor() },
      deps,
    );
    expect(unknownPackage.ok).toBe(false);
    expect(await deps.store.listByPackage(ORG, PACKAGE_ID)).toHaveLength(0);
  });

  it('缺少 capability → CAPABILITY_REQUIRED 且零事实', async () => {
    const deps = depsFor();
    const outcome = await record({ status: 'APPROVED', source: 'USER_REPORTED' }, deps, contextFor({ actorCapabilities: [] }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('CAPABILITY_REQUIRED');
    expect(await deps.store.listByPackage(ORG, PACKAGE_ID)).toHaveLength(0);
  });

  it('actor / organization 全部 server-derived（client 注入字段被忽略）', async () => {
    const outcome = await record({
      status: 'APPROVED',
      source: 'USER_REPORTED',
      organizationId: ORG_B,
      recordedByUserId: 'attacker',
      verificationLevel: 'PROVIDER_VERIFIED',
    } as never);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.fact.organizationId).toBe(ORG);
    expect(outcome.fact.recordedByUserId).toBe(USER);
    expect(outcome.fact.verificationLevel).toBe('UNVERIFIED');
  });

  it('㉑ 重复 provider fact → 幂等（ALREADY_RECORDED，仍只有一条事实）', async () => {
    const deps = depsFor({ trustedProviderSources: ['PROVIDER_API'] });
    const first = await record({ status: 'APPROVED', source: 'PROVIDER_API', providerReference: 'CASE-3' }, deps);
    const second = await record({ status: 'APPROVED', source: 'PROVIDER_API', providerReference: 'CASE-3' }, deps);
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.status).toBe('RECORDED');
    expect(second.status).toBe('ALREADY_RECORDED');
    expect(second.fact.factId).toBe(first.fact.factId);
    expect(await deps.store.listByPackage(ORG, PACKAGE_ID)).toHaveLength(1);
  });

  it('append-only：store 只暴露 append / listByPackage（无覆盖写入口）', () => {
    const store = createInMemoryCarrierClaimResponseStore();
    expect(Object.keys(store).sort()).toEqual(['append', 'listByPackage']);
  });

  it('status history 保留：多条事实不覆盖历史，投影按 (observedAt, recordedAt, factId) 确定性排序', async () => {
    const deps = depsFor();
    await record({ status: 'PENDING', source: 'USER_REPORTED', observedAt: '2026-10-03T06:00:00.000Z' }, deps);
    await record({ status: 'UNDER_REVIEW', source: 'USER_REPORTED', observedAt: '2026-10-03T07:00:00.000Z' }, deps);
    await record({ status: 'APPROVED', source: 'USER_REPORTED', observedAt: '2026-10-03T07:30:00.000Z' }, deps);
    const facts = await deps.store.listByPackage(ORG, PACKAGE_ID);
    const projection = projectCarrierClaimResponse(facts, { organizationId: ORG, packageId: PACKAGE_ID });
    expect(projection.statusHistory.map((h) => h.status)).toEqual(['PENDING', 'UNDER_REVIEW', 'APPROVED']);
    expect(projection.currentStatus).toBe('APPROVED');
    expect(projection.factCount).toBe(3);
  });

  it('相同事实集合 → 相同投影（顺序无关）', async () => {
    const deps = depsFor();
    await record({ status: 'PENDING', source: 'USER_REPORTED', observedAt: '2026-10-03T06:00:00.000Z' }, deps);
    await record({ status: 'DENIED', source: 'USER_REPORTED', observedAt: '2026-10-03T07:10:00.000Z' }, deps);
    const facts = await deps.store.listByPackage(ORG, PACKAGE_ID);
    const a = projectCarrierClaimResponse(facts, { organizationId: ORG, packageId: PACKAGE_ID });
    const b = projectCarrierClaimResponse(facts.slice().reverse(), { organizationId: ORG, packageId: PACKAGE_ID });
    expect(b).toEqual(a);
  });

  it('㉑ APPROVED != PAID：投影不会从 APPROVED 推导出 PAID', async () => {
    const deps = depsFor();
    await record({ status: 'APPROVED', source: 'USER_REPORTED', observedAt: '2026-10-03T07:00:00.000Z' }, deps);
    const projection = projectCarrierClaimResponse(await deps.store.listByPackage(ORG, PACKAGE_ID), {
      organizationId: ORG,
      packageId: PACKAGE_ID,
    });
    expect(projection.currentStatus).toBe('APPROVED');
    expect(projection.currentStatus).not.toBe('PAID');
    expect(projection.derivesRecoveredCash).toBe(false);
    expect(projection.derivesSuccessFee).toBe(false);
  });

  it('㉑ PAID != recovered cash：事实不携带任何资金真值变更', async () => {
    const outcome = await record({ status: 'PAID', source: 'USER_REPORTED' });
    if (!outcome.ok) throw new Error('expected ok');
    const fact = outcome.fact;
    expect(fact.recoveredCashUpdated).toBe(false);
    expect(fact.successFeeCalculated).toBe(false);
    expect(fact.paymentCollectionPerformed).toBe(false);
    expect(CARRIER_CLAIM_RESPONSE_MONEY_BOUNDARY.recoveredCashUpdated).toBe(false);
    expect(CARRIER_CLAIM_RESPONSE_MONEY_BOUNDARY.successFeeCalculated).toBe(false);
  });

  it('㉑ 无资金 / 无外写 / TRANSPORT=false / platformWrite=false / 无生产凭据', async () => {
    const outcome = await record({ status: 'PAID', source: 'USER_REPORTED' });
    if (!outcome.ok) throw new Error('expected ok');
    const forbidden = ['actualRecovered', 'recoveryPayout', 'successFee', 'commission', 'collectionAmount', 'paymentId'];
    const keys = Object.keys(outcome.fact);
    for (const name of forbidden) expect(keys).not.toContain(name);
    expect(outcome.fact.transportEnabled).toBe(false);
    expect(outcome.fact.platformWriteEnabled).toBe(false);
    expect(outcome.fact.productionCredentials).toBe('ABSENT');
    expect(CARRIER_CLAIM_RESPONSE_MONEY_BOUNDARY.transportEnabled).toBe(false);
    expect(CARRIER_CLAIM_RESPONSE_MONEY_BOUNDARY.platformWriteEnabled).toBe(false);
  });

  it('㉑ no network：记录 carrier response 全程不发起任何 provider 调用', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const outcome = await record({ status: 'UNDER_REVIEW', source: 'USER_REPORTED' });
      expect(outcome.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('非法 status / source → INVALID_REQUEST', async () => {
    const bad = await record({ status: 'RECOVERED', source: 'USER_REPORTED' } as never);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('INVALID_REQUEST');
    const badSource = await record({ status: 'APPROVED', source: 'CARRIER_PORTAL' } as never);
    expect(badSource.ok).toBe(false);
  });

  it('非法 / 未来 observedAt → INVALID_TIMESTAMP / FUTURE_TIMESTAMP', async () => {
    const invalid = await record({ status: 'APPROVED', source: 'USER_REPORTED', observedAt: 'not-a-date' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toBe('INVALID_TIMESTAMP');
    const future = await record({ status: 'APPROVED', source: 'USER_REPORTED', observedAt: '2026-10-04T00:00:00.000Z' });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.reason).toBe('FUTURE_TIMESTAMP');
  });

  it('note / providerReference 形状校验（长度与控制字符）', async () => {
    const longNote = await record({ status: 'APPROVED', source: 'USER_REPORTED', note: 'x'.repeat(501) });
    expect(longNote.ok).toBe(false);
    const control = await record({ status: 'APPROVED', source: 'USER_REPORTED', note: 'bad\u0007note' });
    expect(control.ok).toBe(false);
    const longRef = await record(
      { status: 'APPROVED', source: 'PROVIDER_API', providerReference: 'r'.repeat(129) },
      depsFor({ trustedProviderSources: ['PROVIDER_API'] }),
    );
    expect(longRef.ok).toBe(false);
  });

  it('recordedAt 使用 server 时钟（client 无法提供）', async () => {
    const outcome = await record({ status: 'UNKNOWN', source: 'USER_REPORTED', recordedAt: '1999-01-01T00:00:00.000Z' } as never);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.fact.recordedAt).toBe(NOW.toISOString());
  });

  it('projection 空事实集合 → currentStatus null（不虚构状态）', () => {
    const projection = projectCarrierClaimResponse([] as CarrierClaimResponseFact[], {
      organizationId: ORG,
      packageId: PACKAGE_ID,
    });
    expect(projection.currentStatus).toBeNull();
    expect(projection.factCount).toBe(0);
    expect(projection.hasProviderVerifiedFact).toBe(false);
  });

  it('projection 只统计本租户 + 本 package 的事实', () => {
    const base: CarrierClaimResponseFact = {
      factId: 'crf_x',
      organizationId: ORG_B,
      packageId: PACKAGE_ID,
      submissionRecordId: 's',
      provider: 'UPS',
      externalAccountId: 'A',
      trackingNumber: 'T',
      status: 'APPROVED',
      source: 'USER_REPORTED' as CarrierClaimResponseSource,
      verificationLevel: 'UNVERIFIED',
      providerReference: null,
      observedAt: NOW.toISOString(),
      recordedAt: NOW.toISOString(),
      rawArtifactReference: null,
      recordedByUserId: USER,
      recoveredCashUpdated: false,
      successFeeCalculated: false,
      paymentCollectionPerformed: false,
      externalWritePerformed: false,
      transportEnabled: false,
      platformWriteEnabled: false,
      productionCredentials: 'ABSENT',
    };
    const projection = projectCarrierClaimResponse([base], { organizationId: ORG, packageId: PACKAGE_ID });
    expect(projection.factCount).toBe(0);
    expect(projection.currentStatus).toBeNull();
  });
});
