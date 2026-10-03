/**
 * TRACK A / PC-11A（MSG-20261003-99 ⑲）— sandbox / fake provider harness（**仅供测试**）。
 * ---------------------------------------------------------------
 * 目的：在没有真实凭据的前提下，仍可端到端演练 OAuth 回调 → 身份校验 → 凭据引用绑定。
 * 纪律：
 *   · 所有产物显式标记 `sandbox: true`，token 引用以 `SANDBOX:` 前缀，绝不形似生产 secret；
 *   · 永远不产生 PRODUCTION_READY；`productionCredentials` 恒 ABSENT；
 *   · 不发起任何真实网络请求；不写平台；不启用 transport。
 */

import { createHash, randomBytes as randomBytesImpl } from 'node:crypto';

import { resolveProviderContract } from './provider-integration-contract';

export interface SandboxAuthorization {
  sandbox: true;
  provider: string;
  code: string;
  scopes: readonly string[];
  callbackPath: string;
}

export interface SandboxExchangeResult {
  sandbox: true;
  provider: string;
  /** 凭据引用（明文不入库）；前缀 SANDBOX: 明确非生产。 */
  credentialRef: string;
  scopes: readonly string[];
  externalAccountId: string;
  displayName: string;
  identityVerified: true;
}

export interface SandboxProviderHarness {
  readonly sandbox: true;
  approve(input: { state: string; externalAccountId?: string; displayName?: string; codeChallenge?: string }): SandboxAuthorization;
  exchangeCode(input: { code: string; codeVerifier?: string }): SandboxExchangeResult;
}

/** 未知 provider → fail-closed（返回 null，不猜测）。 */
export function createSandboxProviderHarness(provider: string): SandboxProviderHarness | null {
  const contract = resolveProviderContract(provider);
  if (!contract) return null;
  const codes = new Map<string, { externalAccountId: string; displayName: string; codeChallenge: string | null }>();
  return {
    sandbox: true,
    approve(input) {
      // PKCE required 的 provider：approve 必须携带 challenge（否则 fail-closed）。
      if (contract.pkce.required && (!input.codeChallenge || input.codeChallenge.trim() === '')) {
        throw new Error('SANDBOX_PKCE_CHALLENGE_REQUIRED');
      }
      const code = 'SANDBOX-CODE-' + randomBytesImpl(12).toString('hex');
      const externalAccountId = input.externalAccountId ?? 'sandbox-account-' + randomBytesImpl(4).toString('hex');
      const displayName = input.displayName ?? 'Sandbox Account';
      codes.set(code, { externalAccountId, displayName, codeChallenge: input.codeChallenge ?? null });
      return { sandbox: true, provider: contract.provider, code, scopes: contract.readOnlyScopes, callbackPath: contract.callbackPath };
    },
    exchangeCode(input) {
      const found = codes.get(input.code);
      if (!found) throw new Error('SANDBOX_CODE_NOT_FOUND');
      // PKCE 校验先于消费授权码：失败不烧码（sandbox 语义），成功才删除。
      if (contract.pkce.required) {
        if (!input.codeVerifier || input.codeVerifier.trim() === '') throw new Error('SANDBOX_PKCE_VERIFIER_REQUIRED');
        const derived = createHash('sha256').update(input.codeVerifier, 'utf8').digest('base64url');
        if (!found.codeChallenge || derived !== found.codeChallenge) throw new Error('SANDBOX_PKCE_VERIFIER_MISMATCH');
      }
      codes.delete(input.code);
      return {
        sandbox: true,
        provider: contract.provider,
        credentialRef: 'SANDBOX:' + contract.provider + ':' + randomBytesImpl(8).toString('hex'),
        scopes: contract.readOnlyScopes,
        externalAccountId: found.externalAccountId,
        displayName: found.displayName,
        identityVerified: true,
      };
    },
  };
}
