/**
 * CARRIER QUEUE #10（MSG-20261003-121 ⑬–㉑）— CARRIER RESPONSE / STATUS READ MODEL（契约层）。
 * ---------------------------------------------------------------
 * 目标：把「carrier 对 claim 的后续响应」变成可审计的事实记录，同时**严格区分**：
 *   1. CLAIM PACKAGE READY
 *   2. HUMAN REPORTED SUBMITTED（Queue #9B）
 *   3. CARRIER VERIFIED RESPONSE（本单元开始建立）
 * 硬边界（⑭⑮⑰⑱⑲⑳）：
 *   · status 与 provenance 必须分开：status = APPROVED + source = USER_REPORTED 只能表达
 *     「用户说 carrier 批准了」，**不得**升级成系统已验证。
 *   · 只有可信 provider 来源（provider API / webhook / document / portal artifact，且已登记为可信路径）
 *     才能 verificationLevel = PROVIDER_VERIFIED；真实 provider 集成继续 HOLD_EXTERNAL。
 *   · 不得依据 carrierReference 自动升级 verificationLevel。
 *   · APPROVED != PAID != recovered cash：本单元不修改 RecoveryPayout / actualRecovered /
 *     Settlement money truth，不产生 successFee，不发起 payment collection，不做任何外部写。
 *   · 事实 append-only：仅追加 CarrierClaimResponseFact，current status 由投影 derive，不覆盖历史。
 * 说明：本文件是契约层（纯服务 + 注入端口），不含 Schema / DB / HTTP 绑定；
 *       持久化与路由需另行 Schema Delta 审核。
 */

import { createHash } from 'node:crypto';

import type { CarrierProvider } from './connector-capability';

/** ⑭ status（与 provenance 正交，不得互相推断）。 */
export const CARRIER_RESPONSE_STATUSES = [
  'PENDING',
  'UNDER_REVIEW',
  'DENIED',
  'APPROVED',
  'PARTIALLY_APPROVED',
  'PAID',
  'CLOSED',
  'UNKNOWN',
] as const;
export type CarrierClaimResponseStatus = (typeof CARRIER_RESPONSE_STATUSES)[number];

/** ⑮ source / provenance。 */
export const CARRIER_RESPONSE_SOURCES = [
  'USER_REPORTED',
  'PROVIDER_API',
  'PROVIDER_WEBHOOK',
  'PROVIDER_DOCUMENT',
  'PROVIDER_PORTAL_ARTIFACT',
] as const;
export type CarrierClaimResponseSource = (typeof CARRIER_RESPONSE_SOURCES)[number];

/** ⑱ 只有 trusted provider source path 才能产生 PROVIDER_VERIFIED。 */
export const CARRIER_PROVIDER_RESPONSE_SOURCES: readonly CarrierClaimResponseSource[] = [
  'PROVIDER_API',
  'PROVIDER_WEBHOOK',
  'PROVIDER_DOCUMENT',
  'PROVIDER_PORTAL_ARTIFACT',
];

export const CARRIER_RESPONSE_VERIFICATION_LEVELS = ['UNVERIFIED', 'PROVIDER_VERIFIED'] as const;
export type CarrierResponseVerificationLevel = (typeof CARRIER_RESPONSE_VERIFICATION_LEVELS)[number];

export const CARRIER_CLAIM_RESPONSE_CAPABILITY = 'carrier.claim_response.record';
export const CARRIER_CLAIM_RESPONSE_AUDIT_EVENT = 'carrier.claim_response_recorded';

const PROVIDER_REFERENCE_MAX_LENGTH = 128;
const NOTE_MAX_LENGTH = 500;

/** client 只能提交这些字段（不含身份 / verified 断言 / 资金字段）。 */
export interface CarrierClaimResponseRequest {
  status: CarrierClaimResponseStatus;
  source: CarrierClaimResponseSource;
  providerReference?: string | null;
  observedAt?: string | null;
  note?: string | null;
}

/** server-derived 上下文（从已认证会话与租户上下文派生，绝不来自 client body）。 */
export interface CarrierClaimResponseContext {
  organizationId: string;
  actorUserId: string;
  actorCapabilities: readonly string[];
}

/** server-side submission truth 绑定（provider / account / tracking 不得由 client 提供）。 */
export interface CarrierClaimResponseSubmissionRef {
  packageId: string;
  submissionRecordId: string;
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
}

/** ⑯ append-only carrier response fact。 */
export interface CarrierClaimResponseFact {
  factId: string;
  organizationId: string;
  packageId: string;
  submissionRecordId: string;
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  status: CarrierClaimResponseStatus;
  source: CarrierClaimResponseSource;
  verificationLevel: CarrierResponseVerificationLevel;
  providerReference: string | null;
  observedAt: string;
  recordedAt: string;
  rawArtifactReference: string | null;
  recordedByUserId: string;
  /** ⑲⑳ 该事实永不触碰资金真值。 */
  recoveredCashUpdated: false;
  successFeeCalculated: false;
  paymentCollectionPerformed: false;
  externalWritePerformed: false;
  transportEnabled: false;
  platformWriteEnabled: false;
  productionCredentials: 'ABSENT';
}

/** ⑯ status 投影（derive，不覆盖历史事实）。 */
export interface CarrierClaimResponseProjection {
  organizationId: string;
  packageId: string;
  currentStatus: CarrierClaimResponseStatus | null;
  currentVerificationLevel: CarrierResponseVerificationLevel | null;
  currentFactId: string | null;
  statusHistory: ReadonlyArray<{
    factId: string;
    status: CarrierClaimResponseStatus;
    source: CarrierClaimResponseSource;
    verificationLevel: CarrierResponseVerificationLevel;
    observedAt: string;
  }>;
  factCount: number;
  hasProviderVerifiedFact: boolean;
  /** ⑲⑳ 投影只描述 provider outcome fact，绝不派生资金真值。 */
  derivesRecoveredCash: false;
  derivesSuccessFee: false;
}

export interface CarrierClaimResponseStore {
  /** append-only：只允许新增；重复事实（same idempotency key）返回 created = false。 */
  append(fact: CarrierClaimResponseFact): Promise<{ created: boolean; fact: CarrierClaimResponseFact }>;
  listByPackage(organizationId: string, packageId: string): Promise<CarrierClaimResponseFact[]>;
}

export interface CarrierClaimResponseDeps {
  submissions: {
    load(organizationId: string, packageId: string): Promise<CarrierClaimResponseSubmissionRef | null>;
  };
  store: CarrierClaimResponseStore;
  /**
   * ⑱ 已登记的**可信 provider 来源路径**。默认空集合 → provider 来源一律 fail-closed 拒绝，
   * 因为真实 provider API / webhook 集成属于 HOLD_EXTERNAL。
   */
  trustedProviderSources?: readonly CarrierClaimResponseSource[];
  now?: () => Date;
  audit?: { emit(event: { action: string; entityId: string; organizationId: string }): Promise<void> };
}

export type CarrierClaimResponseFailure =
  | 'INVALID_REQUEST'
  | 'CAPABILITY_REQUIRED'
  | 'SUBMISSION_NOT_FOUND'
  | 'PROVIDER_REFERENCE_REQUIRED'
  | 'PROVIDER_SOURCE_NOT_TRUSTED'
  | 'INVALID_TIMESTAMP'
  | 'FUTURE_TIMESTAMP';

export type CarrierClaimResponseOutcome =
  | { ok: true; status: 'RECORDED' | 'ALREADY_RECORDED'; fact: CarrierClaimResponseFact }
  | { ok: false; reason: CarrierClaimResponseFailure };

/** ⑱ user-reported 事实永远是 UNVERIFIED；provider 来源只有在可信路径下才是 PROVIDER_VERIFIED。 */
export function verificationLevelForSource(
  source: CarrierClaimResponseSource,
  trustedProviderSources: readonly CarrierClaimResponseSource[] = [],
): CarrierResponseVerificationLevel {
  if (source === 'USER_REPORTED') return 'UNVERIFIED';
  return trustedProviderSources.includes(source) ? 'PROVIDER_VERIFIED' : 'UNVERIFIED';
}

/** ⑯ 幂等键：同一 submission 上重复的 (status, source, providerReference) 视为同一事实。 */
export function carrierClaimResponseIdempotencyKey(input: {
  organizationId: string;
  packageId: string;
  status: CarrierClaimResponseStatus;
  source: CarrierClaimResponseSource;
  providerReference: string | null;
}): string {
  return createHash('sha256')
    .update(
      [
        input.organizationId,
        input.packageId,
        input.status,
        input.source,
        input.providerReference === null ? '' : input.providerReference,
      ].join('|'),
    )
    .digest('hex');
}

function isKnownStatus(value: unknown): value is CarrierClaimResponseStatus {
  return typeof value === 'string' && (CARRIER_RESPONSE_STATUSES as readonly string[]).includes(value);
}

function isKnownSource(value: unknown): value is CarrierClaimResponseSource {
  return typeof value === 'string' && (CARRIER_RESPONSE_SOURCES as readonly string[]).includes(value);
}

function normalizeReference(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

function normalizeNote(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * ⑰⑱ 记录一条 carrier response fact（人工补录 或 可信 provider 来源）。
 * 该函数**不修改任何资金真值**，也不产生 successFee / payment collection / 外部写。
 */
export async function recordCarrierClaimResponse(
  input: {
    packageId: string;
    request: CarrierClaimResponseRequest;
    context: CarrierClaimResponseContext;
  },
  deps: CarrierClaimResponseDeps,
): Promise<CarrierClaimResponseOutcome> {
  const { context, request } = input;

  // ㉔ server-side authorization：capability 缺失一律拒绝（fail closed）。
  if (!context.actorCapabilities.includes(CARRIER_CLAIM_RESPONSE_CAPABILITY)) {
    return { ok: false, reason: 'CAPABILITY_REQUIRED' };
  }

  if (typeof input.packageId !== 'string' || input.packageId.trim().length === 0) {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }

  if (!isKnownStatus(request.status) || !isKnownSource(request.source)) {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }

  // ㉓ package truth 必须由 server 侧加载（cross-tenant 或未知 package 一律 SUBMISSION_NOT_FOUND）。
  const submission = await deps.submissions.load(context.organizationId, input.packageId);
  if (submission === null) return { ok: false, reason: 'SUBMISSION_NOT_FOUND' };

  const providerReference = normalizeReference(request.providerReference);
  const isProviderSource = CARRIER_PROVIDER_RESPONSE_SOURCES.includes(request.source);

  if (isProviderSource) {
    if (providerReference === null) return { ok: false, reason: 'PROVIDER_REFERENCE_REQUIRED' };
    if (providerReference.length > PROVIDER_REFERENCE_MAX_LENGTH || hasControlCharacters(providerReference)) {
      return { ok: false, reason: 'INVALID_REQUEST' };
    }
    // ⑱ 未登记可信路径 → fail-closed（真实 provider 集成仍 HOLD_EXTERNAL）。
    const trusted = deps.trustedProviderSources ?? [];
    if (!trusted.includes(request.source)) return { ok: false, reason: 'PROVIDER_SOURCE_NOT_TRUSTED' };
  }

  const note = normalizeNote(request.note);
  if (note !== null && (note.length > NOTE_MAX_LENGTH || hasControlCharacters(note))) {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }

  const now = deps.now ? deps.now() : new Date();
  const observedAtRaw = normalizeReference(request.observedAt ?? null);
  const observedAt = observedAtRaw === null ? now.toISOString() : observedAtRaw;
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) return { ok: false, reason: 'INVALID_TIMESTAMP' };
  if (observedMs > now.getTime()) return { ok: false, reason: 'FUTURE_TIMESTAMP' };

  const recordedAt = now.toISOString();
  const verificationLevel = verificationLevelForSource(request.source, deps.trustedProviderSources ?? []);
  const factId =
    'crf_' +
    carrierClaimResponseIdempotencyKey({
      organizationId: context.organizationId,
      packageId: submission.packageId,
      status: request.status,
      source: request.source,
      providerReference,
    }).slice(0, 32);

  const fact: CarrierClaimResponseFact = {
    factId,
    organizationId: context.organizationId,
    packageId: submission.packageId,
    submissionRecordId: submission.submissionRecordId,
    provider: submission.provider,
    externalAccountId: submission.externalAccountId,
    trackingNumber: submission.trackingNumber,
    status: request.status,
    source: request.source,
    verificationLevel,
    providerReference,
    observedAt,
    recordedAt,
    rawArtifactReference: null,
    recordedByUserId: context.actorUserId,
    recoveredCashUpdated: false,
    successFeeCalculated: false,
    paymentCollectionPerformed: false,
    externalWritePerformed: false,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
  };

  const appended = await deps.store.append(fact);
  if (appended.created && deps.audit) {
    await deps.audit.emit({
      action: CARRIER_CLAIM_RESPONSE_AUDIT_EVENT,
      entityId: appended.fact.factId,
      organizationId: appended.fact.organizationId,
    });
  }
  return { ok: true, status: appended.created ? 'RECORDED' : 'ALREADY_RECORDED', fact: appended.fact };
}

/**
 * ⑯ status 投影：按 (observedAt, recordedAt, factId) 确定性排序取最新事实。
 * **不**推断状态跃迁（⑲ APPROVED 不得推导出 PAID），也**不**派生任何资金真值。
 */
export function projectCarrierClaimResponse(
  facts: readonly CarrierClaimResponseFact[],
  input: { organizationId: string; packageId: string },
): CarrierClaimResponseProjection {
  const scoped = facts
    .filter((f) => f.organizationId === input.organizationId && f.packageId === input.packageId)
    .slice()
    .sort((a, b) => {
      if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? -1 : 1;
      if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
      if (a.factId === b.factId) return 0;
      return a.factId < b.factId ? -1 : 1;
    });

  const latest = scoped.length === 0 ? null : scoped[scoped.length - 1];
  return {
    organizationId: input.organizationId,
    packageId: input.packageId,
    currentStatus: latest === null ? null : latest.status,
    currentVerificationLevel: latest === null ? null : latest.verificationLevel,
    currentFactId: latest === null ? null : latest.factId,
    statusHistory: scoped.map((f) => ({
      factId: f.factId,
      status: f.status,
      source: f.source,
      verificationLevel: f.verificationLevel,
      observedAt: f.observedAt,
    })),
    factCount: scoped.length,
    hasProviderVerifiedFact: scoped.some((f) => f.verificationLevel === 'PROVIDER_VERIFIED'),
    derivesRecoveredCash: false,
    derivesSuccessFee: false,
  };
}

/** 内存 store（契约层测试 / 只读适配器用；真实持久化需 Schema Delta 审核）。 */
export function createInMemoryCarrierClaimResponseStore(): CarrierClaimResponseStore {
  const byIdempotencyKey = new Map<string, CarrierClaimResponseFact>();
  return {
    async append(fact) {
      const key = fact.organizationId + '|' + fact.packageId + '|' + fact.factId;
      const existing = byIdempotencyKey.get(key);
      if (existing !== undefined) return { created: false, fact: existing };
      byIdempotencyKey.set(key, fact);
      return { created: true, fact };
    },
    async listByPackage(organizationId, packageId) {
      return Array.from(byIdempotencyKey.values()).filter(
        (f) => f.organizationId === organizationId && f.packageId === packageId,
      );
    },
  };
}

/** ⑲⑳ 自证常量：本单元不允许任何资金真值变更。 */
export const CARRIER_CLAIM_RESPONSE_MONEY_BOUNDARY = {
  recoveredCashUpdated: false,
  successFeeCalculated: false,
  paymentCollectionPerformed: false,
  externalWritePerformed: false,
  transportEnabled: false,
  platformWriteEnabled: false,
  productionCredentials: 'ABSENT',
} as const;
