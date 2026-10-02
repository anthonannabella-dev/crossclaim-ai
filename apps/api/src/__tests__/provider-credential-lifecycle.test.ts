/**
 * TRACK A / PC-11A FINAL — provider 凭据生命周期 port（CHANGE C）（MSG-20261003-100）。
 */

import { describe, expect, it } from 'vitest';

import { PROVIDER_RECONNECT_CAPABILITY } from '../services/connect/provider-integration-contract';
import {
  assertRefreshResultTouchesOnlyCredential,
  createSandboxCredentialLifecyclePort,
  mapProviderRevocationToConnectionState,
} from '../services/connect/provider-credential-lifecycle';

describe('PC-11A — credential lifecycle port', () => {
  it('未知 provider → null（fail-closed）', () => {
    expect(createSandboxCredentialLifecyclePort('NOT_A_PROVIDER')).toBeNull();
  });

  it('refresh 只返回 credentialRef（不含身份字段）；空凭据引用 → 拒绝', async () => {
    const port = createSandboxCredentialLifecyclePort('AMAZON')!;
    const result = await port.refresh({ provider: 'AMAZON', organizationId: 'org-1', credentialRef: 'SANDBOX:AMAZON:1' });
    expect(Object.keys(result).sort()).toEqual(['credentialRef']);
    expect(result.credentialRef.startsWith('SANDBOX:AMAZON:')).toBe(true);
    await expect(port.refresh({ provider: 'AMAZON', organizationId: 'org-1', credentialRef: '  ' })).rejects.toThrow(
      'CREDENTIAL_REF_REQUIRED',
    );
  });

  it('refresh 结果触碰身份字段必须被拒绝（credential rotation ≠ identity rotation）', () => {
    expect(() =>
      assertRefreshResultTouchesOnlyCredential({ credentialRef: 'SANDBOX:AMAZON:2', externalAccountId: 'AMZ-A' }),
    ).toThrow('REFRESH_MUST_NOT_TOUCH_IDENTITY:externalAccountId');
    expect(() => assertRefreshResultTouchesOnlyCredential({ credentialRef: 'SANDBOX:AMAZON:2' })).not.toThrow();
  });

  it('revoke → REVOKED；invalid_grant → NEEDS_AUTH；未知 → ERROR', () => {
    expect(mapProviderRevocationToConnectionState({ revoked: true })).toBe('REVOKED');
    expect(mapProviderRevocationToConnectionState({ revoked: true, reason: 'REVOKED' })).toBe('REVOKED');
    expect(mapProviderRevocationToConnectionState({ revoked: false, reason: 'INVALID_GRANT' })).toBe('NEEDS_AUTH');
    expect(mapProviderRevocationToConnectionState({ revoked: false })).toBe('ERROR');
  });

  it('health 返回稳定生命周期状态（空引用 → NEEDS_AUTH；正常 → ACTIVE）', async () => {
    const port = createSandboxCredentialLifecyclePort('AMAZON')!;
    expect(await port.health({ provider: 'AMAZON', organizationId: 'org-1', credentialRef: 'SANDBOX:AMAZON:1' })).toEqual({
      state: 'ACTIVE',
    });
    expect(await port.health({ provider: 'AMAZON', organizationId: 'org-1', credentialRef: '' })).toEqual({
      state: 'NEEDS_AUTH',
    });
  });

  it('新增接口不改变 reconnect truth：仍 REAL_OAUTH_EXTERNAL_GATE / available=false', () => {
    expect(PROVIDER_RECONNECT_CAPABILITY).toEqual({ available: false, reason: 'REAL_OAUTH_EXTERNAL_GATE' });
  });
});
