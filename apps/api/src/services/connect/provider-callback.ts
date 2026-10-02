/**
 * TRACK A / PC-11A（MSG-20261003-99 ⑲）— OAuth 回调边界（内部契约；不写库、不绑定、不发起真实请求）。
 * ---------------------------------------------------------------
 * 顺序（任何一步失败都 fail-closed，且不产生任何业务事实）：
 *   consume state（一次性；provider / 租户 / 用户 / 回调绑定）
 *     → resolve provider contract（未知 provider 拒绝）
 *     → exchange code（注入端口；sandbox 或未来真实实现）
 *     → scope 边界校验（不得出现 broad write scope）
 *     → 平台身份验证（服务端派生的 externalAccountId，不信任客户端）
 *     → 返回**绑定计划**（bindExecuted 恒 false：本批不执行绑定）
 * 凭据边界：只产出 credentialRef（明文永不入库 / 永不入日志 / 永不回显）。
 * 边界：NO platform write · TRANSPORT=false · Payment HOLD · 无生产凭据。
 */

import type { Platform } from '@prisma/client';

import type { PlatformIdentityVerifier } from '../connectors/platform-identity-verifier';
import { consumeOAuthState, type OAuthStateStore } from './oauth-state';
import { resolveProviderContract, type ProviderIntegrationContract } from './provider-integration-contract';

/** code → 凭据引用 / scope 的交换端口（真实实现在 PC-11B；本批只提供 sandbox 实现）。 */
export interface CodeExchangePort {
  exchange(input: { provider: string; code: string; callbackPath: string }): Promise<{
    credentialRef: string;
    scopes: readonly string[];
    sandbox: boolean;
  }>;
}

export type ProviderCallbackFailure =
  | 'STATE_UNKNOWN'
  | 'STATE_EXPIRED'
  | 'STATE_PROVIDER_MISMATCH'
  | 'STATE_TENANT_MISMATCH'
  | 'STATE_USER_MISMATCH'
  | 'STATE_CALLBACK_MISMATCH'
  | 'UNKNOWN_PROVIDER'
  | 'EXCHANGE_FAILED'
  | 'SCOPE_ESCALATION_REJECTED'
  | 'IDENTITY_NOT_VERIFIED';

export interface ProviderBindPlan {
  provider: string;
  organizationId: string;
  userId: string;
  /** 凭据引用（明文永不出现） */
  credentialRef: string;
  scopes: readonly string[];
  /** 服务端验证得到的平台身份（不信任客户端提交） */
  identity: {
    externalAccountId: string;
    displayName: string;
    identityVersion: string;
    marketplace: string | null;
    region: string | null;
  };
  sandbox: boolean;
  /** 本批**不执行**绑定（绑定执行仍需 PC-11B 放行） */
  bindExecuted: false;
  /** 生产凭据恒 ABSENT */
  productionCredentials: 'ABSENT';
}

export type ProviderCallbackOutcome =
  | { ok: true; plan: ProviderBindPlan }
  | { ok: false; reason: ProviderCallbackFailure };

export interface ProviderCallbackDeps {
  store: OAuthStateStore;
  exchange: CodeExchangePort;
  identityVerifier: PlatformIdentityVerifier;
  now?: () => Date;
}

export interface ProviderCallbackInput {
  provider: string;
  state: string;
  code: string;
  callbackPath: string;
  organizationId: string;
  userId: string;
}

function stateFailureReason(reason: string): ProviderCallbackFailure {
  switch (reason) {
    case 'EXPIRED':
      return 'STATE_EXPIRED';
    case 'PROVIDER_MISMATCH':
      return 'STATE_PROVIDER_MISMATCH';
    case 'TENANT_MISMATCH':
      return 'STATE_TENANT_MISMATCH';
    case 'USER_MISMATCH':
      return 'STATE_USER_MISMATCH';
    case 'CALLBACK_MISMATCH':
      return 'STATE_CALLBACK_MISMATCH';
    default:
      return 'STATE_UNKNOWN';
  }
}

/** scope 必须在契约登记的只读 scope 内（禁止 broad write / 越权 scope）。 */
export function assertScopesWithinContract(contract: ProviderIntegrationContract, scopes: readonly string[]): boolean {
  return scopes.every((scope) => contract.readOnlyScopes.includes(scope) && !/write/i.test(scope));
}

export async function handleProviderCallback(
  deps: ProviderCallbackDeps,
  input: ProviderCallbackInput,
): Promise<ProviderCallbackOutcome> {
  const consumed = await consumeOAuthState(
    deps.store,
    {
      state: input.state,
      provider: input.provider,
      organizationId: input.organizationId,
      userId: input.userId,
      callbackPath: input.callbackPath,
    },
    { ...(deps.now ? { now: deps.now } : {}) },
  );
  if (!consumed.ok) return { ok: false, reason: stateFailureReason(consumed.reason) };

  const contract = resolveProviderContract(input.provider);
  if (!contract) return { ok: false, reason: 'UNKNOWN_PROVIDER' };
  if (contract.callbackPath !== input.callbackPath) {
    return { ok: false, reason: 'STATE_CALLBACK_MISMATCH' };
  }

  let exchanged: { credentialRef: string; scopes: readonly string[]; sandbox: boolean };
  try {
    exchanged = await deps.exchange.exchange({
      provider: contract.provider,
      code: input.code,
      callbackPath: contract.callbackPath,
    });
  } catch {
    return { ok: false, reason: 'EXCHANGE_FAILED' };
  }
  if (!exchanged.credentialRef || exchanged.credentialRef.trim() === '') {
    return { ok: false, reason: 'EXCHANGE_FAILED' };
  }
  if (!assertScopesWithinContract(contract, exchanged.scopes)) {
    return { ok: false, reason: 'SCOPE_ESCALATION_REJECTED' };
  }

  let verified;
  try {
    verified = await deps.identityVerifier.verify({
      organizationId: input.organizationId,
      platform: contract.provider as Platform,
      credentialRef: exchanged.credentialRef,
    });
  } catch {
    return { ok: false, reason: 'IDENTITY_NOT_VERIFIED' };
  }

  return {
    ok: true,
    plan: {
      provider: contract.provider,
      organizationId: input.organizationId,
      userId: input.userId,
      credentialRef: exchanged.credentialRef,
      scopes: exchanged.scopes,
      identity: {
        externalAccountId: verified.identity.externalAccountId,
        displayName: verified.identity.displayName,
        identityVersion: verified.identity.identityVersion ?? 'v1',
        marketplace: verified.identity.marketplace ?? null,
        region: verified.identity.region ?? null,
      },
      sandbox: exchanged.sandbox,
      bindExecuted: false,
      productionCredentials: 'ABSENT',
    },
  };
}
