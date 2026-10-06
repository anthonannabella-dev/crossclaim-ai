// CUSTOMS / DUTY RECOVERY — slice B-S3 — CBP 7501 候选字段抽取
// ---------------------------------------------------------------------------
// 定位：把 CBP 7501（或其 OCR/原生文本）里的字段抽成**候选值**，每个候选都携带
//   rawValue / normalizedValue / page / bbox / confidenceBp / sourceKind / provider /
//   sourceFileSha256 / lineNumber，可回溯、可对账。
// 硬边界：
//   ① 只产出候选（candidate），**不是** Customs Truth：canonicalWriteAllowed=false；
//   ② 关键字段（entryNumber/entryDate/hts/customsValue/dutyPaid/currency）低置信 → QUARANTINE + HITL；
//   ③ OCR 来源一律降权（≤9900 且默认 6500），并强制人工复核；
//   ④ 冲突不做 last-write-wins：同字段多值一律全部保留并标记 CONFLICT。

import { digestOf } from '../config-execution-durability/digests';
import type { CandidateField, DocumentSourceKind } from './document-types';
import { detectCandidateConflicts } from './field-extraction';

export const CUSTOMS_7501_EXTRACTION_VERSION = 'customs-7501-extraction/v1';

export const CUSTOMS_7501_FIELDS = [
  'entryNumber',
  'entryDate',
  'portOfEntry',
  'ior',
  'hts',
  'countryOfOrigin',
  'customsValue',
  'dutiableValue',
  'dutyRate',
  'dutyPaid',
  'currency',
  'preference',
  'broker',
] as const;
export type Customs7501Field = (typeof CUSTOMS_7501_FIELDS)[number];

/** 关键字段：低置信必须隔离并交人工 */
export const CUSTOMS_7501_CRITICAL_FIELDS: readonly Customs7501Field[] = [
  'entryNumber',
  'entryDate',
  'hts',
  'customsValue',
  'dutyPaid',
  'currency',
];

export const DEFAULT_7501_LOW_CONFIDENCE_BP = 6_000;
export const DEFAULT_7501_OCR_CONFIDENCE_BP = 6_500;
export const MAX_7501_CANDIDATE_CONFIDENCE_BP = 9_500;
export const MAX_7501_OCR_CANDIDATE_CONFIDENCE_BP = 9_900;

export interface CustomsFieldCandidate extends CandidateField {
  /** 行项目号（主表字段为 null） */
  lineNumber: number | null;
}

export interface CustomsEntryLineCandidate {
  lineNumber: number;
  hts: string | null;
  countryOfOrigin: string | null;
  customsValue: string | null;
  dutiableValue: string | null;
  dutyRate: string | null;
  dutyPaid: string | null;
  rawLine: string;
  confidenceBp: number;
  sourceKind: DocumentSourceKind;
}

export interface Customs7501Extraction {
  kind: 'CBP_7501_CANDIDATE_FIELDS';
  version: string;
  sourceFileSha256: string;
  sourceKind: DocumentSourceKind;
  status: 'EXTRACTED' | 'QUARANTINED' | 'NO_CANDIDATES';
  candidates: CustomsFieldCandidate[];
  lines: CustomsEntryLineCandidate[];
  presentCriticalFields: Customs7501Field[];
  missingCriticalFields: Customs7501Field[];
  criticalLowConfidence: Customs7501Field[];
  conflicts: Array<{ field: string; values: string[]; sources: string[] }>;
  requiresManualReview: boolean;
  /** 候选值永远不是 Canonical / Customs Truth */
  customsTruthEligible: false;
  canonicalWriteAllowed: false;
  reasons: string[];
  extractedAt: string | null;
  extractionDigest: string;
}

export type Customs7501ExtractionErrorCode = 'CUSTOMS_7501_CANDIDATE_CANNOT_BE_CLAIMED_AS_TRUTH';

export class Customs7501ExtractionError extends Error {
  readonly code: Customs7501ExtractionErrorCode;

  constructor(code: Customs7501ExtractionErrorCode, message: string) {
    super(message);
    this.name = 'Customs7501ExtractionError';
    this.code = code;
  }
}

const MONEY = /^\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,6})?)$/;

function normalizeMoney(raw: string): string | null {
  const match = MONEY.exec(raw.trim());
  if (!match) return null;
  const normalized = match[1].replace(/,/g, '');
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return null;
  return numeric.toFixed(2);
}

function toValidIsoDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeEntryDate(raw: string): string | null {
  const trimmed = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return toValidIsoDate(iso[1], iso[2], iso[3]);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (compact) return toValidIsoDate(compact[1], compact[2], compact[3]);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return toValidIsoDate(year, slash[1], slash[2]);
  }
  return null;
}

/** 每个字段的抽取规则 + 规范化（规范化失败 → normalizedValue=null，绝不猜） */
export const CUSTOMS_7501_FIELD_RULES: ReadonlyArray<{
  field: Customs7501Field;
  pattern: RegExp;
  normalize: (raw: string) => string | null;
  critical: boolean;
}> = [
  {
    field: 'entryNumber',
    pattern: /entry\s*(?:number|no\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,20})/i,
    normalize: (raw) => raw.toUpperCase().replace(/\s+/g, ''),
    critical: true,
  },
  {
    field: 'entryDate',
    pattern: /entry\s*date\s*[:#]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{8})/i,
    normalize: normalizeEntryDate,
    critical: true,
  },
  {
    field: 'portOfEntry',
    pattern: /\bport\s*(?:of\s*entry)?\s*[:#]?\s*([A-Z]{3,5}|\d{4})/i,
    normalize: (raw) => raw.toUpperCase().replace(/\s+/g, ''),
    critical: false,
  },
  {
    field: 'ior',
    pattern: /(?:ior|importer\s*of\s*record)\s*(?:number|no\.?)?\s*[:#]?\s*(\d{2}-?\d{7}|\d{9})/i,
    normalize: (raw) => raw.replace(/[^0-9]/g, ''),
    critical: false,
  },
  {
    field: 'hts',
    pattern: /(?:hts(?:us)?|hs\s*code)\s*[:#]?\s*(\d{4}\.\d{2}(?:\.\d{2,4})?|\d{8,10})/i,
    normalize: (raw) => raw.replace(/[^0-9.]/g, ''),
    critical: true,
  },
  {
    field: 'countryOfOrigin',
    pattern: /(?:country\s*of\s*origin|origin)\s*[:#]?\s*([A-Z]{2})\b/i,
    normalize: (raw) => raw.toUpperCase(),
    critical: false,
  },
  {
    field: 'customsValue',
    pattern: /(?:customs\s*value|entered\s*value)\s*[:#]?\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?)/i,
    normalize: normalizeMoney,
    critical: true,
  },
  {
    field: 'dutiableValue',
    pattern: /dutiable\s*value\s*[:#]?\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?)/i,
    normalize: normalizeMoney,
    critical: false,
  },
  {
    field: 'dutyRate',
    pattern: /(?:duty\s*rate|rate\s*of\s*duty)\s*[:#]?\s*(\d{1,2}(?:\.\d{1,4})?)\s*%/i,
    normalize: (raw) => {
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? (numeric / 100).toFixed(4) : null;
    },
    critical: false,
  },
  {
    field: 'dutyPaid',
    pattern: /(?:duty\s*paid|total\s*duty|duty\s*amount)\s*[:#]?\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?)/i,
    normalize: normalizeMoney,
    critical: true,
  },
  {
    field: 'currency',
    pattern: /\b(USD|EUR|JPY|CNY|GBP|CAD|AUD|MXN)\b/,
    normalize: (raw) => raw.toUpperCase(),
    critical: true,
  },
  {
    field: 'preference',
    pattern: /(?:preference|special\s*program)\s*[:#]?\s*([A-Z0-9][A-Z0-9 -]{1,20})/i,
    normalize: (raw) => raw.toUpperCase().trim(),
    critical: false,
  },
  {
    field: 'broker',
    pattern: /broker\s*(?:name|license|reference|no\.?)?\s*[:#]\s*([A-Z0-9][A-Z0-9 .\-]{2,40})/i,
    normalize: (raw) => raw.replace(/\s+/g, ' ').trim().toUpperCase(),
    critical: false,
  },
];

export function is7501CriticalField(field: string): boolean {
  return (CUSTOMS_7501_CRITICAL_FIELDS as readonly string[]).includes(field);
}

/** 行项目解析：`line | HTS | origin | customsValue | dutiableValue | rate% | dutyPaid` */
export function extractCustomsEntryLines(input: {
  text: string;
  sourceKind: DocumentSourceKind;
  baseConfidenceBp: number;
}): CustomsEntryLineCandidate[] {
  const lines: CustomsEntryLineCandidate[] = [];
  for (const rawLine of input.text.split(/\r?\n/)) {
    const match = /^\s*(\d{1,3})\s*[|,\t]\s*(\d{4}\.\d{2}(?:\.\d{2,4})?)\s*[|,\t]\s*([A-Z]{2})\s*[|,\t]\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?)\s*[|,\t]\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?)(?:\s*[|,\t]\s*(\d{1,2}(?:\.\d{1,4})?)\s*%?)?(?:\s*[|,\t]\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?))?\s*$/.exec(
      rawLine,
    );
    if (!match) continue;
    lines.push({
      lineNumber: Number(match[1]),
      hts: match[2].replace(/[^0-9.]/g, ''),
      countryOfOrigin: match[3].toUpperCase(),
      customsValue: normalizeMoney(match[4]),
      dutiableValue: normalizeMoney(match[5]),
      dutyRate: match[6] ? (Number(match[6]) / 100).toFixed(4) : null,
      dutyPaid: match[7] ? normalizeMoney(match[7]) : null,
      rawLine: rawLine.trim(),
      confidenceBp: input.baseConfidenceBp,
      sourceKind: input.sourceKind,
    });
  }
  return lines;
}

/**
 * 抽取 CBP 7501 候选字段（纯函数）。
 * 注意：只会产出候选值；`customsTruthEligible` / `canonicalWriteAllowed` 恒为 false。
 */
export function extractCustoms7501Fields(input: {
  text: string;
  pages?: readonly string[];
  sourceFileSha256: string;
  sourceKind: DocumentSourceKind;
  provider: string;
  providerVersion: string;
  ocrConfidenceBp?: number;
  lowConfidenceBp?: number;
  now?: Date;
}): Customs7501Extraction {
  const lowConfidenceBp = input.lowConfidenceBp ?? DEFAULT_7501_LOW_CONFIDENCE_BP;
  const pages = input.pages && input.pages.length > 0 ? input.pages : [input.text];
  const baseConfidenceBp =
    input.sourceKind === 'STRUCTURED'
      ? MAX_7501_CANDIDATE_CONFIDENCE_BP
      : input.sourceKind === 'NATIVE_TEXT'
        ? 9_000
        : Math.min(input.ocrConfidenceBp ?? DEFAULT_7501_OCR_CONFIDENCE_BP, MAX_7501_OCR_CANDIDATE_CONFIDENCE_BP);

  const candidates: CustomsFieldCandidate[] = [];
  for (const rule of CUSTOMS_7501_FIELD_RULES) {
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const match = rule.pattern.exec(pages[pageIndex]);
      if (!match) continue;
      const rawValue = (match[1] ?? match[0]).trim();
      const normalizedValue = rule.normalize(rawValue);
      candidates.push({
        field: rule.field,
        rawValue,
        normalizedValue,
        page: input.sourceKind === 'STRUCTURED' ? null : pageIndex + 1,
        boundingBox: null,
        confidenceBp: Math.max(0, Math.min(MAX_7501_OCR_CANDIDATE_CONFIDENCE_BP, baseConfidenceBp)),
        sourceKind: input.sourceKind,
        provider: input.provider,
        providerVersion: input.providerVersion,
        sourceFileSha256: input.sourceFileSha256,
        lineNumber: null,
      });
    }
  }

  const lines = extractCustomsEntryLines({
    text: input.text,
    sourceKind: input.sourceKind,
    baseConfidenceBp,
  });

  const reasons: string[] = [];
  const presentCriticalFields = CUSTOMS_7501_CRITICAL_FIELDS.filter((field) =>
    candidates.some((candidate) => candidate.field === field),
  );
  const missingCriticalFields = CUSTOMS_7501_CRITICAL_FIELDS.filter(
    (field) => !presentCriticalFields.includes(field),
  );
  if (missingCriticalFields.length > 0) {
    reasons.push('MISSING_CRITICAL_FIELDS:' + missingCriticalFields.join(','));
  }

  const criticalLowConfidence = CUSTOMS_7501_CRITICAL_FIELDS.filter((field) =>
    candidates.some((candidate) => candidate.field === field && candidate.confidenceBp < lowConfidenceBp),
  );
  if (criticalLowConfidence.length > 0) {
    reasons.push('LOW_CONFIDENCE_CRITICAL_FIELDS:' + criticalLowConfidence.join(','));
  }

  // 规范化失败（normalizedValue=null）也算不可用，需要人工
  const unnormalized = candidates.filter(
    (candidate) => candidate.normalizedValue === null && is7501CriticalField(candidate.field),
  );
  if (unnormalized.length > 0) {
    reasons.push('UNNORMALIZABLE_CRITICAL_FIELDS:' + unnormalized.map((c) => c.field).join(','));
  }

  const conflicts = detectCandidateConflicts(candidates);
  if (conflicts.length > 0) {
    reasons.push('CROSS_SOURCE_CONFLICT:' + conflicts.map((c) => c.field).join(','));
  }

  const ocrDerived = input.sourceKind === 'OCR_DERIVED';
  if (ocrDerived) reasons.push('OCR_DERIVED_REQUIRES_REVIEW');

  let status: Customs7501Extraction['status'];
  if (candidates.length === 0) {
    status = 'NO_CANDIDATES';
    reasons.push('NO_CANDIDATES_EXTRACTED');
  } else if (criticalLowConfidence.length > 0 || unnormalized.length > 0) {
    status = 'QUARANTINED';
  } else {
    status = 'EXTRACTED';
  }

  const requiresManualReview =
    status !== 'EXTRACTED' || ocrDerived || conflicts.length > 0 || missingCriticalFields.length > 0;

  const body = {
    version: CUSTOMS_7501_EXTRACTION_VERSION,
    sourceFileSha256: input.sourceFileSha256,
    sourceKind: input.sourceKind,
    status,
    candidates,
    lines,
    presentCriticalFields,
    missingCriticalFields,
    criticalLowConfidence,
    conflicts,
    requiresManualReview,
    customsTruthEligible: false as const,
    canonicalWriteAllowed: false as const,
    reasons,
    extractedAt: input.now ? input.now.toISOString() : null,
  };

  return {
    kind: 'CBP_7501_CANDIDATE_FIELDS',
    ...body,
    extractionDigest: digestOf(body),
  };
}

export const CUSTOMS_7501_EXTRACTION_BOUNDARY = {
  candidateOnly: true,
  customsTruthEligible: false,
  canonicalWriteAllowed: false,
  lowConfidenceQuarantines: true,
  ocrDownweighted: true,
  lastWriteWinsForbidden: true,
  forbidden: [
    'writing candidate values as canonical / customs truth',
    'treating OCR-derived numbers as authoritative duty amounts',
    'resolving conflicting values by last-write-wins',
    'deciding eligibility or recoverable amount from extracted fields',
    'fabricating missing fields',
  ],
} as const;

/** 边界断言：任何把候选值当成 Customs Truth / 允许直接写 Canonical 的记录都必须被拒绝 */
export function assertCandidateIsNotCustomsTruth(record: {
  customsTruthEligible?: boolean;
  canonicalWriteAllowed?: boolean;
}): void {
  if (record.customsTruthEligible === true || record.canonicalWriteAllowed === true) {
    throw new Customs7501ExtractionError(
      'CUSTOMS_7501_CANDIDATE_CANNOT_BE_CLAIMED_AS_TRUTH',
      '7501 抽取结果只是候选值，不能作为 Customs Truth，也不能直接写 Canonical。',
    );
  }
}

export function isCustoms7501Field(value: string): value is Customs7501Field {
  return (CUSTOMS_7501_FIELDS as readonly string[]).includes(value);
}
