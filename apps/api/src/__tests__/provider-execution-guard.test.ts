/**
 * PHASE 3 U2/U3/U4 验收 —— credential port / idempotency-exactly-once / retry-reconcile
 * 边界：真实凭据 / 外写 / 网络 = HOLD（本批全部为契约与内存 mock）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRY_POLICY,
  PROVIDER_EXECUTION_BOUNDARY,
  createInMemoryIdempotencyStore,
  decideProviderReconcile,
  decideProviderRetry,
  resolveProviderCredential,
  type ProviderCredentialPort,
} from '../services/action-runtime/provider-execution-guard';

const port = (ref: string | null): ProviderCredentialPort => ({
  async resolveRef() {
    return ref === null ? null : { credentialRef: ref, providerName: 'p', organizationId: 'org-1' };
  },
});

describe('PHASE 3 U2 · credential port（只返回 opaque ref，fail-closed）', () => {
  it('P3U2_1 未配置 port / 身份缺失 / ref 缺失 → 一律拒绝', async () => {
    expect((await resolveProviderCredential(null, { providerName: 'p', organizationId: 'org-1' })).ok).toBe(false);
    const identityMissing = await resolveProviderCredential(port('vault:key-1'), {
      providerName: '  ',
      organizationId: 'org-1',
    });
    expect(identityMissing.ok).toBe(false);
    if (!identityMissing.ok) expect(identityMissing.reason).toBe('PROVIDER_CREDENTIAL_IDENTITY_REQUIRED');
    const missing = await resolveProviderCredential(port(null), { providerName: 'p', organizationId: 'org-1' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('PROVIDER_CREDENTIAL_UNAVAILABLE');
  });

  it('P3U2_2 形似密钥本体（长随机串 / sk- 前缀）→ REJECT（只接受 opaque ref）', async () => {
    const looksLikeKey = await resolveProviderCredential(port('A'.repeat(40)), { providerName: 'p', organizationId: 'org-1' });
    expect(looksLikeKey.ok).toBe(false);
    if (!looksLikeKey.ok) expect(looksLikeKey.reason).toBe('PROVIDER_CREDENTIAL_REF_NOT_OPAQUE');
    const ok = await resolveProviderCredential(port('vault:providers/amazon/org-1'), { providerName: 'p', organizationId: 'org-1' });
    expect(ok.ok).toBe(true);
    expect(PROVIDER_EXECUTION_BOUNDARY.realCredentials).toContain('ABSENT');
  });
});

describe('PHASE 3 U3 · idempotency / exactly-once', () => {
  it('P3U3_1 同 key 第二次 begin → DUPLICATE（返回既有记录，不二次执行）', () => {
    const store = createInMemoryIdempotencyStore();
    const first = store.begin({ idempotencyKey: 'k-1' });
    expect(first.outcome).toBe('WON');
    store.complete({ idempotencyKey: 'k-1', status: 'SUCCEEDED', providerRef: 'p:1' });
    const second = store.begin({ idempotencyKey: 'k-1' });
    expect(second.outcome).toBe('DUPLICATE');
    if (second.outcome === 'DUPLICATE') {
      expect(second.record.status).toBe('SUCCEEDED');
      expect(second.record.providerRef).toBe('p:1');
      expect(second.record.attempts).toBe(1);
    }
  });

  it('P3U3_2 缺 idempotencyKey → 直接抛错（fail-closed）；complete 未知 key → 抛错', () => {
    const store = createInMemoryIdempotencyStore();
    expect(() => store.begin({ idempotencyKey: '   ' })).toThrow(/PROVIDER_IDEMPOTENCY_KEY_REQUIRED/);
    expect(() => store.complete({ idempotencyKey: 'nope', status: 'FAILED' })).toThrow(/PROVIDER_IDEMPOTENCY_UNKNOWN_KEY/);
    expect(PROVIDER_EXECUTION_BOUNDARY.exactlyOnce).toContain('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('PHASE 3 U4 · retry / reconcile（有界 + fail-closed）', () => {
  it('P3U4_1 成功 → STOP；失败且确认无副作用 → RETRY；达到上限 → STOP', () => {
    expect(decideProviderRetry({ attempts: 1, lastStatus: 'SUCCEEDED', sideEffectConfirmedAbsent: false })).toBe('STOP');
    expect(decideProviderRetry({ attempts: 1, lastStatus: 'FAILED', sideEffectConfirmedAbsent: true })).toBe('RETRY');
    expect(
      decideProviderRetry({ attempts: DEFAULT_RETRY_POLICY.maxAttempts, lastStatus: 'FAILED', sideEffectConfirmedAbsent: true }),
    ).toBe('STOP');
  });

  it('P3U4_2 副作用未知 / UNKNOWN 结果 → MANUAL_REVIEW（绝不盲目重试）', () => {
    expect(decideProviderRetry({ attempts: 1, lastStatus: 'UNKNOWN', sideEffectConfirmedAbsent: false })).toBe('MANUAL_REVIEW');
    expect(decideProviderRetry({ attempts: 1, lastStatus: 'FAILED', sideEffectConfirmedAbsent: false })).toBe('MANUAL_REVIEW');
    expect(PROVIDER_EXECUTION_BOUNDARY.unknownSideEffect).toContain('MANUAL_REVIEW');
  });

  it('P3U4_3 reconcile：SUCCEEDED / 确认无副作用 → NO_ACTION；UNKNOWN + 有 providerRef → RECONCILE_REQUIRED；无 ref → MANUAL_REVIEW', () => {
    expect(decideProviderReconcile({ status: 'SUCCEEDED', providerRef: 'p:1', sideEffectConfirmedAbsent: false }).action).toBe('NO_ACTION');
    expect(decideProviderReconcile({ status: 'FAILED', providerRef: null, sideEffectConfirmedAbsent: true }).action).toBe('NO_ACTION');
    expect(decideProviderReconcile({ status: 'UNKNOWN', providerRef: 'p:2', sideEffectConfirmedAbsent: false }).action).toBe('RECONCILE_REQUIRED');
    expect(decideProviderReconcile({ status: 'UNKNOWN', providerRef: null, sideEffectConfirmedAbsent: false }).action).toBe('MANUAL_REVIEW');
  });

  it('P3U4_4 边界口径：凭据 ABSENT / 外写 HOLD / 无第二 Action Runtime', () => {
    expect(PROVIDER_EXECUTION_BOUNDARY.externalWrite).toBe('HOLD');
    expect(PROVIDER_EXECUTION_BOUNDARY.secondActionRuntime).toBe('FORBIDDEN');
    expect(PROVIDER_EXECUTION_BOUNDARY.retry).toContain('BOUNDED');
  });
});
