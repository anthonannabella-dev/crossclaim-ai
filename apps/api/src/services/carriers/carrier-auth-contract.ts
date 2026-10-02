/**
 * CARRIER QUEUE #3（MSG-20261003-105 ⑯–㉓）— UPS / FedEx 授权 + 账号发现**内部契约**。
 * ---------------------------------------------------------------
 * 本模块只描述「真实接入前必须成立的契约」，**不包含任何真实 provider 调用**：
 *   · UPS / FedEx 的 authKind / endpoint 抽象 / token 过期 / refresh 行为 / 只读 scope 意图**分别**声明；
 *   · 端点只声明抽象名与「由 HOST 注入」，本仓库不持有任何真实 URL / client id / client secret；
 *   · 凭据边界沿用 PC-11A：只允许 credentialRef（明文永不入库 / 永不入日志 / 永不回显）；
 *   · capability / readiness 事实按 provider **分别**表达（禁止一个泛化的 CARRIER_READY）。
 * 单一口径：provider 差异（authModel / 能力标志）来自 connector-capability.ts，本模块不另立第二事实源。
 * 边界：productionCredentials 恒 ABSENT · platformWriteEnabled=false · transportEnabled=false · TRANSPORT=false。
 */

import { resolveCarrierConnector, type CarrierAuthModel, type CarrierProvider } from './connector-capability';

export type { CarrierProvider } from './connector-capability';

/** 生产审批状态：本仓库永远不声称已获批。 */
export type CarrierProductionApprovalState = 'NOT_REQUESTED' | 'PENDING' | 'APPROVED';

/** 只读 scope **意图**（内部抽象名；与 provider 真实 scope 名称的映射在真实接入批次完成）。 */
export const CARRIER_READ_ONLY_SCOPE_INTENTS = ['TRACKING_READ', 'INVOICE_READ', 'POD_READ'] as const;
export type CarrierReadOnlyScopeIntent = (typeof CARRIER_READ_ONLY_SCOPE_INTENTS)[number];

/** token 过期策略：真实 TTL 由 HOST / provider 文档注入，本仓库不猜具体数值。 */
export interface CarrierTokenExpiryPolicy {
  supported: boolean;
  defaultTtlSeconds: number | null;
}

/** refresh 语义：OAuth refresh_token 轮换 vs Integrator 凭据重新签发。 */
export type CarrierRefreshBehavior = 'REFRESH_TOKEN' | 'CLIENT_CREDENTIAL_REISSUE';

/** 端点抽象：只声明「这类端点必须存在 + 由 HOST 配置」，不持有任何取值。 */
export interface CarrierEndpointAbstraction {
  abstraction: string;
  configuredBy: 'HOST';
  value: null;
}

export interface CarrierAuthContract {
  provider: CarrierProvider;
  /** 与 connector-capability 的 provider 事实同源（UPS = OAuth Auth-Code；FedEx = Integrator Credential Registration）。 */
  authKind: CarrierAuthModel;
  authorizationEndpoint: CarrierEndpointAbstraction;
  tokenEndpoint: CarrierEndpointAbstraction;
  accountDiscoveryEndpoint: CarrierEndpointAbstraction;
  tokenExpiry: CarrierTokenExpiryPolicy;
  refreshBehavior: CarrierRefreshBehavior;
  refreshSupported: boolean;
  /** 只读 scope 意图（禁止出现任何 write）。 */
  readOnlyScopeIntents: readonly CarrierReadOnlyScopeIntent[];
  /** 生产凭据要求（只声明变量名 / 概念，永不落值）。 */
  requiredProductionCredentials: readonly string[];
  credentialReferenceOnly: true;
  identityVerificationRequired: true;
  /** 1 credential 能否发现多个账号由 provider discovery 事实决定（不得假定 1:1）。 */
  multiAccountPerCredential: 'PROVIDER_DISCOVERY_DECIDES';
  /** 真实网络调用实现状态（本批恒 false —— HOLD_EXTERNAL）。 */
  authImplemented: false;
  accountDiscoveryImplemented: false;
  /** 内部契约就绪（接口 / 边界 / 回归已定义）。 */
  authContractReady: true;
  accountDiscoveryContractReady: true;
  productionCredentials: 'ABSENT';
  productionApprovalState: CarrierProductionApprovalState;
  sandboxState: 'AVAILABLE';
  platformWriteEnabled: false;
  transportEnabled: false;
  requiredHostActions: readonly string[];
}

export type CarrierAuthContractErrorCode =
  | 'CARRIER_PROVIDER_UNKNOWN'
  | 'CARRIER_SCOPE_ESCALATION_REJECTED'
  | 'CARRIER_READINESS_MUST_REMAIN_EXTERNAL_GATE';

export class CarrierAuthContractError extends Error {
  constructor(readonly code: CarrierAuthContractErrorCode, readonly detail?: string) {
    super(code);
    this.name = 'CarrierAuthContractError';
  }
}

const CARRIER_REQUIRED_HOST_ACTIONS = [
  'UPS developer credentials (client id / client secret) written by HOST',
  'FedEx developer credentials (Integrator credential registration) written by HOST',
  'carrier callback / config registration',
  'real seller / shipper account authorization',
  'sandbox then real-data read validation',
] as const;

interface CarrierProviderSpecifics {
  authorization: string;
  token: string;
  discovery: string;
  tokenExpiry: CarrierTokenExpiryPolicy;
  refreshBehavior: CarrierRefreshBehavior;
  refreshSupported: boolean;
  requiredProductionCredentials: readonly string[];
}

/**
 * provider 差异集中在这里（**不是**把两家 carrier 写成同一套协议）：
 *   UPS  = 第三方应用 OAuth Auth-Code（客户授权，多 shipper account 映射多个 PlatformAccount）；
 *   FedEx = Integrator Provider / Credential Registration（provider-specific onboarding，不得假定与 UPS 相同流程）。
 * 统一的是 interface，不是 provider-specific details。
 */
const CARRIER_PROVIDER_SPECIFICS: Readonly<Record<CarrierProvider, CarrierProviderSpecifics>> = {
  UPS: {
    authorization: 'UPS_OAUTH_AUTHORIZATION_CODE',
    token: 'UPS_OAUTH_TOKEN',
    discovery: 'UPS_SHIPPER_ACCOUNT_DISCOVERY',
    tokenExpiry: { supported: true, defaultTtlSeconds: null },
    refreshBehavior: 'REFRESH_TOKEN',
    refreshSupported: true,
    requiredProductionCredentials: ['UPS_CLIENT_ID', 'UPS_CLIENT_SECRET'],
  },
  FEDEX: {
    authorization: 'FEDEX_INTEGRATOR_CREDENTIAL_REGISTRATION',
    token: 'FEDEX_INTEGRATOR_TOKEN',
    discovery: 'FEDEX_INTEGRATOR_ACCOUNT_DISCOVERY',
    tokenExpiry: { supported: true, defaultTtlSeconds: null },
    refreshBehavior: 'CLIENT_CREDENTIAL_REISSUE',
    refreshSupported: true,
    requiredProductionCredentials: ['FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET', 'FEDEX_INTEGRATOR_CREDENTIAL_REF'],
  },
};

function buildCarrierAuthContract(provider: CarrierProvider): CarrierAuthContract {
  const descriptor = resolveCarrierConnector(provider);
  if (!descriptor) throw new CarrierAuthContractError('CARRIER_PROVIDER_UNKNOWN', provider);
  const specifics = CARRIER_PROVIDER_SPECIFICS[provider];
  return {
    provider,
    authKind: descriptor.authModel,
    authorizationEndpoint: { abstraction: specifics.authorization, configuredBy: 'HOST', value: null },
    tokenEndpoint: { abstraction: specifics.token, configuredBy: 'HOST', value: null },
    accountDiscoveryEndpoint: { abstraction: specifics.discovery, configuredBy: 'HOST', value: null },
    tokenExpiry: specifics.tokenExpiry,
    refreshBehavior: specifics.refreshBehavior,
    refreshSupported: specifics.refreshSupported,
    readOnlyScopeIntents: CARRIER_READ_ONLY_SCOPE_INTENTS,
    requiredProductionCredentials: specifics.requiredProductionCredentials,
    credentialReferenceOnly: true,
    identityVerificationRequired: true,
    multiAccountPerCredential: 'PROVIDER_DISCOVERY_DECIDES',
    authImplemented: false,
    accountDiscoveryImplemented: false,
    authContractReady: true,
    accountDiscoveryContractReady: true,
    productionCredentials: 'ABSENT',
    productionApprovalState: 'NOT_REQUESTED',
    sandboxState: 'AVAILABLE',
    platformWriteEnabled: false,
    transportEnabled: false,
    requiredHostActions: CARRIER_REQUIRED_HOST_ACTIONS,
  };
}

export const CARRIER_AUTH_CONTRACTS: readonly CarrierAuthContract[] = [
  buildCarrierAuthContract('UPS'),
  buildCarrierAuthContract('FEDEX'),
];

/** 未知 carrier → null（调用方必须 fail-closed，不得猜测）。 */
export function resolveCarrierAuthContract(provider: string): CarrierAuthContract | null {
  return CARRIER_AUTH_CONTRACTS.find((entry) => entry.provider === provider.toUpperCase()) ?? null;
}

export function requireCarrierAuthContract(provider: string): CarrierAuthContract {
  const contract = resolveCarrierAuthContract(provider);
  if (!contract) throw new CarrierAuthContractError('CARRIER_PROVIDER_UNKNOWN', provider);
  return contract;
}

/** 只读 scope 意图守卫：任何 write / 未登记意图一律拒绝（fail-closed，不得 broaden scope）。 */
export function assertCarrierReadOnlyScopeIntents(provider: string, intents: readonly string[]): void {
  const contract = requireCarrierAuthContract(provider);
  for (const intent of intents) {
    if (/write|delete|create|update|submit|mutate/i.test(intent)) {
      throw new CarrierAuthContractError('CARRIER_SCOPE_ESCALATION_REJECTED', provider + ':' + intent);
    }
    if (!contract.readOnlyScopeIntents.includes(intent as CarrierReadOnlyScopeIntent)) {
      throw new CarrierAuthContractError('CARRIER_SCOPE_ESCALATION_REJECTED', provider + ':' + intent);
    }
  }
}

export interface CarrierReadinessView {
  provider: CarrierProvider;
  authKind: CarrierAuthModel;
  authContractReady: true;
  accountDiscoveryContractReady: true;
  authImplemented: false;
  accountDiscoveryImplemented: false;
  identityVerificationRequired: true;
  productionCredentials: 'ABSENT';
  productionApprovalState: CarrierProductionApprovalState;
  sandboxState: 'AVAILABLE';
  platformWriteEnabled: false;
  transportEnabled: false;
  requiredHostActions: readonly string[];
}

/**
 * readiness 投影：**合同就绪 ≠ 生产可用**。
 * 按 provider 分别返回（不存在一个泛化的 CARRIER_READY）；真实接入仍需 HOLD_EXTERNAL 外部闸门。
 */
export function projectCarrierReadiness(): CarrierReadinessView[] {
  return CARRIER_AUTH_CONTRACTS.map((contract) => ({
    provider: contract.provider,
    authKind: contract.authKind,
    authContractReady: true,
    accountDiscoveryContractReady: true,
    authImplemented: false,
    accountDiscoveryImplemented: false,
    identityVerificationRequired: true,
    productionCredentials: 'ABSENT',
    productionApprovalState: contract.productionApprovalState,
    sandboxState: 'AVAILABLE',
    platformWriteEnabled: false,
    transportEnabled: false,
    requiredHostActions: contract.requiredHostActions,
  }));
}

/** 防御式断言：任何消费方都不得把 carrier readiness 当成生产可用。 */
export function assertCarrierNotProductionReady(view: CarrierReadinessView): void {
  if (view.productionCredentials !== 'ABSENT' || view.platformWriteEnabled !== false || view.transportEnabled !== false) {
    throw new CarrierAuthContractError('CARRIER_READINESS_MUST_REMAIN_EXTERNAL_GATE', view.provider);
  }
}
