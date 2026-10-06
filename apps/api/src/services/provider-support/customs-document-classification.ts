// CUSTOMS / DUTY RECOVERY — slice B-S2 — Customs 文档分类（只分类型，不判定任何权利）
// ---------------------------------------------------------------------------
// 职责：把一份文档（结构化文本 / PDF 原生文本 / OCR 文本 + 文件名）分类成 Customs 文档种类：
//   CBP_7501 / CBP_28 / CBP_29 / ACE_ENTRY_RECORD / BROKER_ENTRY_RECORD / DUTY_PAYMENT_RECORD /
//   COMMERCIAL_INVOICE / PURCHASE_INVOICE / PACKING_LIST / RETURN_RECORD / EXPORT_RECORD /
//   DESTRUCTION_RECORD / POD / POA / RULING / EXCLUSION_REFERENCE / REFUND_EVIDENCE /
//   TRACKING_CONFIRMATION / OTHER。
// 硬边界：
//   ① 只分类：不抽字段、不判定 eligibility / 可退金额 / successFee，也不写任何 Canonical / Customs Truth；
//   ② 证据不足 → OTHER（fail-closed），绝不猜；信息互相冲突 → 降级为歧义（封顶置信度 + 人工复核）；
//   ③ OCR 文本一律降权（≤6000bp）并标记人工复核；
//   ④ 9801 / 9802 是特别条款，**不是** drawback：出现此类 heading 且文本提到 drawback 时给出显式警示。

import { digestOf } from '../config-execution-durability/digests';
import { DOCUMENT_KINDS, type DocumentKind } from './document-types';

export const CUSTOMS_CLASSIFIER_VERSION = 'customs-document-classifier/v1';
export const CUSTOMS_CLASSIFICATION_CONFIDENCE_CAP_BP = 9_500;
export const CUSTOMS_OCR_CONFIDENCE_CAP_BP = 6_000;
export const CUSTOMS_AMBIGUOUS_CONFIDENCE_CAP_BP = 5_000;
export const CUSTOMS_FLOOR_CONFIDENCE_BP = 2_000;

/** 本模块可判定的 Customs 文档种类（= A-S6 的文档种类全集，逐类都有规则） */
export const CUSTOMS_DOCUMENT_KINDS: readonly DocumentKind[] = [
  'CBP_7501',
  'CBP_28',
  'CBP_29',
  'ACE_ENTRY_RECORD',
  'BROKER_ENTRY_RECORD',
  'DUTY_PAYMENT_RECORD',
  'COMMERCIAL_INVOICE',
  'PURCHASE_INVOICE',
  'PACKING_LIST',
  'RETURN_RECORD',
  'EXPORT_RECORD',
  'DESTRUCTION_RECORD',
  'POD',
  'POA',
  'RULING',
  'EXCLUSION_REFERENCE',
  'REFUND_EVIDENCE',
  'TRACKING_CONFIRMATION',
  'OTHER',
];

/** 文本信号（单一事实来源：规则与特殊 heading 检测共用） */
export const CUSTOMS_TEXT_SIGNALS: Record<string, RegExp> = {
  FORM_7501: /\b7501\b/i,
  CBP_FORM_7501: /cbp\s*form\s*7501/i,
  ENTRY_SUMMARY: /entry\s+summary/i,
  CUSTOMS_VALUE: /customs\s*value|entered\s*value/i,
  ENTRY_DATE: /entry\s+date/i,
  DUTY_AMOUNT: /total\s*duty|duty\s*paid|duty\s*amount/i,
  FORM_28: /\bcf\s?-?28\b|cbp\s*form\s*28|\bform\s*28\b/i,
  REQUEST_FOR_INFORMATION: /request\s+for\s+information/i,
  FORM_29: /\bcf\s?-?29\b|cbp\s*form\s*29|\bform\s*29\b/i,
  NOTICE_OF_ACTION: /notice\s+of\s+action/i,
  ACE_ENTRY: /ace\s+entry/i,
  ENTRY_RECORD: /entry\s+record/i,
  ENTRY_NUMBER: /entry\s*(?:number|no\.?)/i,
  BROKER_ENTRY: /broker\s+entry/i,
  BROKER_REFERENCE: /broker\s+(?:reference|record|file)/i,
  DUTY_PAYMENT: /duty\s+payment|payment\s+of\s+duties/i,
  DUTY_STATEMENT: /duty\s+statement/i,
  DUTIES_PAID: /duties\s+paid/i,
  COMMERCIAL_INVOICE: /commercial\s+invoice/i,
  INVOICE_WORD: /\binvoice\b/i,
  INVOICE_NO: /invoice\s*(?:number|no\.?)/i,
  PURCHASE_INVOICE: /purchase\s+invoice/i,
  VENDOR_INVOICE: /vendor\s+invoice|supplier\s+invoice/i,
  PACKING_LIST: /packing\s+list/i,
  RETURN_RECORD: /return\s+record|return\s+receipt/i,
  RETURN_AUTHORIZATION: /return\s+authorization|\brma\b/i,
  EXPORT_RECORD: /export\s+record/i,
  EXPORT_DECLARATION: /export\s+declaration|export\s+manifest/i,
  DESTRUCTION_CERTIFICATE: /destruction\s+certificate|certificate\s+of\s+destruction/i,
  DESTRUCTION_RECORD: /destruction\s+record/i,
  POD_WORD: /\bpod\b/i,
  PROOF_OF_DELIVERY: /proof\s+of\s+delivery/i,
  DELIVERY_RECEIPT: /delivery\s+receipt/i,
  POWER_OF_ATTORNEY: /power\s+of\s+attorney/i,
  FORM_5291: /form\s*5291/i,
  POA_WORD: /\bpoa\b/i,
  RULING_WORD: /customs\s+ruling|\bruling\b/i,
  RULING_NUMBER: /\b(?:ny|n)\s?\d{6}\b/i,
  SECTION_301: /section\s+301/i,
  EXCLUSION_ORDER: /exclusion\s+order|product\s+exclusion/i,
  HEADING_9903: /\b9903\./i,
  DRAWBACK: /drawback/i,
  DUTY_REFUND: /duty\s+refund|refund\s+of\s+duties/i,
  REFUND_WORD: /\brefund\b/i,
  TRACKING_WORD: /\btracking\b/i,
  DELIVERY_CONFIRMATION: /delivery\s+confirmation|tracking\s+number/i,
};

interface CustomsClassificationRule {
  id: string;
  kind: DocumentKind;
  /** 至少命中其一 → 得基础分 2；否则该规则不成立 */
  required: readonly string[];
  /** 每命中一个 +1 分 */
  optional: readonly string[];
  /** 命中任一 → 该规则被否决（用于互斥消歧） */
  vetoIf?: readonly string[];
}

/**
 * 规则表：required 命中是**必要条件**（fail-closed），vetoIf 用于互斥消歧。
 * 例：出现 7501 时，ACE / Broker entry record 一律让位。
 */
export const CUSTOMS_CLASSIFICATION_RULES: readonly CustomsClassificationRule[] = [
  {
    id: 'CBP_7501_FORM',
    kind: 'CBP_7501',
    required: ['FORM_7501', 'CBP_FORM_7501'],
    optional: ['ENTRY_SUMMARY', 'CUSTOMS_VALUE', 'ENTRY_DATE', 'DUTY_AMOUNT'],
  },
  {
    id: 'CBP_28_RFI',
    kind: 'CBP_28',
    required: ['FORM_28'],
    optional: ['REQUEST_FOR_INFORMATION', 'ENTRY_NUMBER'],
  },
  {
    id: 'CBP_29_NOTICE',
    kind: 'CBP_29',
    required: ['FORM_29'],
    optional: ['NOTICE_OF_ACTION', 'ENTRY_NUMBER'],
  },
  {
    id: 'ACE_ENTRY',
    kind: 'ACE_ENTRY_RECORD',
    // 必须有 ACE 专属锚点（"entry record" 会出现在 broker record 里，不能作为必要条件）
    required: ['ACE_ENTRY'],
    optional: ['ENTRY_RECORD', 'ENTRY_NUMBER', 'ENTRY_SUMMARY'],
    // ACE 是权威系统记录，Broker 记录是其衍生件 → 两者同时出现时 ACE 胜出
    vetoIf: ['FORM_7501'],
  },
  {
    id: 'BROKER_ENTRY',
    kind: 'BROKER_ENTRY_RECORD',
    required: ['BROKER_ENTRY', 'BROKER_REFERENCE'],
    optional: ['ENTRY_NUMBER'],
    vetoIf: ['FORM_7501', 'ACE_ENTRY'],
  },
  {
    id: 'DUTY_PAYMENT',
    kind: 'DUTY_PAYMENT_RECORD',
    required: ['DUTY_PAYMENT', 'DUTY_STATEMENT', 'DUTIES_PAID'],
    optional: ['DUTY_AMOUNT', 'ENTRY_NUMBER'],
  },
  {
    id: 'COMMERCIAL_INVOICE',
    kind: 'COMMERCIAL_INVOICE',
    required: ['COMMERCIAL_INVOICE'],
    optional: ['INVOICE_NO', 'INVOICE_WORD'],
  },
  {
    id: 'PURCHASE_INVOICE',
    kind: 'PURCHASE_INVOICE',
    required: ['PURCHASE_INVOICE', 'VENDOR_INVOICE'],
    optional: ['INVOICE_NO', 'INVOICE_WORD'],
  },
  {
    id: 'PACKING_LIST',
    kind: 'PACKING_LIST',
    required: ['PACKING_LIST'],
    optional: ['INVOICE_WORD'],
  },
  {
    id: 'RETURN_RECORD',
    kind: 'RETURN_RECORD',
    required: ['RETURN_RECORD', 'RETURN_AUTHORIZATION'],
    optional: ['TRACKING_WORD'],
  },
  {
    id: 'EXPORT_RECORD',
    kind: 'EXPORT_RECORD',
    required: ['EXPORT_RECORD', 'EXPORT_DECLARATION'],
    optional: ['ENTRY_NUMBER', 'TRACKING_WORD'],
  },
  {
    id: 'DESTRUCTION_RECORD',
    kind: 'DESTRUCTION_RECORD',
    required: ['DESTRUCTION_CERTIFICATE', 'DESTRUCTION_RECORD'],
    optional: ['RETURN_RECORD'],
  },
  {
    id: 'POD',
    kind: 'POD',
    required: ['PROOF_OF_DELIVERY', 'POD_WORD', 'DELIVERY_RECEIPT'],
    optional: ['TRACKING_WORD', 'DELIVERY_CONFIRMATION'],
  },
  {
    id: 'POA',
    kind: 'POA',
    required: ['POWER_OF_ATTORNEY', 'FORM_5291', 'POA_WORD'],
    optional: ['ENTRY_NUMBER'],
  },
  {
    id: 'RULING',
    kind: 'RULING',
    required: ['RULING_WORD', 'RULING_NUMBER'],
    optional: ['HEADING_9903'],
  },
  {
    id: 'EXCLUSION_REFERENCE',
    kind: 'EXCLUSION_REFERENCE',
    required: ['SECTION_301', 'EXCLUSION_ORDER', 'HEADING_9903'],
    optional: ['ENTRY_NUMBER'],
  },
  {
    id: 'REFUND_EVIDENCE',
    kind: 'REFUND_EVIDENCE',
    required: ['DRAWBACK', 'DUTY_REFUND', 'REFUND_WORD'],
    optional: ['HEADING_9903', 'ENTRY_NUMBER'],
  },
  {
    id: 'TRACKING_CONFIRMATION',
    kind: 'TRACKING_CONFIRMATION',
    required: ['DELIVERY_CONFIRMATION'],
    optional: ['TRACKING_WORD'],
  },
];

export interface CustomsClassificationAlternative {
  documentKind: DocumentKind;
  ruleId: string;
  score: number;
  matchedSignals: string[];
}

export interface CustomsSpecialHeadings {
  /** 文本中出现的特别条款 heading（如 9801 / 9802） */
  headings: string[];
  drawbackSignals: string[];
  /** 出现 9801/9802 又提到 drawback 时的显式警示 */
  nonDrawbackHeadsUp: string | null;
}

export interface CustomsDocumentClassification {
  kind: 'CUSTOMS_DOCUMENT_CLASSIFICATION';
  version: string;
  documentKind: DocumentKind;
  confidenceBp: number;
  matchedSignals: string[];
  alternatives: CustomsClassificationAlternative[];
  specialHeadings: CustomsSpecialHeadings;
  reasons: string[];
  requiresManualReview: boolean;
  /** 分类只是「候选类型」，永远不是 Customs Truth */
  customsTruthEligible: false;
  canDecideEligibility: false;
  sourceTextFromOcr: boolean;
  classifiedAt: string | null;
  classificationDigest: string;
}

export type CustomsClassificationErrorCode = 'CUSTOMS_CLASSIFICATION_CANNOT_BE_TRUTH';

export class CustomsClassificationError extends Error {
  readonly code: CustomsClassificationErrorCode;

  constructor(code: CustomsClassificationErrorCode, message: string) {
    super(message);
    this.name = 'CustomsClassificationError';
    this.code = code;
  }
}

function matchedSignalIds(haystack: string): Set<string> {
  const matched = new Set<string>();
  for (const [id, pattern] of Object.entries(CUSTOMS_TEXT_SIGNALS)) {
    if (pattern.test(haystack)) matched.add(id);
  }
  return matched;
}

/** 特别 heading 检测：9801 / 9802 是特别条款，**不是** drawback */
export function detectCustomsSpecialHeadings(haystack: string): CustomsSpecialHeadings {
  const headings: string[] = [];
  if (/\b9801\b/.test(haystack)) headings.push('9801');
  if (/\b9802\b/.test(haystack)) headings.push('9802');
  const drawbackSignals = ['DRAWBACK', 'DUTY_REFUND', 'REFUND_WORD'].filter((id) =>
    CUSTOMS_TEXT_SIGNALS[id].test(haystack),
  );
  const nonDrawbackHeadsUp =
    headings.length > 0 && drawbackSignals.length > 0 ? 'HTS_9801_9802_ARE_NOT_DRAWBACK' : null;
  return { headings, drawbackSignals, nonDrawbackHeadsUp };
}

/**
 * Customs 文档分类（纯函数，可单测）。默认 fail-closed：证据不足 → OTHER。
 */
export function classifyCustomsDocument(input: {
  filename?: string | null;
  text: string;
  textFromOcr?: boolean;
  maxConfidenceBp?: number;
  now?: Date;
}): CustomsDocumentClassification {
  const haystack = `${input.filename ?? ''}\n${input.text}`;
  const matched = matchedSignalIds(haystack);

  const qualified: CustomsClassificationAlternative[] = [];
  for (const rule of CUSTOMS_CLASSIFICATION_RULES) {
    const requiredHit = rule.required.some((id) => matched.has(id));
    if (!requiredHit) continue;
    const vetoed = (rule.vetoIf ?? []).some((id) => matched.has(id));
    if (vetoed) continue;
    const optionalMatched = rule.optional.filter((id) => matched.has(id));
    const score = 2 + optionalMatched.length;
    qualified.push({
      documentKind: rule.kind,
      ruleId: rule.id,
      score,
      matchedSignals: [...rule.required.filter((id) => matched.has(id)), ...optionalMatched],
    });
  }

  qualified.sort((a, b) => (b.score - a.score) || (a.documentKind < b.documentKind ? -1 : 1));

  const reasons: string[] = [];
  const specialHeadings = detectCustomsSpecialHeadings(haystack);
  const textFromOcr = input.textFromOcr === true;

  if (qualified.length === 0) {
    reasons.push('NO_RULE_MATCHED');
    if (specialHeadings.nonDrawbackHeadsUp) reasons.push(specialHeadings.nonDrawbackHeadsUp);
    const body = {
      version: CUSTOMS_CLASSIFIER_VERSION,
      documentKind: 'OTHER' as DocumentKind,
      confidenceBp: CUSTOMS_FLOOR_CONFIDENCE_BP,
      matchedSignals: [] as string[],
      alternatives: [] as CustomsClassificationAlternative[],
      specialHeadings,
      reasons,
      requiresManualReview: true,
      customsTruthEligible: false as const,
      canDecideEligibility: false as const,
      sourceTextFromOcr: textFromOcr,
      classifiedAt: input.now ? input.now.toISOString() : null,
    };
    return {
      kind: 'CUSTOMS_DOCUMENT_CLASSIFICATION',
      ...body,
      classificationDigest: digestOf(body),
    };
  }

  const best = qualified[0];
  const tied = qualified.filter((candidate) => candidate.score === best.score);
  const ambiguous = tied.length > 1;

  reasons.push(`RULE_${best.ruleId}_MATCHED`);
  if (ambiguous) {
    reasons.push('AMBIGUOUS_BETWEEN_' + tied.map((t) => t.documentKind).join('_'));
  }
  if (textFromOcr) reasons.push('TEXT_FROM_OCR_DOWNWEIGHTED');
  if (specialHeadings.nonDrawbackHeadsUp) reasons.push(specialHeadings.nonDrawbackHeadsUp);

  let confidenceBp = Math.min(CUSTOMS_CLASSIFICATION_CONFIDENCE_CAP_BP, 4_000 + best.score * 1_500);
  if (ambiguous) confidenceBp = Math.min(confidenceBp, CUSTOMS_AMBIGUOUS_CONFIDENCE_CAP_BP);
  if (textFromOcr) confidenceBp = Math.min(confidenceBp, CUSTOMS_OCR_CONFIDENCE_CAP_BP);
  confidenceBp = Math.min(confidenceBp, input.maxConfidenceBp ?? CUSTOMS_CLASSIFICATION_CONFIDENCE_CAP_BP);

  const requiresManualReview =
    ambiguous || textFromOcr || specialHeadings.nonDrawbackHeadsUp !== null;

  const body = {
    version: CUSTOMS_CLASSIFIER_VERSION,
    documentKind: best.documentKind,
    confidenceBp,
    matchedSignals: best.matchedSignals,
    alternatives: qualified.slice(0, 5),
    specialHeadings,
    reasons,
    requiresManualReview,
    customsTruthEligible: false as const,
    canDecideEligibility: false as const,
    sourceTextFromOcr: textFromOcr,
    classifiedAt: input.now ? input.now.toISOString() : null,
  };

  return {
    kind: 'CUSTOMS_DOCUMENT_CLASSIFICATION',
    ...body,
    classificationDigest: digestOf(body),
  };
}

export const CUSTOMS_CLASSIFICATION_BOUNDARY = {
  classificationOnly: true,
  ocrIsNotCustomsTruth: true,
  llmCannotDecideEligibility: true,
  extractsFields: false,
  writesCanonicalTruth: false,
  computesRecoverableAmount: false,
  determinesSuccessFeeEligibility: false,
  failClosedOnInsufficientEvidence: true,
  forbidden: [
    'treating a classification as Customs Truth',
    'deciding eligibility / recoverable amount / successFeeEligible from classification',
    'treating OCR text as authoritative',
    'treating HTS 9801 / 9802 as drawback',
    'persisting a classification as a canonical fact',
  ],
} as const;

/** 边界断言：任何把分类结果当成 Customs Truth / 可判定 eligibility 的记录都必须被拒绝 */
export function assertClassificationIsNotCustomsTruth(record: {
  customsTruthEligible?: boolean;
  canDecideEligibility?: boolean;
}): void {
  if (record.customsTruthEligible === true || record.canDecideEligibility === true) {
    throw new CustomsClassificationError(
      'CUSTOMS_CLASSIFICATION_CANNOT_BE_TRUTH',
      '文档分类只是候选类型，不能成为 Customs Truth，也不能决定 eligibility。',
    );
  }
}

export function isCustomsDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}
