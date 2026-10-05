/**
 * PHASE 3 U2/U3/U4 + FINAL —— credential port（opaque ref + provider/organization 绑定）/
 * idempotency-exactly-once（key + fingerprint）/ retry-reconcile 有界策略
 * 边界：真实凭据 / 外写 / 网络 = HOLD；全部为契约与内存 mock。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRY_POLICY,
  PROVIDER_EXECUTION_BOUNDARY,
  buildProviderIdempotencyFingerprint,
  createInMemoryIdempotencyStore,
  decideProviderReconcile,
  decideProviderRetry,
  resolveProviderCredential,
  type ProviderCredentialPort,
} from '../services/action-runtime/provider-execution-guard';

const port = (ref: string | null, over: { providerName?: string; organizationId?: string } = {}): ProviderCredentialPort => ({
  async resolveRef() {
    return ref === null
      ? null
      : {
          credentialRef: ref,
          providerName: over.providerName ?? 'p',
          organizationId: over.organizationId ?? 'org-1',
        };
  },
});

const FP = (over: Partial<Parameters<typeof buildProviderIdempotencyFingerprint>[0]> = {}): string =>
  buildProviderIdempotencyFingerprint({
    organizationId: 'org-1',
    providerName: 'p',
    action: 'evidence.read',
    payloadRef: 'recovery-basis:1',
    payloadDigest: 'a'.repeat(64),
    ...over,
  });

describe('PHASE 3 U2 —— credential port（opaque ref + 绑定，fail-closed）', () => {
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

  it('P3U2_2 形如密钥的串（长随机 / sk- 前缀）→ REJECT；只接受 opaque ref', async () => {
    const looksLikeKey = await resolveProviderCredential(port('A'.repeat(40)), { providerName: 'p', organizationId: 'org-1' });
    expect(looksLikeKey.ok).toBe(false);
    if (!looksLikeKey.ok) expect(looksLikeKey.reason).toBe('PROVIDER_CREDENTIAL_REF_NOT_OPAQUE');
    const ok = await resolveProviderCredential(port('vault:providers/amazon/org-1'), {
      providerName: 'p',
      organizationId: 'org-1',
    });
    expect(ok.ok).toBe(true);
    expect(PROVIDER_EXECUTION_BOUNDARY.realCredentials).toContain('ABSENT');
  });

  it('P3U2_3 port 返回的 providerName 与请求不一致 → PROVIDER_CREDENTIAL_PROVIDER_MISMATCH', async () => {
    const mismatched = await resolveProviderCredential(port('vault:providers/amazon/org-1', { providerName: 'tiktok' }), {
      providerName: 'amazon',
      organizationId: 'org-1',
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.reason).toBe('PROVIDER_CREDENTIAL_PROVIDER_MISMATCH');
  });

  it('P3U2_4 port 返回的 organizationId 与请求不一致 → PROVIDER_CREDENTIAL_TENANT_MISMATCH', async () => {
    const mismatched = await resolveProviderCredential(port('vault:providers/amazon/org-2', { organizationId: 'org-2' }), {
      providerName: 'p',
      organizationId: 'org-1',
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.reason).toBe('PROVIDER_CREDENTIAL_TENANT_MISMATCH');
    expect(PROVIDER_EXECUTION_BOUNDARY.credentialBinding).toContain('MUST_MATCH');
  });
});

describe('PHASE 3 U3 —— idempotency / exactly-once（key + fingerprint）', () => {
  it('P3U3_1 同 key 同 fingerprint 第二次 begin → DUPLICATE，且不重复执行', async () => {
    const store = createInMemoryIdempotencyStore();
    const fingerprint = FP();
    const first = await store.begin({ idempotencyKey: 'k-1', fingerprint });
    expect(first.outcome).toBe('WON');
    await store.complete({ idempotencyKey: 'k-1', status: 'SUCCEEDED', providerRef: 'p:1' });
    const second = await store.begin({ idempotencyKey: 'k-1', fingerprint });
    expect(second.outcome).toBe('DUPLICATE');
    if (second.outcome === 'DUPLICATE') {
      expect(second.record.status).toBe('SUCCEEDED');
      expect(second.record.providerRef).toBe('p:1');
      expect(second.record.attempts).toBe(1);
    }
  });

  it('P3U3_2 同 key 不同 fingerprint（payload/action/org/provider 变化）→ CONFLICT', async () => {
    const store = createInMemoryIdempotencyStore();
    const key = 'k-conflict';
    expect((await store.begin({ idempotencyKey: key, fingerprint: FP() })).outcome).toBe('WON');
    for (const changed of [
      { payloadDigest: 'b'.repeat(64) },
      { action: 'claim.prepare' },
      { organizationId: 'org-2' },
      { providerName: 'tiktok' },
    ]) {
      const res = await store.begin({ idempotencyKey: key, fingerprint: FP(changed) });
      expect(res.outcome).toBe('CONFLICT');
    }
    expect(store.get(key)?.fingerprint).toBe(FP());
  });

  it('P3U3_3 并发 begin 同一 key → 恰好一个 WON（唯一赢家）', async () => {
    const store = createInMemoryIdempotencyStore();
    const fingerprint = FP();
    const results = await Promise.all([
      store.begin({ idempotencyKey: 'k-race', fingerprint }),
      store.begin({ idempotencyKey: 'k-race', fingerprint }),
      store.begin({ idempotencyKey: 'k-race', fingerprint }),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['DUPLICATE', 'DUPLICATE', 'WON']);
  });

  it('P3U3_4 缺 key / 缺 fingerprint / complete 未知 key → 抛错（fail-closed）', async () => {
    const store = createInMemoryIdempotencyStore();
    await expect(store.begin({ idempotencyKey: '   ', fingerprint: FP() })).rejects.toThrow(/PROVIDER_IDEMPOTENCY_KEY_REQUIRED/);
    await expect(store.begin({ idempotencyKey: 'k-1', fingerprint: '  ' })).rejects.toThrow(
      /PROVIDER_IDEMPOTENCY_FINGERPRINT_REQUIRED/,
    );
    await expect(store.complete({ idempotencyKey: 'nope', status: 'FAILED' })).rejects.toThrow(
      /PROVIDER_IDEMPOTENCY_UNKNOWN_KEY/,
    );
    expect(PROVIDER_EXECUTION_BOUNDARY.exactlyOnce).toContain('IDEMPOTENCY_KEY_REQUIRED');
    expect(PROVIDER_EXECUTION_BOUNDARY.idempotencyFingerprint).toContain('CONFLICT');
  });
});

describe('PHASE 3 U4 —— retry / reconcile（有界 + fail-closed）', () => {
  it('P3U4_1 成功 → STOP；失败且确认无副作用 → RETRY；达到上限 → STOP', () => {
    expect(decideProviderRetry({ attempts: 1, lastStatus: 'SUCCEEDED', sideEffectConfirmedAbsent: false })).toBe('STOP');
    expect(decideProviderRetry({ attempts: 1, lastStatus: 'FAILED', sideEffectConfirmedAbsent: true })).toBe('RETRY');
    expect(
      decideProviderRetry({ attempts: DEFAULT_RETRY_POLICY.maxAttempts, lastStatus: 'FAILED', sideEffectConfirmedAbsent: true }),
    ).toBe('STOP');
  });

  it('P3U4_2 副作用未知 / UNKNOWN 结果 → MANUAL_REVIEW（不盲目重试）', () => {
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

  it('P3U4_4 边界：真实凭据 ABSENT / 外写 HOLD / 无第二 Action Runtime', () => {
    expect(PROVIDER_EXECUTION_BOUNDARY.externalWrite).toBe('HOLD');
    expect(PROVIDER_EXECUTION_BOUNDARY.secondActionRuntime).toBe('FORBIDDEN');
    expect(PROVIDER_EXECUTION_BOUNDARY.retry).toContain('BOUNDED');
  });
});
