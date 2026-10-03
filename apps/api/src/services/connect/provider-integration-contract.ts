/**
 * TRACK A / PC-11A（MSG-20261003-99 ⑲）— provider 接入的**内部契约**（真实凭据仍在 HOST / EXTERNAL GATE）。
 * ---------------------------------------------------------------
 * 本模块只描述「接入应该长什么样」，不包含任何真实 provider 调用：
 *   · provider 维度 registry（authKind / 最小只读 scope / 回调边界 / 凭据引用边界）
 *   · 每个 provider 的 requiredProductionCredentials（**只声明，不拥有**）
 *   · readiness 投影：合同就绪 = CONTRACT_READY，但**生产就绪恒为 EXTERNAL_GATE**
 * 硬约束：不得出现 fake PRODUCTION_READY / 硬编码生产 token / broad write scope / platform write。
 */

import type { ConnectorAuthKind } from '../connectors/types';

export interface ProviderIntegrationContract {
  provider: string;
  authKind: ConnectorAuthKind;
  /** 最小只读 scope（禁止 broad write scope） */
  readOnlyScopes: readonly string[];
  /** 生产凭据要求（全部由 HOST 提供；本仓库永远不含真实值） */
  requiredProductionCredentials: readonly string[];
  /** 回调边界（唯一允许的回调路径） */
  callbackPath: string;
  /** 凭据只以引用形式落库；明文永不入库 / 永不入日志 */
  credentialReferenceOnly: true;
  /** 平台身份必须经 verifier 验证后才允许绑定账户 */
  identityVerificationRequired: true;
  /** 对外提交/写入能力：本阶段恒 false */
  platformWriteEnabled: false;
  /**
   * PC-11A FINAL（MSG-20261003-100 CHANGE B）：PKCE 能力必须**显式**声明（不得运行时猜测）。
   * required=true 的 provider 在 issue state 时必须生成 server-side code_verifier 并派生 S256 challenge。
   */
  pkce: { supported: boolean; required: boolean; method: 'S256' | null };
  /** PC-11A FINAL（CHANGE D）：能力矩阵（supported=平台/协议是否支持；implemented=本仓库是否已实现真实调用）。 */
  capabilities: {
    oauth: { supported: boolean; implemented: boolean };
    refresh: { supported: boolean; implemented: boolean };
    revoke: { supported: boolean; implemented: boolean };
    webhook: { supported: boolean; verificationReady: boolean };
  };
}

export const PROVIDER_INTEGRATION_CONTRACTS: readonly ProviderIntegrationContract[] = [
  {
    provider: 'AMAZON',
    authKind: 'OAUTH',
    readOnlyScopes: ['sellingpartnerapi::migration'],
    requiredProductionCredentials: ['LWA_CLIENT_ID', 'LWA_CLIENT_SECRET', 'SPAPI_REFRESH_TOKEN'],
    callbackPath: '/connect/callbacks/amazon',
    credentialReferenceOnly: true,
    identityVerificationRequired: true,
    platformWriteEnabled: false,
    pkce: { supported: true, required: true, method: 'S256' },
    capabilities: {
      oauth: { supported: true, implemented: false },
      refresh: { supported: true, implemented: false },
      revoke: { supported: true, implemented: false },
      webhook: { supported: false, verificationReady: false },
    },
  },
  {
    provider: 'TIKTOK_SHOP',
    authKind: 'OAUTH',
    readOnlyScopes: ['order.info.read'],
    requiredProductionCredentials: ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET'],
    callbackPath: '/connect/callbacks/tiktok',
    credentialReferenceOnly: true,
    identityVerificationRequired: true,
    platformWriteEnabled: false,
    pkce: { supported: true, required: true, method: 'S256' },
    capabilities: {
      oauth: { supported: true, implemented: false },
      refresh: { supported: true, implemented: false },
      revoke: { supported: true, implemented: false },
      webhook: { supported: false, verificationReady: false },
    },
  },
  {
    provider: 'WALMART',
    authKind: 'OAUTH',
    readOnlyScopes: ['returns.read'],
    requiredProductionCredentials: ['WALMART_CLIENT_ID', 'WALMART_CLIENT_SECRET'],
    callbackPath: '/connect/callbacks/walmart',
    credentialReferenceOnly: true,
    identityVerificationRequired: true,
    platformWriteEnabled: false,
    pkce: { supported: true, required: true, method: 'S256' },
    capabilities: {
      oauth: { supported: true, implemented: false },
      refresh: { supported: true, implemented: false },
      revoke: { supported: true, implemented: false },
      webhook: { supported: false, verificationReady: false },
    },
  },
  {
    provider: 'UPS',
    authKind: 'API_KEY',
    readOnlyScopes: [],
    requiredProductionCredentials: ['UPS_CLIENT_ID', 'UPS_CLIENT_SECRET'],
    callbackPath: '/connect/callbacks/ups',
    credentialReferenceOnly: true,
    identityVerificationRequired: true,
    platformWriteEnabled: false,
    pkce: { supported: false, required: false, method: null },
    capabilities: {
      oauth: { supported: false, implemented: false },
      refresh: { supported: false, implemented: false },
      revoke: { supported: false, implemented: false },
      webhook: { supported: false, verificationReady: false },
    },
  },
  {
    provider: 'FEDEX',
    authKind: 'API_KEY',
    readOnlyScopes: [],
    requiredProductionCredentials: ['FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET'],
    callbackPath: '/connect/callbacks/fedex',
    credentialReferenceOnly: true,
    identityVerificationRequired: true,
    platformWriteEnabled: false,
    pkce: { supported: false, required: false, method: null },
    capabilities: {
      oauth: { supported: false, implemented: false },
      refresh: { supported: false, implemented: false },
      revoke: { supported: false, implemented: false },
      webhook: { supported: false, verificationReady: false },
    },
  },
] as const;

/** 未知 provider → null（调用方必须 fail-closed，不得猜测）。 */
export function resolveProviderContract(provider: string): ProviderIntegrationContract | null {
  return PROVIDER_INTEGRATION_CONTRACTS.find((entry) => entry.provider === provider.toUpperCase()) ?? null;
}

/** 回调边界：只允许契约登记过的路径。 */
export const CALLBACK_BOUNDARY_PREFIX = '/connect/callbacks/';
export function isAllowedCallbackPath(path: string): boolean {
  return PROVIDER_INTEGRATION_CONTRACTS.some((entry) => entry.callbackPath === path);
}

/** PC-11A FINAL（MSG-100 ⑰）：reconnect 能力在真实 OAuth 落地前恒不可执行。 */
export const PROVIDER_RECONNECT_CAPABILITY = {
  available: false,
  reason: 'REAL_OAUTH_EXTERNAL_GATE',
} as const;

/** 生产审批状态：本仓库永远不声称已获批。 */
export type ProductionApprovalState = 'NOT_REQUESTED' | 'PENDING' | 'APPROVED';

export interface ProviderReadinessView {
  provider: string;
  authKind: ConnectorAuthKind;
  /** PC-11A FINAL（CHANGE D）：能力矩阵（生命周期真相） */
  capabilities: {
    oauth: { supported: boolean; implemented: boolean };
    pkce: { supported: boolean; required: boolean; method: 'S256' | null };
    refresh: { supported: boolean; implemented: boolean };
    revoke: { supported: boolean; implemented: boolean };
    webhook: { supported: boolean; verificationReady: boolean };
  };
  readOnlyScopes: readonly string[];
  productionApprovalState: ProductionApprovalState;
  sandboxState: 'AVAILABLE';
  reconnect: typeof PROVIDER_RECONNECT_CAPABILITY;
  /** 内部契约是否就绪（接口 / 边界 / 生命周期已定义并测试） */
  contractReady: true;
  /** 生产凭据是否存在（本仓库恒为 ABSENT —— 只能由 HOST 提供） */
  productionCredentials: 'ABSENT';
  /** 生产可用性：恒 EXTERNAL_GATE（禁止 fake PRODUCTION_READY） */
  readiness: 'EXTERNAL_GATE';
  reason: 'PRODUCTION_CREDENTIALS_REQUIRED';
  requiredHostActions: readonly string[];
  platformWriteEnabled: false;
  callbackPath: string;
}

/**
 * readiness 投影：**合同就绪 ≠ 生产可用**。
 * 本函数永远不返回 PRODUCTION_READY —— 真实启用需 PC-11B（HOST / EXTERNAL GATE）。
 */
export function projectProviderReadiness(): ProviderReadinessView[] {
  return PROVIDER_INTEGRATION_CONTRACTS.map((entry) => ({
    provider: entry.provider,
    authKind: entry.authKind,
    capabilities: {
      oauth: entry.capabilities.oauth,
      pkce: entry.pkce,
      refresh: entry.capabilities.refresh,
      revoke: entry.capabilities.revoke,
      webhook: entry.capabilities.webhook,
    },
    readOnlyScopes: entry.readOnlyScopes,
    productionApprovalState: 'NOT_REQUESTED',
    sandboxState: 'AVAILABLE',
    reconnect: PROVIDER_RECONNECT_CAPABILITY,
    contractReady: true,
    productionCredentials: 'ABSENT',
    readiness: 'EXTERNAL_GATE',
    reason: 'PRODUCTION_CREDENTIALS_REQUIRED',
    requiredHostActions: [
      'provider developer account approval',
      'production credentials (client id/secret) written by HOST',
      'callback domain registration',
      'real seller authorization',
    ],
    platformWriteEnabled: false,
    callbackPath: entry.callbackPath,
  }));
}

/** 防御式断言：任何消费方都不得把 readiness 当成生产可用。 */
export function assertProviderNotProductionReady(view: ProviderReadinessView): void {
  if (view.readiness !== 'EXTERNAL_GATE' || view.productionCredentials !== 'ABSENT') {
    throw new Error('PROVIDER_READINESS_MUST_REMAIN_EXTERNAL_GATE');
  }
}
