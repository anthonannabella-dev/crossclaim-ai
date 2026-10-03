/**
 * CUSTOMS GAP G4 / C3（MASTER GAP CLOSURE）— Classification / Rate Discrepancy 回归。
 * 断言：类别/金额/币种/缺失/多余差异识别、fail-closed 预期校验、只读事实守卫、无裁决、
 *       十进制精确 delta、确定性、C1→C3 端到端。
 */

import { describe, expect, it } from 'vitest';

import { normalizeCustomsEntryFact, type CustomsEntryFact } from '../services/customs/customs-entry-contract';
import { computeCustomsDutyTruth } from '../services/customs/customs-duty-truth';
import {
  CUSTOMS_DISCREPANCY_CODES,
  CustomsDiscrepancyError,
  compareCustomsClassification,
  subtractDecimalStrings,
  type CustomsRateExpectation,
} from '../services/customs/customs-classification-discrepancy';

function factOf(dutyLines: readonly Record<string, unknown>[]): CustomsEntryFact {
  return normalizeCustomsEntryFact({
    entryNumber: 'ABI-2026-000123',
    entryDate: '2026-09-18',
    jurisdiction: 'US',
    portOfEntry: 'Los Angeles, CA',
    importerOfRecordRef: 'ior_acct_88213',
    source: 'ABI_VENDOR',
    rawReference: 'abi:entry:88213',
    observedAt: '2026-09-19T02:11:00.000Z',
    dutyLines,
  });
}

function expectation(overrides: Partial<CustomsRateExpectation> = {}): CustomsRateExpectation {
  return {
    lineRawCode: 'DUTY-9901',
    htsCode: '9901.00.10',
    expectedKind: 'DUTY',
    expectedAmount: '100.00',
    currency: 'USD',
    source: 'RATE_TABLE',
    reference: 'rate-table:2026-Q3',
    ...overrides,
  };
}

function codeOf(fact: unknown, expectations: unknown): string {
  try {
    compareCustomsClassification({ fact: fact as CustomsEntryFact, expectations: expectations as CustomsRateExpectation[] });
  } catch (error) {
    return error instanceof CustomsDiscrepancyError ? error.code : 'NOT_A_DISCREPANCY_ERROR';
  }
  return 'NO_ERROR';
}

const usdLine = { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' };

describe('compareCustomsClassification', () => {
  it('完全一致 → 无差异项', () => {
    const report = compareCustomsClassification({ fact: factOf([usdLine]), expectations: [expectation()] });
    expect(report.items).toEqual([]);
    expect(report.discrepanciesFound).toBe(false);
    expect(report.matchedLineCount).toBe(1);
    expect(report.lineCount).toBe(1);
    expect(report.expectationCount).toBe(1);
  });

  it('金额不一致 → AMOUNT_MISMATCH + 精确 delta（正 / 负）', () => {
    const report = compareCustomsClassification({
      fact: factOf([usdLine]),
      expectations: [expectation({ expectedAmount: '70.00' })],
    });
    expect(report.items).toHaveLength(1);
    expect(report.items[0].code).toBe('AMOUNT_MISMATCH');
    expect(report.items[0].deltaAmount).toBe('30.00');

    const negative = compareCustomsClassification({
      fact: factOf([usdLine]),
      expectations: [expectation({ expectedAmount: '120.00' })],
    });
    expect(negative.items[0].deltaAmount).toBe('-20.00');
  });

  it('kind 不一致 → KIND_MISMATCH（金额一致时也只报 kind）', () => {
    const report = compareCustomsClassification({
      fact: factOf([usdLine]),
      expectations: [expectation({ expectedKind: 'TAX' })],
    });
    expect(report.items.map((item) => item.code)).toEqual(['KIND_MISMATCH']);
  });

  it('同 rawCode 不同币种 → CURRENCY_MISMATCH（不跨币种比较金额）', () => {
    const report = compareCustomsClassification({
      fact: factOf([usdLine]),
      expectations: [expectation({ currency: 'CAD' })],
    });
    expect(report.items.map((item) => item.code)).toEqual(['CURRENCY_MISMATCH']);
    expect(report.matchedLineCount).toBe(0);
    expect(report.items[0].deltaAmount).toBeNull();
  });

  it('事实行缺预期 → MISSING_EXPECTATION；预期无对应行 → UNMATCHED_EXPECTATION', () => {
    const missing = compareCustomsClassification({ fact: factOf([usdLine]), expectations: [expectation({ lineRawCode: 'DUTY-9999' })] });
    expect(missing.items.map((item) => item.code).sort()).toEqual(['MISSING_EXPECTATION', 'UNMATCHED_EXPECTATION']);

    const extra = compareCustomsClassification({
      fact: factOf([usdLine]),
      expectations: [expectation(), expectation({ lineRawCode: 'DUTY-0002' })],
    });
    expect(extra.items.map((item) => item.code)).toEqual(['UNMATCHED_EXPECTATION']);
    expect(extra.matchedLineCount).toBe(1);
  });

  it('无任何预期数据 → NO_EXPECTATION_DATA（单条，不伪造逐行差异）', () => {
    const report = compareCustomsClassification({ fact: factOf([usdLine]), expectations: [] });
    expect(report.items.map((item) => item.code)).toEqual(['NO_EXPECTATION_DATA']);
    expect(report.discrepanciesFound).toBe(true);
    expect(report.matchedLineCount).toBe(0);
  });

  it('预期输入非法 → fail-closed（形状 / 金额 / 重复键 / 未知值）', () => {
    expect(codeOf(factOf([usdLine]), [null])).toBe('INVALID_EXPECTATION');
    expect(codeOf(factOf([usdLine]), [expectation({ expectedAmount: 'abc' })])).toBe('INVALID_AMOUNT_IN_EXPECTATION');
    expect(codeOf(factOf([usdLine]), [expectation({ currency: 'usd' })])).toBe('INVALID_EXPECTATION');
    const badKind = { ...expectation(), expectedKind: 'EXCISE' } as unknown as CustomsRateExpectation;
    const badSource = { ...expectation(), source: 'GUESS' } as unknown as CustomsRateExpectation;
    expect(codeOf(factOf([usdLine]), [badKind])).toBe('INVALID_EXPECTATION');
    expect(codeOf(factOf([usdLine]), [badSource])).toBe('INVALID_EXPECTATION');
    expect(codeOf(factOf([usdLine]), [expectation(), expectation()])).toBe('DUPLICATE_EXPECTATION_KEY');
    expect(codeOf(factOf([usdLine]), 'none')).toBe('INVALID_EXPECTATION');
  });

  it('非只读事实 → NOT_A_READ_ONLY_FACT', () => {
    const fact = factOf([usdLine]);
    expect(codeOf({ ...fact, readOnly: false }, [expectation()])).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf({ ...fact, filingPerformed: true }, [expectation()])).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf(null, [expectation()])).toBe('NOT_A_READ_ONLY_FACT');
  });

  it('确定性：同一输入两次比对结果完全一致', () => {
    const fact = factOf([
      usdLine,
      { kind: 'TAX', rawCode: 'MPF', amount: '30.50', currency: 'USD' },
    ]);
    const expectations = [expectation(), expectation({ lineRawCode: 'MPF', expectedKind: 'TAX', expectedAmount: '30.00', htsCode: 'MPF-1' })];
    const first = compareCustomsClassification({ fact, expectations });
    const second = compareCustomsClassification({ fact, expectations });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.items.map((item) => item.code)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('subtractDecimalStrings 精确 + 最少 2 位小数', () => {
    expect(subtractDecimalStrings('100.00', '30.00')).toBe('70.00');
    expect(subtractDecimalStrings('0.10', '0.20')).toBe('-0.10');
    expect(subtractDecimalStrings('1000000000.00', '999999999.99')).toBe('0.01');
  });

  it('边界：不裁决 / 不推导金额 / 无 FX / 无 filing / 无 payment', () => {
    const report = compareCustomsClassification({ fact: factOf([usdLine]), expectations: [expectation()] });
    expect(report.adjudicationPerformed).toBe(false);
    expect(report.recoverableAmountDerived).toBe(false);
    expect(report.appliesFxConversion).toBe(false);
    expect(report.filingPerformed).toBe(false);
    expect(report.paymentPerformed).toBe(false);
    expect(report.productionCredentials).toBe('ABSENT');
    expect(report).not.toHaveProperty('recoverableAmount');
    expect(CUSTOMS_DISCREPANCY_CODES).toHaveLength(6);
  });

  it('C1 → C2 → C3 端到端：与真值一致的预期不产生差异', () => {
    const fact = factOf([
      { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '1200.00', currency: 'USD' },
      { kind: 'TAX', rawCode: 'MPF', amount: '30.50', currency: 'USD' },
    ]);
    const truth = computeCustomsDutyTruth(fact);
    const report = compareCustomsClassification({
      fact,
      expectations: [
        expectation({ expectedAmount: '1200.00' }),
        expectation({ lineRawCode: 'MPF', htsCode: 'MPF-1', expectedKind: 'TAX', expectedAmount: truth.currencies[0].byKind.TAX as string }),
      ],
    });
    expect(report.discrepanciesFound).toBe(false);
    expect(report.matchedLineCount).toBe(2);
  });
});
