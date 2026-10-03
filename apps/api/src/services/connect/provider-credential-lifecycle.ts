/**
 * TRACK A / PC-11A FINAL（MSG-20261003-100 CHANGE C）— provider 凭据生命周期 port。
 * ---------------------------------------------------------------
 * 只建**契约**（真实网络调用属 PC-11B）：
 *   · refresh → 新 credentialRef（可含 expiresAt）——**不得**创建/改变 PlatformAccount identity；
 *   · revoke  → provider 侧撤销结果；
 *   · health  → 稳定生命周期状态 ACTIVE | NEEDS_AUTH | REVOKED | ERROR。
 * 不变量：credential rotation ≠ business identity rotation；
 * revoke / invalid_grant 必须映射到 REVOKED 或 NEEDS_AUTH（与 PC-06 冻结的 reconnect truth 对齐）。
 */

import { randomBytes as randomBytesImpl } from 'node:crypto';

import { resolveProviderContract } from './provider-integration-contract';

export type ProviderConnectionHealthState = 'ACTIVE' | 'NEEDS_AUTH' | 'REVOKED' | 'ERROR';

export interface ProviderCredentialLifecyclePort {
  refresh(input: {
    provider: string;
    organizationId: string;
    credentialRef: string;
  }): Promise<{ credentialRef: string; expiresAt?: Date }>;
  revoke(input: { provider: string; organizationId: string; credentialRef: string }): Promise<{ revoked: boolean }>;
  health(input: {
    provider: string;
    organizationId: string;
    credentialRef: string;
  }): Promise<{ state: ProviderConnectionHealthState }>;
}

/**
 * refresh 结果**只**允许携带凭据引用（+ 可选到期时间）。
 * 任何身份字段（externalAccountId / identityVersion / platform）都必须被拒绝 ——
 * 凭据轮换不得重写业务身份。
 */
export function assertRefreshResultTouchesOnlyCredential(result: Record<string, unknown>): void {
  for (const forbidden of ['externalAccountId', 'identityVersion', 'platform', 'accountId']) {
    if (result[forbidden] !== undefined) {
      throw new Error('REFRESH_MUST_NOT_TOUCH_IDENTITY:' + forbidden);
    }
  }
}

/** provider 撤销 / invalid_grant → 连接生命周期状态（保持 PC-06 语义）。 */
export function mapProviderRevocationToConnectionState(
  result: { revoked: boolean; reason?: 'INVALID_GRANT' | 'REVOKED' | 'UNKNOWN' },
): ProviderConnectionHealthState {
  if (result.reason === 'INVALID_GRANT') return 'NEEDS_AUTH';
  if (result.revoked || result.reason === 'REVOKED') return 'REVOKED';
  return 'ERROR';
}

/**
 * sandbox / fake 实现（PC-11A 契约可验证；**不发起任何网络请求**）。
 * 未知 provider → null（fail-closed）。
 */
export function createSandboxCredentialLifecyclePort(provider: string): ProviderCredentialLifecyclePort | null {
  const contract = resolveProviderContract(provider);
  if (!contract) return null;
  return {
    async refresh(input) {
      if (!input.credentialRef || input.credentialRef.trim() === '') throw new Error('CREDENTIAL_REF_REQUIRED');
      const result = {
        credentialRef: 'SANDBOX:' + contract.provider + ':rotated-' + randomBytesImpl(6).toString('hex'),
      };
      assertRefreshResultTouchesOnlyCredential(result as unknown as Record<string, unknown>);
      return result;
    },
    async revoke(input) {
      if (!input.credentialRef || input.credentialRef.trim() === '') throw new Error('CREDENTIAL_REF_REQUIRED');
      return { revoked: true };
    },
    async health(input) {
      if (!input.credentialRef || input.credentialRef.trim() === '') return { state: 'NEEDS_AUTH' };
      return { state: 'ACTIVE' };
    },
  };
}
