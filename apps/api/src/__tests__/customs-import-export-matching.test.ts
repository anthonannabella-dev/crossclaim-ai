// CUSTOMS / DUTY RECOVERY — slice B-S6 — Import ↔ Export / Return / Destruction 匹配回归
// ---------------------------------------------------------------------------
// 覆盖：EXACT / PARTIAL / AMBIGUOUS / NO_MATCH 四态、维度一致性（HTS / currency / jurisdiction / 金额容差）、
// tenant·account 隔离、AMBIGUOUS 不自动择优、缺失维度 fail-closed、边界断言、确定性摘要。

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  CUSTOMS_MATCHING_BOUNDARY,
  CUSTOMS_MATCHING_VERSION,
  CustomsMatchingError,
  assertMatchDoesNotDecideEligibility,
  compareAmount,
  compareCurrency,
  compareHts,
  compareJurisdiction,
  isCustomsMatchStatus,
  matchImportLineToCounterparts,
  type CustomsCounterpartRecord,
  type CustomsImportLine,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T18:00:00.000Z');
const SCOPE = { organizationId: 'org-m-1', platformAccountId: 'acct-m-a' } as const;
const TRACKING = '1Z999AA10123456784';
const ENTRY = 'ABC-123456';

const IMPORT: CustomsImportLine = {
  lineId: 'line-1',
  trackingNumber: TRACKING,
  entryNumber: ENTRY,
  hts: '8471.30.01',
  currency: 'USD',
  jurisdiction: 'US',
  customsValue: 1_000,
};

function record(overrides: Partial<CustomsCounterpartRecord> = {}): CustomsCounterpartRecord {
  return {
    recordId: 'rec-1',
    organizationId: SCOPE.organizationId,
    platformAccountId: SCOPE.platformAccountId,
    recordKind: 'EXPORT',
    trackingNumber: TRACKING,
    entryNumber: ENTRY,
    hts: '8471.30.01',
    currency: 'USD',
    jurisdiction: 'US',
    customsValue: 1_000,
    capturedAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  };
}

function match(
  counterparts: readonly CustomsCounterpartRecord[],
  overrides: Partial<Parameters<typeof matchImportLineToCounterparts>[0]> = {},
) {
  return matchImportLineToCounterparts({
    scope: SCOPE,
    importLine: IMPORT,
    counterparts,
    now: NOW,
    ...overrides,
  });
}

describe('B-S6 匹配 — 四态判定', () => {
  it('全维度一致 → EXACT，给出唯一 best match', () => {
    const result = match([record()]);
    expect(result.kind).toBe('CUSTOMS_IMPORT_EXPORT_MATCH');
    expect(result.version).toBe(CUSTOMS_MATCHING_VERSION);
    expect(result.status).toBe('EXACT');
    expect(result.bestMatch?.recordId).toBe('rec-1');
    expect(result.bestMatch?.matchedBy).toBe('TRACKING_NUMBER');
    expect(result.bestMatch?.mismatchedDimensions).toEqual([]);
    expect(result.requiresManualReview).toBe(false);
    expect(result.matchDigest).toHaveLength(64);
  });

  it('HTS 8 位 vs 10 位 → PARTIAL 且标注前缀关系', () => {
    const result = match([record({ hts: '8471.30' })]);
    expect(result.status).toBe('PARTIAL');
    expect(result.bestMatch?.dimensions.hts).toBe('PREFIX');
    expect(result.bestMatch?.reasons).toContain('HTS_PREFIX');
    expect(result.requiresManualReview).toBe(true);
  });

  it('HTS 不同 → PARTIAL（不得判 EXACT）', () => {
    const result = match([record({ hts: '8517.62.00' })]);
    expect(result.status).toBe('PARTIAL');
    expect(result.bestMatch?.dimensions.hts).toBe('MISMATCH');
    expect(result.bestMatch?.status).toBe('PARTIAL');
  });

  it('币种不一致 → PARTIAL（一致性阻断，不得 EXACT）', () => {
    const result = match([record({ currency: 'EUR' })]);
    expect(result.status).toBe('PARTIAL');
    expect(result.bestMatch?.dimensions.currency).toBe('MISMATCH');
    expect(result.bestMatch?.reasons).toContain('CURRENCY_MISMATCH');
  });

  it('司法辖区不一致 → PARTIAL（跨境不得当作同一票货）', () => {
    const result = match([record({ jurisdiction: 'CA' })]);
    expect(result.status).toBe('PARTIAL');
    expect(result.bestMatch?.dimensions.jurisdiction).toBe('MISMATCH');
    expect(result.bestMatch?.reasons).toContain('JURISDICTION_MISMATCH');
  });

  it('缺 currency / jurisdiction → MISSING 维度，fail-closed 降级 PARTIAL', () => {
    const result = match([record({ currency: null, jurisdiction: null })]);
    expect(result.status).toBe('PARTIAL');
    expect(result.bestMatch?.dimensions.currency).toBe('MISSING');
    expect(result.bestMatch?.dimensions.jurisdiction).toBe('MISSING');
    expect(result.consistency.missingDimensions).toEqual(
      expect.arrayContaining(['currency', 'jurisdiction']),
    );
  });

  it('无关联键 → NO_MATCH（NO_LINEAGE_KEY）', () => {
    const result = match([record({ trackingNumber: '1Z00000000000000000', entryNumber: 'ZZZ-999999' })]);
    expect(result.status).toBe('NO_MATCH');
    expect(result.bestMatch).toBeNull();
    expect(result.reasons).toContain('NO_MATCHING_COUNTERPART');
  });

  it('importLine 完全没有关联键 → NO_MATCH + NO_LINEAGE_KEY', () => {
    const result = match([record()], {
      importLine: { lineId: 'line-x', hts: '8471.30.01', currency: 'USD', jurisdiction: 'US' },
    });
    expect(result.status).toBe('NO_MATCH');
    expect(result.reasons).toContain('NO_LINEAGE_KEY');
  });

  it('多条同等匹配 → AMBIGUOUS，绝不自动择优', () => {
    const result = match([record({ recordId: 'rec-1' }), record({ recordId: 'rec-2', recordKind: 'RETURN' })]);
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.bestMatch).toBeNull();
    expect(result.ambiguousBetween).toEqual(['rec-1', 'rec-2']);
    expect(result.reasons).toContain('AUTOMATIC_SELECTION_FORBIDDEN');
    expect(result.automaticSelectionPerformed).toBe(false);
    expect(result.requiresManualReview).toBe(true);
  });

  it('分数更高的记录胜出（HTs+币种+辖区+金额都一致 vs 仅关联键一致）', () => {
    const result = match([
      record({ recordId: 'rec-weak', hts: '9999.99.99', currency: 'EUR', jurisdiction: 'CA', customsValue: 5 }),
      record({ recordId: 'rec-strong' }),
    ]);
    expect(result.status).toBe('EXACT');
    expect(result.bestMatch?.recordId).toBe('rec-strong');
    expect(result.matches[0].recordId).toBe('rec-strong');
  });
});

describe('B-S6 — 隔离、维度工具与边界', () => {
  it('跨 tenant / 跨 account 记录一律剔除并记录（不得参与匹配）', () => {
    const result = match([
      record({ recordId: 'rec-other-org', organizationId: 'org-m-2' }),
      record({ recordId: 'rec-other-acct', platformAccountId: 'acct-m-b' }),
    ]);
    expect(result.status).toBe('NO_MATCH');
    expect(result.rejectedForScope).toEqual(['rec-other-acct', 'rec-other-org']);
    expect(result.matches).toEqual([]);
    expect(result.consistency.tenantScoped).toBe(true);
    expect(result.consistency.accountScoped).toBe(true);
  });

  it('recordKind 覆盖 EXPORT / RETURN / DESTRUCTION', () => {
    for (const kind of ['EXPORT', 'RETURN', 'DESTRUCTION'] as const) {
      const result = match([record({ recordKind: kind })]);
      expect(result.status).toBe('EXACT');
      expect(result.bestMatch?.recordKind).toBe(kind);
    }
  });

  it('金额容差可配：默认 0bp 必须完全一致，容差内视为 PREFIX（仍非 EXACT）', () => {
    const strict = match([record({ customsValue: 1_000.5 })]);
    expect(strict.status).toBe('PARTIAL');
    expect(strict.bestMatch?.dimensions.customsValue).toBe('MISMATCH');

    const tolerant = match([record({ customsValue: 1_000.5 })], { valueToleranceBp: 100 });
    expect(tolerant.bestMatch?.dimensions.customsValue).toBe('PREFIX');
    expect(tolerant.status).toBe('PARTIAL'); // 金额只是容差内 → 不得判 EXACT
  });

  it('维度工具函数语义正确', () => {
    expect(compareHts('8471.30.01', '84713001')).toBe('EXACT');
    expect(compareHts('8471.30', '8471.30.01')).toBe('PREFIX');
    expect(compareHts('8471.30.01', '8517.62.00')).toBe('MISMATCH');
    expect(compareHts(null, '8471.30.01')).toBe('MISSING');
    expect(compareCurrency('usd', 'USD')).toBe('EXACT');
    expect(compareCurrency('USD', 'EUR')).toBe('MISMATCH');
    expect(compareJurisdiction('us', 'US')).toBe('EXACT');
    expect(compareJurisdiction('US', null)).toBe('MISSING');
    expect(compareAmount(100, 100, 0)).toBe('EXACT');
    expect(compareAmount(100, 101, 100)).toBe('PREFIX');
    expect(compareAmount(100, 200, 100)).toBe('MISMATCH');
    expect(compareAmount(null, 5, 0)).toBe('MISSING');
  });

  it('匹配结论不判定 eligibility、不自动择优、不写事实', () => {
    const result = match([record()]);
    expect(result.decidesEligibility).toBe(false);
    expect(result.automaticSelectionPerformed).toBe(false);
    expect(result.canonicalWritePerformed).toBe(false);
    expect(() => assertMatchDoesNotDecideEligibility(result)).not.toThrow();
    expect(() => assertMatchDoesNotDecideEligibility({ decidesEligibility: true as never })).toThrowError(
      CustomsMatchingError,
    );
    expect(() => assertMatchDoesNotDecideEligibility({ automaticSelectionPerformed: true as never })).toThrowError(
      CustomsMatchingError,
    );
  });

  it('边界常量与状态守卫', () => {
    expect(CUSTOMS_MATCHING_BOUNDARY.matchingOnly).toBe(true);
    expect(CUSTOMS_MATCHING_BOUNDARY.tenantScoped).toBe(true);
    expect(CUSTOMS_MATCHING_BOUNDARY.accountScoped).toBe(true);
    expect(CUSTOMS_MATCHING_BOUNDARY.automaticSelectionPerformed).toBe(false);
    expect(CUSTOMS_MATCHING_BOUNDARY.decidesEligibility).toBe(false);
    expect(CUSTOMS_MATCHING_BOUNDARY.computesRecoverableAmount).toBe(false);
    expect(CUSTOMS_MATCHING_BOUNDARY.forbidden).toContain('picking a counterpart among equally-matching records');
    expect(isCustomsMatchStatus('EXACT')).toBe(true);
    expect(isCustomsMatchStatus('MAYBE')).toBe(false);
  });

  it('确定性：同输入同 now → 同 matchDigest；差异输入 → 摘要变', () => {
    const a = match([record()]);
    const b = match([record()]);
    const c = match([record({ currency: 'EUR' })]);
    expect(a.matchDigest).toBe(b.matchDigest);
    expect(a.matchDigest).not.toBe(c.matchDigest);
    expect(a.matchedAt).toBe(NOW.toISOString());
  });

  it('模块不导出任何自动择优 / 判定权利 / 计算金额入口', () => {
    for (const name of Object.keys(providerSupport)) {
      expect(name).not.toMatch(/autoSelectMatch|decideEligibilityFromMatch|computeRecoverableFromMatch|persistMatchAsTruth/i);
    }
  });
});
