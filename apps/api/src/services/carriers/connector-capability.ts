/**
 * HOST DIRECTIVE 2026-10-02（Carrier SLA / Dual-Path / Customs）—— Carrier Connector Capability Interface。
 * ---------------------------------------------------------------
 * 设计纪律（来自指令）：
 *   · **禁止假设**所有 Provider 都具有公开 Direct Claim API：未审计的能力一律 false；
 *   · 未知 provider → fail-closed；
 *   · token / client secret / refresh credential 禁止进入 PlatformAccount，统一走 SourceConnection.credentialRef；
 *   · 本模块只描述能力与提交模式，**不做任何外写**（platformWriteEnabled 恒 false）。
 * 复用约束：账户 / 连接事实源仍是 PlatformAccount + SourceConnection（本模块不建第二事实源）。
 */

/** 统一 operation 契约（指令 2.1）。 */
export const CARRIER_CONNECTOR_OPERATIONS = [
  'authorize',
  'refreshAuthorization',
  'listShipments',
  'getTracking',
  'getInvoice',
  'getPOD',
  'prepareClaim',
  'submitClaim',
  'getClaimStatus',
] as const;
export type CarrierConnectorOperation = (typeof CARRIER_CONNECTOR_OPERATIONS)[number];

/** Capability negotiation 标志（指令 2.1）。 */
export const CARRIER_CAPABILITY_FLAGS = [
  'supportsTrackingRead',
  'supportsInvoiceRead',
  'supportsPODRead',
  'supportsDirectClaimSubmission',
  'supportsClaimStatusRead',
] as const;
export type CarrierCapabilityFlag = (typeof CARRIER_CAPABILITY_FLAGS)[number];

/** Submission Mode（指令 2.1）：DIRECT_API / PORTAL_DEEPLINK / CLAIM_READY_PACKAGE。 */
export const SUBMISSION_MODES = ['DIRECT_API', 'PORTAL_DEEPLINK', 'CLAIM_READY_PACKAGE'] as const;
export type SubmissionMode = (typeof SUBMISSION_MODES)[number];

/** UPS = OAuth Auth-Code；FedEx = Integrator Provider / Credential Registration（两者**不同**）。 */
export type CarrierAuthModel = 'OAUTH_AUTH_CODE' | 'INTEGRATOR_CREDENTIAL_REGISTRATION';

/**
 * CARRIER QUEUE #3 FINAL（MSG-20261003-106 ⑪⑫）：provider **支持**的授权流程 ≠ CrossClaim 选定的 integration flow。
 * UPS 官方同时存在 Client Credentials Flow 与 Authorization Code Flow；把 UPS 写成「只有 OAUTH_AUTH_CODE」是过强表达。
 */
export const CARRIER_AUTH_FLOWS = ['CLIENT_CREDENTIALS', 'AUTHORIZATION_CODE', 'INTEGRATOR_CREDENTIAL_REGISTRATION'] as const;
export type CarrierAuthFlow = (typeof CARRIER_AUTH_FLOWS)[number];

/** 选定该 integration flow 的原因（第三方客户授权 vs provider integrator 注册）。 */
export const CARRIER_AUTH_FLOW_SELECTION_REASONS = ['THIRD_PARTY_CUSTOMER_AUTHORIZATION', 'PROVIDER_INTEGRATOR_REGISTRATION'] as const;
export type CarrierAuthFlowSelectionReason = (typeof CARRIER_AUTH_FLOW_SELECTION_REASONS)[number];

/**
 * CARRIER QUEUE #3 FINAL（MSG-20261003-106 ⑮–⑱）：账号身份获取策略按 provider 分别成立。
 *   PROVIDER_DISCOVERY            —— 一个 profile / credential 可发现多个账号（UPS：Profile 可关联多个 account numbers）。
 *   PROVIDER_VERIFIED_REGISTRATION —— 客户提交候选账号 + 姓名 + 地址，provider 注册/验证后才签发凭据（FedEx）。
 * **不得**假定所有 carrier 都能 discover accounts。
 */
export const CARRIER_ACCOUNT_IDENTITY_STRATEGIES = ['PROVIDER_DISCOVERY', 'PROVIDER_VERIFIED_REGISTRATION'] as const;
export type CarrierAccountIdentityStrategy = (typeof CARRIER_ACCOUNT_IDENTITY_STRATEGIES)[number];
export type CarrierProvider = 'UPS' | 'FEDEX';

/** 能力声明必须区分「provider 支持」与「我们已取证」——「代码支持」不算证据。 */
export interface CapabilityAudit {
  audited: boolean;
  evidenceRef: string | null;
}

export interface CarrierConnectorDescriptor {
  provider: CarrierProvider;
  authModel: CarrierAuthModel;
  /** provider 支持的授权流程集合（不是「只有一种」）。 */
  supportedAuthFlows: readonly CarrierAuthFlow[];
  /** CrossClaim 当前选定的 integration flow（selected flow ≠ provider only flow）。 */
  selectedAuthFlow: CarrierAuthFlow;
  authFlowSelectionReason: CarrierAuthFlowSelectionReason;
  /** 账号身份获取策略（UPS = discovery；FedEx = provider-verified registration）。 */
  accountIdentityStrategy: CarrierAccountIdentityStrategy;
  operations: readonly CarrierConnectorOperation[];
  capabilities: Record<CarrierCapabilityFlag, boolean>;
  capabilityAudit: Record<CarrierCapabilityFlag, CapabilityAudit>;
  submissionModes: readonly SubmissionMode[];
  /** 一个客户可以映射多个 shipper account → 多个 PlatformAccount（指令 2.6）。 */
  multiAccountPerCustomer: boolean;
  /** 凭据只以引用形式保存（SourceConnection.credentialRef）。 */
  credentialReferenceOnly: true;
  /** 本模块不启用任何外写。 */
  platformWriteEnabled: false;
  /** 真实凭据 / 审批仍在外部门槛。 */
  readiness: 'EXTERNAL_GATE';
  requiredHostActions: readonly string[];
}

const NO_AUDIT: CapabilityAudit = { audited: false, evidenceRef: null };
const NO_DIRECT_CLAIM: CapabilityAudit = { audited: false, evidenceRef: null };

const CARRIER_REQUIRED_HOST_ACTIONS = [
  'carrier account authorization (real seller / shipper consent)',
  'production client id / client secret written by HOST',
  'callback domain registration',
  'production webhook secret (if applicable)',
  'REAL DATA READ VALIDATION (real customer data)',
  'direct submission enablement review (only after audited capability)',
] as const;

export const CARRIER_CONNECTOR_DESCRIPTORS: readonly CarrierConnectorDescriptor[] = [
  {
    provider: 'UPS',
    authModel: 'OAUTH_AUTH_CODE',
    supportedAuthFlows: ['CLIENT_CREDENTIALS', 'AUTHORIZATION_CODE'],
    selectedAuthFlow: 'AUTHORIZATION_CODE',
    authFlowSelectionReason: 'THIRD_PARTY_CUSTOMER_AUTHORIZATION',
    accountIdentityStrategy: 'PROVIDER_DISCOVERY',
    operations: CARRIER_CONNECTOR_OPERATIONS,
    capabilities: {
      supportsTrackingRead: true,
      supportsInvoiceRead: true,
      supportsPODRead: true,
      // 指令：**禁止假设**所有 provider 都有公开 Direct Claim API → 未审计即 false
      supportsDirectClaimSubmission: false,
      supportsClaimStatusRead: false,
    },
    capabilityAudit: {
      supportsTrackingRead: NO_AUDIT,
      supportsInvoiceRead: NO_AUDIT,
      supportsPODRead: NO_AUDIT,
      supportsDirectClaimSubmission: NO_DIRECT_CLAIM,
      supportsClaimStatusRead: NO_AUDIT,
    },
    submissionModes: ['CLAIM_READY_PACKAGE', 'PORTAL_DEEPLINK'],
    multiAccountPerCustomer: true,
    credentialReferenceOnly: true,
    platformWriteEnabled: false,
    readiness: 'EXTERNAL_GATE',
    requiredHostActions: CARRIER_REQUIRED_HOST_ACTIONS,
  },
  {
    provider: 'FEDEX',
    authModel: 'INTEGRATOR_CREDENTIAL_REGISTRATION',
    supportedAuthFlows: ['INTEGRATOR_CREDENTIAL_REGISTRATION'],
    selectedAuthFlow: 'INTEGRATOR_CREDENTIAL_REGISTRATION',
    authFlowSelectionReason: 'PROVIDER_INTEGRATOR_REGISTRATION',
    accountIdentityStrategy: 'PROVIDER_VERIFIED_REGISTRATION',
    operations: CARRIER_CONNECTOR_OPERATIONS,
    capabilities: {
      supportsTrackingRead: true,
      supportsInvoiceRead: true,
      supportsPODRead: true,
      supportsDirectClaimSubmission: false,
      supportsClaimStatusRead: false,
    },
    capabilityAudit: {
      supportsTrackingRead: NO_AUDIT,
      supportsInvoiceRead: NO_AUDIT,
      supportsPODRead: NO_AUDIT,
      supportsDirectClaimSubmission: NO_DIRECT_CLAIM,
      supportsClaimStatusRead: NO_AUDIT,
    },
    submissionModes: ['CLAIM_READY_PACKAGE', 'PORTAL_DEEPLINK'],
    multiAccountPerCustomer: true,
    credentialReferenceOnly: true,
    platformWriteEnabled: false,
    readiness: 'EXTERNAL_GATE',
    requiredHostActions: CARRIER_REQUIRED_HOST_ACTIONS,
  },
] as const;

export type CarrierCapabilityErrorCode =
  | 'CARRIER_PROVIDER_UNKNOWN'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'SUBMISSION_MODE_NOT_SUPPORTED'
  | 'DIRECT_CLAIM_SUBMISSION_NOT_AUDITED'
  | 'CARRIER_AUTH_FLOW_INCONSISTENT';

export class CarrierCapabilityError extends Error {
  constructor(readonly code: CarrierCapabilityErrorCode, readonly detail?: string) {
    super(code);
    this.name = 'CarrierCapabilityError';
  }
}

/** 未知 provider → null（调用方必须 fail-closed，不得猜测）。 */
export function resolveCarrierConnector(provider: string): CarrierConnectorDescriptor | null {
  return CARRIER_CONNECTOR_DESCRIPTORS.find((entry) => entry.provider === provider.toUpperCase()) ?? null;
}

export interface CarrierCapabilityNegotiation {
  provider: CarrierProvider;
  authModel: CarrierAuthModel;
  capabilities: Record<CarrierCapabilityFlag, boolean>;
  submissionModes: readonly SubmissionMode[];
  /** 直接提交是否**当前**允许（恒 false，直到 Step 10 独立审计放行）。 */
  directSubmissionAllowed: boolean;
  readiness: 'EXTERNAL_GATE';
}

/** 能力协商：未知 provider 抛错；directSubmissionAllowed 与能力声明严格一致。 */
export function negotiateCarrierCapabilities(provider: string): CarrierCapabilityNegotiation {
  const descriptor = resolveCarrierConnector(provider);
  if (!descriptor) throw new CarrierCapabilityError('CARRIER_PROVIDER_UNKNOWN', provider);
  const direct = descriptor.capabilities.supportsDirectClaimSubmission && descriptor.capabilityAudit.supportsDirectClaimSubmission.audited;
  return {
    provider: descriptor.provider,
    authModel: descriptor.authModel,
    capabilities: descriptor.capabilities,
    submissionModes: descriptor.submissionModes,
    directSubmissionAllowed: direct,
    readiness: 'EXTERNAL_GATE',
  };
}

/** 逐项能力守护：不支持 → CAPABILITY_NOT_SUPPORTED（fail-closed）。 */
export function requireCarrierCapability(provider: string, flag: CarrierCapabilityFlag): void {
  const descriptor = resolveCarrierConnector(provider);
  if (!descriptor) throw new CarrierCapabilityError('CARRIER_PROVIDER_UNKNOWN', provider);
  if (!descriptor.capabilities[flag]) throw new CarrierCapabilityError('CAPABILITY_NOT_SUPPORTED', provider + ':' + flag);
}

/**
 * 提交模式守护：
 *   · 未登记的 mode → SUBMISSION_MODE_NOT_SUPPORTED；
 *   · DIRECT_API → 必须 supportsDirectClaimSubmission 且 capabilityAudit audited，否则 DIRECT_CLAIM_SUBMISSION_NOT_AUDITED。
 * 其余模式（PORTAL_DEEPLINK / CLAIM_READY_PACKAGE）不产生任何外写。
 */
export function assertCarrierSubmissionModeAllowed(provider: string, mode: SubmissionMode): void {
  const descriptor = resolveCarrierConnector(provider);
  if (!descriptor) throw new CarrierCapabilityError('CARRIER_PROVIDER_UNKNOWN', provider);
  if (!descriptor.submissionModes.includes(mode)) throw new CarrierCapabilityError('SUBMISSION_MODE_NOT_SUPPORTED', provider + ':' + mode);
  if (mode === 'DIRECT_API') {
    const declared = descriptor.capabilities.supportsDirectClaimSubmission;
    const audited = descriptor.capabilityAudit.supportsDirectClaimSubmission.audited;
    if (!declared || !audited) throw new CarrierCapabilityError('DIRECT_CLAIM_SUBMISSION_NOT_AUDITED', provider);
  }
}

/** 当前阶段恒 false（Step 10 独立审计后才可能为 true）。 */
export function supportsDirectClaimSubmission(provider: string): boolean {
  return negotiateCarrierCapabilities(provider).directSubmissionAllowed;
}

/** selected integration flow → 既有 authModel 名称（保持既有消费方兼容）。 */
export function carrierAuthModelForFlow(flow: CarrierAuthFlow): CarrierAuthModel {
  if (flow === 'CLIENT_CREDENTIALS') return 'OAUTH_AUTH_CODE';
  if (flow === 'AUTHORIZATION_CODE') return 'OAUTH_AUTH_CODE';
  return 'INTEGRATOR_CREDENTIAL_REGISTRATION';
}

/**
 * 防御式断言：selected flow 必须属于 supported flows，且 authModel 必须与 selected flow 一致。
 * 防止再次出现「把 provider 支持流程集合错误简化成唯一 authModel」。
 */
export function assertCarrierAuthTruth(descriptor: CarrierConnectorDescriptor): void {
  if (!descriptor.supportedAuthFlows.includes(descriptor.selectedAuthFlow)) {
    throw new CarrierCapabilityError('CARRIER_AUTH_FLOW_INCONSISTENT', descriptor.provider + ':selected-not-supported');
  }
  if (descriptor.authModel !== carrierAuthModelForFlow(descriptor.selectedAuthFlow)) {
    throw new CarrierCapabilityError('CARRIER_AUTH_FLOW_INCONSISTENT', descriptor.provider + ':authModel-mismatch');
  }
  if (!CARRIER_ACCOUNT_IDENTITY_STRATEGIES.includes(descriptor.accountIdentityStrategy)) {
    throw new CarrierCapabilityError('CARRIER_AUTH_FLOW_INCONSISTENT', descriptor.provider + ':identity-strategy');
  }
}
