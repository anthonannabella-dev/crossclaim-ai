/**
 * TRACK A / PC-11A FINAL — callback boundary（CHANGE A 缺 code fail-closed + PKCE）（MSG-20261003-100）。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { createMockPlatformIdentityVerifier } from '../services/connectors/platform-identity-verifier';
import { InMemoryOAuthStateStore, issueOAuthState } from '../services/connect/oauth-state';
import { handleProviderCallback, type CodeExchangePort } from '../services/connect/provider-callback';
import { createSandboxProviderHarness } from '../services/connect/sandbox-provider';

const NOW = new Date('2026-10-02T00:00:00.000Z');
const FIXED = Buffer.alloc(32, 9);
const randomBytes = () => FIXED;
const VERIFIER = FIXED.toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER, 'utf8').digest('base64url');
const base = {
  provider: 'AMAZON',
  organizationId: 'org-1',
  userId: 'user-1',
  callbackPath: '/connect/callbacks/amazon',
};

function sandboxExchange(): { port: CodeExchangePort; calls: number[] } {
  const calls: number[] = [];
  const harness = createSandboxProviderHarness('AMAZON')!;
  const authorization = harness.approve({
    state: 's',
    externalAccountId: 'AMZ-A',
    displayName: 'AMZ-A',
    codeChallenge: CHALLENGE,
  });
  return {
    calls,
    port: {
      async exchange(input) {
        calls.push(1);
        const result = harness.exchangeCode({
          code: authorization.code,
          ...(input.codeVerifier ? { codeVerifier: input.codeVerifier } : {}),
        });
        return { credentialRef: result.credentialRef, scopes: result.scopes, sandbox: true };
      },
    },
  };
}

const identityVerifier = () =>
  createMockPlatformIdentityVerifier(
    { AMAZON: { platform: 'AMAZON', externalAccountId: 'AMZ-A', displayName: 'AMZ-A', identityVersion: 'v1' } },
    { now: () => NOW },
  );

const issue = (store: InMemoryOAuthStateStore) => issueOAuthState(store, base, { now: () => NOW, randomBytes });

const input = (state: string) => ({
  provider: 'AMAZON',
  state,
  code: 'c',
  callbackPath: base.callbackPath,
  organizationId: 'org-1',
  userId: 'user-1',
});

describe('PC-11A — provider callback boundary', () => {
  it('happy path（sandbox + PKCE）：绑定计划 bindExecuted=false，身份服务端验证', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issue(store);
    const { port } = sandboxExchange();
    const outcome = await handleProviderCallback(
      { store, exchange: port, identityVerifier: identityVerifier(), now: () => NOW },
      input(issued.state),
    );
    expect(outcome.ok).toBe(true);
    const plan = outcome.ok ? outcome.plan : null;
    expect(plan?.credentialRef.startsWith('SANDBOX:AMAZON:')).toBe(true);
    expect(plan?.identity.externalAccountId).toBe('AMZ-A');
    expect(plan?.bindExecuted).toBe(false);
    expect(plan?.productionCredentials).toBe('ABSENT');
    // verifier 不得出现在计划里
    expect(JSON.stringify(plan)).not.toContain(VERIFIER);
  });

  it('CHANGE A：空 code → AUTHORIZATION_CODE_REQUIRED 且 exchange 不被调用', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issue(store);
    const spy = vi.fn();
    const exchange: CodeExchangePort = {
      async exchange() {
        spy();
        return { credentialRef: 'x', scopes: [], sandbox: true };
      },
    };
    const outcome = await handleProviderCallback(
      { store, exchange, identityVerifier: identityVerifier(), now: () => NOW },
      { ...input(issued.state), code: '   ' },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.reason : null).toBe('AUTHORIZATION_CODE_REQUIRED');
    expect(spy).not.toHaveBeenCalled();
  });

  it('FINAL-2：PKCE verifier 归服务端所有 —— exchange 收到 state 里的 verifier，客户端自报值被忽略', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issue(store);
    const received: Array<string | undefined> = [];
    const exchange: CodeExchangePort = {
      async exchange(input) {
        received.push(input.codeVerifier);
        return { credentialRef: 'SANDBOX:AMAZON:1', scopes: [], sandbox: true };
      },
    };
    // 攻击者试图自带 verifier：类型上已不接受该字段；即使注入也必须被忽略。
    const forged = { ...input(issued.state), codeVerifier: 'attacker-supplied' } as never;
    const outcome = await handleProviderCallback(
      { store, exchange, identityVerifier: identityVerifier(), now: () => NOW },
      forged,
    );
    expect(outcome.ok).toBe(true);
    expect(received).toEqual([VERIFIER]);
    expect(JSON.stringify(outcome)).not.toContain('attacker-supplied');
  });

  it('state 一次性：重放 → STATE_UNKNOWN', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issue(store);
    const deps = { store, exchange: sandboxExchange().port, identityVerifier: identityVerifier(), now: () => NOW };
    await handleProviderCallback(deps, input(issued.state));
    const replay = await handleProviderCallback(deps, input(issued.state));
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
        { store, exchange: sandboxExchange().port, identityVerifier: identityVerifier(), now: () => NOW },
        { ...input(issued.state), ...override },
      );
      expect(outcome.ok === false ? outcome.reason : null).toBe(reason);
    }
  });

  it('exchange 失败 → EXCHANGE_FAILED；broad write scope → SCOPE_ESCALATION_REJECTED；身份不可验证 → IDENTITY_NOT_VERIFIED', async () => {
    const store = new InMemoryOAuthStateStore();
    const failing: CodeExchangePort = {
      async exchange() {
        throw new Error('provider down');
      },
    };
    const failed = await handleProviderCallback(
      { store, exchange: failing, identityVerifier: identityVerifier(), now: () => NOW },
      input((await issue(store)).state),
    );
    expect(failed.ok === false ? failed.reason : null).toBe('EXCHANGE_FAILED');

    const escalating: CodeExchangePort = {
      async exchange() {
        return { credentialRef: 'SANDBOX:AMAZON:1', scopes: ['orders.write'], sandbox: true };
      },
    };
    const escalated = await handleProviderCallback(
      { store, exchange: escalating, identityVerifier: identityVerifier(), now: () => NOW },
      input((await issue(store)).state),
    );
    expect(escalated.ok === false ? escalated.reason : null).toBe('SCOPE_ESCALATION_REJECTED');

    const emptyVerifier = createMockPlatformIdentityVerifier({}, { now: () => NOW });
    const unverified = await handleProviderCallback(
      { store, exchange: sandboxExchange().port, identityVerifier: emptyVerifier, now: () => NOW },
      input((await issue(store)).state),
    );
    expect(unverified.ok === false ? unverified.reason : null).toBe('IDENTITY_NOT_VERIFIED');
  });
});
