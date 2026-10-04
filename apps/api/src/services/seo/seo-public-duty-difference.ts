/**
 * SEO-3 / MSG-20261005-06 items (3) and (4): DUTY_DIFFERENCE calculation.
 *
 * The verdict rejected the earlier proposal that took the user's own
 * "refundable amount" as input and echoed it back (a circular estimate).
 * Here the inputs are the two amounts a declarant actually knows:
 *   dutyPaidAmount        - duty actually paid
 *   dutyActuallyDueAmount - duty that should have been due
 * and the engine derives  difference = max(0, paid - due)  itself.
 *
 * Item (4): the result is a POINT estimate (min === max). No artificial range,
 * no success rate, no historical ratio is ever added.
 *
 * Honesty rules carried in the output:
 *   - estimateLabel = SELF_REPORTED_POINT_ESTIMATE
 *   - disclaimerKey = seo.disclaimer.estimateOnly
 *   - a non-positive difference yields estimate = null (never 0, never negative)
 *
 * Registration is deliberately NOT performed here: per the verdict the engine
 * may only be registered for a rule whose calculation method can genuinely be
 * explained as paid-minus-due. Until that is confirmed for the customs rule the
 * registry stays empty and the public surface keeps answering fail-closed.
 */

import type { PublicInputSchema } from './seo-public-input-schema';
import type { SeoPublicAnswerValue, SeoPublicCalculationOutcome } from './seo-public-checker';

export const SEO_PUBLIC_DUTY_DIFFERENCE_BASIS_KEY = 'engine:customs-duty-difference';
export const SEO_PUBLIC_POINT_ESTIMATE_LABEL = 'SELF_REPORTED_POINT_ESTIMATE' as const;
export const SEO_PUBLIC_ESTIMATE_DISCLAIMER_KEY = 'seo.disclaimer.estimateOnly' as const;

/** Amount ceiling for a self-reported duty figure (schema-driven, not a guess). */
export const SEO_PUBLIC_MAX_DUTY_AMOUNT = 10_000_000;

export function buildDutyDifferenceInputSchema(): PublicInputSchema {
  return {
    allowEmpty: false,
    fields: {
      dutyPaidAmount: { kind: 'number', min: 0, max: SEO_PUBLIC_MAX_DUTY_AMOUNT, required: true },
      dutyActuallyDueAmount: { kind: 'number', min: 0, max: SEO_PUBLIC_MAX_DUTY_AMOUNT, required: true },
      currency: { kind: 'enum', options: ['USD', 'EUR', 'GBP', 'JPY', 'CNY'], required: true },
    },
  };
}

const readAmount = (answers: Record<string, SeoPublicAnswerValue>, key: string): number | null => {
  const value = answers[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};

/**
 * Pure derivation. Returns null when the inputs are unusable OR when the
 * difference is not positive - in both cases the caller must show no estimate.
 */
export function computeDutyDifference(
  answers: Record<string, SeoPublicAnswerValue>,
): { difference: number; currency: string } | null {
  const paid = readAmount(answers, 'dutyPaidAmount');
  const due = readAmount(answers, 'dutyActuallyDueAmount');
  const currency = answers.currency;
  if (paid === null || due === null) return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  const difference = Math.max(0, paid - due);
  if (difference <= 0) return null;
  return { difference, currency };
}

/**
 * Build the calculation outcome for the public checker. Point estimate only:
 * min and max are both the derived difference.
 */
export function runDutyDifferenceCalculation(
  answers: Record<string, SeoPublicAnswerValue>,
): SeoPublicCalculationOutcome {
  const derived = computeDutyDifference(answers);
  if (derived === null) {
    return {
      estimate: null,
      basisKey: SEO_PUBLIC_DUTY_DIFFERENCE_BASIS_KEY,
      disclaimerKey: SEO_PUBLIC_ESTIMATE_DISCLAIMER_KEY,
    };
  }
  return {
    estimate: { min: derived.difference, max: derived.difference, currency: derived.currency },
    basisKey: SEO_PUBLIC_DUTY_DIFFERENCE_BASIS_KEY,
    disclaimerKey: SEO_PUBLIC_ESTIMATE_DISCLAIMER_KEY,
  };
}

export const SEO_PUBLIC_DUTY_DIFFERENCE_BOUNDARY = {
  /** The old circular model (user-supplied refundable amount) is gone. */
  circularRefundableInput: false,
  /** min === max; nothing is padded to look like a range. */
  artificialRange: false,
  successRateUsed: false,
  historicalRatioUsed: false,
  nonPositiveYieldsNull: true,
  estimateLabel: SEO_PUBLIC_POINT_ESTIMATE_LABEL,
  registered: false,
  externalWritePerformed: false,
  tenantDataIncluded: false,
} as const;
