// CUSTOMS / DOCUMENT INTELLIGENCE（slice A-S6 / B-S1）—— 文档摄取编排（端口注入、无真实网络/无收费 OCR）
// ---------------------------------------------------------------------------
// 优先级：CSV/XLSX/JSON 原生结构化 → PDF 文字层 → OCR fallback（仅扫描件/图片/文字层不足）。
// 绝不“所有 PDF 无脑走 OCR”；OCR 结果只产出 CandidateFact（sourceKind=OCR_DERIVED），且必须人工复核。

import { digestOf } from '../config-execution-durability/digests';
import { classifyDocument } from './document-classifier';
import {
  detectCandidateConflicts,
  extractCandidateFields,
  isCriticalField,
} from './field-extraction';
import {
  DOCUMENT_INGESTION_BOUNDARY,
  DocumentIngestionError,
  type CandidateField,
  type DocumentIngestionResult,
  type DocumentInput,
  type DocumentSourceKind,
  type ExtractionStatus,
} from './document-types';
import { ocrFieldsToCandidates, type OcrProviderPort } from './ocr-provider';

export const DOCUMENT_INGESTION_VERSION = 'document-ingestion/v1';
export const DEFAULT_NATIVE_TEXT_MIN_CHARS_PER_PAGE = 200;
export const DEFAULT_LOW_CONFIDENCE_BP = 6_000;

export interface PdfTextExtractorPort {
  readonly extractorId: string;
  readonly extractorVersion: string;
  extract(input: { fileAssetId: string; sha256: string; bytes?: Uint8Array }): Promise<{
    pages: ReadonlyArray<{ page: number; text: string }>;
  }>;
}

export interface DocumentIngestionDeps {
  pdfTextExtractor?: PdfTextExtractorPort;
  ocrProvider?: OcrProviderPort;
  now?: () => Date;
  nativeTextMinCharsPerPage?: number;
  lowConfidenceBp?: number;
}

function mediaCategory(mimeType: string): 'STRUCTURED' | 'PDF' | 'IMAGE' | 'UNSUPPORTED' {
  const mime = mimeType.toLowerCase();
  if (mime === 'text/csv' || mime.includes('spreadsheet') || mime === 'application/json' || mime.includes('excel')) {
    return 'STRUCTURED';
  }
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/tiff') return 'IMAGE';
  return 'UNSUPPORTED';
}

function structuredRowsToText(rows: ReadonlyArray<Record<string, string>>): string {
  return rows
    .slice(0, 500)
    .map((row) =>
      Object.entries(row)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(' | '),
    )
    .join('\n');
}

function pagesCharDensity(pages: ReadonlyArray<{ text: string }>): number {
  if (pages.length === 0) return 0;
  const total = pages.reduce((sum, p) => sum + p.text.replace(/\s+/g, ' ').trim().length, 0);
  return total / pages.length;
}

export function createThrowingPdfExtractor(message = 'PDF 文字层抽取器未注入'): PdfTextExtractorPort {
  return {
    extractorId: 'pdf:unconfigured',
    extractorVersion: 'n/a',
    async extract() {
      throw new DocumentIngestionError('DOCUMENT_PDF_EXTRACTOR_REQUIRED', message);
    },
  };
}

export function createMockPdfExtractor(
  pages: ReadonlyArray<{ page: number; text: string }>,
): PdfTextExtractorPort {
  return {
    extractorId: 'pdf:mock',
    extractorVersion: 'mock/v1',
    async extract() {
      return { pages };
    },
  };
}

/** 摄取一份文档：按优先级选择结构化 / 原生文本 / OCR，并输出候选字段（永不是真值）。 */
export async function ingestDocument(
  document: DocumentInput,
  deps: DocumentIngestionDeps = {},
): Promise<DocumentIngestionResult> {
  const now = deps.now ?? (() => new Date());
  const lowConfidenceBp = deps.lowConfidenceBp ?? DEFAULT_LOW_CONFIDENCE_BP;
  const minChars = deps.nativeTextMinCharsPerPage ?? DEFAULT_NATIVE_TEXT_MIN_CHARS_PER_PAGE;
  const category = mediaCategory(document.mimeType);

  if (category === 'UNSUPPORTED') {
    throw new DocumentIngestionError(
      'DOCUMENT_UNSUPPORTED_MEDIA_TYPE',
      `不支持的媒体类型：${document.mimeType}`,
    );
  }

  let status: ExtractionStatus = 'EXTRACTED';
  let sourceKind: DocumentSourceKind | null = null;
  let parserProvider = 'n/a';
  let parserVersion = 'n/a';
  let ocrProviderId: string | null = null;
  let candidateFields: CandidateField[] = [];
  let text = '';
  let pageCount: number | null = document.pageCount ?? null;
  const reasons: string[] = [];

  if (category === 'STRUCTURED' || document.structured) {
    if (!document.structured) {
      throw new DocumentIngestionError(
        'DOCUMENT_MALFORMED_STRUCTURED_CONTENT',
        '结构化文档必须由调用方提供 structured rows（本单元不解析二进制表格）',
      );
    }
    sourceKind = 'STRUCTURED';
    parserProvider = `structured:${document.structured.format.toLowerCase()}`;
    parserVersion = DOCUMENT_INGESTION_VERSION;
    text = structuredRowsToText(document.structured.rows);
    pageCount = null;
    candidateFields = extractCandidateFields({
      text,
      sourceFileSha256: document.sha256,
      sourceKind: 'STRUCTURED',
      provider: parserProvider,
      providerVersion: parserVersion,
    });
  } else if (category === 'PDF') {
    const extractor = deps.pdfTextExtractor;
    let pages: ReadonlyArray<{ page: number; text: string }> | null = null;
    if (document.nativeText) {
      pages = document.nativeText.pages;
      parserProvider = document.nativeText.extractorId;
      parserVersion = document.nativeText.extractorVersion;
    } else if (extractor) {
      const extracted = await extractor.extract({
        fileAssetId: document.fileAssetId,
        sha256: document.sha256,
        ...(document.binaryBytes ? { bytes: document.binaryBytes } : {}),
      });
      pages = extracted.pages;
      parserProvider = extractor.extractorId;
      parserVersion = extractor.extractorVersion;
    }
    const density = pages ? pagesCharDensity(pages) : 0;
    pageCount = pages?.length ?? pageCount;
    if (pages && density >= minChars) {
      sourceKind = 'NATIVE_TEXT';
      text = pages.map((p) => p.text).join('\n\f\n');
      candidateFields = extractCandidateFields({
        text,
        pages: pages.map((p) => p.text),
        sourceFileSha256: document.sha256,
        sourceKind: 'NATIVE_TEXT',
        provider: parserProvider,
        providerVersion: parserVersion,
      });
      reasons.push('NATIVE_TEXT_LAYER_USED');
    } else {
      reasons.push(pages ? 'NATIVE_TEXT_LAYER_INSUFFICIENT' : 'NO_PDF_TEXT_EXTRACTOR');
      const ocr = await runOcr(document, deps, reasons);
      status = ocr.status;
      sourceKind = ocr.sourceKind;
      ocrProviderId = ocr.ocrProvider;
      candidateFields = ocr.candidateFields;
      text = ocr.text;
      parserProvider = ocr.ocrProvider ?? parserProvider;
      parserVersion = ocr.parserVersion ?? parserVersion;
    }
  } else {
    // 图片：必须 OCR
    const ocr = await runOcr(document, deps, reasons);
    status = ocr.status;
    sourceKind = ocr.sourceKind;
    ocrProviderId = ocr.ocrProvider;
    candidateFields = ocr.candidateFields;
    text = ocr.text;
    parserProvider = ocr.ocrProvider ?? 'ocr:unavailable';
    parserVersion = ocr.parserVersion ?? 'n/a';
  }

  const classification = classifyDocument({
    document,
    text,
    textFromOcr: sourceKind === 'OCR_DERIVED',
  });

  const conflicts = detectCandidateConflicts(candidateFields);
  if (conflicts.length > 0) {
    reasons.push('CROSS_SOURCE_CONFLICT:' + conflicts.map((c) => c.field).join(','));
  }
  const lowConfidenceCritical = candidateFields.filter(
    (c) => isCriticalField(c.field) && c.confidenceBp < lowConfidenceBp,
  );
  if (lowConfidenceCritical.length > 0) {
    reasons.push('LOW_CONFIDENCE_CRITICAL_FIELDS:' + lowConfidenceCritical.map((c) => c.field).join(','));
  }

  const ocrDerived = sourceKind === 'OCR_DERIVED';
  const requiresManualReview =
    ocrDerived || conflicts.length > 0 || lowConfidenceCritical.length > 0 || status !== 'EXTRACTED';
  if (lowConfidenceCritical.length > 0 && status === 'EXTRACTED') {
    status = 'QUARANTINED';
  }
  if (ocrDerived && status === 'EXTRACTED' && candidateFields.some((c) => isCriticalField(c.field))) {
    // OCR 出的关键字段必须人工复核（但不改变状态：置信度足够时允许 EXTRACTED + 人工复核标记）
    reasons.push('OCR_CRITICAL_FIELDS_REQUIRE_REVIEW');
  }

  const body = {
    version: DOCUMENT_INGESTION_VERSION,
    fileAssetId: document.fileAssetId,
    sha256: document.sha256,
    mimeType: document.mimeType,
    status,
    sourceKind,
    classification,
    candidateFields,
    pageCount,
    ocrProvider: ocrProviderId,
    parserProvider,
    parserVersion,
    reasons,
    requiresManualReview,
    ingestedAt: now().toISOString(),
    boundary: DOCUMENT_INGESTION_BOUNDARY.preferredOrder,
  };

  return {
    fileAssetId: document.fileAssetId,
    sha256: document.sha256,
    mimeType: document.mimeType,
    status,
    sourceKind,
    classification,
    candidateFields,
    pageCount,
    ocrProvider: ocrProviderId,
    parserProvider,
    parserVersion,
    reasons,
    requiresManualReview,
    ingestedAt: body.ingestedAt,
    resultDigest: digestOf(body),
  };
}

async function runOcr(
  document: DocumentInput,
  deps: DocumentIngestionDeps,
  reasons: string[],
): Promise<{
  status: ExtractionStatus;
  sourceKind: DocumentSourceKind | null;
  ocrProvider: string | null;
  parserVersion: string | null;
  candidateFields: CandidateField[];
  text: string;
}> {
  const provider = deps.ocrProvider;
  if (!provider) {
    reasons.push('OCR_PROVIDER_NOT_CONFIGURED_HOLD_EXTERNAL');
    return {
      status: 'OCR_DISABLED',
      sourceKind: null,
      ocrProvider: null,
      parserVersion: null,
      candidateFields: [],
      text: '',
    };
  }
  if (!document.binaryBytes) {
    reasons.push('OCR_REQUIRES_BINARY_BYTES');
    return {
      status: 'OCR_REQUIRED',
      sourceKind: null,
      ocrProvider: provider.providerId,
      parserVersion: provider.providerVersion,
      candidateFields: [],
      text: '',
    };
  }
  try {
    const result = await provider.recognize({
      fileAssetId: document.fileAssetId,
      sha256: document.sha256,
      mimeType: document.mimeType,
      bytes: document.binaryBytes,
      ...(document.pageCount !== undefined ? { pageCount: document.pageCount } : {}),
      fields: ['entryNumber', 'entryDate', 'hts', 'currency', 'dutyPaid', 'customsValue', 'invoiceNo', 'trackingNumber'],
    });
    const text = result.pages.map((p) => p.text).join('\n\f\n');
    const candidates = ocrFieldsToCandidates({ result, sourceFileSha256: document.sha256 });
    const textCandidates = text
      ? extractCandidateFields({
          text,
          pages: result.pages.map((p) => p.text),
          sourceFileSha256: document.sha256,
          sourceKind: 'OCR_DERIVED',
          provider: provider.providerId,
          providerVersion: provider.providerVersion,
        })
      : [];
    return {
      status: 'EXTRACTED',
      sourceKind: 'OCR_DERIVED',
      ocrProvider: provider.providerId,
      parserVersion: provider.providerVersion,
      candidateFields: [...candidates, ...textCandidates],
      text,
    };
  } catch (error) {
    reasons.push('OCR_FAILED:' + (error instanceof Error ? error.message : String(error)));
    return {
      status: 'QUARANTINED',
      sourceKind: null,
      ocrProvider: provider.providerId,
      parserVersion: provider.providerVersion,
      candidateFields: [],
      text: '',
    };
  }
}
