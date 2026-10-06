// CUSTOMS / DUTY RECOVERY — slice B-S4 — OCR trust boundary + 候选 → Customs Fact 对账
// ---------------------------------------------------------------------------
// 定位：把来自多个来源（STRUCTURED / NATIVE_TEXT / OCR_DERIVED，可跨文档）的**候选值**对账成
//   「可以进入人工确认环节的字段结论」，并显式区分：
//     AGREED（多来源一致且有可信任来源支撑）/ CONFLICT（≥2 个不同值）/
//     OCR_ONLY（只有 OCR 支撑，永不自动采纳）/ LOW_CONFIDENCE（低于阈值）/ MISSING。
// 硬边界：
//   ① **OCR ≠ Customs Truth**：只有 OCR 支撑的字段一律 promotion.allowed=false；
//   ② 跨源冲突一律 CONFLICT，**禁止 last-write-wins**，也禁止用 OCR 打破冲突；
//   ③ 本模块**不写** Canonical / Customs Fact：canonicalWritePerformed 恒为 false；
//      任何采纳动作都需要人工确认（requiresHumanApproval 恒为 true）；
//   ④ 规范化失败的候选不参与取值（但保留在 sources 里，便于审计）。

import { digestOf } from '../config-execution-durability/digests';
import {
  CUSTOMS_7501_FIELDS,
  DEFAULT_7501_LOW_CONFIDENCE_BP,
  type CustomsFieldCandidate,
  type Customs7501Field,
} from './customs-7501-extraction';
import type { DocumentSourceKind } from './document-types';

export const CUSTOMS_RECONCILIATION_VERSION = 'customs-fact-reconciliation/v1';

export const RECONCILIATION_STATUSES = [
  'AGREED',
  'CONFLICT',
  'OCR_ONLY',
  'LOW_CONFIDENCE',
  'MISSING',
] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const RECONCILIATION_OVERALL_STATUSES = [
  'READY_FOR_HUMAN_REVIEW',
  'BLOCKED_BY_CONFLICT',
  'INSUFFICIENT_EVIDENCE',
] as const;
export type ReconciliationOverallStatus = (typeof RECONCILIATION_OVERALL_STATUSES)[number];

/** 来源信任级别（STRUCTURED 最高；OCR 最低且永不可独占） */
export const SOURCE_TRUST: Record<DocumentSourceKind, number> = {
  STRUCTURED: 3,
  NATIVE_TEXT: 2,
  OCR_DERIVED: 1,
};

export interface ReconciliationSourceRef {
  sourceKind: DocumentSourceKind;
  provider: string;
  providerVersion: string;
  sourceFileSha256: string;
  page: number | null;
  rawValue: string;
  normalizedValue: string | null;
  confidenceBp: number;
}

export interface CustomsFieldReconciliation {
  field: string;
  status: ReconciliationStatus;
  /** 仅在 AGREED 时给出可直接采纳的值 */
  value: string | null;
  /** 未采纳的候选值（例如 OCR_ONLY / LOW_CONFIDENCE），仅作提示 */
  proposedValue: string | null;
  confidenceBp: number;
  distinctValues: string[];
  sources: ReconciliationSourceRef[];
  promotion: {
    allowed: boolean;
    requiresHumanApproval: true;
    forbiddenReason: string | null;
  };
  reasons: string[];
}

export interface CustomsReconciliationResult {
  kind: 'CUSTOMS_FACT_RECONCILIATION';
  version: string;
  organizationId: string | null;
  fields: CustomsFieldReconciliation[];
  agreedFields: string[];
  conflictingFields: string[];
  ocrOnlyFields: string[];
  lowConfidenceFields: string[];
  missingFields: string[];
  promotableFields: string[];
  blockedFields: string[];
  overallStatus: ReconciliationOverallStatus;
  /** 本模块从不写 Canonical / Customs Fact */
  canonicalWritePerformed: false;
  customsTruthEligible: false;
  ocrNeverSufficientAlone: true;
  crossSourceConflictAutoResolved: false;
  requiresManualReview: boolean;
  reasons: string[];
  reconciledAt: string | null;
  reconciliationDigest: string;
}

export type CustomsReconciliationErrorCode = 'CUSTOMS_RECONCILIATION_CANNOT_WRITE_TRUTH';

export class CustomsReconciliationError extends Error {
  readonly code: CustomsReconciliationErrorCode;

  constructor(code: CustomsReconciliationErrorCode, message: string) {
    super(message);
    this.name = 'CustomsReconciliationError';
    this.code = code;
  }
}

function valueOfCandidate(candidate: CustomsFieldCandidate): string | null {
  const normalized = candidate.normalizedValue;
  if (normalized === null) return null;
  const trimmed = normalized.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function toSourceRef(candidate: CustomsFieldCandidate): ReconciliationSourceRef {
  return {
    sourceKind: candidate.sourceKind,
    provider: candidate.provider,
    providerVersion: candidate.providerVersion,
    sourceFileSha256: candidate.sourceFileSha256,
    page: candidate.page,
    rawValue: candidate.rawValue,
    normalizedValue: candidate.normalizedValue,
    confidenceBp: candidate.confidenceBp,
  };
}

/**
 * 对账单份/多份文档的候选值（纯函数）。
 * 输出的是「可供人工确认的字段结论」，不是 Customs Fact。
 */
export function reconcileCustomsFields(input: {
  candidates: readonly CustomsFieldCandidate[];
  organizationId?: string | null;
  fields?: readonly string[];
  confidenceThresholdBp?: number;
  now?: Date;
}): CustomsReconciliationResult {
  const threshold = input.confidenceThresholdBp ?? DEFAULT_7501_LOW_CONFIDENCE_BP;
  const fields = input.fields ?? CUSTOMS_7501_FIELDS;

  const results: CustomsFieldReconciliation[] = [];

  for (const field of fields) {
    const fieldCandidates = input.candidates.filter((candidate) => candidate.field === field);
    const sources = fieldCandidates.map(toSourceRef);
    const reasons: string[] = [];

    if (fieldCandidates.length === 0) {
      results.push({
        field,
        status: 'MISSING',
        value: null,
        proposedValue: null,
        confidenceBp: 0,
        distinctValues: [],
        sources: [],
        promotion: { allowed: false, requiresHumanApproval: true, forbiddenReason: 'NO_CANDIDATE' },
        reasons: ['NO_CANDIDATE'],
      });
      continue;
    }

    const unnormalized = fieldCandidates.filter((candidate) => valueOfCandidate(candidate) === null);
    if (unnormalized.length > 0) {
      reasons.push('UNNORMALIZED_CANDIDATE_IGNORED:' + unnormalized.length);
    }

    const usable = fieldCandidates
      .map((candidate) => ({ candidate, value: valueOfCandidate(candidate) }))
      .filter((entry): entry is { candidate: CustomsFieldCandidate; value: string } => entry.value !== null);

    if (usable.length === 0) {
      results.push({
        field,
        status: 'MISSING',
        value: null,
        proposedValue: null,
        confidenceBp: 0,
        distinctValues: [],
        sources,
        promotion: {
          allowed: false,
          requiresHumanApproval: true,
          forbiddenReason: 'ONLY_UNNORMALIZED_CANDIDATES',
        },
        reasons: [...reasons, 'NO_USABLE_VALUE'],
      });
      continue;
    }

    const distinctValues = [...new Set(usable.map((entry) => entry.value))].sort();

    if (distinctValues.length > 1) {
      // 跨源冲突：绝不 last-write-wins，也绝不用 OCR 打破平局
      results.push({
        field,
        status: 'CONFLICT',
        value: null,
        proposedValue: null,
        confidenceBp: 0,
        distinctValues,
        sources,
        promotion: {
          allowed: false,
          requiresHumanApproval: true,
          forbiddenReason: 'CROSS_SOURCE_CONFLICT',
        },
        reasons: [...reasons, 'CROSS_SOURCE_CONFLICT', 'LAST_WRITE_WINS_FORBIDDEN'],
      });
      continue;
    }

    const agreedValue = distinctValues[0];
    const supporting = usable.filter((entry) => entry.value === agreedValue);
    const nonOcrSupporting = supporting.filter((entry) => entry.candidate.sourceKind !== 'OCR_DERIVED');
    const trustworthy = nonOcrSupporting.filter((entry) => entry.candidate.confidenceBp >= threshold);
    const maxConfidenceBp = Math.max(...supporting.map((entry) => entry.candidate.confidenceBp));
    const ocrOnly = nonOcrSupporting.length === 0;

    if (ocrOnly) {
      results.push({
        field,
        status: 'OCR_ONLY',
        value: null,
        proposedValue: agreedValue,
        confidenceBp: maxConfidenceBp,
        distinctValues,
        sources,
        promotion: {
          allowed: false,
          requiresHumanApproval: true,
          forbiddenReason: 'OCR_NEVER_SUFFICIENT_ALONE',
        },
        reasons: [...reasons, 'OCR_ONLY_VALUE', 'OCR_REQUIRES_HUMAN_VERIFICATION'],
      });
      continue;
    }

    if (trustworthy.length === 0) {
      results.push({
        field,
        status: 'LOW_CONFIDENCE',
        value: null,
        proposedValue: agreedValue,
        confidenceBp: maxConfidenceBp,
        distinctValues,
        sources,
        promotion: {
          allowed: false,
          requiresHumanApproval: true,
          forbiddenReason: 'BELOW_CONFIDENCE_THRESHOLD',
        },
        reasons: [...reasons, 'BELOW_CONFIDENCE_THRESHOLD'],
      });
      continue;
    }

    const winningSourceKind = trustworthy
      .map((entry) => entry.candidate.sourceKind)
      .sort((a, b) => SOURCE_TRUST[b] - SOURCE_TRUST[a])[0];
    const extraReasons: string[] = [];
    if (supporting.length > 1) extraReasons.push('MULTI_SOURCE_AGREEMENT');
    if (supporting.some((entry) => entry.candidate.sourceKind === 'OCR_DERIVED')) {
      extraReasons.push('OCR_CORROBORATION_ONLY');
    }

    results.push({
      field,
      status: 'AGREED',
      value: agreedValue,
      proposedValue: agreedValue,
      confidenceBp: Math.min(9_500, maxConfidenceBp),
      distinctValues,
      sources,
      promotion: {
        allowed: true,
        requiresHumanApproval: true,
        forbiddenReason: null,
      },
      reasons: [...reasons, `AGREED_BY_${winningSourceKind}`, ...extraReasons],
    });
  }

  const agreedFields = results.filter((r) => r.status === 'AGREED').map((r) => r.field);
  const conflictingFields = results.filter((r) => r.status === 'CONFLICT').map((r) => r.field);
  const ocrOnlyFields = results.filter((r) => r.status === 'OCR_ONLY').map((r) => r.field);
  const lowConfidenceFields = results.filter((r) => r.status === 'LOW_CONFIDENCE').map((r) => r.field);
  const missingFields = results.filter((r) => r.status === 'MISSING').map((r) => r.field);
  const promotableFields = results.filter((r) => r.promotion.allowed).map((r) => r.field);
  const blockedFields = results.filter((r) => !r.promotion.allowed).map((r) => r.field);

  const overallStatus: ReconciliationOverallStatus =
    conflictingFields.length > 0
      ? 'BLOCKED_BY_CONFLICT'
      : promotableFields.length === 0
        ? 'INSUFFICIENT_EVIDENCE'
        : 'READY_FOR_HUMAN_REVIEW';

  const reasons: string[] = [];
  if (conflictingFields.length > 0) reasons.push('CONFLICTS_PRESENT');
  if (ocrOnlyFields.length > 0) reasons.push('OCR_ONLY_FIELDS_PRESENT');
  if (missingFields.length > 0) reasons.push('MISSING_FIELDS_PRESENT');
  if (promotableFields.length === 0) reasons.push('NOTHING_PROMOTABLE');

  const body = {
    version: CUSTOMS_RECONCILIATION_VERSION,
    organizationId: input.organizationId ?? null,
    fields: results,
    agreedFields,
    conflictingFields,
    ocrOnlyFields,
    lowConfidenceFields,
    missingFields,
    promotableFields,
    blockedFields,
    overallStatus,
    canonicalWritePerformed: false as const,
    customsTruthEligible: false as const,
    ocrNeverSufficientAlone: true as const,
    crossSourceConflictAutoResolved: false as const,
    requiresManualReview: blockedFields.length > 0 || conflictingFields.length > 0,
    reasons,
    reconciledAt: input.now ? input.now.toISOString() : null,
  };

  return {
    kind: 'CUSTOMS_FACT_RECONCILIATION',
    ...body,
    reconciliationDigest: digestOf(body),
  };
}

export const OCR_TRUST_BOUNDARY = {
  ocrIsNotCustomsTruth: true,
  ocrNeverSufficientAlone: true,
  ocrRequiresHumanVerification: true,
  crossSourceConflictNeverAutoResolved: true,
  lastWriteWinsForbidden: true,
  canonicalWritePerformed: false,
  promotionRequiresHumanApproval: true,
  forbidden: [
    'promoting an OCR-only value to a Customs Fact',
    'resolving a cross-source conflict by last-write-wins',
    'using OCR to break a tie between conflicting non-OCR sources',
    'writing reconciled values directly as canonical truth',
    'silently dropping conflicting values',
  ],
} as const;

/** 边界断言：任何声称本模块已写 Canonical / 已产生 Customs Truth 的记录都必须被拒绝 */
export function assertReconciliationDidNotWriteTruth(record: {
  canonicalWritePerformed?: boolean;
  customsTruthEligible?: boolean;
}): void {
  if (record.canonicalWritePerformed === true || record.customsTruthEligible === true) {
    throw new CustomsReconciliationError(
      'CUSTOMS_RECONCILIATION_CANNOT_WRITE_TRUTH',
      '对账结果不能写 Canonical / Customs Truth；采纳必须经人工确认。',
    );
  }
}

/** 供后续单元（B-S5/B-S10）使用：只有 AGREED 且有可信任来源支撑的字段才允许进入人工确认 */
export function listPromotableFields(result: CustomsReconciliationResult): Customs7501Field[] {
  return result.fields
    .filter((field) => field.promotion.allowed && field.status === 'AGREED' && field.value !== null)
    .map((field) => field.field)
    .filter((field): field is Customs7501Field => (CUSTOMS_7501_FIELDS as readonly string[]).includes(field));
}
