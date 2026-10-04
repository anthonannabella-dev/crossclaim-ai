/**
 * C18-6 — PROVIDER TENANT / ACCOUNT LINEAGE（Layer 3 / P0 真实 Customs Provider 接入，当前离线部分）
 * ---------------------------------------------------------------
 * 分层（架构方 MSG-20261004-15 明确要求）：
 *
 *   authenticated organizationId
 *        ↓
 *   C18-6 ProviderTenantBinding      ← server-derived，调用方**不可**自由传入
 *        ↓
 *   provider tenant/account ref
 *        ↓
 *   C18-2 wire DTO
 *        ↓
 *   RealProviderAdapter（当前 transportEnabled=false）
 *
 * 硬规则（fail-closed，零外写、零凭据、零网络）：
 *   · 调用方传入的 `tenantRef` 绝不作为权威来源；与 server-derived 绑定不一致 → CALLER_TENANT_OVERRIDE_REJECTED；
 *   · 没有绑定 / 绑定非 ACTIVE / provider 不匹配 / 辖区不在 scope 内 → 一律 fail-closed，nextAction=null；
 *   · 跨租户读取必须不可能：resolver 只返回 `organizationId` 完全一致的绑定，
 *     若内部数据出现不一致 → TENANT_ISOLATION_VIOLATION（宁可拒绝，不做「尽力而为」的拼接）；
 *   · 本模块不发生任何外部写 / 申报 / 资金动作，也不读取任何凭据。
 *
 * 持久化（ProviderTenantBinding 表）**不在本单元**：新增 Schema / migration 属硬停条件，
 * 必须先送 Schema Delta 审计，落地后才允许接真实 transport。
 */

import { createHash } from 'node:crypto';

import {
  buildCustomsProviderSubmissionRequest,
  type CustomsProviderDtoErrorCode,
  type CustomsProviderEvidenceRef,
  type CustomsProviderSubmissionEnvelope,
} from './customs-provider-dto';

/** CrossClaim 与 provider 账号之间的商务关系（矩阵 #12「是否允许第三方 SaaS 代客提交」的承载位）。 */
export const CUSTOMS_PROVIDER_TENANT_RELATIONSHIPS = [
  'CROSSCLAIM_SAAS',
  'BROKER_OF_RECORD',
  'CLIENT_DIRECT',
  'REFERRAL_PARTNER',
] as const;
export type CustomsProviderTenantRelationship = (typeof CUSTOMS_PROVIDER_TENANT_RELATIONSHIPS)[number];

export const CUSTOMS_PROVIDER_TENANT_BINDING_STATUSES = [
  'ACTIVE',
  'PENDING_VERIFICATION',
  'SUSPENDED',
  'REVOKED',
] as const;
export type CustomsProviderTenantBindingStatus = (typeof CUSTOMS_PROVIDER_TENANT_BINDING_STATUSES)[number];

export const CUSTOMS_PROVIDER_TENANT_LINEAGE_EVENTS = [
  'BOUND',
  'REBOUND',
  'REAUTH_REQUIRED',
  'SUSPENDED',
  'REVOKED',
  'RESTORED',
] as const;
export type CustomsProviderTenantLineageEvent = (typeof CUSTOMS_PROVIDER_TENANT_LINEAGE_EVENTS)[number];

/** 不可变账本条目：只追加，不覆盖（对齐 C17 append-only 语义）。 */
export interface CustomsProviderTenantLineageEntry {
  event: CustomsProviderTenantLineageEvent;
  at: string;
  actorRef: string;
  note: string | null;
}

export interface CustomsProviderTenantBinding {
  /** CrossClaim 租户（authenticated organizationId）——权威来源。 */
  organizationId: string;
  /** provider-neutral provider 标识（与 C15 `CustomsFilingProvider.providerId` 同名同义）。 */
  providerId: string;
  /** server-derived provider 侧租户引用（opaque）。 */
  providerTenantRef: string;
  /** server-derived provider 侧账号引用（opaque；例如 broker 账号 / ABI filer code 引用）。 */
  providerAccountRef: string;
  relationship: CustomsProviderTenantRelationship;
  /** 该绑定允许的辖区（'*' = 全部；否则 ISO-3166 alpha-2）。 */
  jurisdictionScope: readonly string[];
  status: CustomsProviderTenantBindingStatus;
  verifiedAt: string | null;
  /** 只允许是凭据**引用**，绝不是凭据本体。 */
  credentialReference: string | null;
  lineage: readonly CustomsProviderTenantLineageEntry[];
}

export interface CustomsProviderTenantBindingQuery {
  organizationId: string;
  providerId: string;
  jurisdiction: string;
  /** 可选：Internal principal / IOR 引用（仅用于 lineage 取证，不参与授权判定）。 */
  principalRef?: string | null;
}

export type CustomsProviderTenantBindingReasonCode =
  | 'BINDING_RESOLVED'
  | 'INVALID_QUERY'
  | 'BINDING_UNKNOWN'
  | 'BINDING_NOT_ACTIVE'
  | 'PROVIDER_MISMATCH'
  | 'JURISDICTION_NOT_COVERED'
  | 'CALLER_TENANT_OVERRIDE_REJECTED'
  | 'TENANT_ISOLATION_VIOLATION';

export interface CustomsProviderTenantBindingResolution {
  ok: boolean;
  reasonCode: CustomsProviderTenantBindingReasonCode;
  providerId: string | null;
  /** 只有 ok=true 才是 server-derived 权威值。 */
  providerTenantRef: string | null;
  providerAccountRef: string | null;
  relationship: CustomsProviderTenantRelationship | null;
  status: CustomsProviderTenantBindingStatus | null;
  /** 任何非 OK 结论都不给出可执行动作，防止调用方「猜一个」。 */
  nextAction: null;
  externalWritePerformed: false;
  filingSubmitted: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
}

const OPAQUE_REF_RE = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const RAW_URL_SCHEME_RE = /^(https?:\/\/|javascript:|data:|file:)/i;
const JURISDICTION_RE = /^(\*|[A-Z]{2})$/;

export function isOpaqueProviderRef(value: string): boolean {
  if (RAW_URL_SCHEME_RE.test(value)) return false;
  if (/^[0-9]{2}-[0-9]{7}$/.test(value) || /^[0-9]{6,12}$/.test(value)) return false;
  return OPAQUE_REF_RE.test(value);
}

/** 辖区覆盖：'*' 覆盖全部；否则必须精确相等（大小写敏感，沿用 C18-2 口径）。 */
export function isJurisdictionCovered(scope: readonly string[], jurisdiction: string): boolean {
  return scope.includes('*') || scope.includes(jurisdiction);
}

const DENIED = (reasonCode: CustomsProviderTenantBindingReasonCode): CustomsProviderTenantBindingResolution => ({
  ok: false,
  reasonCode,
  providerId: null,
  providerTenantRef: null,
  providerAccountRef: null,
  relationship: null,
  status: null,
  nextAction: null,
  externalWritePerformed: false,
  filingSubmitted: false,
  transportEnabled: false,
  productionCredentials: 'ABSENT',
});

/**
 * 纯函数判定：**只有** server-derived 绑定满足全部条件才放行。
 * `callerTenantRef` 仅在提供时用于「拒绝调用方覆盖」这一条，永远不是权威来源。
 */
export function resolveCustomsProviderTenantBinding(
  binding: CustomsProviderTenantBinding | null,
  query: CustomsProviderTenantBindingQuery,
  callerTenantRef?: string | null,
): CustomsProviderTenantBindingResolution {
  if (
    !isOpaqueProviderRef(query.organizationId) ||
    !isOpaqueProviderRef(query.providerId) ||
    !JURISDICTION_RE.test(query.jurisdiction)
  ) {
    return DENIED('INVALID_QUERY');
  }
  if (callerTenantRef != null && !isOpaqueProviderRef(callerTenantRef)) {
    return DENIED('CALLER_TENANT_OVERRIDE_REJECTED');
  }
  if (binding === null) return DENIED('BINDING_UNKNOWN');

  // 防御性隔离检查：绑定与查询必须同租户、同 provider。任何不一致都视为隔离事故，直接拒绝。
  if (binding.organizationId !== query.organizationId) return DENIED('TENANT_ISOLATION_VIOLATION');
  if (binding.providerId !== query.providerId) return DENIED('PROVIDER_MISMATCH');

  if (binding.status !== 'ACTIVE') return DENIED('BINDING_NOT_ACTIVE');
  if (!isJurisdictionCovered(binding.jurisdictionScope, query.jurisdiction)) {
    return DENIED('JURISDICTION_NOT_COVERED');
  }
  if (callerTenantRef != null && callerTenantRef !== binding.providerTenantRef) {
    return DENIED('CALLER_TENANT_OVERRIDE_REJECTED');
  }

  return {
    ok: true,
    reasonCode: 'BINDING_RESOLVED',
    providerId: binding.providerId,
    providerTenantRef: binding.providerTenantRef,
    providerAccountRef: binding.providerAccountRef,
    relationship: binding.relationship,
    status: binding.status,
    nextAction: null,
    externalWritePerformed: false,
    filingSubmitted: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
  };
}

/** resolver 端口：实现可以是 DB / 配置 / provider API，但**必须**返回 server-derived 绑定。 */
export interface CustomsProviderTenantBindingResolver {
  resolve(query: CustomsProviderTenantBindingQuery): Promise<CustomsProviderTenantBindingResolution>;
}

/**
 * 进程内 resolver（离线/测试用，无 DB）。严格按 organizationId 隔离：
 * 查询 A 组织时即使表里存在 B 组织的同名 provider 绑定，也只会得到 BINDING_UNKNOWN。
 */
export function createInMemoryCustomsProviderTenantBindingResolver(
  bindings: readonly CustomsProviderTenantBinding[],
): CustomsProviderTenantBindingResolver {
  const rows = [...bindings];
  return {
    async resolve(query: CustomsProviderTenantBindingQuery): Promise<CustomsProviderTenantBindingResolution> {
      const owned = rows.filter((row) => row.organizationId === query.organizationId);
      const match = owned.find((row) => row.providerId === query.providerId) ?? null;
      return resolveCustomsProviderTenantBinding(match, query);
    },
  };
}

export type CustomsProviderBoundSubmissionResult =
  | { ok: true; envelope: CustomsProviderSubmissionEnvelope; reasonCode: 'BINDING_RESOLVED' }
  | { ok: false; stage: 'BINDING'; reasonCode: CustomsProviderTenantBindingReasonCode; detail: string }
  | { ok: false; stage: 'DTO'; reasonCode: CustomsProviderDtoErrorCode; detail: string };

export interface CustomsProviderBoundSubmissionDraft {
  principalRef: string;
  jurisdiction: string;
  remedy: string;
  brokerRef?: string | null;
  poaRef?: string | null;
  signerRef?: string | null;
  filingAuthorized: boolean;
  packageRef: string;
  packageDigest: string;
  evidenceRefs: readonly CustomsProviderEvidenceRef[];
  idempotencyKey: string;
  requestedAt: string;
}

/**
 * 把「已认证 organizationId + 草稿」变成 C18-2 envelope：`tenantRef` 只能来自 server-derived 绑定。
 * 调用方即使传了 tenantRef 也只能用于一致性校验，不能改变结果。
 */
export async function bindCustomsProviderSubmissionRequest(input: {
  resolver: CustomsProviderTenantBindingResolver;
  organizationId: string;
  providerId: string;
  entitlement: CustomsProviderTenantRelationship;
  callerTenantRef?: string | null;
  draft: CustomsProviderBoundSubmissionDraft;
}): Promise<CustomsProviderBoundSubmissionResult> {
  const resolution = await input.resolver.resolve({
    organizationId: input.organizationId,
    providerId: input.providerId,
    jurisdiction: input.draft.jurisdiction,
    principalRef: input.draft.principalRef,
  });
  if (!resolution.ok || resolution.providerTenantRef === null) {
    return {
      ok: false,
      stage: 'BINDING',
      reasonCode: resolution.reasonCode,
      detail: 'provider tenant binding is not resolvable; submission stays fail-closed',
    };
  }
  if (resolution.relationship !== input.entitlement) {
    // 商务关系（例如 CROSSCLAIM_SAAS 代客提交权）必须与绑定一致，否则不得构造提交请求。
    return {
      ok: false,
      stage: 'BINDING',
      reasonCode: 'BINDING_NOT_ACTIVE',
      detail: 'binding relationship does not match the required entitlement',
    };
  }
  if (input.callerTenantRef != null && input.callerTenantRef !== resolution.providerTenantRef) {
    return {
      ok: false,
      stage: 'BINDING',
      reasonCode: 'CALLER_TENANT_OVERRIDE_REJECTED',
      detail: 'caller-supplied tenantRef is not the server-derived provider tenant',
    };
  }

  const built = buildCustomsProviderSubmissionRequest({
    ...input.draft,
    tenantRef: resolution.providerTenantRef,
  });
  if (!built.ok) return { ok: false, stage: 'DTO', reasonCode: built.code, detail: built.detail };
  return { ok: true, envelope: built.envelope, reasonCode: 'BINDING_RESOLVED' };
}

/** 只追加的事件写入：返回新绑定对象，绝不就地修改既有账本。 */
export function appendCustomsProviderTenantLineage(
  binding: CustomsProviderTenantBinding,
  entry: CustomsProviderTenantLineageEntry,
): CustomsProviderTenantBinding {
  if (!(CUSTOMS_PROVIDER_TENANT_LINEAGE_EVENTS as readonly string[]).includes(entry.event)) {
    throw new Error('INVALID_LINEAGE_EVENT');
  }
  if (!isOpaqueProviderRef(entry.actorRef)) throw new Error('INVALID_LINEAGE_ACTOR');
  return { ...binding, lineage: [...binding.lineage, entry] };
}

/** 账本摘要：用于审计取证（同内容同摘要，顺序敏感）。 */
export function customsProviderTenantLineageDigest(
  lineage: readonly CustomsProviderTenantLineageEntry[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        lineage.map((entry) => ({
          actorRef: entry.actorRef,
          at: entry.at,
          event: entry.event,
          note: entry.note,
        })),
      ),
      'utf8',
    )
    .digest('hex');
}

/** 边界自证：C18-6 离线层不产生任何外部写 / 凭据使用 / 资金动作。 */
export const CUSTOMS_PROVIDER_TENANT_BINDING_BOUNDARY = {
  externalWritePerformed: false,
  filingSubmitted: false,
  transportEnabled: false,
  providerAccountMutationPerformed: false,
  credentialReadPerformed: false,
  productionCredentials: 'ABSENT',
} as const;
