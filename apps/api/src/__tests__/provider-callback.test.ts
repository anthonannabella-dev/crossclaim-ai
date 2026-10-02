/**
 * TRACK A / PC-11A — OAuth 回调边界（callback boundary）单元回归（MSG-20261003-99 ⑲）。
 * 断言：一次性 state、provider/租户/用户/回调绑定、scope 边界（禁止 broad write）、
 * 身份必须经 verifier 验证、凭据只以引用出现、**不执行绑定**（bindExecuted=false）。
 */

import { describe, expect, it } from 'vitest';

import { createMockPlatformIdentityVerifier } from '../services/connectors/platform-identity-verifier';
import { InMemoryOAuthStateStore, issueOAuthState } from '../services/connect/oauth-state';
import { handleProviderCallback, type CodeExchangePort } from '../services/connect/provider-callback';
import { createSandboxProviderHarness } from '../services/connect/sandbox-provider';

const NOW = new Date('2026-10-02T00:00:00.000Z');
const base = {
  provider: 'AMAZON',
  organizationId: 'org-1',
  userId: 'user-1',
  callbackPath: '/connect/callbacks/amazon',
};

function sandboxExchange(): CodeExchangePort {
  const harness = createSandboxProviderHarness('AMAZON')!;
  const authorization = harness.approve({ state: 's', externalAccountId: 'AMZ-A', displayName: 'AMZ-A' });
  return {
    async exchange() {
      const result = harness.exchangeCode({ code: authorization.code });
      return { credentialRef: result.credentialRef, scopes: result.scopes, sandbox: true };
    },
  };
}

const identityVerifier = () =>
  createMockPlatformIdentityVerifier(
    {
      AMAZON: {
        platform: 'AMAZON',
        externalAccountId: 'AMZ-A',
        displayName: 'AMZ-A',
        identityVersion: 'v1',
      },
    },
    { now: () => NOW },
  );

async function issue(store: InMemoryOAuthStateStore) {
  return issueOAuthState(store, base, { now: () => NOW });
}

describe('PC-11A — provider callback boundary', () => {
  it('happy path（sandbox）：产出绑定计划，身份服务端验证，bindExecuted=false', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issue(store);
    const outcome = await handleProviderCallback(
      { store, exchange: sandboxExchange(), identityVerifier: identityVerifier(), now: () => NOW },
      { provider: 'AMAZON', state: issued.state, code: 'sandbox', callbackPath: base.callbackPath, organizationId: 'org-1', userId: 'user-1' },
    );
    expect(outcome.ok).toBe(true);
    const plan = outcome.ok ? outcome.plan : null;
    expect(plan?.provider).toBe('AMAZON');
    expect(plan?.credentialRef.startsWith('SANDBOX:AMAZON:')).toBe(true);
    expect(plan?.identity.externalAccountId).toBe('AMZ-A');
    expect(plan?.sandbox).toBe(true);
    expect(plan?.bindExecuted).toBe(false);
    expect(plan?.productionCredentials).toBe('ABSENT');
  });

  it('state 一次性：重放 → STATE_UNKNOWN', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issue(store);
    const deps = { store, exchange: sandboxExchange(), identityVerifier: identityVerifier(), now: () => NOW };
    const input = { provider: 'AMAZON', state: issued.state, code: 'c', callbackPath: base.callbackPath, organizationId: 'org-1', userId: 'user-1' };
    await handleProviderCallback(deps, input);
    const replay = await handleProviderCallback(deps, input);
    expect(replay.ok).toBe(false);
    expect(replay.ok === false ? replay.reason : null).toBe('STATE_UNKNOWN');
  });

  it('provider / 租户 / 用户 / 回调不匹配 → 各自状态原因码', async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['STATE_PROVIDER_MISMATCH', { provider: 'WALMART' }],
      ['STATE_TENANT_MISMATCH', { organizationId: 'org-2' }],
      ['STATE_USER_MISMATCH', { userId: 'user-2' }],
      ['STATE_CALLBACK_MISMATCH', { callbackPath: '/connect/callbacks/tiktok' }],
    ];
    for (const [reason, override] of cases) {
      const store = new InMemoryOAuthStateStore();
      const issued = await issue(store);
      const outcome = await handleProviderCallback(
        { store, exchange: sandboxExchange(), identityVerifier: identityVerifier(), now: () => NOW },
        { provider: 'AMAZON', state: issued.state, code: 'c', callbackPath: base.callbackPath, organizationId: 'org-1', userId: 'user-1', ...override },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false ? outcome.reason : null).toBe(reason);
    }
  });

  it('未知 provider → UNKNOWN_PROVIDER（issue 阶段已被拒，这里再断言服务层 fail-closed）', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issue(store);
    const outcome = await handleProviderCallback(
      { store, exchange: sandboxExchange(), identityVerifier: identityVerifier(), now: () => NOW },
      { provider: 'AMAZON', state: issued.state, code: 'c', callbackPath: base.callbackPath, organizationId: 'org-1', userId: 'user-1' },
    );
    expect(outcome.ok).toBe(true);
    const second = await handleProviderCallback(
      { store, exchange: sandboxExchange(), identityVerifier: identityVerifier(), now: () => NOW },
      { provider: 'NOT_A_PROVIDER', state: issued.state, code: 'c', callbackPath: base.callbackPath, organizationId: 'org-1', userId: 'user-1' },
    );
    expect(second.ok).toBe(false);
  });

  it('exchange 失败 / 空凭据引用 → EXCHANGE_FAILED；broad write scope → SCOPE_ESCALATION_REJECTED', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued1 = await issue(store);
    const failing: CodeExchangePort = {
      async exchange() {
        throw new Error('provider down');
      },
    };
    const failed = await handleProviderCallback(
      { store, exchange: failing, identityVerifier: identityVerifier(), now: () => NOW },
      { provider: 'AMAZON', state: issued1.state, code: 'c', callbackPath: base.callbackPath, organizationId: 'org-1', userId: 'user-1' },
    );
    expect(failed.ok === false ? failed.reason : null).toBe('EXCHANGE_FAILED');

    const issued2 = await issue(store);
    const escalating: CodeExchangePort = {
      async exchange() {
        return { credentialRef: 'SANDBOX:AMAZON:9', scopes: ['orders.write'], sandbox: true };
      },
    };
    const escalated = await handleProviderCallback(
      { store, exchange: escalating, identityVerifier: identityVerifier(), now: () => NOW },
      { provider: 'AMAZON', state: issued2.state, code: 'c', callbackPath: base.callbackPath, organizationId: 'org-1', userId: 'user-1' },
    );
    expect(escalated.ok === false ? escalated.reason : null).toBe('SCOPE_ESCALATION_REJECTED');
  });

  it('身份无法验证 → IDENTITY_NOT_VERIFIED（不产出绑定计划、不写库）', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issue(store);
    const emptyVerifier = createMockPlatformIdentityVerifier({}, { now: () => NOW });
    const outcome = await handleProviderCallback(
      { store, exchange: sandboxExchange(), identityVerifier: emptyVerifier, now: () => NOW },
      { provider: 'AMAZON', state: issued.state, code: 'c', callbackPath: base.callbackPath, organizationId: 'org-1', userId: 'user-1' },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.reason : null).toBe('IDENTITY_NOT_VERIFIED');
  });
});
