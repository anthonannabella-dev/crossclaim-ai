// CUSTOMS / DOCUMENT INTELLIGENCE —— OCR Provider 端口（本轮只建端口 + mock；不接任何收费 OCR）

import { DocumentIngestionError, type CandidateField, type DocumentSourceKind } from './document-types';

export interface OcrRequest {
  fileAssetId: string;
  sha256: string;
  mimeType: string;
  bytes: Uint8Array;
  pageCount?: number;
  /** 期望抽取的字段白名单（避免无边界抽取） */
  fields: readonly string[];
}

export interface OcrResult {
  providerId: string;
  providerVersion: string;
  pages: ReadonlyArray<{ page: number; text: string }>;
  /** provider 自报的关键字段（仍需 confidence / 校验后才可用） */
  fields: ReadonlyArray<{
    field: string;
    rawValue: string;
    page?: number | null;
    confidenceBp: number;
    boundingBox?: { x: number; y: number; width: number; height: number } | null;
  }>;
}

export interface OcrProviderPort {
  readonly providerId: string;
  readonly providerVersion: string;
  recognize(request: OcrRequest): Promise<OcrResult>;
}

/** 默认实现：**未配置**。任何调用都 fail-closed（收费/真实 OCR 属于 HOLD_EXTERNAL）。 */
export function createDisabledOcrProvider(): OcrProviderPort {
  return {
    providerId: 'ocr:disabled',
    providerVersion: 'n/a',
    async recognize() {
      throw new DocumentIngestionError(
        'DOCUMENT_OCR_PROVIDER_NOT_CONFIGURED',
        'OCR provider 未配置：本轮不接入任何真实/收费 OCR（HOLD_EXTERNAL）',
      );
    },
  };
}

export interface MockOcrFixture {
  pages: ReadonlyArray<{ page: number; text: string }>;
  fields?: OcrResult['fields'];
  fail?: boolean;
}

/** 测试/本地演示用 mock：真实数据一律不得进入 fixture。 */
export function createMockOcrProvider(fixture: MockOcrFixture): OcrProviderPort {
  return {
    providerId: 'ocr:mock',
    providerVersion: 'mock/v1',
    async recognize() {
      if (fixture.fail) {
        throw new DocumentIngestionError('DOCUMENT_OCR_FAILED', 'mock OCR 失败（故障注入）');
      }
      return {
        providerId: 'ocr:mock',
        providerVersion: 'mock/v1',
        pages: fixture.pages,
        fields: fixture.fields ?? [],
      };
    },
  };
}

export function ocrFieldsToCandidates(input: {
  result: OcrResult;
  sourceFileSha256: string;
  sourceKind?: DocumentSourceKind;
  normalize?: (field: string, raw: string) => string | null;
}): CandidateField[] {
  const sourceKind = input.sourceKind ?? 'OCR_DERIVED';
  return input.result.fields.map((field) => {
    const candidate: CandidateField = {
      field: field.field,
      rawValue: field.rawValue,
      normalizedValue: input.normalize ? input.normalize(field.field, field.rawValue) : null,
      page: field.page ?? null,
      boundingBox: field.boundingBox ?? null,
      // OCR 置信度上限 9900：禁止把 OCR 标成满置信
      confidenceBp: Math.max(0, Math.min(9_900, Math.round(field.confidenceBp))),
      sourceKind,
      provider: input.result.providerId,
      providerVersion: input.result.providerVersion,
      sourceFileSha256: input.sourceFileSha256,
    };
    return candidate;
  });
}
