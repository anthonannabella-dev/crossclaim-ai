// CUSTOMS / DOCUMENT INTELLIGENCE（slice A-S6 / B-S1）—— 文档管线共享类型（纯模型，无 IO）
// ---------------------------------------------------------------------------
// 信任边界（HOST P5 / B-P4）：
//   STRUCTURED（CSV/XLSX/JSON 原生） > NATIVE_TEXT（PDF 文字层） > OCR_DERIVED（扫描件）
//   OCR 结果**永远**只是 CandidateFact，必须经 schema/跨源校验与 HITL 才能进入 Canonical/Customs Fact。

export const DOCUMENT_KINDS = [
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
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_SOURCE_KINDS = ['STRUCTURED', 'NATIVE_TEXT', 'OCR_DERIVED'] as const;
export type DocumentSourceKind = (typeof DOCUMENT_SOURCE_KINDS)[number];

export const EXTRACTION_STATUSES = [
  'EXTRACTED',
  'NO_TEXT_LAYER',
  'OCR_REQUIRED',
  'OCR_DISABLED',
  'UNSUPPORTED_MEDIA_TYPE',
  'QUARANTINED',
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export interface DocumentInput {
  /** 已在 FileAsset 中登记的文件身份 */
  fileAssetId: string;
  sha256: string;
  mimeType: string;
  byteSize?: number;
  /** 文件名（仅作分类提示，不作为可信依据） */
  filename?: string;
  /** 原生结构化内容（CSV / JSON / XLSX 解析结果，由调用方提供） */
  structured?: { format: 'CSV' | 'XLSX' | 'JSON'; rows: ReadonlyArray<Record<string, string>> };
  /** PDF 文字层抽取结果（由注入的 PdfTextExtractorPort 提供） */
  nativeText?: {
    pages: ReadonlyArray<{ page: number; text: string }>;
    extractorId: string;
    extractorVersion: string;
  } | null;
  /** 图片/扫描件的原始字节（仅交给 OCR port；不落库、不记录） */
  binaryBytes?: Uint8Array;
  pageCount?: number;
}

/** 候选字段（永不直接成为真值） */
export interface CandidateField {
  field: string;
  rawValue: string;
  normalizedValue: string | null;
  page: number | null;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  confidenceBp: number;
  sourceKind: DocumentSourceKind;
  provider: string;
  providerVersion: string;
  sourceFileSha256: string;
}

export interface DocumentClassification {
  documentKind: DocumentKind;
  confidenceBp: number;
  reasons: string[];
}

export interface DocumentIngestionResult {
  fileAssetId: string;
  sha256: string;
  mimeType: string;
  status: ExtractionStatus;
  sourceKind: DocumentSourceKind | null;
  classification: DocumentClassification;
  candidateFields: CandidateField[];
  pageCount: number | null;
  ocrProvider: string | null;
  parserProvider: string;
  parserVersion: string;
  reasons: string[];
  /** 是否必须人工复核（低置信 / OCR 关键字段 / 冲突） */
  requiresManualReview: boolean;
  ingestedAt: string;
  resultDigest: string;
}

export const DOCUMENT_INGESTION_BOUNDARY = {
  ocrIsNotCanonicalTruth: true,
  ocrProviderMustBeInjected: true,
  realOcrNetworkCalls: 'HOLD',
  forbidden: [
    'treating OCR output as canonical/customs truth',
    'enabling a paid OCR provider in this unit',
    'last-write-wins on conflicting extracted values',
    'persisting raw document bytes or credentials',
  ],
  preferredOrder: ['STRUCTURED', 'NATIVE_TEXT', 'OCR_DERIVED'],
} as const;

export type DocumentIngestionErrorCode =
  | 'DOCUMENT_UNSUPPORTED_MEDIA_TYPE'
  | 'DOCUMENT_OCR_PROVIDER_NOT_CONFIGURED'
  | 'DOCUMENT_OCR_FAILED'
  | 'DOCUMENT_MALFORMED_STRUCTURED_CONTENT'
  | 'DOCUMENT_PDF_EXTRACTOR_REQUIRED';

export class DocumentIngestionError extends Error {
  readonly code: DocumentIngestionErrorCode;

  constructor(code: DocumentIngestionErrorCode, message: string) {
    super(message);
    this.name = 'DocumentIngestionError';
    this.code = code;
  }
}

/** OCR 结果禁止直写真值：任何“把 OCR 当 truth”的调用都必须 fail-closed。 */
export function assertOcrCandidateNotCanonical(candidate: CandidateField): void {
  if (candidate.sourceKind === 'OCR_DERIVED' && candidate.confidenceBp >= 10_000) {
    throw new DocumentIngestionError(
      'DOCUMENT_OCR_FAILED',
      'OCR 候选不得被标记为满置信（禁止把 OCR 结果当作真值）',
    );
  }
}
