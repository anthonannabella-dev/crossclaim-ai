/**
 * PHASE 3 U1 验收 —— Provider Adapter 契约 / external-write gate / 结果归一化 / sandbox mock
 * 边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT /
 *      PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD（本批零真实网络、零凭据）。
 */

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_ADAPTER_BOUNDARY,
  assertProviderAdapter,
  createMockProviderAdapter,
  decideExternalWriteGate,
  normalizeProviderResult,
  scanCredentialFields,
  type ProviderAdapter,
  type ProviderInvokeRequest,
} from '../services/action-runtime/provider-adapter-contract';

const request = (over: Partial<ProviderInvokeRequest> = {}): ProviderInvokeRequest => ({
  idempotencyKey: 'idem-1',
  action: 'claim.submit',
  organizationId: 'org-1',
  payloadRef: 'recovery-basis:1',
  payloadDigest: 'a'.repeat(64),
  ...over,
});

describe('PHASE 3 U1 · Provider Adapter 契约（HOLD fail-closed）', () => {
  it('P3U1_1 mock/sandbox adapter（simulated，无 network/paid/write）→ ACCEPTED', () => {
    const mock = createMockProviderAdapter({ providerName: 'mock-provider' });
    const check = assertProviderAdapter(mock);
    expect(check.ok).toBe(true);
    expect(check.reason).toBe('PROVIDER_ADAPTER_ACCEPTED');
    expect(mock.capability.network).toBe(false);
    expect(mock.capability.paid).toBe(false);
  });

  it('P3U1_2 声明 network / paid / write / moneyMovement 的 adapter → REJECT（HOLD 未被绕过）', () => {
    for (const flag of ['network', 'paid', 'write', 'moneyMovement'] as const) {
      const adapter = {
        providerName: 'real-provider',
        capability: { [flag]: true },
        async invoke() {
          throw new Error('must not run');
        },
      } as unknown as ProviderAdapter;
      const check = assertProviderAdapter(adapter);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain('PROVIDER_ADAPTER_HOLD_FORBIDDEN');
      expect(check.rejectedCapabilities).toContain(flag);
    }
  });

  it('P3U1_3 未知能力 flag / 缺 providerName / 凭据字段 → 一律 REJECT', () => {
    expect(
      assertProviderAdapter({ providerName: 'x', capability: { telepathy: true }, async invoke() { throw new Error('x'); } } as never).reason,
    ).toContain('PROVIDER_ADAPTER_CAPABILITY_UNKNOWN');
    expect(
      assertProviderAdapter({ providerName: '   ', capability: {}, async invoke() { throw new Error('x'); } } as never).reason,
    ).toBe('PROVIDER_ADAPTER_NAME_REQUIRED');
    const withCreds = {
      providerName: 'x',
      capability: { simulated: true },
      apiKey: 'should-not-exist',
      async invoke() { throw new Error('x'); },
    } as unknown as ProviderAdapter;
    expect(assertProviderAdapter(withCreds).reason).toContain('PROVIDER_ADAPTER_CREDENTIAL_FIELDS_FORBIDDEN');
    expect(scanCredentialFields({ nested: { access_token: 'x' } })).toContain('access_token');
  });

  it('P3U1_4 external-write gate：HOLD / transport 关 / guard 非 ALLOW / 缺幂等键 → 全部 DENY', () => {
    const mock = createMockProviderAdapter({ providerName: 'mock-provider' });
    expect(decideExternalWriteGate({ adapter: mock, request: request() }).allowed).toBe(false);
    expect(decideExternalWriteGate({ adapter: mock, request: request(), transportEnabled: false }).reason).toBe(
      'EXTERNAL_WRITE_TRANSPORT_DISABLED',
    );
    expect(
      decideExternalWriteGate({ adapter: mock, request: request(), transportEnabled: true, guardDecision: 'REQUIRES_APPROVAL' }).reason,
    ).toContain('EXTERNAL_WRITE_GUARD_NOT_ALLOW');
    expect(
      decideExternalWriteGate({ adapter: mock, request: request({ idempotencyKey: '  ' }), transportEnabled: true, guardDecision: 'ALLOW' }).reason,
    ).toBe('EXTERNAL_WRITE_IDEMPOTENCY_KEY_REQUIRED');
    // 即使 transport + guard 全允许，PHASE 3 仍为 HOLD（只留契约与 mock）
    const held = decideExternalWriteGate({ adapter: mock, request: request(), transportEnabled: true, guardDecision: 'ALLOW' });
    expect(held.allowed).toBe(false);
    expect(held.reason).toContain('EXTERNAL_WRITE_HOLD');
  });

  it('P3U1_5 结果归一化：畸形 / 未知状态 / 凭据字段 → UNKNOWN（fail-closed）', () => {
    expect(normalizeProviderResult(null).status).toBe('UNKNOWN');
    expect(normalizeProviderResult('nope').status).toBe('UNKNOWN');
    expect(normalizeProviderResult({ status: 'MAYBE' }).status).toBe('UNKNOWN');
    expect(normalizeProviderResult({ status: 'SUCCEEDED', apiKey: 'x' }).status).toBe('UNKNOWN');
    const ok = normalizeProviderResult({ status: 'SUCCEEDED', providerRef: 'p:1', reasonCodes: ['OK'], sideEffectConfirmedAbsent: false });
    expect(ok.status).toBe('SUCCEEDED');
    expect(ok.providerRef).toBe('p:1');
  });

  it('P3U1_6 mock provider 三态（SUCCESS / FAIL / DEGRADED）可确定性驱动', async () => {
    const calls = { n: 0 };
    const ok = createMockProviderAdapter({ providerName: 'mock-ok', behavior: 'SUCCESS', onInvoke: () => { calls.n += 1; } });
    const fail = createMockProviderAdapter({ providerName: 'mock-fail', behavior: 'FAIL' });
    const degraded = createMockProviderAdapter({ providerName: 'mock-degraded', behavior: 'DEGRADED' });
    expect((await ok.invoke(request())).status).toBe('SUCCEEDED');
    expect(calls.n).toBe(1);
    expect((await fail.invoke(request())).status).toBe('FAILED');
    const degradedResult = await degraded.invoke(request());
    expect(degradedResult.status).toBe('UNKNOWN');
    expect(degradedResult.sideEffectConfirmedAbsent).toBe(false);
  });

  it('P3U1_7 边界口径：HOLD 与禁止第二运行时/禁止凭据', () => {
    expect(PROVIDER_ADAPTER_BOUNDARY.realNetwork).toBe('HOLD');
    expect(PROVIDER_ADAPTER_BOUNDARY.paidCalls).toBe('HOLD');
    expect(PROVIDER_ADAPTER_BOUNDARY.externalWrite).toBe('HOLD');
    expect(PROVIDER_ADAPTER_BOUNDARY.secondActionRuntime).toBe('FORBIDDEN');
    expect(PROVIDER_ADAPTER_BOUNDARY.productionCredentials).toContain('ABSENT');
    expect(PROVIDER_ADAPTER_BOUNDARY.resultNormalization).toContain('FAIL_CLOSED');
  });
});
