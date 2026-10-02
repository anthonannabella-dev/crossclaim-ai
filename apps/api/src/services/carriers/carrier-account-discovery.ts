/**
 * CARRIER QUEUE #3（MSG-20261003-105 ⑰–㉕）— UPS / FedEx 账号发现**内部契约**（read-only first）。
 * ---------------------------------------------------------------
 * 顺序（任何一步失败都 fail-closed，且不产生任何业务事实）：
 *   provider 解析（未知 carrier 拒绝）
 *     → 输入形状校验（**不接受**明文凭据；未声明字段拒绝）
 *     → credentialRef 必需（只允许引用，不接受取值）
 *     → credential lineage 登记（organizationId + actorUserId + provider + credentialRef；跨租户拒绝）
 *     → 调 discovery port（本批只有 sandbox / fixture 实现，**无任何真实网络请求**）
 *     → 账号形状校验（provider 必须一致、externalAccountId 非空、不得携带任何凭据字段）
 *     → 按 candidateIdentity(provider + externalAccountId) 去重（幂等）
 *     → 0 / 1 / 多账号分支（多账号必须显式选择，**禁止自动绑定**）
 * 硬约束：bindExecuted=false · transportEnabled=false · platformWriteEnabled=false · productionCredentials=ABSENT。
 * 用户输入的账号号永远只是 hint，**不得**成为 verified identity。
 */

import type { CarrierProvider } from './connector-capability';
import { resolveCarrierAuthContract } from './carrier-auth-contract';

export const CARRIER_ACCOUNT_TYPES = ['SHIPPER', 'PAYER', 'THIRD_PARTY', 'UNKNOWN'] as const;
export type CarrierAccountType = (typeof CARRIER_ACCOUNT_TYPES)[number];

export const CARRIER_ACCOUNT_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;
export type CarrierAccountStatus = (typeof CARRIER_ACCOUNT_STATUSES)[number];

/** carrier 账号身份版本默认值（真实接入时由 provider discovery 返回）。 */
export const CARRIER_IDENTITY_VERSION = 'carrier-identity-v1';

/** provider discovery 返回的账号 —— identity 只能来自这里。 */
export interface CarrierDiscoveredAccount {
  provider: CarrierProvider;
  externalAccountId: string;
  displayName: string;
  accountType: CarrierAccountType;
  countryOrRegion: string;
  status: CarrierAccountStatus;
  identityVersion: string;
}

/**
 * 账号发现端口：真实实现属 HOLD_EXTERNAL（需要 UPS / FedEx developer credentials）。
 * 端口只接受 credentialRef —— 明文 token / client secret 永不进入本接口。
 */
export interface CarrierAccountDiscoveryPort {
  discoverAccounts(input: {
    provider: CarrierProvider;
    credentialRef: string;
    organizationId: string;
    actorUserId: string;
  }): Promise<readonly CarrierDiscoveredAccount[]>;
}

export type CarrierDiscoveryFailureCode =
  | 'UNKNOWN_CARRIER'
  | 'PLAINTEXT_CREDENTIAL_NOT_SUPPORTED'
  | 'UNSUPPORTED_INPUT'
  | 'CREDENTIAL_REF_REQUIRED'
  | 'TENANT_CONTEXT_REQUIRED'
  | 'CREDENTIAL_LINEAGE_CONFLICT'
  | 'DISCOVERY_FAILED'
  | 'DISCOVERED_ACCOUNT_INVALID';

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
 * 后续若出现其它 organization（跨租户）或其它 provider，一律拒绝复用。
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
  identitySource: 'PROVIDER_DISCOVERY';
  /** 幂等键：provider + externalAccountId（重复 discovery 必须映射到同一候选身份）。 */
  candidateIdentity: string;
}

/** 绑定计划：本批**不执行**绑定（bindExecuted 恒 false）。 */
export interface CarrierBindPlan {
  provider: CarrierProvider;
  organizationId: string;
  actorUserId: string;
  credentialRef: string;
  credentialLineage: CarrierCredentialLineage;
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

const ALLOWED_INPUT_KEYS = new Set(['provider', 'credentialRef', 'organizationId', 'actorUserId', 'hint']);
const CREDENTIAL_MATERIAL_KEY = /(token|secret|password|passwd|apikey|api[-_]?key|client[-_]?id|client[-_]?secret|credential)/i;
const DISCOVERED_ACCOUNT_KEYS = new Set(['provider', 'externalAccountId', 'displayName', 'accountType', 'countryOrRegion', 'status', 'identityVersion']);

/** 幂等候选身份：provider + externalAccountId（与 credentialRef / 租户无关）。 */
export function carrierCandidateIdentity(provider: CarrierProvider, externalAccountId: string): string {
  return 'carrier:' + provider + ':' + externalAccountId.trim();
}

function scanInputShape(input: CarrierDiscoveryInput): CarrierDiscoveryFailureCode | null {
  for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
    if (ALLOWED_INPUT_KEYS.has(key)) continue;
    return CREDENTIAL_MATERIAL_KEY.test(key) ? 'PLAINTEXT_CREDENTIAL_NOT_SUPPORTED' : 'UNSUPPORTED_INPUT';
  }
  return null;
}

function toCandidate(provider: CarrierProvider, raw: unknown): CarrierDiscoveryCandidate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const account = raw as Record<string, unknown>;
  for (const key of Object.keys(account)) {
    // 任何额外字段（尤其 access token / client secret）一律拒绝：凭据绝不进入本层。
    if (!DISCOVERED_ACCOUNT_KEYS.has(key)) return null;
  }
  if (account.provider !== provider) return null;
  const externalAccountId = typeof account.externalAccountId === 'string' ? account.externalAccountId.trim() : '';
  if (externalAccountId === '') return null;
  if (typeof account.accountType !== 'string' || !CARRIER_ACCOUNT_TYPES.includes(account.accountType as CarrierAccountType)) return null;
  if (typeof account.status !== 'string' || !CARRIER_ACCOUNT_STATUSES.includes(account.status as CarrierAccountStatus)) return null;
  const displayName = typeof account.displayName === 'string' && account.displayName.trim() !== '' ? account.displayName.trim() : externalAccountId;
  const countryOrRegion = typeof account.countryOrRegion === 'string' && account.countryOrRegion.trim() !== '' ? account.countryOrRegion.trim() : 'UNKNOWN';
  const identityVersion = typeof account.identityVersion === 'string' && account.identityVersion.trim() !== '' ? account.identityVersion.trim() : CARRIER_IDENTITY_VERSION;
  return {
    provider,
    externalAccountId,
    displayName,
    accountType: account.accountType as CarrierAccountType,
    countryOrRegion,
    status: account.status as CarrierAccountStatus,
    identityVersion,
    identitySource: 'PROVIDER_DISCOVERY',
    candidateIdentity: carrierCandidateIdentity(provider, externalAccountId),
  };
}

export async function discoverCarrierAccounts(
  deps: CarrierDiscoveryDeps,
  input: CarrierDiscoveryInput,
): Promise<CarrierDiscoveryOutcome> {
  const contract = resolveCarrierAuthContract(input.provider);
  if (!contract) return { ok: false, reason: 'UNKNOWN_CARRIER' };
  const provider = contract.provider;

  const shapeFailure = scanInputShape(input);
  if (shapeFailure) return { ok: false, reason: shapeFailure };

  const credentialRef = typeof input.credentialRef === 'string' ? input.credentialRef.trim() : '';
  if (credentialRef === '') return { ok: false, reason: 'CREDENTIAL_REF_REQUIRED' };

  const organizationId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
  const actorUserId = typeof input.actorUserId === 'string' ? input.actorUserId.trim() : '';
  if (organizationId === '' || actorUserId === '') return { ok: false, reason: 'TENANT_CONTEXT_REQUIRED' };

  if (deps.lineage) {
    const registration = deps.lineage.register({ provider, organizationId, actorUserId, credentialRef });
    if (!registration.ok) return { ok: false, reason: 'CREDENTIAL_LINEAGE_CONFLICT' };
  }

  let discovered: readonly unknown[];
  try {
    discovered = await deps.port.discoverAccounts({ provider, credentialRef, organizationId, actorUserId });
  } catch {
    return { ok: false, reason: 'DISCOVERY_FAILED' };
  }
  if (!Array.isArray(discovered)) return { ok: false, reason: 'DISCOVERY_FAILED' };

  const candidates: CarrierDiscoveryCandidate[] = [];
  const seen = new Set<string>();
  for (const account of discovered) {
    const candidate = toCandidate(provider, account);
    if (!candidate) return { ok: false, reason: 'DISCOVERED_ACCOUNT_INVALID' };
    if (seen.has(candidate.candidateIdentity)) continue;
    seen.add(candidate.candidateIdentity);
    candidates.push(candidate);
  }
  candidates.sort((left, right) =>
    left.candidateIdentity < right.candidateIdentity ? -1 : left.candidateIdentity > right.candidateIdentity ? 1 : 0,
  );

  const common = {
    provider,
    identityHintAccepted: false,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
  } as const;

  if (candidates.length === 0) {
    return { ok: true, status: 'NO_ACCOUNT_DISCOVERED', candidates: [], plan: null, ...common };
  }
  if (candidates.length === 1) {
    const plan: CarrierBindPlan = {
      provider,
      organizationId,
      actorUserId,
      credentialRef,
      credentialLineage: { provider, organizationId, actorUserId, credentialRef },
      candidates: [candidates[0]],
      bindExecuted: false,
      transportEnabled: false,
      platformWriteEnabled: false,
      productionCredentials: 'ABSENT',
      requiredNextStep: 'VERIFIED_BIND_REQUIRED_EXTERNAL_GATE',
    };
    return { ok: true, status: 'CANDIDATE_BIND_PLAN', candidates, plan, ...common };
  }
  // 多个账号：必须显式选择；hint 不参与选择，也绝不自动绑定。
  return { ok: true, status: 'EXPLICIT_SELECTION_REQUIRED', candidates, plan: null, ...common };
}

/**
 * 测试 / 本地 fixture port：**不发起任何网络请求**，只按注入的 fixture 返回。
 * 未登记的 credentialRef → 空数组（由编排层映射为 NO_ACCOUNT_DISCOVERED）。
 */
export function createSandboxCarrierAccountDiscoveryPort(
  fixtures: Partial<Record<CarrierProvider, Readonly<Record<string, readonly CarrierDiscoveredAccount[]>>>> = {},
): CarrierAccountDiscoveryPort {
  return {
    async discoverAccounts(input) {
      const byCredentialRef = fixtures[input.provider];
      if (!byCredentialRef) return [];
      return byCredentialRef[input.credentialRef] ?? [];
    },
  };
}
