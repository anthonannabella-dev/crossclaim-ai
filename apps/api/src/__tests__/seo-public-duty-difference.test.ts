/**
 * MSG-20261005-06 items (3) and (4): derive the difference instead of echoing a
 * user-supplied refundable amount, and never pad the result into a range.
 */

import { describe, expect, it } from 'vitest';

import {
  buildDutyDifferenceInputSchema,
  computeDutyDifference,
  runDutyDifferenceCalculation,
  SEO_PUBLIC_DUTY_DIFFERENCE_BOUNDARY,
  SEO_PUBLIC_ESTIMATE_DISCLAIMER_KEY,
  SEO_PUBLIC_POINT_ESTIMATE_LABEL,
} from '../services/seo/seo-public-duty-difference';

describe('SEO-3 DUTY_DIFFERENCE engine', () => {
  it('DERIVES_THE_DIFFERENCE: paid - actually due, not an echoed input', () => {
    expect(computeDutyDifference({ dutyPaidAmount: 10000, dutyActuallyDueAmount: 6000, currency: 'USD' })).toEqual({
      difference: 4000,
      currency: 'USD',
    });
  });

  it('POINT_ESTIMATE_ONLY: min equals max, with the estimate-only disclaimer', () => {
    const outcome = runDutyDifferenceCalculation({
      dutyPaidAmount: 10000,
      dutyActuallyDueAmount: 6000,
      currency: 'EUR',
    });
    expect(outcome.estimate).toEqual({ min: 4000, max: 4000, currency: 'EUR' });
    expect(outcome.disclaimerKey).toBe(SEO_PUBLIC_ESTIMATE_DISCLAIMER_KEY);
  });

  it('NON_POSITIVE_YIELDS_NULL: overpaid-by-nothing or underpaid => no estimate', () => {
    expect(runDutyDifferenceCalculation({ dutyPaidAmount: 500, dutyActuallyDueAmount: 500, currency: 'USD' }).estimate).toBeNull();
    expect(runDutyDifferenceCalculation({ dutyPaidAmount: 500, dutyActuallyDueAmount: 900, currency: 'USD' }).estimate).toBeNull();
  });

  it('UNUSABLE_INPUT_YIELDS_NULL: missing, negative or non-finite values never fabricate a number', () => {
    expect(runDutyDifferenceCalculation({ dutyPaidAmount: 100, currency: 'USD' }).estimate).toBeNull();
    expect(runDutyDifferenceCalculation({ dutyPaidAmount: -1, dutyActuallyDueAmount: 0, currency: 'USD' }).estimate).toBeNull();
    expect(runDutyDifferenceCalculation({ dutyPaidAmount: 100, dutyActuallyDueAmount: 0, currency: 'usd' }).estimate).toBeNull();
  });

  it('NO_ARTIFICIAL_RANGE: exactly one derived number is reported', () => {
    const outcome = runDutyDifferenceCalculation({ dutyPaidAmount: 1000, dutyActuallyDueAmount: 250, currency: 'GBP' });
    expect(outcome.estimate).not.toBeNull();
    expect(outcome.estimate!.min).toBe(outcome.estimate!.max);
    expect(SEO_PUBLIC_DUTY_DIFFERENCE_BOUNDARY.artificialRange).toBe(false);
    expect(SEO_PUBLIC_DUTY_DIFFERENCE_BOUNDARY.successRateUsed).toBe(false);
    expect(SEO_PUBLIC_DUTY_DIFFERENCE_BOUNDARY.historicalRatioUsed).toBe(false);
  });

  it('CIRCULAR_MODEL_IS_GONE: refundableAmount is no longer an accepted input', () => {
    const schema = buildDutyDifferenceInputSchema();
    expect(Object.keys(schema.fields).sort()).toEqual(['currency', 'dutyActuallyDueAmount', 'dutyPaidAmount']);
    expect(SEO_PUBLIC_DUTY_DIFFERENCE_BOUNDARY.circularRefundableInput).toBe(false);
  });

  it('SCHEMA_REQUIRES_ALL_THREE_INPUTS', () => {
    const schema = buildDutyDifferenceInputSchema();
    expect(schema.allowEmpty).toBe(false);
    expect(schema.fields.dutyPaidAmount.required).toBe(true);
    expect(schema.fields.dutyActuallyDueAmount.required).toBe(true);
    expect(schema.fields.currency.required).toBe(true);
  });

  it('NOT_REGISTERED_YET: engine stays unregistered until the rule genuinely supports it', () => {
    expect(SEO_PUBLIC_DUTY_DIFFERENCE_BOUNDARY.registered).toBe(false);
    expect(SEO_PUBLIC_POINT_ESTIMATE_LABEL).toBe('SELF_REPORTED_POINT_ESTIMATE');
  });
});
