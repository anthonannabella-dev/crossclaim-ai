/**
 * C18-2 — PROVIDER-NEUTRAL WIRE DTO（Layer 3 / P0 真实 Customs Provider 接入）
 * ---------------------------------------------------------------
 * 位于 C15 `CustomsFilingProvider` 契约**之外**的线上载荷层：把内部 server-derived 事实
 * 规范化成 provider 可消费的请求，并把 provider 响应映射回内部事实（C19 filing status 词表）。
 *
 * 硬规则（fail-closed，零外写）：
 *   · opaque-only：任何引用都不得是裸 URL / EIN-like / 纯数字（沿用 CA/CA-5 口径）；
 *   · 只有 `filingAuthorized === true` 才允许构造提交请求（追回权 ≠ 申报授权）；
 *   · digest 稳定且不含易变字段（requestedAt 不参与），用于幂等与对账（配合 C17 ledger）；
 *   · provider 响应永远是 PROVIDER_VERIFIED，不得冒充 AUTHORITY_VERIFIED；
 *   · 绝不从 status 隐式推导「已受理 / 已到账」（SUBMITTED ≠ ACCEPTED、APPROVED ≠ PAID）。
 *
 * 本模块不做任何网络调用、不读取任何凭据。
 */

import { createHash } from 'node:crypto';

import type {
  CustomsFilingRefundStatusResult,
  CustomsFilingStatusResult,
} from './customs-filing-provider';

export const CUSTOMS_PROVIDER_REMEDIES = [
  'DRAWBACK',
  'PROTEST',
  'POST_SUMMARY_CORRECTION',
  'EXCLUSION_REFUND',
  'CLASSIFICATION_CORRECTION',
  'DUPLICATE_DUTY',
  'OTHER',
] as const;
export type CustomsProviderRemedy = (typeof CUSTOMS_PROVIDER_REMEDIES)[number];

/** C19 filing status 词表（此处只做映射，不新增状态）。 */
export const CUSTOMS_PROVIDER_STATUS_VOCABULARY = [
  'PREPARING',
  'READY_TO_FILE',
  'SUBMITTED',
  'ACCEPTED',
  'NEEDS_MORE_INFO',
  'UNDER_REVIEW',
  'DENIED',
  'APPROVED',
  'PAID',
  'UNKNOWN',
] as const;
export type CustomsProviderStatus = (typeof CUSTOMS_PROVIDER_STATUS_VOCABULARY)[number];

const OPAQUE_REF_RE = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const RAW_URL_SCHEME_RE = /^(https?:\/\/|javascript:|data:|file:)/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const JURISDICTION_RE = /^(\*|[A-Z]{2})$/;

export type CustomsProviderDtoErrorCode =
  | 'INVALID_OPAQUE_REF'
  | 'INVALID_DIGEST'
  | 'INVALID_JURISDICTION'
  | 'INVALID_REMEDY'
  | 'FILING_NOT_AUTHORIZED'
  | 'EMPTY_EVIDENCE'
  | 'INVALID_TIMESTAMP';

export interface CustomsProviderEvidenceRef {
  evidenceRef: string;
  documentKind: string;
  sha256: string;
}

export interface CustomsProviderSubmissionRequest {
  tenantRef: string;
  principalRef: string;
  jurisdiction: string;
  remedy: CustomsProviderRemedy;
  brokerRef: string | null;
  poaRef: string | null;
  signerRef: string | null;
  filingAuthorized: true;
  packageRef: string;
  packageDigest: string;
  evidenceRefs: readonly CustomsProviderEvidenceRef[];
  idempotencyKey: string;
  requestedAt: string;
}

export interface CustomsProviderSubmissionEnvelope {
  request: CustomsProviderSubmissionRequest;
  /** 稳定请求摘要（不含 requestedAt）：同 key + 同 digest 视为同一提交。 */
  requestDigest: string;
  externalWritePerformed: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
}

export type CustomsProviderBuildResult =
  | { ok: true; envelope: CustomsProviderSubmissionEnvelope }
  | { ok: false; code: CustomsProviderDtoErrorCode; detail: string };

function assertOpaqueRef(value: string | null, field: string): CustomsProviderDtoErrorCode | null {
  void field; // 字段名仅用于调用方可读性；此处统一返回 INVALID_OPAQUE_REF
  if (value === null) return null;
  if (RAW_URL_SCHEME_RE.test(value)) return 'INVALID_OPAQUE_REF';
  if (/^[0-9]{2}-[0-9]{7}$/.test(value) || /^[0-9]{6,12}$/.test(value)) return 'INVALID_OPAQUE_REF';
  if (!OPAQUE_REF_RE.test(value)) return 'INVALID_OPAQUE_REF';
  return null;
}

/**
 * 规范化摘要：**递归**排序 object keys（replacer 数组会作用于嵌套对象并丢掉嵌套字段，禁止使用），
 * 并对无序集合 evidenceRefs 做稳定排序（evidenceRef + documentKind + sha256）。
 * 排除易变字段：requestedAt 不参与。
 */
export function customsProviderRequestDigest(request: Record<string, unknown>): string {
  const evidenceRefs = Array.isArray(request.evidenceRefs)
    ? [...(request.evidenceRefs as CustomsProviderEvidenceRef[])].sort((a, b) => {
        const keyA = a.evidenceRef + '|' + a.documentKind + '|' + a.sha256;
        const keyB = b.evidenceRef + '|' + b.documentKind + '|' + b.sha256;
        return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
      })
    : request.evidenceRefs;
  const canonical = canonicalize({ ...request, evidenceRefs });
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** 递归规范化：对象按键排序，数组保序（集合类字段在调用方先行排序）。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

export function buildCustomsProviderSubmissionRequest(input: {
  tenantRef: string;
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
}): CustomsProviderBuildResult {
  for (const value of [input.tenantRef, input.principalRef, input.packageRef, input.idempotencyKey]) {
    const code = assertOpaqueRef(value, 'ref');
    if (code) return { ok: false, code, detail: 'request references must be opaque' };
  }
  for (const value of [input.brokerRef ?? null, input.poaRef ?? null, input.signerRef ?? null]) {
    const code = assertOpaqueRef(value, 'ref');
    if (code) return { ok: false, code, detail: 'authorization references must be opaque' };
  }

  if (!DIGEST_RE.test(input.packageDigest)) {
    return { ok: false, code: 'INVALID_DIGEST', detail: 'packageDigest must be a 64-char lowercase hex digest' };
  }
  if (!JURISDICTION_RE.test(input.jurisdiction)) {
    return { ok: false, code: 'INVALID_JURISDICTION', detail: 'jurisdiction must be "*" or an ISO-3166 alpha-2 code' };
  }
  if (!(CUSTOMS_PROVIDER_REMEDIES as readonly string[]).includes(input.remedy)) {
    return { ok: false, code: 'INVALID_REMEDY', detail: 'remedy is not in the provider-neutral remedy vocabulary' };
  }
  if (input.filingAuthorized !== true) {
    return {
      ok: false,
      code: 'FILING_NOT_AUTHORIZED',
      detail: 'recovery right does not imply filing authorization; provider submission requires filingAuthorized=true',
    };
  }
  if (input.evidenceRefs.length === 0) {
    return { ok: false, code: 'EMPTY_EVIDENCE', detail: 'at least one evidence reference is required' };
  }
  for (const evidence of input.evidenceRefs) {
    const refCode = assertOpaqueRef(evidence.evidenceRef, 'evidenceRef');
    if (refCode) return { ok: false, code: refCode, detail: 'evidenceRef must be an opaque reference' };
    if (!OPAQUE_REF_RE.test(evidence.documentKind)) {
      return { ok: false, code: 'INVALID_OPAQUE_REF', detail: 'documentKind must be a token' };
    }
    if (!DIGEST_RE.test(evidence.sha256)) {
      return { ok: false, code: 'INVALID_DIGEST', detail: 'evidence sha256 must be a 64-char lowercase hex digest' };
    }
  }
  if (Number.isNaN(Date.parse(input.requestedAt))) {
    return { ok: false, code: 'INVALID_TIMESTAMP', detail: 'requestedAt must be an ISO-8601 timestamp' };
  }

  const request: CustomsProviderSubmissionRequest = {
    tenantRef: input.tenantRef,
    principalRef: input.principalRef,
    jurisdiction: input.jurisdiction,
    remedy: input.remedy as CustomsProviderRemedy,
    brokerRef: input.brokerRef ?? null,
    poaRef: input.poaRef ?? null,
    signerRef: input.signerRef ?? null,
    filingAuthorized: true,
    packageRef: input.packageRef,
    packageDigest: input.packageDigest,
    evidenceRefs: input.evidenceRefs.map((evidence) => ({ ...evidence })),
    idempotencyKey: input.idempotencyKey,
    requestedAt: input.requestedAt,
  };
  const { requestedAt, ...stable } = request;
  void requestedAt;
  return {
    ok: true,
    envelope: {
      request,
      requestDigest: customsProviderRequestDigest(stable),
      externalWritePerformed: false,
      transportEnabled: false,
      productionCredentials: 'ABSENT',
    },
  };
}

/** provider 原始 status 文本 → 内部词表的显式白名单（未知一律 UNKNOWN，绝不隐式升级）。 */
const PROVIDER_STATUS_MAP: Record<string, CustomsProviderStatus> = {
  PREPARING: 'PREPARING',
  READY_TO_FILE: 'READY_TO_FILE',
  SUBMITTED: 'SUBMITTED',
  ACCEPTED: 'ACCEPTED',
  NEEDS_MORE_INFO: 'NEEDS_MORE_INFO',
  UNDER_REVIEW: 'UNDER_REVIEW',
  DENIED: 'DENIED',
  APPROVED: 'APPROVED',
  PAID: 'PAID',
};

export function mapProviderStatus(status: string): CustomsProviderStatus {
  return PROVIDER_STATUS_MAP[status.trim().toUpperCase()] ?? 'UNKNOWN';
}

export interface CustomsProviderStatusRevision {
  providerSubmissionId: string;
  status: CustomsProviderStatus;
  /** provider 通道只能是 PROVIDER_VERIFIED（authority 级事实由 authority 通道产生）。 */
  sourceLevel: 'PROVIDER_VERIFIED';
  observedAt: string;
  rawStatusText: string | null;
  derivesRecoveredCash: false;
  derivesFee: false;
}

export function mapProviderStatusToRevision(
  result: Pick<CustomsFilingStatusResult, 'providerSubmissionId' | 'status' | 'observedAt' | 'rawStatusText'>,
): CustomsProviderStatusRevision {
  return {
    providerSubmissionId: result.providerSubmissionId,
    status: mapProviderStatus(result.status),
    sourceLevel: 'PROVIDER_VERIFIED',
    observedAt: result.observedAt,
    rawStatusText: result.rawStatusText,
    derivesRecoveredCash: false,
    derivesFee: false,
  };
}

export interface CustomsProviderRefundRevision {
  providerSubmissionId: string;
  refundStatus: string;
  refundedAmount: string | null;
  currency: string | null;
  observedAt: string;
  sourceLevel: 'PROVIDER_VERIFIED';
  /** provider 报告的退款金额不得直接记为已追回现金/费用依据（须走 C20 结算与确认）。 */
  derivesRecoveredCash: false;
  derivesFee: false;
}

export function mapProviderRefundStatusToRevision(
  result: Pick<
    CustomsFilingRefundStatusResult,
    'providerSubmissionId' | 'refundStatus' | 'refundedAmount' | 'currency' | 'observedAt'
  >,
): CustomsProviderRefundRevision {
  return {
    providerSubmissionId: result.providerSubmissionId,
    refundStatus: result.refundStatus,
    refundedAmount: result.refundedAmount,
    currency: result.currency,
    observedAt: result.observedAt,
    sourceLevel: 'PROVIDER_VERIFIED',
    derivesRecoveredCash: false,
    derivesFee: false,
  };
}
