/**
 * CUSTOMS GAP G4 / C2（MASTER GAP CLOSURE）— Duty Calculation Truth 回归。
 * 断言：只读事实守卫（fail-closed）、每 kind / 每币种确定性合计、不跨币种相加、异常观察项、
 *       无裁决 / 无 recoverable amount / 无 FX、确定性、与 C1 契约端到端一致。
 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_ENTRY_SOURCES,
  normalizeCustomsEntryFact,
  type CustomsEntryFact,
} from '../services/customs/customs-entry-contract';
import {
  CUSTOMS_DUTY_OBSERVATIONS,
  CustomsDutyTruthError,
  computeCustomsDutyTruth,
} from '../services/customs/customs-duty-truth';

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

function codeOf(fact: unknown): string {
  try {
    computeCustomsDutyTruth(fact as CustomsEntryFact);
  } catch (error) {
    return error instanceof CustomsDutyTruthError ? error.code : 'NOT_A_DUTY_TRUTH_ERROR';
  }
  return 'NO_ERROR';
}

describe('computeCustomsDutyTruth', () => {
  it('单币种多 kind → byKind 与 total 确定性合计', () => {
    const truth = computeCustomsDutyTruth(
      factOf([
        { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '1200.00', currency: 'USD' },
        { kind: 'DUTY', rawCode: 'DUTY-9902', amount: '100.00', currency: 'USD' },
        { kind: 'TAX', rawCode: 'MPF', amount: '30.50', currency: 'USD' },
        { kind: 'INTEREST', rawCode: 'INT-1', amount: '5.25', currency: 'USD' },
      ]),
    );

    expect(truth.currencies).toHaveLength(1);
    const usd = truth.currencies[0];
    expect(usd.currency).toBe('USD');
    expect(usd.lineCount).toBe(4);
    expect(usd.byKind.DUTY).toBe('1300.00');
    expect(usd.byKind.TAX).toBe('30.50');
    expect(usd.byKind.FEE).toBeNull();
    expect(usd.byKind.INTEREST).toBe('5.25');
    expect(usd.byKind.OTHER).toBeNull();
    expect(usd.totalAmount).toBe('1335.75');
    expect(usd.declaredTotalAmount).toBe('1335.75');
    expect(truth.observations).toEqual([]);
  });

  it('空 dutyLines → EMPTY_ENTRY（不伪造合计）', () => {
    const truth = computeCustomsDutyTruth(factOf([]));
    expect(truth.currencies).toEqual([]);
    expect(truth.dutyLineRefs).toEqual([]);
    expect(truth.observations).toEqual(['EMPTY_ENTRY']);
  });

  it('只有 TAX 没有 DUTY → NO_DUTY_LINE', () => {
    const truth = computeCustomsDutyTruth(factOf([{ kind: 'TAX', rawCode: 'MPF', amount: '30.50', currency: 'USD' }]));
    expect(truth.observations).toContain('NO_DUTY_LINE');
    expect(truth.currencies[0].byKind.DUTY).toBeNull();
  });

  it('负额 / 零额 / 重复 raw code / OTHER kind → 对应观察项（合计仍精确）', () => {
    const truth = computeCustomsDutyTruth(
      factOf([
        { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' },
        { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' },
        { kind: 'FEE', rawCode: 'ADJ-1', amount: '-25.00', currency: 'USD' },
        { kind: 'OTHER', rawCode: 'MISC', amount: '0.00', currency: 'USD' },
      ]),
    );
    expect(truth.observations).toContain('NEGATIVE_AMOUNT_LINE');
    expect(truth.observations).toContain('ZERO_AMOUNT_LINE');
    expect(truth.observations).toContain('DUPLICATE_RAW_CODE');
    expect(truth.observations).toContain('OTHER_KIND_PRESENT');
    expect(truth.currencies[0].totalAmount).toBe('175.00');
  });

  it('declared total 与计算不一致 → DUTY_TOTAL_MISMATCH（不覆盖计算值）', () => {
    const fact = factOf([{ kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' }]);
    const tampered: CustomsEntryFact = { ...fact, totalDutyAmountByCurrency: { USD: '101.00' } };
    const truth = computeCustomsDutyTruth(tampered);
    expect(truth.observations).toContain('DUTY_TOTAL_MISMATCH');
    expect(truth.currencies[0].totalAmount).toBe('100.00');
    expect(truth.currencies[0].declaredTotalAmount).toBe('101.00');
  });

  it('多币种事实 → 逐币种独立合计，绝不跨币种相加', () => {
    const fact = factOf([{ kind: 'DUTY', rawCode: 'DUTY-USD', amount: '100.00', currency: 'USD' }]);
    const multi: CustomsEntryFact = {
      ...fact,
      dutyLines: [
        { kind: 'DUTY', rawCode: 'DUTY-USD', amount: '100.00', currency: 'USD' },
        { kind: 'DUTY', rawCode: 'DUTY-CAD', amount: '50.00', currency: 'CAD' },
      ],
      totalDutyAmountByCurrency: { CAD: '50.00', USD: '100.00' },
    };
    const truth = computeCustomsDutyTruth(multi);
    expect(truth.currencies.map((entry) => entry.currency)).toEqual(['CAD', 'USD']);
    expect(truth.currencies[0].totalAmount).toBe('50.00');
    expect(truth.currencies[1].totalAmount).toBe('100.00');
    expect(truth.currencies[0].declaredTotalAmount).toBe('50.00');
    expect(truth.currencies[1].declaredTotalAmount).toBe('100.00');
    expect(truth.observations).toEqual(['MULTI_CURRENCY_FACT']);
  });

  it('非只读事实（readOnly / filing / payment / 生产凭据）→ NOT_A_READ_ONLY_FACT', () => {
    const fact = factOf([{ kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' }]);
    expect(codeOf({ ...fact, readOnly: false })).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf({ ...fact, filingPerformed: true })).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf({ ...fact, paymentPerformed: true })).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf({ ...fact, productionCredentials: 'PRESENT' })).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf(null)).toBe('NOT_A_READ_ONLY_FACT');
  });

  it('事实内金额 / kind / 币种非法 → INVALID_AMOUNT_IN_FACT / INVALID_DUTY_LINE_IN_FACT', () => {
    const fact = factOf([{ kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' }]);
    expect(codeOf({ ...fact, dutyLines: [{ kind: 'DUTY', rawCode: 'X', amount: 'abc', currency: 'USD' }] })).toBe(
      'INVALID_AMOUNT_IN_FACT',
    );
    expect(codeOf({ ...fact, dutyLines: [{ kind: 'EXCISE', rawCode: 'X', amount: '1.00', currency: 'USD' }] })).toBe(
      'INVALID_DUTY_LINE_IN_FACT',
    );
    expect(codeOf({ ...fact, dutyLines: [{ kind: 'DUTY', rawCode: 'X', amount: '1.00', currency: 'usd' }] })).toBe(
      'INVALID_DUTY_LINE_IN_FACT',
    );
    expect(codeOf({ ...fact, dutyLines: 'none' })).toBe('INVALID_DUTY_LINE_IN_FACT');
  });

  it('确定性：同一事实两次计算结果完全一致（含观察项顺序）', () => {
    const fact = factOf([
      { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' },
      { kind: 'OTHER', rawCode: 'MISC', amount: '0.00', currency: 'USD' },
    ]);
    const first = computeCustomsDutyTruth(fact);
    const second = computeCustomsDutyTruth(fact);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('C1 → C2 端到端：合计与 C1 声明一致', () => {
    const fact = factOf([
      { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '1200.00', currency: 'USD' },
      { kind: 'TAX', rawCode: 'MPF', amount: '30.50', currency: 'USD' },
    ]);
    const truth = computeCustomsDutyTruth(fact);
    expect(truth.currencies[0].totalAmount).toBe(fact.totalDutyAmountByCurrency.USD);
    expect(truth.observations).not.toContain('DUTY_TOTAL_MISMATCH');
    expect(CUSTOMS_ENTRY_SOURCES).toContain('ABI_VENDOR');
  });

  it('边界：无裁决 / 无 recoverable amount / 无 FX / 无 filing / 无 payment', () => {
    const truth = computeCustomsDutyTruth(factOf([{ kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' }]));
    expect(truth.calculationPerformed).toBe(true);
    expect(truth.adjudicationPerformed).toBe(false);
    expect(truth.recoverableAmountDerived).toBe(false);
    expect(truth.appliesFxConversion).toBe(false);
    expect(truth.filingPerformed).toBe(false);
    expect(truth.paymentPerformed).toBe(false);
    expect(truth.productionCredentials).toBe('ABSENT');
    expect(truth).not.toHaveProperty('recoverableAmount');
    expect(truth).not.toHaveProperty('eligibility');
    expect(CUSTOMS_DUTY_OBSERVATIONS).toHaveLength(8);
  });
});
