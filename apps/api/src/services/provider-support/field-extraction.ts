// CUSTOMS / DOCUMENT INTELLIGENCE —— 通用候选字段抽取（rawValue/normalizedValue/置信度/来源，永不是真值）

import type { CandidateField, DocumentSourceKind } from './document-types';

export const FIELD_EXTRACTION_VERSION = 'field-extraction/v1';

export interface FieldRule {
  field: string;
  pattern: RegExp;
  normalize?: (raw: string) => string | null;
  /** 关键字段：低置信必须进人工复核 */
  critical?: boolean;
}

export const CRITICAL_FIELDS = [
  'entryNumber',
  'invoiceNo',
  'dutyPaid',
  'customsValue',
  'totalValue',
  'hts',
  'quantity',
  'currency',
  'trackingNumber',
  'entryDate',
] as const;

const MONEY = /^\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,6})?)$/;

export const DEFAULT_FIELD_RULES: readonly FieldRule[] = [
  {
    field: 'entryNumber',
    pattern: /(?:entry\s*(?:number|no\.?)|entry#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,20})/i,
    normalize: (raw) => raw.toUpperCase().replace(/\s+/g, ''),
    critical: true,
  },
  {
    field: 'entryDate',
    pattern: /(?:entry\s*date)\s*[:#]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    normalize: (raw) => raw.replace(/\//g, '-'),
    critical: true,
  },
  {
    field: 'hts',
    pattern: /(?:hts(?:us)?|hs\s*code)\s*[:#]?\s*(\d{4}\.\d{2}(?:\.\d{2,4})?|\d{8,10})/i,
    normalize: (raw) => raw.replace(/[^0-9.]/g, ''),
    critical: true,
  },
  {
    field: 'currency',
    pattern: /\b(USD|EUR|JPY|CNY|GBP|CAD|AUD)\b/,
    normalize: (raw) => raw.toUpperCase(),
    critical: true,
  },
  {
    field: 'dutyPaid',
    pattern: /(?:duty\s*(?:paid|amount)|total\s*duty)\s*[:#]?\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?)/i,
    normalize: (raw) => {
      const m = MONEY.exec(raw.trim());
      return m ? m[1].replace(/,/g, '') : null;
    },
    critical: true,
  },
  {
    field: 'customsValue',
    pattern: /(?:customs\s*value|entered\s*value)\s*[:#]?\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?)/i,
    normalize: (raw) => {
      const m = MONEY.exec(raw.trim());
      return m ? m[1].replace(/,/g, '') : null;
    },
    critical: true,
  },
  {
    field: 'invoiceNo',
    pattern: /(?:invoice\s*(?:number|no\.?)|inv#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,30})/i,
    normalize: (raw) => raw.toUpperCase().replace(/\s+/g, ''),
    critical: true,
  },
  {
    field: 'trackingNumber',
    pattern: /\b(1Z[0-9A-Z]{10,}|[A-Z]{2}\d{9}[A-Z]{2}|\d{12,22})\b/,
    normalize: (raw) => raw.toUpperCase(),
    critical: true,
  },
  {
    field: 'portOfEntry',
    pattern: /(?:port\s*of\s*entry|port)\s*[:#]?\s*([A-Z]{3,5}|\d{4})/i,
    normalize: (raw) => raw.toUpperCase(),
  },
];

const BBOX_UNSUPPORTED = null;

/** 从文本中抽取候选字段（结构化/原生文本置信高；OCR 来源整体降权）。 */
export function extractCandidateFields(input: {
  text: string;
  pages?: readonly string[];
  sourceFileSha256: string;
  sourceKind: DocumentSourceKind;
  provider: string;
  providerVersion: string;
  rules?: readonly FieldRule[];
  baseConfidenceBp?: number;
  ocrConfidenceBp?: number;
}): CandidateField[] {
  const rules = input.rules ?? DEFAULT_FIELD_RULES;
  const pages = input.pages && input.pages.length > 0 ? input.pages : [input.text];
  const base =
    input.sourceKind === 'STRUCTURED'
      ? (input.baseConfidenceBp ?? 9_500)
      : input.sourceKind === 'NATIVE_TEXT'
        ? (input.baseConfidenceBp ?? 9_000)
        : Math.min(input.ocrConfidenceBp ?? 6_500, 9_900);
  const out: CandidateField[] = [];
  for (const rule of rules) {
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const match = rule.pattern.exec(pages[pageIndex]);
      if (!match) continue;
      const rawValue = (match[1] ?? match[0]).trim();
      const normalizedValue = rule.normalize ? rule.normalize(rawValue) : rawValue;
      out.push({
        field: rule.field,
        rawValue,
        normalizedValue,
        page: input.sourceKind === 'STRUCTURED' ? null : pageIndex + 1,
        boundingBox: BBOX_UNSUPPORTED,
        confidenceBp: Math.max(0, Math.min(9_900, base)),
        sourceKind: input.sourceKind,
        provider: input.provider,
        providerVersion: input.providerVersion,
        sourceFileSha256: input.sourceFileSha256,
      });
      break; // 每字段每文档取首个命中（后续冲突由跨源校验处理）
    }
  }
  return out;
}

export function isCriticalField(field: string): boolean {
  return (CRITICAL_FIELDS as readonly string[]).includes(field);
}

/** 跨源冲突检测：同字段出现 ≥2 个不同 normalizedValue → CONFLICT（禁止 last-write-wins）。 */
export function detectCandidateConflicts(candidates: readonly CandidateField[]): Array<{
  field: string;
  values: string[];
  sources: string[];
}> {
  const byField = new Map<string, Map<string, Set<string>>>();
  for (const candidate of candidates) {
    const value = (candidate.normalizedValue ?? candidate.rawValue).trim();
    if (value.length === 0) continue;
    if (!byField.has(candidate.field)) byField.set(candidate.field, new Map());
    const bucket = byField.get(candidate.field) as Map<string, Set<string>>;
    if (!bucket.has(value)) bucket.set(value, new Set());
    (bucket.get(value) as Set<string>).add(`${candidate.sourceKind}:${candidate.provider}`);
  }
  const conflicts: Array<{ field: string; values: string[]; sources: string[] }> = [];
  for (const [field, bucket] of byField) {
    if (bucket.size > 1) {
      conflicts.push({
        field,
        values: [...bucket.keys()].sort(),
        sources: [...new Set([...bucket.values()].flatMap((s) => [...s]))].sort(),
      });
    }
  }
  return conflicts;
}
