// CUSTOMS / DUTY RECOVERY — slice B-S6 — Import ↔ Export / Return / Destruction 匹配
// ---------------------------------------------------------------------------
// 定位：把一条**进口 entry 行**（CBP 7501 行项目）与出口 / 退货 / 销毁记录做一致性匹配，
//   产出 EXACT / PARTIAL / AMBIGUOUS / NO_MATCH 四种结论，并逐维度给出一致性判定：
//   tenant / platformAccount / HTS / currency / jurisdiction / customsValue（容差可配）。
// 硬边界：
//   ① 只做匹配：不判定 eligibility、不算可退金额、不写任何 Canonical / Customs Truth；
//   ② tenant / platformAccount 不一致的记录一律剔除并记录（rejectedForScope），不得参与匹配；
//   ③ 多个记录同等匹配 → AMBIGUOUS，**绝不自动挑选**（automaticSelectionPerformed 恒为 false）；
//   ④ 缺维度（如缺 currency / jurisdiction）不得判 EXACT —— fail-closed，降级 PARTIAL。

import { digestOf } from '../config-execution-durability/digests';

export const CUSTOMS_MATCHING_VERSION = 'customs-import-export-matching/v1';

export const CUSTOMS_MATCH_STATUSES = ['EXACT', 'PARTIAL', 'AMBIGUOUS', 'NO_MATCH'] as const;
export type CustomsMatchStatus = (typeof CUSTOMS_MATCH_STATUSES)[number];

export const CUSTOMS_COUNTERPART_KINDS = ['EXPORT', 'RETURN', 'DESTRUCTION'] as const;
export type CustomsCounterpartKind = (typeof CUSTOMS_COUNTERPART_KINDS)[number];

export const DIMENSION_RELATIONS = ['EXACT', 'PREFIX', 'MISMATCH', 'MISSING'] as const;
export type DimensionRelation = (typeof DIMENSION_RELATIONS)[number];

export interface CustomsImportLine {
  lineId: string;
  /** 关联键（至少给一个；全缺 → NO_MATCH） */
  trackingNumber?: string | null;
  entryNumber?: string | null;
  lineRef?: string | null;
  hts?: string | null;
  currency?: string | null;
  jurisdiction?: string | null;
  customsValue?: number | null;
}

export interface CustomsCounterpartRecord {
  recordId: string;
  organizationId: string;
  platformAccountId: string;
  recordKind: CustomsCounterpartKind;
  trackingNumber?: string | null;
  entryNumber?: string | null;
  lineRef?: string | null;
  hts?: string | null;
  currency?: string | null;
  jurisdiction?: string | null;
  customsValue?: number | null;
  capturedAt?: string | null;
}

export interface CustomsDimensionComparison {
  hts: DimensionRelation;
  currency: DimensionRelation;
  jurisdiction: DimensionRelation;
  customsValue: DimensionRelation;
}

export interface CustomsRecordMatch {
  recordId: string;
  recordKind: CustomsCounterpartKind;
  status: Exclude<CustomsMatchStatus, 'AMBIGUOUS' | 'NO_MATCH'>;
  score: number;
  matchedBy: 'TRACKING_NUMBER' | 'ENTRY_NUMBER' | 'LINE_REF';
  dimensions: CustomsDimensionComparison;
  mismatchedDimensions: string[];
  reasons: string[];
}

export interface CustomsMatchResult {
  kind: 'CUSTOMS_IMPORT_EXPORT_MATCH';
  version: string;
  organizationId: string;
  platformAccountId: string;
  lineId: string;
  status: CustomsMatchStatus;
  matches: CustomsRecordMatch[];
  bestMatch: CustomsRecordMatch | null;
  ambiguousBetween: string[];
  rejectedForScope: string[];
  consistency: {
    tenantScoped: true;
    accountScoped: true;
    missingDimensions: string[];
  };
  /** 恒为 false：本模块不做自动择优，也不产生任何权利结论 */
  automaticSelectionPerformed: false;
  decidesEligibility: false;
  canonicalWritePerformed: false;
  requiresManualReview: boolean;
  reasons: string[];
  matchedAt: string | null;
  matchDigest: string;
}

export type CustomsMatchingErrorCode = 'CUSTOMS_MATCH_CANNOT_DECIDE_ELIGIBILITY';

export class CustomsMatchingError extends Error {
  readonly code: CustomsMatchingErrorCode;

  constructor(code: CustomsMatchingErrorCode, message: string) {
    super(message);
    this.name = 'CustomsMatchingError';
    this.code = code;
  }
}

function normalizeKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '');
  return normalized.length === 0 ? null : normalized;
}

function normalizeHts(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/[^0-9]/g, '');
  return digits.length === 0 ? null : digits;
}

/** HTS 关系：完全相同 / 一方是另一方前缀（8 位 vs 10 位）/ 不同 / 缺失 */
export function compareHts(a: string | null | undefined, b: string | null | undefined): DimensionRelation {
  const left = normalizeHts(a);
  const right = normalizeHts(b);
  if (left === null || right === null) return 'MISSING';
  if (left === right) return 'EXACT';
  if (left.startsWith(right) || right.startsWith(left)) return 'PREFIX';
  return 'MISMATCH';
}

export function compareCurrency(a: string | null | undefined, b: string | null | undefined): DimensionRelation {
  const left = normalizeKey(a);
  const right = normalizeKey(b);
  if (left === null || right === null) return 'MISSING';
  return left === right ? 'EXACT' : 'MISMATCH';
}

export function compareJurisdiction(
  a: string | null | undefined,
  b: string | null | undefined,
): DimensionRelation {
  const left = normalizeKey(a);
  const right = normalizeKey(b);
  if (left === null || right === null) return 'MISSING';
  return left === right ? 'EXACT' : 'MISMATCH';
}

export function compareAmount(
  a: number | null | undefined,
  b: number | null | undefined,
  toleranceBp: number,
): DimensionRelation {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    return 'MISSING';
  }
  if (a === b) return 'EXACT';
  const base = Math.max(Math.abs(a), Math.abs(b));
  if (base === 0) return 'EXACT';
  const diffBp = (Math.abs(a - b) / base) * 10_000;
  return diffBp <= toleranceBp ? 'PREFIX' : 'MISMATCH';
}

/**
 * 匹配一条进口 entry 行与若干出口 / 退货 / 销毁记录（纯函数）。
 * 不判定 eligibility、不自动择优、不写任何事实。
 */
export function matchImportLineToCounterparts(input: {
  scope: { organizationId: string; platformAccountId: string };
  importLine: CustomsImportLine;
  counterparts: readonly CustomsCounterpartRecord[];
  valueToleranceBp?: number;
  now?: Date;
}): CustomsMatchResult {
  const { scope, importLine } = input;
  const toleranceBp = input.valueToleranceBp ?? 0;

  const rejectedForScope: string[] = [];
  const inScope: CustomsCounterpartRecord[] = [];
  for (const record of input.counterparts) {
    if (
      record.organizationId !== scope.organizationId ||
      record.platformAccountId !== scope.platformAccountId
    ) {
      rejectedForScope.push(record.recordId);
      continue;
    }
    inScope.push(record);
  }

  const lineTracking = normalizeKey(importLine.trackingNumber);
  const lineEntry = normalizeKey(importLine.entryNumber);
  const lineRef = normalizeKey(importLine.lineRef);

  const matches: CustomsRecordMatch[] = [];
  for (const record of inScope) {
    let matchedBy: CustomsRecordMatch['matchedBy'] | null = null;
    if (lineTracking !== null && lineTracking === normalizeKey(record.trackingNumber)) {
      matchedBy = 'TRACKING_NUMBER';
    } else if (lineEntry !== null && lineEntry === normalizeKey(record.entryNumber)) {
      matchedBy = 'ENTRY_NUMBER';
    } else if (lineRef !== null && lineRef === normalizeKey(record.lineRef)) {
      matchedBy = 'LINE_REF';
    }
    if (matchedBy === null) continue;

    const dimensions: CustomsDimensionComparison = {
      hts: compareHts(importLine.hts, record.hts),
      currency: compareCurrency(importLine.currency, record.currency),
      jurisdiction: compareJurisdiction(importLine.jurisdiction, record.jurisdiction),
      customsValue: compareAmount(importLine.customsValue, record.customsValue, toleranceBp),
    };

    const mismatchedDimensions = (Object.keys(dimensions) as Array<keyof CustomsDimensionComparison>).filter(
      (dimension) => dimensions[dimension] !== 'EXACT',
    );
    const score =
      1 +
      (dimensions.hts === 'EXACT' ? 1 : 0) +
      (dimensions.currency === 'EXACT' ? 1 : 0) +
      (dimensions.jurisdiction === 'EXACT' ? 1 : 0) +
      (dimensions.customsValue === 'EXACT' || dimensions.customsValue === 'PREFIX' ? 1 : 0);

    const reasons: string[] = [`MATCHED_BY_${matchedBy}`];
    for (const dimension of mismatchedDimensions) {
      reasons.push(`${dimension.toUpperCase()}_${dimensions[dimension]}`);
    }

    matches.push({
      recordId: record.recordId,
      recordKind: record.recordKind,
      status: mismatchedDimensions.length === 0 ? 'EXACT' : 'PARTIAL',
      score,
      matchedBy,
      dimensions,
      mismatchedDimensions: [...mismatchedDimensions],
      reasons,
    });
  }

  matches.sort(
    (a, b) => b.score - a.score || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
  );

  const reasons: string[] = [];
  let status: CustomsMatchStatus;
  let bestMatch: CustomsRecordMatch | null = null;
  let ambiguousBetween: string[] = [];

  if (matches.length === 0) {
    status = 'NO_MATCH';
    reasons.push(lineTracking === null && lineEntry === null && lineRef === null ? 'NO_LINEAGE_KEY' : 'NO_MATCHING_COUNTERPART');
  } else {
    const top = matches[0];
    const tied = matches.filter((match) => match.score === top.score);
    if (tied.length > 1) {
      status = 'AMBIGUOUS';
      ambiguousBetween = tied.map((match) => match.recordId).sort();
      reasons.push('MULTIPLE_EQUAL_MATCHES');
      reasons.push('AUTOMATIC_SELECTION_FORBIDDEN');
    } else {
      bestMatch = top;
      status = top.status;
      reasons.push(top.status === 'EXACT' ? 'SINGLE_EXACT_MATCH' : 'SINGLE_PARTIAL_MATCH');
    }
  }

  const missingDimensions: string[] = (['hts', 'currency', 'jurisdiction', 'customsValue'] as const).filter(
    (dimension) => {
      if (bestMatch) return bestMatch.dimensions[dimension] === 'MISSING';
      if (dimension === 'customsValue') return false;
      return normalizeKey(importLine[dimension]) === null;
    },
  );

  const requiresManualReview = status !== 'EXACT';

  const body = {
    version: CUSTOMS_MATCHING_VERSION,
    organizationId: scope.organizationId,
    platformAccountId: scope.platformAccountId,
    lineId: importLine.lineId,
    status,
    matches,
    bestMatch,
    ambiguousBetween,
    rejectedForScope: [...rejectedForScope].sort(),
    consistency: {
      tenantScoped: true as const,
      accountScoped: true as const,
      missingDimensions,
    },
    automaticSelectionPerformed: false as const,
    decidesEligibility: false as const,
    canonicalWritePerformed: false as const,
    requiresManualReview,
    reasons,
    matchedAt: input.now ? input.now.toISOString() : null,
  };

  return {
    kind: 'CUSTOMS_IMPORT_EXPORT_MATCH',
    ...body,
    matchDigest: digestOf(body),
  };
}

export const CUSTOMS_MATCHING_BOUNDARY = {
  matchingOnly: true,
  tenantScoped: true,
  accountScoped: true,
  automaticSelectionPerformed: false,
  decidesEligibility: false,
  canonicalWritePerformed: false,
  computesRecoverableAmount: false,
  ambiguityRequiresManualReview: true,
  forbidden: [
    'picking a counterpart among equally-matching records',
    'matching across tenants or platform accounts',
    'treating a match as eligibility for a refund or drawback',
    'computing a recoverable duty amount from a match',
    'writing matched values as canonical truth',
  ],
} as const;

/** 边界断言：任何把匹配结论当成权利/金额结论的记录都必须被拒绝 */
export function assertMatchDoesNotDecideEligibility(record: {
  status?: CustomsMatchStatus;
  automaticSelectionPerformed?: boolean;
  decidesEligibility?: boolean;
}): void {
  if (record.decidesEligibility === true || record.automaticSelectionPerformed === true) {
    throw new CustomsMatchingError(
      'CUSTOMS_MATCH_CANNOT_DECIDE_ELIGIBILITY',
      '匹配结论不能判定 eligibility，也不能在同等匹配中自动择优。',
    );
  }
}

export function isCustomsMatchStatus(value: string): value is CustomsMatchStatus {
  return (CUSTOMS_MATCH_STATUSES as readonly string[]).includes(value);
}
