/**
 * CUSTOMS GAP G4 / C4（MASTER GAP CLOSURE）— Customs Recovery Eligibility 回归。
 * 断言：确定性政策判定（ELIGIBLE / NOT_ELIGIBLE / INDETERMINATE）、原因码、时效、来源白名单、
 *       最小争议金额、缺阈值 fail-closed、观察金额不跨币种合并、政策校验 fail-closed、只读事实守卫、确定性。
 */

import { describe, expect, it } from 'vitest';

import { normalizeCustomsEntryFact, type CustomsEntryFact } from '../services/customs/customs-entry-contract';
import { computeCustomsDutyTruth } from '../services/customs/customs-duty-truth';
import {
  compareCustomsClassification,
  type CustomsRateExpectation,
} from '../services/customs/customs-classification-discrepancy';
import {
  CUSTOMS_ELIGIBILITY_REASONS,
  CustomsEligibilityError,
  evaluateCustomsEligibility,
  type CustomsEligibilityPolicy,
} from '../services/customs/customs-recovery-eligibility';

function factOf(
  dutyLines: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): CustomsEntryFact {
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
    ...overrides,
  });
}

function expectation(overrides: Partial<CustomsRateExpectation> = {}): CustomsRateExpectation {
  return {
    lineRawCode: 'DUTY-9901',
    htsCode: '9901.00.10',
    expectedKind: 'DUTY',
    expectedAmount: '70.00',
    currency: 'USD',
    source: 'RATE_TABLE',
    reference: 'rate-table:2026-Q3',
    ...overrides,
  };
}

function policy(overrides: Partial<CustomsEligibilityPolicy> = {}): CustomsEligibilityPolicy {
  return {
    policyId: 'customs-us-2026',
    policyVersion: '1.0.0',
    jurisdiction: 'US',
    allowedSources: ['ABI_VENDOR', 'BROKER_DOCUMENT'],
    maxEntryAgeDays: 365,
    requiredDiscrepancyCodes: ['AMOUNT_MISMATCH'],
    minDisputedAmountByCurrency: { USD: '10.00' },
    allowOtherKindLines: true,
    ...overrides,
  };
}

const line = { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' };

function evaluateWith(
  fact: CustomsEntryFact,
  expectations: readonly CustomsRateExpectation[],
  policyOverrides: Partial<CustomsEligibilityPolicy> = {},
) {
  return evaluateCustomsEligibility({
    fact,
    truth: computeCustomsDutyTruth(fact),
    discrepancy: compareCustomsClassification({ fact, expectations }),
    policy: policy(policyOverrides),
  });
}

function codeOf(input: Record<string, unknown>): string {
  try {
    evaluateCustomsEligibility(input as never);
  } catch (error) {
    return error instanceof CustomsEligibilityError ? error.code : 'NOT_AN_ELIGIBILITY_ERROR';
  }
  return 'NO_ERROR';
}

describe('evaluateCustomsEligibility', () => {
  it('满足政策 → ELIGIBLE + OK，并给出观察到的差异金额（不是 recoverable amount）', () => {
    const assessment = evaluateWith(factOf([line]), [expectation()]);
    expect(assessment.status).toBe('ELIGIBLE');
    expect(assessment.reasons.map((reason) => reason.code)).toEqual(['OK']);
    expect(assessment.observedDiscrepancyAmountByCurrency).toEqual({ USD: '30.00' });
    expect(assessment.examinedLineCount).toBe(1);
    expect(assessment.entryAgeDays).toBe(1);
  });

  it('来源不在白名单 → NOT_ELIGIBLE SOURCE_NOT_ALLOWED', () => {
    const assessment = evaluateWith(factOf([line]), [expectation()], { allowedSources: ['BROKER_DOCUMENT'] });
    expect(assessment.status).toBe('NOT_ELIGIBLE');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('SOURCE_NOT_ALLOWED');
  });

  it('辖区不支持 → NOT_ELIGIBLE JURISDICTION_NOT_SUPPORTED', () => {
    const assessment = evaluateWith(factOf([line]), [expectation()], { jurisdiction: 'CA' });
    expect(assessment.status).toBe('NOT_ELIGIBLE');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('JURISDICTION_NOT_SUPPORTED');
  });

  it('entry 超时效 → NOT_ELIGIBLE ENTRY_TOO_OLD（entryAgeDays 可审计）', () => {
    const assessment = evaluateWith(factOf([line]), [expectation()], { maxEntryAgeDays: 0 });
    expect(assessment.status).toBe('NOT_ELIGIBLE');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('ENTRY_TOO_OLD');
    expect(assessment.entryAgeDays).toBe(1);
  });

  it('缺少必需差异 → NOT_ELIGIBLE REQUIRED_DISCREPANCY_MISSING', () => {
    const assessment = evaluateWith(factOf([line]), [expectation({ expectedAmount: '100.00' })]);
    expect(assessment.status).toBe('NOT_ELIGIBLE');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('REQUIRED_DISCREPANCY_MISSING');
    expect(assessment.observedDiscrepancyAmountByCurrency).toEqual({});
  });

  it('低于最小争议金额 → NOT_ELIGIBLE BELOW_MIN_DISPUTED_AMOUNT', () => {
    const assessment = evaluateWith(factOf([line]), [expectation({ expectedAmount: '95.00' })], {
      minDisputedAmountByCurrency: { USD: '10.00' },
    });
    expect(assessment.status).toBe('NOT_ELIGIBLE');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('BELOW_MIN_DISPUTED_AMOUNT');
  });

  it('无 duty line → NOT_ELIGIBLE NO_DUTY_LINES（且不给虚高 status）', () => {
    const assessment = evaluateWith(factOf([]), []);
    expect(assessment.status).toBe('NOT_ELIGIBLE');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('NO_DUTY_LINES');
  });

  it('政策缺该币种阈值 → INDETERMINATE MIN_THRESHOLD_NOT_DEFINED_FOR_CURRENCY', () => {
    const assessment = evaluateWith(factOf([line]), [expectation()], { minDisputedAmountByCurrency: {} });
    expect(assessment.status).toBe('INDETERMINATE');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('MIN_THRESHOLD_NOT_DEFINED_FOR_CURRENCY');
  });

  it('存在 OTHER kind 且政策不允许 → INDETERMINATE OTHER_KIND_LINES_PRESENT', () => {
    const fact = factOf([
      line,
      { kind: 'OTHER', rawCode: 'MISC-1', amount: '20.00', currency: 'USD' },
    ]);
    const assessment = evaluateWith(fact, [expectation()], { allowOtherKindLines: false });
    expect(assessment.status).toBe('INDETERMINATE');
    expect(assessment.reasons.map((reason) => reason.code)).toContain('OTHER_KIND_LINES_PRESENT');
  });

  it('多币种 → 观察金额逐币种独立，绝不合并', () => {
    const fact = factOf([line]);
    const multi: CustomsEntryFact = {
      ...fact,
      dutyLines: [
        { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' },
        { kind: 'DUTY', rawCode: 'DUTY-9902', amount: '80.00', currency: 'CAD' },
      ],
      totalDutyAmountByCurrency: { CAD: '80.00', USD: '100.00' },
    };
    const assessment = evaluateWith(
      multi,
      [expectation(), expectation({ lineRawCode: 'DUTY-9902', currency: 'CAD', expectedAmount: '50.00' })],
      { minDisputedAmountByCurrency: { USD: '10.00', CAD: '10.00' } },
    );
    expect(assessment.status).toBe('ELIGIBLE');
    expect(assessment.observedDiscrepancyAmountByCurrency).toEqual({ CAD: '30.00', USD: '30.00' });
  });

  it('政策非法 / 阈值非法 → fail-closed（不静默默认）', () => {
    const fact = factOf([line]);
    const base = {
      fact,
      truth: computeCustomsDutyTruth(fact),
      discrepancy: compareCustomsClassification({ fact, expectations: [expectation()] }),
    };
    expect(codeOf({ ...base, policy: null })).toBe('INVALID_POLICY');
    expect(codeOf({ ...base, policy: policy({ allowedSources: [] }) })).toBe('INVALID_POLICY');
    expect(codeOf({ ...base, policy: policy({ maxEntryAgeDays: -1 }) })).toBe('INVALID_POLICY');
    expect(codeOf({ ...base, policy: { ...policy(), minDisputedAmountByCurrency: { USD: 'abc' } } })).toBe('INVALID_THRESHOLD_AMOUNT');
  });

  it('非只读事实 / 非法 truth → fail-closed', () => {
    const fact = factOf([line]);
    const base = {
      truth: computeCustomsDutyTruth(fact),
      discrepancy: compareCustomsClassification({ fact, expectations: [expectation()] }),
      policy: policy(),
    };
    expect(codeOf({ ...base, fact: { ...fact, readOnly: false } })).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf({ ...base, fact: null })).toBe('NOT_A_READ_ONLY_FACT');
    expect(codeOf({ ...base, fact, truth: null })).toBe('INVALID_TRUTH');
    expect(codeOf({ ...base, fact, discrepancy: null })).toBe('INVALID_DISCREPANCY_REPORT');
  });

  it('确定性：同一输入两次判定结果完全一致', () => {
    const fact = factOf([line]);
    const first = evaluateWith(fact, [expectation()]);
    const second = evaluateWith(fact, [expectation()]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('边界：确定资格但不产生金额 / 费用 / FX / filing / payment', () => {
    const assessment = evaluateWith(factOf([line]), [expectation()]);
    expect(assessment.eligibilityDetermined).toBe(true);
    expect(assessment.adjudicationPerformed).toBe(false);
    expect(assessment.recoverableAmountDerived).toBe(false);
    expect(assessment.feeDerived).toBe(false);
    expect(assessment.appliesFxConversion).toBe(false);
    expect(assessment.filingPerformed).toBe(false);
    expect(assessment.paymentPerformed).toBe(false);
    expect(assessment.productionCredentials).toBe('ABSENT');
    expect(assessment).not.toHaveProperty('recoverableAmount');
    expect(assessment).not.toHaveProperty('successFee');
    expect(CUSTOMS_ELIGIBILITY_REASONS).toHaveLength(9);
  });
});
