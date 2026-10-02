/**
 * TRACK A / PC-11A FINAL — provider 契约 / PKCE 能力 / 能力矩阵 / sandbox harness（MSG-20261003-100）。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CALLBACK_BOUNDARY_PREFIX,
  PROVIDER_INTEGRATION_CONTRACTS,
  PROVIDER_RECONNECT_CAPABILITY,
  assertProviderNotProductionReady,
  isAllowedCallbackPath,
  projectProviderReadiness,
  resolveProviderContract,
} from '../services/connect/provider-integration-contract';
import {
  DEFAULT_OAUTH_STATE_TTL_SECONDS,
  InMemoryOAuthStateStore,
  consumeOAuthState,
  issueOAuthState,
} from '../services/connect/oauth-state';
import { createSandboxProviderHarness } from '../services/connect/sandbox-provider';

const NOW = new Date('2026-10-02T00:00:00.000Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const FIXED = Buffer.alloc(32, 7);
const randomBytes = () => FIXED;
const VERIFIER = FIXED.toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER, 'utf8').digest('base64url');
const base = {
  provider: 'AMAZON',
  organizationId: 'org-1',
  userId: 'user-1',
  callbackPath: '/connect/callbacks/amazon',
};
const correct = { provider: 'AMAZON', organizationId: 'org-1', userId: 'user-1' };

describe('PC-11A — OAuth state 生命周期', () => {
  it('issue → consume 成功；state 不含身份信息；PKCE verifier 只在服务端', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issueOAuthState(store, base, { now: () => NOW, randomBytes });
    expect(issued.state).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.state).not.toContain(base.organizationId);
    expect(issued.productionAuthorizationEnabled).toBe(false);
    expect(issued.expiresAt.getTime()).toBe(NOW.getTime() + DEFAULT_OAUTH_STATE_TTL_SECONDS * 1000);
    // PKCE：公开结果只含 challenge，verifier 绝不出现在公开结果里
    expect(issued.codeChallenge).toBe(CHALLENGE);
    expect(issued.codeChallengeMethod).toBe('S256');
    expect(JSON.stringify(issued)).not.toContain(VERIFIER);

    const consumed = await consumeOAuthState(store, { state: issued.state, ...correct }, { now: () => NOW });
    expect(consumed.ok).toBe(true);
    // verifier 只存在于服务端 state 记录
    expect(consumed.ok ? consumed.record.codeVerifier : null).toBe(VERIFIER);
  });

  it('一次性：重放同一 state → UNKNOWN（且不泄漏绑定信息）', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issueOAuthState(store, base, { now: () => NOW, randomBytes });
    await consumeOAuthState(store, { state: issued.state, ...correct }, { now: () => NOW });
    const replay = await consumeOAuthState(store, { state: issued.state, ...correct }, { now: () => NOW });
    expect(replay.ok).toBe(false);
    expect(replay.ok === false ? replay.reason : null).toBe('UNKNOWN');
    expect(JSON.stringify(replay)).not.toContain('org-1');
  });

  it('TTL 过期 → EXPIRED；边界内仍可用', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issueOAuthState(store, base, { now: () => NOW, randomBytes });
    const expired = await consumeOAuthState(
      store,
      { state: issued.state, ...correct },
      { now: () => later(DEFAULT_OAUTH_STATE_TTL_SECONDS + 1) },
    );
    expect(expired.ok === false ? expired.reason : null).toBe('EXPIRED');
    const store2 = new InMemoryOAuthStateStore();
    const issued2 = await issueOAuthState(store2, base, { now: () => NOW, randomBytes });
    const inside = await consumeOAuthState(
      store2,
      { state: issued2.state, ...correct },
      { now: () => later(DEFAULT_OAUTH_STATE_TTL_SECONDS - 1) },
    );
    expect(inside.ok).toBe(true);
  });

  it('provider / 租户 / 用户 / 回调不匹配 → 各自原因码（state 被烧掉）', async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['PROVIDER_MISMATCH', { provider: 'WALMART' }],
      ['TENANT_MISMATCH', { organizationId: 'org-2' }],
      ['USER_MISMATCH', { userId: 'user-2' }],
      ['CALLBACK_MISMATCH', { callbackPath: '/connect/callbacks/tiktok' }],
    ];
    for (const [reason, override] of cases) {
      const store = new InMemoryOAuthStateStore();
      const issued = await issueOAuthState(store, base, { now: () => NOW, randomBytes });
      const result = await consumeOAuthState(store, { state: issued.state, ...correct, ...override }, { now: () => NOW });
      expect(result.ok === false ? result.reason : null).toBe(reason);
      const again = await consumeOAuthState(store, { state: issued.state, ...correct }, { now: () => NOW });
      expect(again.ok).toBe(false);
    }
  });

  it('未知 provider / 未登记回调路径 → fail-closed（issue 阶段即拒绝）', async () => {
    const store = new InMemoryOAuthStateStore();
    await expect(
      issueOAuthState(store, { ...base, provider: 'NOT_A_PROVIDER' }, { now: () => NOW, randomBytes }),
    ).rejects.toThrow('UNKNOWN_PROVIDER');
    await expect(
      issueOAuthState(store, { ...base, callbackPath: '/connect/callbacks/evil' }, { now: () => NOW, randomBytes }),
    ).rejects.toThrow('CALLBACK_PATH_NOT_ALLOWED');
  });
});

describe('PC-11A — provider 契约 / PKCE 能力 / 能力矩阵', () => {
  it('registry：已知 provider 可解析；未知 provider → null', () => {
    expect(resolveProviderContract('amazon')?.provider).toBe('AMAZON');
    expect(resolveProviderContract('NOT_A_PROVIDER')).toBeNull();
  });

  it('PKCE 能力显式声明（OAUTH → supported/required S256；API_KEY → 明确不支持）', () => {
    for (const contract of PROVIDER_INTEGRATION_CONTRACTS) {
      if (contract.authKind === 'OAUTH') {
        expect(contract.pkce).toEqual({ supported: true, required: true, method: 'S256' });
      } else {
        expect(contract.pkce).toEqual({ supported: false, required: false, method: null });
      }
    }
  });

  it('契约无 write scope、platformWrite=false、回调路径命中边界', () => {
    for (const contract of PROVIDER_INTEGRATION_CONTRACTS) {
      expect(contract.platformWriteEnabled).toBe(false);
      expect(contract.credentialReferenceOnly).toBe(true);
      expect(contract.callbackPath.startsWith(CALLBACK_BOUNDARY_PREFIX)).toBe(true);
      expect(isAllowedCallbackPath(contract.callbackPath)).toBe(true);
      for (const scope of contract.readOnlyScopes) expect(scope).not.toMatch(/write/i);
    }
    expect(isAllowedCallbackPath('/connect/callbacks/evil')).toBe(false);
  });

  it('readiness 暴露能力矩阵真相；production 恒 EXTERNAL_GATE / ABSENT / platformWrite=false', () => {
    const views = projectProviderReadiness();
    expect(views.length).toBe(PROVIDER_INTEGRATION_CONTRACTS.length);
    for (const view of views) {
      expect(view.contractReady).toBe(true);
      expect(view.readiness).toBe('EXTERNAL_GATE');
      expect(view.productionCredentials).toBe('ABSENT');
      expect(view.platformWriteEnabled).toBe(false);
      expect(view.productionApprovalState).toBe('NOT_REQUESTED');
      expect(view.sandboxState).toBe('AVAILABLE');
      expect(view.reconnect).toEqual(PROVIDER_RECONNECT_CAPABILITY);
      expect(view.reconnect.available).toBe(false);
      expect(view.reconnect.reason).toBe('REAL_OAUTH_EXTERNAL_GATE');
      // 能力矩阵：real 调用尚未实现（PC-11B）
      expect(view.capabilities.oauth.implemented).toBe(false);
      expect(view.capabilities.refresh.implemented).toBe(false);
      expect(view.capabilities.revoke.implemented).toBe(false);
      expect(view.capabilities.webhook.verificationReady).toBe(false);
      expect(view.capabilities.pkce).toEqual(
        view.authKind === 'OAUTH'
          ? { supported: true, required: true, method: 'S256' }
          : { supported: false, required: false, method: null },
      );
      expect(() => assertProviderNotProductionReady(view)).not.toThrow();
      expect(JSON.stringify(view)).not.toContain('PRODUCTION_READY');
    }
    const forged = { ...views[0]!, readiness: 'PRODUCTION_READY' as never };
    expect(() => assertProviderNotProductionReady(forged)).toThrow('PROVIDER_READINESS_MUST_REMAIN_EXTERNAL_GATE');
  });
});

describe('PC-11A — sandbox provider harness（PKCE 感知）', () => {
  it('未知 provider → null；PKCE-required provider 必须 challenge + verifier 匹配', () => {
    expect(createSandboxProviderHarness('NOT_A_PROVIDER')).toBeNull();
    const harness = createSandboxProviderHarness('AMAZON')!;
    // 缺 challenge → fail-closed
    expect(() => harness.approve({ state: 's' })).toThrow('SANDBOX_PKCE_CHALLENGE_REQUIRED');
    const authorization = harness.approve({ state: 's', externalAccountId: 'A1', displayName: 'AMZ-A', codeChallenge: CHALLENGE });
    // 缺 verifier → fail-closed
    expect(() => harness.exchangeCode({ code: authorization.code })).toThrow('SANDBOX_PKCE_VERIFIER_REQUIRED');
    // verifier 不匹配 → fail-closed
    expect(() => harness.exchangeCode({ code: authorization.code, codeVerifier: 'wrong-verifier' })).toThrow(
      'SANDBOX_PKCE_VERIFIER_MISMATCH',
    );
    // 正确 verifier → 成功且产物显式 sandbox，无生产形 secret
    const exchanged = harness.exchangeCode({ code: authorization.code, codeVerifier: VERIFIER });
    expect(exchanged.sandbox).toBe(true);
    expect(exchanged.credentialRef.startsWith('SANDBOX:AMAZON:')).toBe(true);
    expect(exchanged.identityVerified).toBe(true);
    const raw = JSON.stringify(exchanged).toLowerCase();
    for (const forbidden of ['sk_', 'secret', 'production_ready', 'client_secret']) {
      expect(raw).not.toContain(forbidden);
    }
    // 授权码一次性
    expect(() => harness.exchangeCode({ code: authorization.code, codeVerifier: VERIFIER })).toThrow(
      'SANDBOX_CODE_NOT_FOUND',
    );
  });

  it('非 PKCE provider（API_KEY）不需要 verifier', () => {
    const harness = createSandboxProviderHarness('UPS')!;
    const authorization = harness.approve({ state: 's' });
    const exchanged = harness.exchangeCode({ code: authorization.code });
    expect(exchanged.sandbox).toBe(true);
  });
});
