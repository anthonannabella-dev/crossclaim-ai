// CUSTOMS / DOCUMENT INTELLIGENCE — slice A-S6 / B-S1 单元与回归测试
// ---------------------------------------------------------------------------
// 覆盖：摄取优先级（STRUCTURED > NATIVE_TEXT > OCR_DERIVED）、OCR 回退、
// 关键字段低置信 → 隔离/HITL、跨源冲突 → CONFLICT（禁 last-write-wins）、
// 不支持媒体类型 fail-closed、OCR 置信上限、确定性摘要、以及「OCR ≠ Canonical Truth」长期安全断言。

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  CRITICAL_FIELDS,
  DOCUMENT_INGESTION_BOUNDARY,
  DEFAULT_FIELD_RULES,
  DocumentIngestionError,
  assertOcrCandidateNotCanonical,
  classifyDocument,
  createDisabledOcrProvider,
  createMockOcrProvider,
  createMockPdfExtractor,
  createThrowingPdfExtractor,
  detectCandidateConflicts,
  extractCandidateFields,
  ingestDocument,
  isCriticalField,
  ocrFieldsToCandidates,
  type CandidateField,
  type OcrProviderPort,
} from '../services/provider-support';

const NOW = (): Date => new Date('2026-10-06T00:00:00.000Z');

/** 让 PDF 原生文本层达到 char-density 阈值（默认 200 字符/页） */
const FILLER = 'SECTION-A LINE-B ITEM-C '.repeat(20);

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function spyOcrProvider(): { provider: OcrProviderPort; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      providerId: 'ocr:spy',
      providerVersion: 'spy/v1',
      async recognize() {
        calls += 1;
        throw new Error('OCR_SHOULD_NOT_BE_CALLED');
      },
    },
  };
}

function entryNumberField(rawValue: string, confidenceBp: number) {
  return { field: 'entryNumber', rawValue, page: 1, confidenceBp };
}

describe('A-S6 DocumentIngestionPort — 摄取优先级', () => {
  it('结构化原文（CSV）优先：不调用 OCR，候选字段置信 9500 且 page=null', async () => {
    const spy = spyOcrProvider();
    const result = await ingestDocument(
      {
        fileAssetId: 'fa-csv-1',
        sha256: SHA_A,
        mimeType: 'text/csv',
        structured: {
          format: 'CSV',
          rows: [{ 'Entry Number': 'ABC-123456', HTS: '8471.30.01', 'Duty Paid': '123.45' }],
        },
      },
      { ocrProvider: spy.provider, now: NOW },
    );

    expect(spy.calls()).toBe(0);
    expect(result.sourceKind).toBe('STRUCTURED');
    expect(result.status).toBe('EXTRACTED');
    expect(result.ocrProvider).toBeNull();
    expect(result.pageCount).toBeNull();
    expect(result.candidateFields.length).toBeGreaterThan(0);
    expect(result.candidateFields.every((c) => c.confidenceBp === 9_500)).toBe(true);
    expect(result.candidateFields.every((c) => c.page === null)).toBe(true);
    expect(result.candidateFields.map((c) => c.field)).toContain('entryNumber');
    expect(result.requiresManualReview).toBe(false);
  });

  it('结构化格式但缺 rows → fail-closed DOCUMENT_MALFORMED_STRUCTURED_CONTENT（禁止静默降级）', async () => {
    await expect(
      ingestDocument({ fileAssetId: 'fa-csv-2', sha256: SHA_A, mimeType: 'text/csv' }, { now: NOW }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_MALFORMED_STRUCTURED_CONTENT' });
  });

  it('PDF 有原生文本层 → NATIVE_TEXT，OCR 全程未被调用', async () => {
    const spy = spyOcrProvider();
    const result = await ingestDocument(
      {
        fileAssetId: 'fa-pdf-native',
        sha256: SHA_A,
        mimeType: 'application/pdf',
        nativeText: {
          pages: [
            {
              page: 1,
              text: `CBP Form 7501 Entry Summary\nEntry Number: ABC-123456\nHTS: 8471.30.01\nDuty Paid: 123.45\n${FILLER}`,
            },
          ],
          extractorId: 'pdf:mock',
          extractorVersion: 'mock/v1',
        },
      },
      { ocrProvider: spy.provider, now: NOW },
    );

    expect(spy.calls()).toBe(0);
    expect(result.sourceKind).toBe('NATIVE_TEXT');
    expect(result.status).toBe('EXTRACTED');
    expect(result.ocrProvider).toBeNull();
    expect(result.pageCount).toBe(1);
    expect(result.reasons).toContain('NATIVE_TEXT_LAYER_USED');
    expect(result.classification.documentKind).toBe('CBP_7501');
    expect(result.requiresManualReview).toBe(false);
  });

  it('PDF 文本层不足（扫描件）→ OCR 回退，结果标记 OCR_DERIVED + 人工复核', async () => {
    const result = await ingestDocument(
      {
        fileAssetId: 'fa-pdf-scan',
        sha256: SHA_B,
        mimeType: 'application/pdf',
        nativeText: { pages: [{ page: 1, text: 'scanned' }], extractorId: 'pdf:mock', extractorVersion: 'mock/v1' },
        binaryBytes: new Uint8Array([1, 2, 3]),
        pageCount: 1,
      },
      {
        ocrProvider: createMockOcrProvider({
          pages: [{ page: 1, text: 'CBP Form 7501 Entry Summary\nEntry Number: ABC-999999' }],
          fields: [entryNumberField('ABC-999999', 8_800)],
        }),
        now: NOW,
      },
    );

    expect(result.sourceKind).toBe('OCR_DERIVED');
    expect(result.ocrProvider).toBe('ocr:mock');
    expect(result.reasons).toContain('NATIVE_TEXT_LAYER_INSUFFICIENT');
    expect(result.requiresManualReview).toBe(true);
    expect(result.classification.documentKind).toBe('CBP_7501');
    expect(result.classification.confidenceBp).toBeLessThanOrEqual(6_000);
  });

  it('注入 PdfTextExtractorPort：无 nativeText 时走端口抽取，且不触发 OCR', async () => {
    const spy = spyOcrProvider();
    const result = await ingestDocument(
      {
        fileAssetId: 'fa-pdf-port',
        sha256: SHA_A,
        mimeType: 'application/pdf',
        binaryBytes: new Uint8Array([7]),
      },
      {
        pdfTextExtractor: createMockPdfExtractor([
          { page: 1, text: `CBP Form 7501 Entry Summary\nEntry Number: ABC-123456\n${FILLER}` },
        ]),
        ocrProvider: spy.provider,
        now: NOW,
      },
    );

    expect(spy.calls()).toBe(0);
    expect(result.sourceKind).toBe('NATIVE_TEXT');
    expect(result.parserProvider).toBe('pdf:mock');
  });

  it('PDF 无文本层且未注入抽取器 → OCR_DISABLED（NO_PDF_TEXT_EXTRACTOR），不伪称已抽取', async () => {
    const result = await ingestDocument(
      { fileAssetId: 'fa-pdf-none', sha256: SHA_A, mimeType: 'application/pdf', binaryBytes: new Uint8Array([1]) },
      { now: NOW },
    );

    expect(result.sourceKind).toBeNull();
    expect(result.status).toBe('OCR_DISABLED');
    expect(result.reasons).toContain('NO_PDF_TEXT_EXTRACTOR');
    expect(result.reasons).toContain('OCR_PROVIDER_NOT_CONFIGURED_HOLD_EXTERNAL');
    expect(result.requiresManualReview).toBe(true);
    expect(result.candidateFields).toHaveLength(0);
  });

  it('PDF 抽取器未配置抛错实现 → fail-closed DOCUMENT_PDF_EXTRACTOR_REQUIRED', async () => {
    await expect(
      ingestDocument(
        { fileAssetId: 'fa-pdf-x', sha256: SHA_A, mimeType: 'application/pdf', binaryBytes: new Uint8Array([1]) },
        { pdfTextExtractor: createThrowingPdfExtractor(), now: NOW },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_PDF_EXTRACTOR_REQUIRED' });
  });

  it('图片（PNG）→ OCR 路径，候选一律 OCR_DERIVED 且必须人工复核', async () => {
    const result = await ingestDocument(
      {
        fileAssetId: 'fa-img-1',
        sha256: SHA_B,
        mimeType: 'image/png',
        binaryBytes: new Uint8Array([9]),
      },
      {
        ocrProvider: createMockOcrProvider({
          pages: [{ page: 1, text: 'proof of delivery 1Z999AA10123456784' }],
        }),
        now: NOW,
      },
    );

    expect(result.sourceKind).toBe('OCR_DERIVED');
    expect(result.requiresManualReview).toBe(true);
    expect(result.classification.documentKind).toBe('POD');
    expect(result.candidateFields.every((c) => c.sourceKind === 'OCR_DERIVED')).toBe(true);
    expect(result.candidateFields.every((c) => c.confidenceBp < 10_000)).toBe(true);
  });

  it('不支持的媒体类型 → fail-closed DOCUMENT_UNSUPPORTED_MEDIA_TYPE', async () => {
    await expect(
      ingestDocument({ fileAssetId: 'fa-zip', sha256: SHA_A, mimeType: 'application/zip' }, { now: NOW }),
    ).rejects.toBeInstanceOf(DocumentIngestionError);
    await expect(
      ingestDocument({ fileAssetId: 'fa-zip', sha256: SHA_A, mimeType: 'application/zip' }, { now: NOW }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_UNSUPPORTED_MEDIA_TYPE' });
  });
});

describe('A-S6 — OCR 端口缺失 / 失败时的 fail-closed 行为', () => {
  it('未配置 OCR provider（图片）→ OCR_DISABLED，不产生任何候选值', async () => {
    const result = await ingestDocument(
      { fileAssetId: 'fa-img-2', sha256: SHA_A, mimeType: 'image/jpeg', binaryBytes: new Uint8Array([1]) },
      { now: NOW },
    );

    expect(result.status).toBe('OCR_DISABLED');
    expect(result.sourceKind).toBeNull();
    expect(result.ocrProvider).toBeNull();
    expect(result.reasons).toContain('OCR_PROVIDER_NOT_CONFIGURED_HOLD_EXTERNAL');
    expect(result.candidateFields).toHaveLength(0);
  });

  it('有 OCR provider 但缺原始字节 → OCR_REQUIRED（不猜测、不伪造）', async () => {
    const result = await ingestDocument(
      { fileAssetId: 'fa-img-3', sha256: SHA_A, mimeType: 'image/png' },
      { ocrProvider: createMockOcrProvider({ pages: [] }), now: NOW },
    );

    expect(result.status).toBe('OCR_REQUIRED');
    expect(result.reasons).toContain('OCR_REQUIRES_BINARY_BYTES');
    expect(result.requiresManualReview).toBe(true);
  });

  it('OCR provider 抛错 → QUARANTINED（fail-closed，交人工）', async () => {
    const result = await ingestDocument(
      { fileAssetId: 'fa-img-4', sha256: SHA_A, mimeType: 'image/png', binaryBytes: new Uint8Array([4]) },
      { ocrProvider: createMockOcrProvider({ pages: [], fail: true }), now: NOW },
    );

    expect(result.status).toBe('QUARANTINED');
    expect(result.ocrProvider).toBe('ocr:mock');
    expect(result.reasons.some((r) => r.startsWith('OCR_FAILED:'))).toBe(true);
    expect(result.requiresManualReview).toBe(true);
  });

  it('默认禁用实现必须直接抛 DOCUMENT_OCR_PROVIDER_NOT_CONFIGURED（真实/收费 OCR = HOLD）', async () => {
    const disabled = createDisabledOcrProvider();
    expect(disabled.providerId).toBe('ocr:disabled');
    await expect(
      disabled.recognize({
        fileAssetId: 'fa-x',
        sha256: SHA_A,
        mimeType: 'image/png',
        bytes: new Uint8Array([1]),
        fields: ['entryNumber'],
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_OCR_PROVIDER_NOT_CONFIGURED' });
  });
});

describe('A-S6 — 低置信 / 冲突 / HITL 升级', () => {
  it('OCR 关键字段低置信 → QUARANTINED + LOW_CONFIDENCE_CRITICAL_FIELDS', async () => {
    const result = await ingestDocument(
      { fileAssetId: 'fa-low', sha256: SHA_A, mimeType: 'image/jpeg', binaryBytes: new Uint8Array([1]) },
      {
        ocrProvider: createMockOcrProvider({
          pages: [{ page: 1, text: '' }],
          fields: [{ field: 'hts', rawValue: '8471.30.01', page: 1, confidenceBp: 3_000 }],
        }),
        now: NOW,
      },
    );

    expect(result.status).toBe('QUARANTINED');
    expect(result.requiresManualReview).toBe(true);
    expect(result.reasons.some((r) => r.startsWith('LOW_CONFIDENCE_CRITICAL_FIELDS'))).toBe(true);
    expect(result.candidateFields.every((c) => c.confidenceBp < 10_000)).toBe(true);
  });

  it('OCR 关键字段高置信 → EXTRACTED 但仍要求人工复核（OCR 不等于事实）', async () => {
    const result = await ingestDocument(
      { fileAssetId: 'fa-high', sha256: SHA_A, mimeType: 'image/png', binaryBytes: new Uint8Array([1]) },
      {
        ocrProvider: createMockOcrProvider({
          pages: [{ page: 1, text: '' }],
          fields: [{ field: 'entryNumber', rawValue: 'ABC-777777', page: 1, confidenceBp: 9_500 }],
        }),
        now: NOW,
      },
    );

    expect(result.status).toBe('EXTRACTED');
    expect(result.requiresManualReview).toBe(true);
    expect(result.reasons).toContain('OCR_CRITICAL_FIELDS_REQUIRE_REVIEW');
  });

  it('同字段不同值 → CROSS_SOURCE_CONFLICT，全部候选保留（禁 last-write-wins）', async () => {
    const result = await ingestDocument(
      { fileAssetId: 'fa-conflict', sha256: SHA_A, mimeType: 'image/png', binaryBytes: new Uint8Array([1]) },
      {
        ocrProvider: createMockOcrProvider({
          pages: [{ page: 1, text: '' }],
          fields: [entryNumberField('ABC-111111', 9_000), entryNumberField('ABC-222222', 9_000)],
        }),
        now: NOW,
      },
    );

    expect(result.reasons.some((r) => r.startsWith('CROSS_SOURCE_CONFLICT'))).toBe(true);
    expect(result.requiresManualReview).toBe(true);
    expect(
      result.candidateFields
        .filter((c) => c.field === 'entryNumber')
        .map((c) => c.rawValue)
        .sort(),
    ).toEqual(['ABC-111111', 'ABC-222222']);
  });

  it('非关键字段低置信不触发隔离（避免过度阻断）', async () => {
    const result = await ingestDocument(
      { fileAssetId: 'fa-noncrit', sha256: SHA_A, mimeType: 'image/png', binaryBytes: new Uint8Array([1]) },
      {
        ocrProvider: createMockOcrProvider({
          pages: [{ page: 1, text: '' }],
          fields: [{ field: 'portOfEntry', rawValue: '2704', page: 1, confidenceBp: 3_000 }],
        }),
        now: NOW,
      },
    );

    expect(isCriticalField('portOfEntry')).toBe(false);
    expect(result.status).not.toBe('QUARANTINED');
    expect(result.reasons.some((r) => r.startsWith('LOW_CONFIDENCE_CRITICAL_FIELDS'))).toBe(false);
  });
});

describe('A-S6 — 文档分类器（规则优先，OCR 文本降权）', () => {
  it('文件名命中 7501 → CBP_7501，不越界高置信', () => {
    const result = classifyDocument({ document: { filename: '7501-scan.pdf' }, text: '' });
    expect(result.documentKind).toBe('CBP_7501');
    expect(result.confidenceBp).toBeLessThanOrEqual(9_500);
    expect(result.reasons).toContain('RULE_HITS_1');
  });

  it('OCR 文本降权：置信上限 6000 且标记 TEXT_FROM_OCR_DOWNWEIGHTED', () => {
    const result = classifyDocument({
      document: {},
      text: 'cbp form 7501 entry summary',
      textFromOcr: true,
    });
    expect(result.documentKind).toBe('CBP_7501');
    expect(result.confidenceBp).toBeLessThanOrEqual(6_000);
    expect(result.reasons).toContain('TEXT_FROM_OCR_DOWNWEIGHTED');
  });

  it('无规则命中 → OTHER / 2000 / NO_RULE_MATCHED（不猜测）', () => {
    const result = classifyDocument({ document: { filename: 'random.bin' }, text: 'hello world' });
    expect(result.documentKind).toBe('OTHER');
    expect(result.confidenceBp).toBe(2_000);
    expect(result.reasons).toContain('NO_RULE_MATCHED');
  });

  it('多规则平局 → 置信降级 + AMBIGUOUS（交人工裁决）', () => {
    const result = classifyDocument({ document: {}, text: 'packing list and proof of delivery' });
    expect(result.confidenceBp).toBeLessThanOrEqual(5_000);
    expect(result.reasons.some((r) => r.startsWith('AMBIGUOUS_BETWEEN_'))).toBe(true);
  });

  it('maxConfidenceBp 可显式压低上限', () => {
    const result = classifyDocument({ document: { filename: '7501.pdf' }, text: '', maxConfidenceBp: 3_000 });
    expect(result.confidenceBp).toBeLessThanOrEqual(3_000);
  });
});

describe('A-S6 — 候选字段抽取 / 冲突检测', () => {
  it('按来源分级置信：STRUCTURED 9500 > NATIVE_TEXT 9000，OCR 不超过 9900', () => {
    const text = 'Entry Number: ABC-123456\nHTS: 8471.30.01';
    const structured = extractCandidateFields({
      text,
      sourceFileSha256: SHA_A,
      sourceKind: 'STRUCTURED',
      provider: 'structured:csv',
      providerVersion: 'v1',
    });
    const native = extractCandidateFields({
      text,
      pages: [text],
      sourceFileSha256: SHA_A,
      sourceKind: 'NATIVE_TEXT',
      provider: 'pdf:mock',
      providerVersion: 'v1',
    });
    const ocr = extractCandidateFields({
      text,
      pages: [text],
      sourceFileSha256: SHA_A,
      sourceKind: 'OCR_DERIVED',
      provider: 'ocr:mock',
      providerVersion: 'v1',
    });

    expect(structured.every((c) => c.confidenceBp === 9_500)).toBe(true);
    expect(native.every((c) => c.confidenceBp === 9_000)).toBe(true);
    expect(ocr.every((c) => c.confidenceBp <= 9_900)).toBe(true);
    expect(native.map((c) => c.field)).toContain('entryNumber');
    expect(native.find((c) => c.field === 'entryNumber')?.normalizedValue).toBe('ABC-123456');
    expect(native.find((c) => c.field === 'hts')?.normalizedValue).toBe('8471.30.01');
    expect(native.every((c) => c.page === 1)).toBe(true);
    expect(native.every((c) => c.sourceFileSha256 === SHA_A)).toBe(true);
  });

  it('detectCandidateConflicts：同值无冲突；异值列出字段/取值/来源', () => {
    const base = (overrides: Partial<CandidateField>): CandidateField => ({
      field: 'entryNumber',
      rawValue: 'ABC-123456',
      normalizedValue: 'ABC-123456',
      page: 1,
      boundingBox: null,
      confidenceBp: 9_000,
      sourceKind: 'NATIVE_TEXT',
      provider: 'pdf:mock',
      providerVersion: 'v1',
      sourceFileSha256: SHA_A,
      ...overrides,
    });

    expect(detectCandidateConflicts([base({}), base({})])).toHaveLength(0);

    const conflicts = detectCandidateConflicts([
      base({}),
      base({ rawValue: 'ABC-999999', normalizedValue: 'ABC-999999', sourceKind: 'OCR_DERIVED', provider: 'ocr:mock' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('entryNumber');
    expect(conflicts[0].values).toEqual(['ABC-123456', 'ABC-999999']);
    expect(conflicts[0].sources.sort()).toEqual(['NATIVE_TEXT:pdf:mock', 'OCR_DERIVED:ocr:mock']);
  });

  it('CRITICAL_FIELDS 覆盖关键字段，isCriticalField 精确判定', () => {
    expect(CRITICAL_FIELDS).toContain('entryNumber');
    expect(CRITICAL_FIELDS).toContain('hts');
    expect(isCriticalField('entryNumber')).toBe(true);
    expect(isCriticalField('portOfEntry')).toBe(false);
    expect(DEFAULT_FIELD_RULES.length).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_FIELD_RULES.some((r) => r.critical === true)).toBe(true);
  });
});

describe('A-S6 — OCR 置信上限与「非 Canonical」断言', () => {
  it('ocrFieldsToCandidates 把置信硬限制在 9900，且保留来源/摘要/页码', () => {
    const candidates = ocrFieldsToCandidates({
      result: {
        providerId: 'ocr:mock',
        providerVersion: 'mock/v1',
        pages: [{ page: 1, text: 'x' }],
        fields: [
          { field: 'entryNumber', rawValue: 'abc-123456', page: 1, confidenceBp: 10_000 },
          { field: 'hts', rawValue: '8471.30.01', confidenceBp: 12_345 },
        ],
      },
      sourceFileSha256: SHA_B,
      normalize: (field, raw) => (field === 'entryNumber' ? raw.toUpperCase() : raw),
    });

    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.confidenceBp === 9_900)).toBe(true);
    expect(candidates.every((c) => c.sourceKind === 'OCR_DERIVED')).toBe(true);
    expect(candidates.every((c) => c.sourceFileSha256 === SHA_B)).toBe(true);
    expect(candidates[0].normalizedValue).toBe('ABC-123456');
    expect(candidates[1].page).toBeNull();
  });

  it('assertOcrCandidateNotCanonical：OCR 候选达到 10000 视为「写成事实」→ 抛错；9900 通过', () => {
    const ocrCandidate: CandidateField = {
      field: 'hts',
      rawValue: '8471.30.01',
      normalizedValue: '8471.30.01',
      page: 1,
      boundingBox: null,
      confidenceBp: 9_900,
      sourceKind: 'OCR_DERIVED',
      provider: 'ocr:mock',
      providerVersion: 'mock/v1',
      sourceFileSha256: SHA_A,
    };
    expect(() => assertOcrCandidateNotCanonical(ocrCandidate)).not.toThrow();
    expect(() => assertOcrCandidateNotCanonical({ ...ocrCandidate, confidenceBp: 10_000 })).toThrowError(
      DocumentIngestionError,
    );
    expect(() =>
      assertOcrCandidateNotCanonical({ ...ocrCandidate, confidenceBp: 10_000, sourceKind: 'NATIVE_TEXT' }),
    ).not.toThrow();
  });
});

describe('A-S6 — 确定性与长期安全边界', () => {
  it('确定性：相同输入 + 相同时间 → 相同 resultDigest；时间不同 → 摘要不同', async () => {
    const input = {
      fileAssetId: 'fa-det',
      sha256: SHA_A,
      mimeType: 'image/png',
      binaryBytes: new Uint8Array([5]),
    } as const;
    const provider = (): OcrProviderPort =>
      createMockOcrProvider({
        pages: [{ page: 1, text: '' }],
        fields: [entryNumberField('ABC-555555', 9_000)],
      });

    const a = await ingestDocument(input, { ocrProvider: provider(), now: NOW });
    const b = await ingestDocument(input, { ocrProvider: provider(), now: NOW });
    const c = await ingestDocument(input, {
      ocrProvider: provider(),
      now: () => new Date('2026-10-06T01:00:00.000Z'),
    });

    expect(a.resultDigest).toBe(b.resultDigest);
    expect(a.resultDigest).not.toBe(c.resultDigest);
    expect(a.resultDigest).toHaveLength(64);
    expect(a.ingestedAt).toBe('2026-10-06T00:00:00.000Z');
  });

  it('长期安全断言：OCR 结果一律 requiresManualReview，且所有候选置信 < 10000', async () => {
    const result = await ingestDocument(
      { fileAssetId: 'fa-boundary', sha256: SHA_A, mimeType: 'image/png', binaryBytes: new Uint8Array([6]) },
      {
        ocrProvider: createMockOcrProvider({
          pages: [{ page: 1, text: 'duty paid 100.00' }],
          fields: [{ field: 'dutyPaid', rawValue: '100.00', confidenceBp: 10_000 }],
        }),
        now: NOW,
      },
    );

    expect(result.sourceKind).toBe('OCR_DERIVED');
    expect(result.requiresManualReview).toBe(true);
    expect(result.candidateFields.length).toBeGreaterThan(0);
    expect(result.candidateFields.every((c) => c.confidenceBp < 10_000)).toBe(true);
    for (const candidate of result.candidateFields) {
      expect(() => assertOcrCandidateNotCanonical(candidate)).not.toThrow();
    }
  });

  it('边界常量：OCR 不得成为 Canonical Truth，真实 OCR 网络调用 = HOLD', () => {
    expect(DOCUMENT_INGESTION_BOUNDARY.ocrIsNotCanonicalTruth).toBe(true);
    expect(DOCUMENT_INGESTION_BOUNDARY.ocrProviderMustBeInjected).toBe(true);
    expect(DOCUMENT_INGESTION_BOUNDARY.realOcrNetworkCalls).toBe('HOLD');
    expect([...DOCUMENT_INGESTION_BOUNDARY.preferredOrder]).toEqual(['STRUCTURED', 'NATIVE_TEXT', 'OCR_DERIVED']);
  });

  it('本期只提供只读端口/纯函数：不导出任何文档写入、持久化或推送能力', () => {
    for (const name of Object.keys(providerSupport)) {
      expect(name).not.toMatch(/persistDocument|writeDocument|mutateDocument|saveDocument|uploadDocument|sendDocument/i);
    }
  });
});
