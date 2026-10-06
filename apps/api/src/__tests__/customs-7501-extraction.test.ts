// CUSTOMS / DUTY RECOVERY — slice B-S3 — CBP 7501 候选字段抽取回归
// ---------------------------------------------------------------------------
// 覆盖：13 类字段抽取与规范化、行项目解析、来源分级置信、OCR 降权、关键字段缺失/低置信 → 隔离+HITL、
// 跨页冲突不覆盖、无候选 fail-closed、制度边界不变量、确定性摘要。

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  CUSTOMS_7501_CRITICAL_FIELDS,
  CUSTOMS_7501_EXTRACTION_BOUNDARY,
  CUSTOMS_7501_FIELD_RULES,
  CUSTOMS_7501_FIELDS,
  MAX_7501_CANDIDATE_CONFIDENCE_BP,
  MAX_7501_OCR_CANDIDATE_CONFIDENCE_BP,
  Customs7501ExtractionError,
  assertCandidateIsNotCustomsTruth,
  extractCustoms7501Fields,
  is7501CriticalField,
  isCustoms7501Field,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T15:00:00.000Z');
const SHA = 'f'.repeat(64);

const FULL_7501 = [
  'CBP Form 7501 Entry Summary',
  'Entry Number: ABC-123456',
  'Entry Date: 08/01/2026',
  'Port of Entry: 2704',
  'Importer of Record: 12-3456789',
  'HTS: 8471.30.01',
  'Country of Origin: CN',
  'Customs Value: 12,500.00',
  'Dutiable Value: 12,500.00',
  'Duty Rate: 3.5 %',
  'Duty Paid: 437.50',
  'Currency: USD',
  'Preference: NONE',
  'Broker: ACME CUSTOMS BROKERS',
  '1 | 8471.30.01 | CN | 10,000.00 | 10,000.00 | 3.5 % | 350.00',
  '2 | 8517.62.00 | CN | 2,500.00 | 2,500.00 | 3.5 % | 87.50',
].join('\n');

function extract(text: string, overrides: Partial<Parameters<typeof extractCustoms7501Fields>[0]> = {}) {
  return extractCustoms7501Fields({
    text,
    sourceFileSha256: SHA,
    sourceKind: 'NATIVE_TEXT',
    provider: 'pdf:mock',
    providerVersion: 'mock/v1',
    now: NOW,
    ...overrides,
  });
}

function valueOf(extraction: ReturnType<typeof extract>, field: string) {
  return extraction.candidates.find((candidate) => candidate.field === field)?.normalizedValue ?? null;
}

describe('B-S3 CBP 7501 抽取 — 字段与规范化', () => {
  it('完整 7501 → 13 类字段全部命中且规范化正确', () => {
    const extraction = extract(FULL_7501);
    expect(extraction.status).toBe('EXTRACTED');
    expect(extraction.presentCriticalFields).toEqual([...CUSTOMS_7501_CRITICAL_FIELDS]);
    expect(extraction.missingCriticalFields).toEqual([]);
    expect(valueOf(extraction, 'entryNumber')).toBe('ABC-123456');
    expect(valueOf(extraction, 'entryDate')).toBe('2026-08-01');
    expect(valueOf(extraction, 'portOfEntry')).toBe('2704');
    expect(valueOf(extraction, 'ior')).toBe('123456789');
    expect(valueOf(extraction, 'hts')).toBe('8471.30.01');
    expect(valueOf(extraction, 'countryOfOrigin')).toBe('CN');
    expect(valueOf(extraction, 'customsValue')).toBe('12500.00');
    expect(valueOf(extraction, 'dutiableValue')).toBe('12500.00');
    expect(valueOf(extraction, 'dutyRate')).toBe('0.0350');
    expect(valueOf(extraction, 'dutyPaid')).toBe('437.50');
    expect(valueOf(extraction, 'currency')).toBe('USD');
    expect(valueOf(extraction, 'preference')).toBe('NONE');
    expect(valueOf(extraction, 'broker')).toBe('ACME CUSTOMS BROKERS');
    expect(extraction.requiresManualReview).toBe(false);
  });

  it('每个候选都携带 rawValue / source digest / provider / 页码（可回溯）', () => {
    const extraction = extract(FULL_7501);
    for (const candidate of extraction.candidates) {
      expect(candidate.rawValue.length).toBeGreaterThan(0);
      expect(candidate.sourceFileSha256).toBe(SHA);
      expect(candidate.provider).toBe('pdf:mock');
      expect(candidate.providerVersion).toBe('mock/v1');
      expect(candidate.page).toBe(1);
      expect(candidate.boundingBox).toBeNull();
      expect(candidate.lineNumber).toBeNull();
      expect(isCustoms7501Field(candidate.field)).toBe(true);
    }
  });

  it('来源分级置信：STRUCTURED 9500 > NATIVE_TEXT 9000 > OCR ≤9900', () => {
    expect(extract(FULL_7501).candidates[0].confidenceBp).toBe(9_000);
    const structured = extract(FULL_7501, { sourceKind: 'STRUCTURED' });
    expect(structured.candidates[0].confidenceBp).toBe(MAX_7501_CANDIDATE_CONFIDENCE_BP);
    expect(structured.candidates.every((candidate) => candidate.page === null)).toBe(true);
    const ocr = extract(FULL_7501, { sourceKind: 'OCR_DERIVED' });
    expect(ocr.candidates.every((candidate) => candidate.confidenceBp <= MAX_7501_OCR_CANDIDATE_CONFIDENCE_BP)).toBe(
      true,
    );
  });

  it('行项目解析：line / HTS / origin / value / duty 逐行结构化', () => {
    const extraction = extract(FULL_7501);
    expect(extraction.lines).toHaveLength(2);
    expect(extraction.lines[0]).toMatchObject({
      lineNumber: 1,
      hts: '8471.30.01',
      countryOfOrigin: 'CN',
      customsValue: '10000.00',
      dutiableValue: '10000.00',
      dutyRate: '0.0350',
      dutyPaid: '350.00',
    });
    expect(extraction.lines[1].lineNumber).toBe(2);
    expect(extraction.lines[1].hts).toBe('8517.62.00');
  });

  it('缺少可选 rate/duty 的行仍可解析（不猜测）', () => {
    const extraction = extract('1 | 8471.30.01 | CN | 100.00 | 100.00');
    expect(extraction.lines).toHaveLength(1);
    expect(extraction.lines[0].dutyRate).toBeNull();
    expect(extraction.lines[0].dutyPaid).toBeNull();
  });
});

describe('B-S3 — 关键字段缺失 / 低置信 / 不可规范化', () => {
  it('缺关键字段（无 currency）→ 列出缺失并强制人工复核，但不伪造', () => {
    const extraction = extract(FULL_7501.replace('Currency: USD\n', ''));
    expect(extraction.missingCriticalFields).toEqual(['currency']);
    expect(extraction.reasons).toContain('MISSING_CRITICAL_FIELDS:currency');
    expect(extraction.requiresManualReview).toBe(true);
    expect(extraction.candidates.some((candidate) => candidate.field === 'currency')).toBe(false);
  });

  it('OCR 低置信关键字段 → QUARANTINED + LOW_CONFIDENCE_CRITICAL_FIELDS', () => {
    const extraction = extract(FULL_7501, { sourceKind: 'OCR_DERIVED', ocrConfidenceBp: 3_000 });
    expect(extraction.status).toBe('QUARANTINED');
    expect(extraction.criticalLowConfidence.length).toBeGreaterThan(0);
    expect(extraction.reasons.some((r) => r.startsWith('LOW_CONFIDENCE_CRITICAL_FIELDS'))).toBe(true);
    expect(extraction.requiresManualReview).toBe(true);
  });

  it('不可规范化的关键字段（无效日期 02/30/2026）→ QUARANTINED（不猜日期）', () => {
    const extraction = extract(FULL_7501.replace('08/01/2026', '02/30/2026'));
    expect(extraction.status).toBe('QUARANTINED');
    expect(valueOf(extraction, 'entryDate')).toBeNull();
    expect(extraction.reasons.some((r) => r.startsWith('UNNORMALIZABLE_CRITICAL_FIELDS'))).toBe(true);
  });

  it('自定义 lowConfidenceBp 可收紧（调用方策略）', () => {
    const extraction = extract(FULL_7501, { lowConfidenceBp: 9_500 });
    expect(extraction.status).toBe('QUARANTINED');
    expect(extraction.criticalLowConfidence.length).toBe(CUSTOMS_7501_CRITICAL_FIELDS.length);
  });
});

describe('B-S3 — 冲突不覆盖 / 无候选 fail-closed / 边界', () => {
  it('跨页同字段异值 → 冲突全部保留（禁止 last-write-wins）', () => {
    const extraction = extractCustoms7501Fields({
      text: 'Entry Number: ABC-111111\nEntry Number: ABC-222222',
      pages: ['Entry Number: ABC-111111', 'Entry Number: ABC-222222'],
      sourceFileSha256: SHA,
      sourceKind: 'NATIVE_TEXT',
      provider: 'pdf:mock',
      providerVersion: 'mock/v1',
      now: NOW,
    });
    expect(extraction.conflicts).toHaveLength(1);
    expect(extraction.conflicts[0].field).toBe('entryNumber');
    expect(extraction.conflicts[0].values.sort()).toEqual(['ABC-111111', 'ABC-222222']);
    expect(
      extraction.candidates
        .filter((candidate) => candidate.field === 'entryNumber')
        .map((candidate) => candidate.normalizedValue)
        .sort(),
    ).toEqual(['ABC-111111', 'ABC-222222']);
    expect(extraction.requiresManualReview).toBe(true);
  });

  it('完全无候选 → NO_CANDIDATES（fail-closed，不伪造字段）', () => {
    const extraction = extract('This page intentionally left blank.');
    expect(extraction.status).toBe('NO_CANDIDATES');
    expect(extraction.candidates).toEqual([]);
    expect(extraction.reasons).toContain('NO_CANDIDATES_EXTRACTED');
    expect(extraction.missingCriticalFields).toEqual([...CUSTOMS_7501_CRITICAL_FIELDS]);
    expect(extraction.requiresManualReview).toBe(true);
  });

  it('OCR 来源一律标记人工复核', () => {
    const extraction = extract(FULL_7501, { sourceKind: 'OCR_DERIVED' });
    expect(extraction.reasons).toContain('OCR_DERIVED_REQUIRES_REVIEW');
    expect(extraction.requiresManualReview).toBe(true);
  });

  it('边界断言：候选值不得被当成 Customs Truth / 不得直接写 Canonical', () => {
    const extraction = extract(FULL_7501);
    expect(extraction.kind).toBe('CBP_7501_CANDIDATE_FIELDS');
    expect(extraction.customsTruthEligible).toBe(false);
    expect(extraction.canonicalWriteAllowed).toBe(false);
    expect(() => assertCandidateIsNotCustomsTruth(extraction)).not.toThrow();
    expect(() => assertCandidateIsNotCustomsTruth({ customsTruthEligible: true as never })).toThrowError(
      Customs7501ExtractionError,
    );
    expect(() => assertCandidateIsNotCustomsTruth({ canonicalWriteAllowed: true as never })).toThrowError(
      Customs7501ExtractionError,
    );
  });

  it('边界常量：候选制、低置信隔离、OCR 降权、禁 last-write-wins', () => {
    expect(CUSTOMS_7501_EXTRACTION_BOUNDARY.candidateOnly).toBe(true);
    expect(CUSTOMS_7501_EXTRACTION_BOUNDARY.customsTruthEligible).toBe(false);
    expect(CUSTOMS_7501_EXTRACTION_BOUNDARY.canonicalWriteAllowed).toBe(false);
    expect(CUSTOMS_7501_EXTRACTION_BOUNDARY.lowConfidenceQuarantines).toBe(true);
    expect(CUSTOMS_7501_EXTRACTION_BOUNDARY.ocrDownweighted).toBe(true);
    expect(CUSTOMS_7501_EXTRACTION_BOUNDARY.lastWriteWinsForbidden).toBe(true);
    expect(CUSTOMS_7501_EXTRACTION_BOUNDARY.forbidden).toContain(
      'writing candidate values as canonical / customs truth',
    );
  });

  it('规则表覆盖全部字段，且关键字段标记一致', () => {
    const covered = new Set(CUSTOMS_7501_FIELD_RULES.map((rule) => rule.field));
    for (const field of CUSTOMS_7501_FIELDS) {
      expect(covered.has(field)).toBe(true);
    }
    for (const rule of CUSTOMS_7501_FIELD_RULES) {
      expect(rule.critical).toBe(is7501CriticalField(rule.field));
    }
    expect(is7501CriticalField('entryNumber')).toBe(true);
    expect(is7501CriticalField('broker')).toBe(false);
  });

  it('确定性：同输入同 now → 同 extractionDigest；文本变 → 摘要变', () => {
    const a = extract(FULL_7501);
    const b = extract(FULL_7501);
    const c = extract(FULL_7501.replace('ABC-123456', 'ABC-999999'));
    expect(a.extractionDigest).toBe(b.extractionDigest);
    expect(a.extractionDigest).not.toBe(c.extractionDigest);
    expect(a.extractionDigest).toHaveLength(64);
    expect(a.extractedAt).toBe(NOW.toISOString());
  });

  it('模块只导出候选抽取能力，不导出任何 Canonical 写入 / 金额判定入口', () => {
    for (const name of Object.keys(providerSupport)) {
      expect(name).not.toMatch(/writeCanonical7501|persistCandidateAsTruth|computeDutyRecoverable|claimFrom7501/i);
    }
  });
});
