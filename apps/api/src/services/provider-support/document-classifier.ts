// CUSTOMS / DOCUMENT INTELLIGENCE —— 文档分类（规则优先；UNKNOWN 不猜 → OTHER + 低置信）

import {
  DOCUMENT_KINDS,
  type DocumentClassification,
  type DocumentInput,
  type DocumentKind,
} from './document-types';

export const DOCUMENT_CLASSIFIER_VERSION = 'document-classifier/v1';

/** 规则：{ kind, patterns, weight }；命中越多置信越高。文本来自文件名 + 原生文本（OCR 文本单独降权）。 */
const RULES: ReadonlyArray<{ kind: DocumentKind; patterns: readonly RegExp[] }> = [
  { kind: 'CBP_7501', patterns: [/\b7501\b/i, /entry summary/i, /customs entry summary/i] },
  { kind: 'CBP_28', patterns: [/\bcf\s?28\b/i, /cbp form 28/i] },
  { kind: 'CBP_29', patterns: [/\bcf\s?29\b/i, /cbp form 29/i] },
  { kind: 'ACE_ENTRY_RECORD', patterns: [/ace\s+entry/i, /entry\s+record/i, /entry number/i] },
  { kind: 'BROKER_ENTRY_RECORD', patterns: [/broker\s+entry/i, /broker\s+record/i] },
  { kind: 'DUTY_PAYMENT_RECORD', patterns: [/duty\s+payment/i, /duties\s+paid/i, /duty\s+statement/i] },
  { kind: 'COMMERCIAL_INVOICE', patterns: [/commercial\s+invoice/i, /\binvoice\b/i] },
  { kind: 'PURCHASE_INVOICE', patterns: [/purchase\s+invoice/i, /vendor\s+invoice/i] },
  { kind: 'PACKING_LIST', patterns: [/packing\s+list/i] },
  { kind: 'RETURN_RECORD', patterns: [/return\s+record/i, /return\s+authorization/i, /\brma\b/i] },
  { kind: 'EXPORT_RECORD', patterns: [/export\s+record/i, /export\s+declaration/i] },
  { kind: 'DESTRUCTION_RECORD', patterns: [/destruction\s+certificate/i, /destruction\s+record/i] },
  { kind: 'POD', patterns: [/proof\s+of\s+delivery/i, /\bpod\b/i, /delivery\s+receipt/i] },
  { kind: 'POA', patterns: [/power\s+of\s+attorney/i, /form\s+5291/i, /\bpoa\b/i] },
  { kind: 'RULING', patterns: [/ruling/i, /\bny\s?n?\d{6}\b/i] },
  { kind: 'EXCLUSION_REFERENCE', patterns: [/exclusion/i, /section\s+301/i, /9903\./i] },
  { kind: 'REFUND_EVIDENCE', patterns: [/refund/i, /drawback\s+payment/i] },
  { kind: 'TRACKING_CONFIRMATION', patterns: [/tracking/i, /delivery\s+confirmation/i] },
];

export function classifyDocument(input: {
  document: Pick<DocumentInput, 'filename'>;
  text: string;
  /** OCR 文本参与分类时整体降权（避免“OCR 说它是 7501”就当真） */
  textFromOcr?: boolean;
  maxConfidenceBp?: number;
}): DocumentClassification {
  const haystack = `${input.document.filename ?? ''}\n${input.text}`;
  const scores: Array<{ kind: DocumentKind; hits: number }> = [];
  for (const rule of RULES) {
    const hits = rule.patterns.filter((p) => p.test(haystack)).length;
    if (hits > 0) scores.push({ kind: rule.kind, hits });
  }
  if (scores.length === 0) {
    return { documentKind: 'OTHER', confidenceBp: 2_000, reasons: ['NO_RULE_MATCHED'] };
  }
  scores.sort((a, b) => (b.hits - a.hits) || (a.kind < b.kind ? -1 : 1));
  const best = scores[0];
  const tied = scores.filter((s) => s.hits === best.hits);
  let confidenceBp = Math.min(9_500, 4_000 + best.hits * 2_000);
  const reasons: string[] = [`RULE_HITS_${best.hits}`];
  if (tied.length > 1) {
    confidenceBp = Math.min(confidenceBp, 5_000);
    reasons.push('AMBIGUOUS_BETWEEN_' + tied.map((t) => t.kind).join('_'));
  }
  if (input.textFromOcr) {
    confidenceBp = Math.min(confidenceBp, 6_000);
    reasons.push('TEXT_FROM_OCR_DOWNWEIGHTED');
  }
  const cap = input.maxConfidenceBp ?? 9_500;
  return { documentKind: best.kind, confidenceBp: Math.min(confidenceBp, cap), reasons };
}

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}
