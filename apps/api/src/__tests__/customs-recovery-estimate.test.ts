/**
 * CUSTOMS GAP G4 / C5（MASTER GAP CLOSURE）— Estimated Recoverable Amount 回归。
 * 断言：仅 ELIGIBLE 估算、保守向下取整、cap / min 语义、逐币种独立、缺政策 fail-closed、
 *       estimateOnly 且不可计费、确定性、边界常量。
 */

import { describe, expect, it } from 'vitest';

import { normalizeCustomsEntryFact, type CustomsEntryFact } from '../services/customs/customs-entry-contract';
import { computeCustomsDutyTruth } from '../services/customs/customs-duty-truth';
import { compareCustomsClassification, type CustomsRateExpectation } from '../services/customs/customs-classification-discrepancy';
import { evaluateCustomsEligibility, type CustomsEligibilityPolicy } from '../services/customs/customs-recovery-eligibility';
import {
  CUSTOMS_ESTIMATE_REASONS,
  CustomsEstimateError,
  estimateCustomsRecovery,
  floorToCent,
  multiplyDecimalStrings,
  type CustomsEstimatePolicy,
} from '../services/customs/customs-recovery-estimate';

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
    expectedAmount: '70.00',
    currency: 'USD',
    source: 'RATE_TABLE',
    reference: 'rate-table:2026-Q3',
    ...overrides,
  };
}

function eligibilityPolicy(overrides: Partial<CustomsEligibilityPolicy> = {}): CustomsEligibilityPolicy {
  return {
    policyId: 'customs-us-2026',
    policyVersion: '1.0.0',
    jurisdiction: 'US',
    allowedSources: ['ABI_VENDOR'],
    maxEntryAgeDays: 365,
    requiredDiscrepancyCodes: ['AMOUNT_MISMATCH'],
    minDisputedAmountByCurrency: { USD: '10.00' },
    allowOtherKindLines: true,
    ...overrides,
  };
}

function estimatePolicy(overrides: Partial<CustomsEstimatePolicy> = {}): CustomsEstimatePolicy {
  return {
    policyId: 'customs-estimate-2026',
    policyVersion: '1.0.0',
    ratioByCurrency: { USD: '1.00' },
    capByCurrency: { USD: '10000.00' },
    minEstimateByCurrency: { USD: '1.00' },
    ...overrides,
  };
}

const line = { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' };

function estimateWith(
  fact: CustomsEntryFact,
  expectations: readonly CustomsRateExpectation[],
  estimateOverrides: Partial<CustomsEstimatePolicy> = {},
  eligibilityOverrides: Partial<CustomsEligibilityPolicy> = {},
) {
  const discrepancy = compareCustomsClassification({ fact, expectations });
  return estimateCustomsRecovery({
    fact,
    assessment: evaluateCustomsEligibility({
      fact,
      truth: computeCustomsDutyTruth(fact),
      discrepancy,
      policy: eligibilityPolicy(eligibilityOverrides),
    }),
    discrepancy,
    policy: estimatePolicy(estimateOverrides),
  });
}

function codeOf(input: Record<string, unknown>): string {
  try {
    estimateCustomsRecovery(input as never);
  } catch (error) {
    return error instanceof CustomsEstimateError ? error.code : 'NOT_AN_ESTIMATE_ERROR';
  }
  return 'NO_ERROR';
}

describe('estimateCustomsRecovery', () => {
  it('ELIGIBLE + ratio 1.00 → 估算等于争议金额（estimateOnly，不产生账单）', () => {
    const estimate = estimateWith(factOf([line]), [expectation()]);
    expect(estimate.status).toBe('ESTIMATED');
    expect(estimate.byCurrency).toHaveLength(1);
    expect(estimate.byCurrency[0].disputedAmount).toBe('30.00');
    expect(estimate.byCurrency[0].estimatedAmount).toBe('30.00');
    expect(estimate.estimateOnly).toBe(true);
    expect(estimate.billable).toBe(false);
    expect(estimate.reasons.map((reason) => reason.code)).toEqual(['OK']);
  });

  it('ratio < 1 → 保守向下取整（不向上放大）', () => {
    const half = estimateWith(factOf([line]), [expectation()], { ratioByCurrency: { USD: '0.50' } });
    expect(half.byCurrency[0].estimatedAmount).toBe('15.00');

    const third = estimateWith(factOf([line]), [expectation()], { ratioByCurrency: { USD: '0.333' } });
    expect(third.byCurrency[0].estimatedAmount).toBe('9.99');
  });

  it('cap 生效 → capped=true 且取 cap', () => {
    const estimate = estimateWith(factOf([line]), [expectation()], { capByCurrency: { USD: '5.00' } });
    expect(estimate.byCurrency[0].estimatedAmount).toBe('5.00');
    expect(estimate.byCurrency[0].capped).toBe(true);
    expect(estimate.reasons.map((reason) => reason.code)).toContain('CAPPED_AT_POLICY_LIMIT');
  });

  it('低于最小估算 → 估算归零并记录 BELOW_MIN_ESTIMATE（不虚增）', () => {
    const estimate = estimateWith(factOf([line]), [expectation()], { minEstimateByCurrency: { USD: '50.00' } });
    expect(estimate.byCurrency[0].estimatedAmount).toBe('0.00');
    expect(estimate.byCurrency[0].belowMinimum).toBe(true);
    expect(estimate.reasons.map((reason) => reason.code)).toContain('BELOW_MIN_ESTIMATE');
  });

  it('NOT_ELIGIBLE 输入 → NOT_ESTIMATED 且不产出任何金额', () => {
    const estimate = estimateWith(factOf([line]), [expectation()], {}, { allowedSources: ['BROKER_DOCUMENT'] });
    expect(estimate.status).toBe('NOT_ESTIMATED');
    expect(estimate.byCurrency).toEqual([]);
    expect(estimate.reasons.map((reason) => reason.code)).toEqual(['NOT_ELIGIBLE_INPUT']);
  });

  it('INDETERMINATE 输入 → INDETERMINATE（不猜测金额）', () => {
    const estimate = estimateWith(factOf([line]), [expectation()], {}, { minDisputedAmountByCurrency: {} });
    expect(estimate.status).toBe('INDETERMINATE');
    expect(estimate.byCurrency).toEqual([]);
    expect(estimate.reasons.map((reason) => reason.code)).toEqual(['ELIGIBILITY_INDETERMINATE']);
  });

  it('无 AMOUNT_MISMATCH → NO_DISPUTED_AMOUNT（不产出金额）', () => {
    const estimate = estimateWith(
      factOf([line]),
      [expectation({ expectedAmount: '100.00' })],
      {},
      { requiredDiscrepancyCodes: [], minDisputedAmountByCurrency: { USD: '0.00' } },
    );
    expect(estimate.status).toBe('NOT_ESTIMATED');
    expect(estimate.reasons.map((reason) => reason.code)).toEqual(['NO_DISPUTED_AMOUNT']);
  });

  it('政策缺 ratio / cap → INDETERMINATE fail-closed', () => {
    const missingRatio = estimateWith(factOf([line]), [expectation()], { ratioByCurrency: {} });
    expect(missingRatio.status).toBe('INDETERMINATE');
    expect(missingRatio.reasons.map((reason) => reason.code)).toContain('RATIO_NOT_DEFINED_FOR_CURRENCY');

    const missingCap = estimateWith(factOf([line]), [expectation()], { capByCurrency: {} });
    expect(missingCap.status).toBe('INDETERMINATE');
    expect(missingCap.reasons.map((reason) => reason.code)).toContain('CAP_NOT_DEFINED_FOR_CURRENCY');
  });

  it('多币种 → 逐币种独立估算，绝不合并', () => {
    const fact = factOf([line]);
    const multi: CustomsEntryFact = {
      ...fact,
      dutyLines: [
        { kind: 'DUTY', rawCode: 'DUTY-9901', amount: '100.00', currency: 'USD' },
        { kind: 'DUTY', rawCode: 'DUTY-9902', amount: '80.00', currency: 'CAD' },
      ],
      totalDutyAmountByCurrency: { CAD: '80.00', USD: '100.00' },
    };
    const estimate = estimateWith(
      multi,
      [expectation(), expectation({ lineRawCode: 'DUTY-9902', currency: 'CAD', expectedAmount: '50.00' })],
      { ratioByCurrency: { USD: '1.00', CAD: '0.50' }, capByCurrency: { USD: '10000.00', CAD: '10000.00' } },
      { minDisputedAmountByCurrency: { USD: '10.00', CAD: '10.00' } },
    );
    expect(estimate.status).toBe('ESTIMATED');
    expect(estimate.byCurrency.map((entry) => entry.currency)).toEqual(['CAD', 'USD']);
    expect(estimate.byCurrency[0].estimatedAmount).toBe('15.00');
    expect(estimate.byCurrency[1].estimatedAmount).toBe('30.00');
  });

  it('政策非法 → fail-closed（ratio 越界 / cap 负数 / 形状非法）', () => {
    const fact = factOf([line]);
    const discrepancy = compareCustomsClassification({ fact, expectations: [expectation()] });
    const base = {
      fact,
      assessment: evaluateCustomsEligibility({
        fact,
        truth: computeCustomsDutyTruth(fact),
        discrepancy,
        policy: eligibilityPolicy(),
      }),
      discrepancy,
    };
    expect(codeOf({ ...base, policy: null })).toBe('INVALID_POLICY');
    expect(codeOf({ ...base, policy: estimatePolicy({ ratioByCurrency: { USD: '1.50' } }) })).toBe('INVALID_RATIO');
    expect(codeOf({ ...base, policy: estimatePolicy({ capByCurrency: { USD: '-1.00' } }) })).toBe('INVALID_CAP');
    expect(codeOf({ ...base, policy: estimatePolicy({ minEstimateByCurrency: { USD: '-1.00' } }) })).toBe('INVALID_MIN_ESTIMATE');
  });

  it('非只读事实 → NOT_A_READ_ONLY_FACT', () => {
    const fact = factOf([line]);
    const discrepancy = compareCustomsClassification({ fact, expectations: [expectation()] });
    const assessment = evaluateCustomsEligibility({
      fact,
      truth: computeCustomsDutyTruth(fact),
      discrepancy,
      policy: eligibilityPolicy(),
    });
    expect(codeOf({ fact: { ...fact, readOnly: false }, assessment, discrepancy, policy: estimatePolicy() })).toBe(
      'NOT_A_READ_ONLY_FACT',
    );
  });

  it('确定性：同一输入两次估算完全一致', () => {
    const first = estimateWith(factOf([line]), [expectation()]);
    const second = estimateWith(factOf([line]), [expectation()]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('十进制工具：乘法向下截断 / floorToCent 保守', () => {
    expect(multiplyDecimalStrings('30.00', '0.333')).toBe('9.99');
    expect(multiplyDecimalStrings('0.10', '0.50')).toBe('0.05');
    expect(floorToCent('9.999999')).toBe('9.99');
    expect(floorToCent('0.001')).toBe('0.00');
  });

  it('边界：估算不可计费 / 不产生最终金额 / 无 FX / 无 filing / 无 payment', () => {
    const estimate = estimateWith(factOf([line]), [expectation()]);
    expect(estimate.estimateOnly).toBe(true);
    expect(estimate.finalAmountDerived).toBe(false);
    expect(estimate.billable).toBe(false);
    expect(estimate.feeDerived).toBe(false);
    expect(estimate.appliesFxConversion).toBe(false);
    expect(estimate.filingPerformed).toBe(false);
    expect(estimate.paymentPerformed).toBe(false);
    expect(estimate.productionCredentials).toBe('ABSENT');
    expect(estimate).not.toHaveProperty('billableAmount');
    expect(estimate).not.toHaveProperty('successFee');
    expect(CUSTOMS_ESTIMATE_REASONS).toHaveLength(8);
  });
});
