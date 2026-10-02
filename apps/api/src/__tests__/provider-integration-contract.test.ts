/**
 * TRACK A / PC-11A — provider 接入内部契约回归（MSG-20261003-99 ⑲）。
 * 覆盖：OAuth state 生命周期（一次性 / TTL / provider·租户·用户·回调绑定）、provider 契约 fail-closed、
 * readiness 恒 EXTERNAL_GATE（禁止 fake PRODUCTION_READY）、sandbox harness 产物显式标记且不含生产形 secret。
 */

import { describe, expect, it } from 'vitest';

import {
  CALLBACK_BOUNDARY_PREFIX,
  PROVIDER_INTEGRATION_CONTRACTS,
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
const base = {
  provider: 'AMAZON',
  organizationId: 'org-1',
  userId: 'user-1',
  callbackPath: '/connect/callbacks/amazon',
};
const correct = { provider: 'AMAZON', organizationId: 'org-1', userId: 'user-1' };

describe('PC-11A — OAuth state 生命周期', () => {
  it('issue → consume 成功；state 是不透明随机值且不含身份信息', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issueOAuthState(store, base, { now: () => NOW });
    expect(issued.state).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.state).not.toContain(base.organizationId);
    expect(issued.productionAuthorizationEnabled).toBe(false);
    expect(issued.expiresAt.getTime()).toBe(NOW.getTime() + DEFAULT_OAUTH_STATE_TTL_SECONDS * 1000);

    const consumed = await consumeOAuthState(store, { state: issued.state, ...correct }, { now: () => NOW });
    expect(consumed.ok).toBe(true);
  });

  it('一次性：重放同一 state → UNKNOWN（且不泄漏绑定信息）', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issueOAuthState(store, base, { now: () => NOW });
    await consumeOAuthState(store, { state: issued.state, ...correct }, { now: () => NOW });
    const replay = await consumeOAuthState(store, { state: issued.state, ...correct }, { now: () => NOW });
    expect(replay.ok).toBe(false);
    expect(replay.ok === false ? replay.reason : null).toBe('UNKNOWN');
    expect(JSON.stringify(replay)).not.toContain('org-1');
  });

  it('TTL 过期 → EXPIRED；边界内仍可用', async () => {
    const store = new InMemoryOAuthStateStore();
    const issued = await issueOAuthState(store, base, { now: () => NOW });
    const expired = await consumeOAuthState(
      store,
      { state: issued.state, ...correct },
      { now: () => later(DEFAULT_OAUTH_STATE_TTL_SECONDS + 1) },
    );
    expect(expired.ok).toBe(false);
    expect(expired.ok === false ? expired.reason : null).toBe('EXPIRED');

    const store2 = new InMemoryOAuthStateStore();
    const issued2 = await issueOAuthState(store2, base, { now: () => NOW });
    const inside = await consumeOAuthState(
      store2,
      { state: issued2.state, ...correct },
      { now: () => later(DEFAULT_OAUTH_STATE_TTL_SECONDS - 1) },
    );
    expect(inside.ok).toBe(true);
  });

  it('provider / 租户 / 用户 / 回调不匹配 → 各自明确原因码（state 被烧掉）', async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['PROVIDER_MISMATCH', { provider: 'WALMART' }],
      ['TENANT_MISMATCH', { organizationId: 'org-2' }],
      ['USER_MISMATCH', { userId: 'user-2' }],
      ['CALLBACK_MISMATCH', { callbackPath: '/connect/callbacks/tiktok' }],
    ];
    for (const [reason, override] of cases) {
      const store = new InMemoryOAuthStateStore();
      const issued = await issueOAuthState(store, base, { now: () => NOW });
      const result = await consumeOAuthState(
        store,
        { state: issued.state, ...correct, ...override },
        { now: () => NOW },
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.reason : null).toBe(reason);
      const again = await consumeOAuthState(store, { state: issued.state, ...correct }, { now: () => NOW });
      expect(again.ok).toBe(false);
    }
  });

  it('未知 provider / 未登记回调路径 → fail-closed（issue 阶段即拒绝）', async () => {
    const store = new InMemoryOAuthStateStore();
    await expect(
      issueOAuthState(store, { ...base, provider: 'NOT_A_PROVIDER' }, { now: () => NOW }),
    ).rejects.toThrow('UNKNOWN_PROVIDER');
    await expect(
      issueOAuthState(store, { ...base, callbackPath: '/connect/callbacks/evil' }, { now: () => NOW }),
    ).rejects.toThrow('CALLBACK_PATH_NOT_ALLOWED');
  });
});

describe('PC-11A — provider 契约与 readiness', () => {
  it('registry：已知 provider 可解析；未知 provider → null（fail-closed）', () => {
    expect(resolveProviderContract('amazon')?.provider).toBe('AMAZON');
    expect(resolveProviderContract('NOT_A_PROVIDER')).toBeNull();
    expect(PROVIDER_INTEGRATION_CONTRACTS.length).toBeGreaterThanOrEqual(5);
  });

  it('契约不含 write scope / platform write 恒关 / 回调路径命中边界', () => {
    for (const contract of PROVIDER_INTEGRATION_CONTRACTS) {
      expect(contract.platformWriteEnabled).toBe(false);
      expect(contract.credentialReferenceOnly).toBe(true);
      expect(contract.identityVerificationRequired).toBe(true);
      expect(contract.callbackPath.startsWith(CALLBACK_BOUNDARY_PREFIX)).toBe(true);
      expect(isAllowedCallbackPath(contract.callbackPath)).toBe(true);
      for (const scope of contract.readOnlyScopes) expect(scope).not.toMatch(/write/i);
    }
    expect(isAllowedCallbackPath('/connect/callbacks/evil')).toBe(false);
  });

  it('readiness 恒 EXTERNAL_GATE 且 productionCredentials=ABSENT（禁止 fake PRODUCTION_READY）', () => {
    const views = projectProviderReadiness();
    expect(views.length).toBe(PROVIDER_INTEGRATION_CONTRACTS.length);
    for (const view of views) {
      expect(view.contractReady).toBe(true);
      expect(view.readiness).toBe('EXTERNAL_GATE');
      expect(view.productionCredentials).toBe('ABSENT');
      expect(view.platformWriteEnabled).toBe(false);
      expect(view.requiredHostActions.length).toBeGreaterThan(0);
      expect(() => assertProviderNotProductionReady(view)).not.toThrow();
      expect(JSON.stringify(view)).not.toContain('PRODUCTION_READY');
    }
    const forged = { ...views[0]!, readiness: 'PRODUCTION_READY' as never };
    expect(() => assertProviderNotProductionReady(forged)).toThrow('PROVIDER_READINESS_MUST_REMAIN_EXTERNAL_GATE');
  });
});

describe('PC-11A — sandbox provider harness', () => {
  it('未知 provider → null；已知 provider 可演练 approve → exchange', () => {
    expect(createSandboxProviderHarness('NOT_A_PROVIDER')).toBeNull();
    const harness = createSandboxProviderHarness('AMAZON');
    expect(harness?.sandbox).toBe(true);
    const authorization = harness!.approve({ state: 'state-1', externalAccountId: 'A1', displayName: 'AMZ-A' });
    expect(authorization.sandbox).toBe(true);
    expect(authorization.callbackPath).toBe('/connect/callbacks/amazon');
    const exchanged = harness!.exchangeCode({ code: authorization.code });
    expect(exchanged.sandbox).toBe(true);
    expect(exchanged.credentialRef.startsWith('SANDBOX:AMAZON:')).toBe(true);
    expect(exchanged.identityVerified).toBe(true);
    expect(exchanged.externalAccountId).toBe('A1');
    const raw = JSON.stringify(exchanged).toLowerCase();
    for (const forbidden of ['sk_', 'secret', 'production_ready', 'client_secret']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('授权码一次性（重复 exchange → 拒绝）', () => {
    const harness = createSandboxProviderHarness('TIKTOK_SHOP')!;
    const authorization = harness.approve({ state: 'state-2' });
    harness.exchangeCode({ code: authorization.code });
    expect(() => harness.exchangeCode({ code: authorization.code })).toThrow('SANDBOX_CODE_NOT_FOUND');
  });
});
