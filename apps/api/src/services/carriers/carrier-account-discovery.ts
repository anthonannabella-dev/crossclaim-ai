/**
 * CARRIER QUEUE #3 / #3 FINAL（MSG-20261003-105 ⑰–㉕ + MSG-20261003-106 ⑬–㉓）
 * — UPS / FedEx 账号身份获取**内部契约**（read-only first，provider-specific strategy）。
 * ---------------------------------------------------------------
 * 身份策略（MSG-106 ⑮–⑱）：
 *   · UPS   = PROVIDER_DISCOVERY            —— 一个 UPS Profile 可关联多个 account numbers，0 / 1 / 多语义适用。
 *   · FedEx = PROVIDER_VERIFIED_REGISTRATION —— 客户提交候选账号 + 姓名 + 地址 → provider 注册/验证 → 签发凭据
 *                                              → **才**成为 provider-verified identity。
 * **不得**把 FedEx 塞进 discovery 模型，也不得声称「拿 credential 自动列出客户全部账号」。
 * ---------------------------------------------------------------
 * 通用顺序（任何一步失败都 fail-closed，且不产生任何业务事实）：
 *   provider 解析 → 输入形状（**不接受**明文凭据 / 未声明字段）→ tenant 上下文
 *     → 策略守卫（discovery 只服务 PROVIDER_DISCOVERY；registration 只服务 PROVIDER_VERIFIED_REGISTRATION）
 *     → 身份形状校验（provider 一致 / externalAccountId 非空 / identitySource 显式且与策略一致 / 无凭据字段）
 *     → candidateIdentity(provider + externalAccountId) 去重（幂等）→ 0 / 1 / 多分支（多账号必须显式选择）
 * 硬约束：bindExecuted=false · transportEnabled=false · platformWriteEnabled=false · productionCredentials=ABSENT。
 * 用户输入的账号号永远只是 candidate identity input，**不得**成为 trusted identity。
 */

import type { CarrierAccountIdentityStrategy, CarrierProvider } from './connector-capability';
import { resolveCarrierAuthContract } from './carrier-auth-contract';

export const CARRIER_ACCOUNT_TYPES = ['SHIPPER', 'PAYER', 'THIRD_PARTY', 'UNKNOWN'] as const;
export type CarrierAccountType = (typeof CARRIER_ACCOUNT_TYPES)[number];

export const CARRIER_ACCOUNT_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;
export type CarrierAccountStatus = (typeof CARRIER_ACCOUNT_STATUSES)[number];

/** carrier 账号身份版本默认值（真实接入时由 provider 返回）。 */
export const CARRIER_IDENTITY_VERSION = 'carrier-identity-v1';

/** MSG-106 ⑲：身份来源必须显式返回（策略中立，不把 FedEx 硬塞进 discovery 模型）。 */
export const CARRIER_ACCOUNT_IDENTITY_SOURCES = ['PROVIDER_DISCOVERY', 'PROVIDER_VERIFIED_REGISTRATION'] as const;
export type CarrierAccountIdentitySource = (typeof CARRIER_ACCOUNT_IDENTITY_SOURCES)[number];

/** provider 已验证账号身份（策略中立命名，MSG-106 ⑲）。 */
export interface CarrierVerifiedAccountIdentity {
  provider: CarrierProvider;
  externalAccountId: string;
  displayName: string;
  accountType: CarrierAccountType;
  countryOrRegion: string;
  status: CarrierAccountStatus;
  identityVersion: string;
  identitySource: CarrierAccountIdentitySource;
}

/** @deprecated 使用策略中立的 CarrierVerifiedAccountIdentity。 */
export type CarrierDiscoveredAccount = CarrierVerifiedAccountIdentity;

/**
 * 账号发现端口（**仅** PROVIDER_DISCOVERY 策略：UPS）。
 * 真实实现属 HOLD_EXTERNAL；只接受 credentialRef，明文 token / client secret 永不进入本接口。
 */
export interface CarrierAccountDiscoveryPort {
  discoverAccounts(input: {
    provider: CarrierProvider;
    credentialRef: string;
    organizationId: string;
    actorUserId: string;
  }): Promise<readonly CarrierVerifiedAccountIdentity[]>;
}

/** MSG-106 ⑭：客户提交的候选账号 —— 只是 candidate identity input，不是 trusted identity。 */
export interface CarrierAccountRegistrationCandidate {
  externalAccountId: string;
  customerName: string;
  customerAddress: string;
}

/** provider 注册/验证结果（credentialRef 由 provider 签发；明文永不出现）。 */
export interface CarrierRegistrationResult {
  verified: boolean;
  credentialRef: string | null;
  identity: CarrierVerifiedAccountIdentity | null;
  registrationRef: string;
}

/**
 * 账号注册/验证端口（**仅** PROVIDER_VERIFIED_REGISTRATION 策略：FedEx）。
 * 真实实现属 HOLD_EXTERNAL（需 FedEx Credential Registration 资质）。
 */
export interface CarrierAccountRegistrationPort {
  registerAccount(input: {
    provider: CarrierProvider;
    organizationId: string;
    actorUserId: string;
    candidate: CarrierAccountRegistrationCandidate;
  }): Promise<CarrierRegistrationResult>;
}

export type CarrierDiscoveryFailureCode =
  | 'UNKNOWN_CARRIER'
  | 'PLAINTEXT_CREDENTIAL_NOT_SUPPORTED'
  | 'UNSUPPORTED_INPUT'
  | 'CREDENTIAL_REF_REQUIRED'
  | 'TENANT_CONTEXT_REQUIRED'
  | 'IDENTITY_STRATEGY_NOT_DISCOVERY'
  | 'IDENTITY_STRATEGY_NOT_REGISTRATION'
  | 'CANDIDATE_EVIDENCE_REQUIRED'
  | 'CREDENTIAL_LINEAGE_CONFLICT'
  | 'DISCOVERY_FAILED'
  | 'REGISTRATION_FAILED'
  | 'REGISTRATION_NOT_VERIFIED'
  | 'DISCOVERED_ACCOUNT_INVALID'
  | 'IDENTITY_INVALID';

/** credentialRef 的租户血脉：organizationId + actorUserId + provider + credentialRef。 */
export interface CarrierCredentialLineage {
  provider: CarrierProvider;
  organizationId: string;
  actorUserId: string;
  credentialRef: string;
}

export type CarrierCredentialLineageRegistration =
  | { ok: true }
  | { ok: false; reason: 'CROSS_TENANT' | 'PROVIDER_MISMATCH' };

export interface CarrierCredentialLineageStore {
  register(input: CarrierCredentialLineage): CarrierCredentialLineageRegistration;
}

/**
 * 进程内血脉登记表：同一 credentialRef 首次登记决定归属；
 * 后续若出现其它 organization（跨租户）或其它 provider，一律拒绝复用（MSG-106 ㉑ 保持）。
 */
export function createInMemoryCarrierCredentialLineageStore(): CarrierCredentialLineageStore {
  const registry = new Map<string, CarrierCredentialLineage>();
  return {
    register(input) {
      const existing = registry.get(input.credentialRef);
      if (!existing) {
        registry.set(input.credentialRef, {
          provider: input.provider,
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          credentialRef: input.credentialRef,
        });
        return { ok: true };
      }
      if (existing.organizationId !== input.organizationId) return { ok: false, reason: 'CROSS_TENANT' };
      if (existing.provider !== input.provider) return { ok: false, reason: 'PROVIDER_MISMATCH' };
      return { ok: true };
    },
  };
}

/** 服务端派生候选身份（客户端提交的账号号永远不进入这里）。 */
export interface CarrierDiscoveryCandidate {
  provider: CarrierProvider;
  externalAccountId: string;
  displayName: string;
  accountType: CarrierAccountType;
  countryOrRegion: string;
  status: CarrierAccountStatus;
  identityVersion: string;
  identitySource: CarrierAccountIdentitySource;
  /** 幂等键：provider + externalAccountId（重复 discovery / registration 必须映射到同一候选身份）。 */
  candidateIdentity: string;
}

/** 绑定计划：本批**不执行**绑定（bindExecuted 恒 false）。 */
export interface CarrierBindPlan {
  provider: CarrierProvider;
  organizationId: string;
  actorUserId: string;
  credentialRef: string;
  credentialLineage: CarrierCredentialLineage;
  identityStrategy: CarrierAccountIdentityStrategy;
  /** FedEx 注册事务 lineage（discovery 为 null）。 */
  registrationRef: string | null;
  candidates: readonly CarrierDiscoveryCandidate[];
  bindExecuted: false;
  transportEnabled: false;
  platformWriteEnabled: false;
  productionCredentials: 'ABSENT';
  requiredNextStep: 'VERIFIED_BIND_REQUIRED_EXTERNAL_GATE';
}

export type CarrierDiscoveryOutcome =
  | {
      ok: true;
      status: 'NO_ACCOUNT_DISCOVERED';
      provider: CarrierProvider;
      candidates: readonly CarrierDiscoveryCandidate[];
      plan: null;
      identityHintAccepted: false;
      transportEnabled: false;
      platformWriteEnabled: false;
      productionCredentials: 'ABSENT';
    }
  | {
      ok: true;
      status: 'CANDIDATE_BIND_PLAN';
      provider: CarrierProvider;
      candidates: readonly CarrierDiscoveryCandidate[];
      plan: CarrierBindPlan;
      identityHintAccepted: false;
      transportEnabled: false;
      platformWriteEnabled: false;
      productionCredentials: 'ABSENT';
    }
  | {
      ok: true;
      status: 'EXPLICIT_SELECTION_REQUIRED';
      provider: CarrierProvider;
      candidates: readonly CarrierDiscoveryCandidate[];
      plan: null;
      identityHintAccepted: false;
      transportEnabled: false;
      platformWriteEnabled: false;
      productionCredentials: 'ABSENT';
    }
  | { ok: false; reason: CarrierDiscoveryFailureCode };

export interface CarrierDiscoveryDeps {
  port: CarrierAccountDiscoveryPort;
  /** 建议显式注入：跨租户复用防护（缺省时不校验血脉，调用方自负） */
  lineage?: CarrierCredentialLineageStore;
}

export interface CarrierDiscoveryInput {
  provider: string;
  credentialRef?: string | null;
  organizationId?: string | null;
  actorUserId?: string | null;
  /** 仅提示，不参与身份派生与账号选择。 */
  hint?: { externalAccountId?: string | null } | null;
}

export interface CarrierAccountRegistrationDeps {
  port: CarrierAccountRegistrationPort;
  lineage?: CarrierCredentialLineageStore;
}

export interface CarrierAccountRegistrationInput {
  provider: string;
  organizationId?: string | null;
  actorUserId?: string | null;
  /** 客户提交的候选账号 + 姓名 + 地址（缺任一项即 fail-closed）。 */
  candidate?: Partial<CarrierAccountRegistrationCandidate> | null;
}

const ALLOWED_INPUT_KEYS = new Set(['provider', 'credentialRef', 'organizationId', 'actorUserId', 'hint']);
const ALLOWED_REGISTRATION_INPUT_KEYS = new Set(['provider', 'organizationId', 'actorUserId', 'candidate']);
const ALLOWED_CANDIDATE_KEYS = new Set(['externalAccountId', 'customerName', 'customerAddress']);
const CREDENTIAL_MATERIAL_KEY = /(token|secret|password|passwd|apikey|api[-_]?key|client[-_]?id|client[-_]?secret|credential)/i;
const IDENTITY_KEYS = new Set([
  'provider',
  'externalAccountId',
  'displayName',
  'accountType',
  'countryOrRegion',
  'status',
  'identityVersion',
  'identitySource',
]);

/** 幂等候选身份：provider + externalAccountId（与 credentialRef / 租户 / 策略无关）。 */
export function carrierCandidateIdentity(provider: CarrierProvider, externalAccountId: string): string {
  return 'carrier:' + provider + ':' + externalAccountId.trim();
}

function scanKeys(source: unknown, allowed: Set<string>): CarrierDiscoveryFailureCode | null {
  if (typeof source !== 'object' || source === null) return 'UNSUPPORTED_INPUT';
  for (const key of Object.keys(source as Record<string, unknown>)) {
    if (allowed.has(key)) continue;
    return CREDENTIAL_MATERIAL_KEY.test(key) ? 'PLAINTEXT_CREDENTIAL_NOT_SUPPORTED' : 'UNSUPPORTED_INPUT';
  }
  return null;
}

function toCandidate(
  provider: CarrierProvider,
  raw: unknown,
  expectedSource: CarrierAccountIdentitySource,
): CarrierDiscoveryCandidate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const identity = raw as Record<string, unknown>;
  for (const key of Object.keys(identity)) {
    // 任何额外字段（尤其 access token / client secret）一律拒绝：凭据绝不进入本层。
    if (!IDENTITY_KEYS.has(key)) return null;
  }
  if (identity.provider !== provider) return null;
  if (identity.identitySource !== expectedSource) return null;
  const externalAccountId = typeof identity.externalAccountId === 'string' ? identity.externalAccountId.trim() : '';
  if (externalAccountId === '') return null;
  if (typeof identity.accountType !== 'string' || !CARRIER_ACCOUNT_TYPES.includes(identity.accountType as CarrierAccountType)) return null;
  if (typeof identity.status !== 'string' || !CARRIER_ACCOUNT_STATUSES.includes(identity.status as CarrierAccountStatus)) return null;
  const displayName = typeof identity.displayName === 'string' && identity.displayName.trim() !== '' ? identity.displayName.trim() : externalAccountId;
  const countryOrRegion = typeof identity.countryOrRegion === 'string' && identity.countryOrRegion.trim() !== '' ? identity.countryOrRegion.trim() : 'UNKNOWN';
  const identityVersion = typeof identity.identityVersion === 'string' && identity.identityVersion.trim() !== '' ? identity.identityVersion.trim() : CARRIER_IDENTITY_VERSION;
  return {
    provider,
    externalAccountId,
    displayName,
    accountType: identity.accountType as CarrierAccountType,
    countryOrRegion,
    status: identity.status as CarrierAccountStatus,
    identityVersion,
    identitySource: expectedSource,
    candidateIdentity: carrierCandidateIdentity(provider, externalAccountId),
  };
}

function dedupeCandidates(candidates: readonly CarrierDiscoveryCandidate[]): CarrierDiscoveryCandidate[] {
  const seen = new Set<string>();
  const unique: CarrierDiscoveryCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.candidateIdentity)) continue;
    seen.add(candidate.candidateIdentity);
    unique.push(candidate);
  }
  unique.sort((left, right) =>
    left.candidateIdentity < right.candidateIdentity ? -1 : left.candidateIdentity > right.candidateIdentity ? 1 : 0,
  );
  return unique;
}

function tenantContext(input: { organizationId?: string | null; actorUserId?: string | null }): {
  organizationId: string;
  actorUserId: string;
} | null {
  const organizationId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
  const actorUserId = typeof input.actorUserId === 'string' ? input.actorUserId.trim() : '';
  if (organizationId === '' || actorUserId === '') return null;
  return { organizationId, actorUserId };
}

function buildPlan(input: {
  provider: CarrierProvider;
  organizationId: string;
  actorUserId: string;
  credentialRef: string;
  strategy: CarrierAccountIdentityStrategy;
  registrationRef: string | null;
  candidate: CarrierDiscoveryCandidate;
}): CarrierBindPlan {
  return {
    provider: input.provider,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    credentialRef: input.credentialRef,
    credentialLineage: {
      provider: input.provider,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      credentialRef: input.credentialRef,
    },
    identityStrategy: input.strategy,
    registrationRef: input.registrationRef,
    candidates: [input.candidate],
    bindExecuted: false,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
    requiredNextStep: 'VERIFIED_BIND_REQUIRED_EXTERNAL_GATE',
  };
}

function buildPlanOutcome(plan: CarrierBindPlan, candidates: readonly CarrierDiscoveryCandidate[]): CarrierDiscoveryOutcome {
  return {
    ok: true,
    status: 'CANDIDATE_BIND_PLAN',
    provider: plan.provider,
    candidates,
    plan,
    identityHintAccepted: false,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
  };
}

/**
 * 账号发现（**仅** PROVIDER_DISCOVERY 策略）：UPS 一个 profile 可关联多个 account numbers。
 * 0 → NO_ACCOUNT_DISCOVERED；1 → CANDIDATE_BIND_PLAN；多 → EXPLICIT_SELECTION_REQUIRED（禁止自动绑定）。
 */
export async function discoverCarrierAccounts(
  deps: CarrierDiscoveryDeps,
  input: CarrierDiscoveryInput,
): Promise<CarrierDiscoveryOutcome> {
  const contract = resolveCarrierAuthContract(input.provider);
  if (!contract) return { ok: false, reason: 'UNKNOWN_CARRIER' };
  const provider = contract.provider;

  const shapeFailure = scanKeys(input, ALLOWED_INPUT_KEYS);
  if (shapeFailure) return { ok: false, reason: shapeFailure };

  const credentialRef = typeof input.credentialRef === 'string' ? input.credentialRef.trim() : '';
  if (credentialRef === '') return { ok: false, reason: 'CREDENTIAL_REF_REQUIRED' };

  const tenant = tenantContext(input);
  if (!tenant) return { ok: false, reason: 'TENANT_CONTEXT_REQUIRED' };

  // MSG-106 ⑬⑮⑯：discovery 只服务 PROVIDER_DISCOVERY（UPS）；FedEx 不得被塞进 discovery 模型。
  if (contract.accountIdentityStrategy !== 'PROVIDER_DISCOVERY') {
    return { ok: false, reason: 'IDENTITY_STRATEGY_NOT_DISCOVERY' };
  }

  if (deps.lineage) {
    const registration = deps.lineage.register({ provider, ...tenant, credentialRef });
    if (!registration.ok) return { ok: false, reason: 'CREDENTIAL_LINEAGE_CONFLICT' };
  }

  let discovered: readonly unknown[];
  try {
    discovered = await deps.port.discoverAccounts({ provider, credentialRef, ...tenant });
  } catch {
    return { ok: false, reason: 'DISCOVERY_FAILED' };
  }
  if (!Array.isArray(discovered)) return { ok: false, reason: 'DISCOVERY_FAILED' };

  const candidates: CarrierDiscoveryCandidate[] = [];
  for (const identity of discovered) {
    const candidate = toCandidate(provider, identity, 'PROVIDER_DISCOVERY');
    if (!candidate) return { ok: false, reason: 'DISCOVERED_ACCOUNT_INVALID' };
    candidates.push(candidate);
  }
  const unique = dedupeCandidates(candidates);

  if (unique.length === 0) {
    return {
      ok: true,
      status: 'NO_ACCOUNT_DISCOVERED',
      provider,
      candidates: [],
      plan: null,
      identityHintAccepted: false,
      transportEnabled: false,
      platformWriteEnabled: false,
      productionCredentials: 'ABSENT',
    };
  }
  if (unique.length > 1) {
    // 多个账号：必须显式选择；hint 不参与选择，也绝不自动绑定。
    return {
      ok: true,
      status: 'EXPLICIT_SELECTION_REQUIRED',
      provider,
      candidates: unique,
      plan: null,
      identityHintAccepted: false,
      transportEnabled: false,
      platformWriteEnabled: false,
      productionCredentials: 'ABSENT',
    };
  }
  const plan = buildPlan({
    provider,
    ...tenant,
    credentialRef,
    strategy: 'PROVIDER_DISCOVERY',
    registrationRef: null,
    candidate: unique[0],
  });
  return buildPlanOutcome(plan, unique);
}

/**
 * 账号身份注册/验证（**仅** PROVIDER_VERIFIED_REGISTRATION 策略）：FedEx。
 * 客户提交候选账号 + 姓名 + 地址 → provider 注册/验证 → 签发凭据 → 才成为 verified identity。
 * 任意一步缺失或未通过：不产生 candidate bind plan。
 */
export async function registerCarrierAccountIdentity(
  deps: CarrierAccountRegistrationDeps,
  input: CarrierAccountRegistrationInput,
): Promise<CarrierDiscoveryOutcome> {
  const contract = resolveCarrierAuthContract(input.provider);
  if (!contract) return { ok: false, reason: 'UNKNOWN_CARRIER' };
  const provider = contract.provider;

  const shapeFailure = scanKeys(input, ALLOWED_REGISTRATION_INPUT_KEYS);
  if (shapeFailure) return { ok: false, reason: shapeFailure };
  if (input.candidate !== undefined && input.candidate !== null) {
    const candidateShapeFailure = scanKeys(input.candidate, ALLOWED_CANDIDATE_KEYS);
    if (candidateShapeFailure) return { ok: false, reason: candidateShapeFailure };
  }

  const tenant = tenantContext(input);
  if (!tenant) return { ok: false, reason: 'TENANT_CONTEXT_REQUIRED' };

  if (contract.accountIdentityStrategy !== 'PROVIDER_VERIFIED_REGISTRATION') {
    return { ok: false, reason: 'IDENTITY_STRATEGY_NOT_REGISTRATION' };
  }

  const candidate = input.candidate ?? {};
  const externalAccountId = typeof candidate.externalAccountId === 'string' ? candidate.externalAccountId.trim() : '';
  const customerName = typeof candidate.customerName === 'string' ? candidate.customerName.trim() : '';
  const customerAddress = typeof candidate.customerAddress === 'string' ? candidate.customerAddress.trim() : '';
  if (externalAccountId === '' || customerName === '' || customerAddress === '') {
    // MSG-106 ⑭：裸账号号（缺姓名/地址证据）不是 verified identity。
    return { ok: false, reason: 'CANDIDATE_EVIDENCE_REQUIRED' };
  }

  let registered: Awaited<ReturnType<CarrierAccountRegistrationPort["registerAccount"]>>;
  try {
    registered = await deps.port.registerAccount({
      provider,
      ...tenant,
      candidate: { externalAccountId, customerName, customerAddress },
    });
  } catch {
    return { ok: false, reason: 'REGISTRATION_FAILED' };
  }
  if (!registered || !registered.verified || !registered.identity || !registered.credentialRef) {
    return { ok: false, reason: 'REGISTRATION_NOT_VERIFIED' };
  }

  const verified = toCandidate(provider, registered.identity, 'PROVIDER_VERIFIED_REGISTRATION');
  if (!verified) return { ok: false, reason: 'IDENTITY_INVALID' };

  if (deps.lineage) {
    const lineage = deps.lineage.register({ provider, ...tenant, credentialRef: registered.credentialRef });
    if (!lineage.ok) return { ok: false, reason: 'CREDENTIAL_LINEAGE_CONFLICT' };
  }

  const plan = buildPlan({
    provider,
    ...tenant,
    credentialRef: registered.credentialRef,
    strategy: 'PROVIDER_VERIFIED_REGISTRATION',
    registrationRef: registered.registrationRef,
    candidate: verified,
  });
  return buildPlanOutcome(plan, [verified]);
}

/**
 * 测试 / 本地 fixture：discovery port（**不发起任何网络请求**）。
 * 未登记的 credentialRef → 空数组（由编排层映射为 NO_ACCOUNT_DISCOVERED）。
 */
export function createSandboxCarrierAccountDiscoveryPort(
  fixtures: Partial<Record<CarrierProvider, Readonly<Record<string, readonly CarrierVerifiedAccountIdentity[]>>>> = {},
): CarrierAccountDiscoveryPort {
  return {
    async discoverAccounts(input) {
      const byCredentialRef = fixtures[input.provider];
      if (!byCredentialRef) return [];
      return byCredentialRef[input.credentialRef] ?? [];
    },
  };
}

/**
 * 测试 / 本地 fixture：registration port（**不发起任何网络请求**）。
 * 只有登记在 verifiedAccounts 中的候选账号才会「通过 provider 验证」并拿到确定性 credentialRef。
 */
export function createSandboxCarrierAccountRegistrationPort(
  verifiedAccounts: readonly CarrierVerifiedAccountIdentity[] = [],
): CarrierAccountRegistrationPort {
  return {
    async registerAccount(input) {
      const found = verifiedAccounts.find(
        (account) =>
          account.provider === input.provider &&
          account.externalAccountId === input.candidate.externalAccountId,
      );
      if (!found) {
        return {
          verified: false,
          credentialRef: null,
          identity: null,
          registrationRef: 'sandbox-registration:' + input.candidate.externalAccountId + ':rejected',
        };
      }
      return {
        verified: true,
        credentialRef: 'SANDBOX:' + input.provider + ':registration:' + found.externalAccountId.toLowerCase(),
        identity: { ...found, identitySource: 'PROVIDER_VERIFIED_REGISTRATION' },
        registrationRef: 'sandbox-registration:' + found.externalAccountId,
      };
    },
  };
}
