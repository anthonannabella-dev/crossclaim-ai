/**
 * CUSTOMS GAP G4 / C5（MASTER GAP CLOSURE）— Estimated Recoverable Amount（估算，不产生账单事实）。
 * ---------------------------------------------------------------
 * 输入：C1 事实 + C4 资格判定 + C3 差异报告 + 显式估算政策（ratio / cap / min / 取整口径）。
 * 输出：逐币种**估算值**（ESTIMATED）或 NOT_ESTIMATED / INDETERMINATE + 原因码。
 *
 * 硬边界（严格遵守 SUCCESS-FEE-BILLING-REDLINE）：
 *   · estimateOnly=true；billable=false；finalAmountDerived=false；feeDerived=false。
 *   · 估算**不是** recovered truth，也不是账单基数；不得据此收费。
 *   · 只有 C4 = ELIGIBLE 才估算；NOT_ELIGIBLE / INDETERMINATE 一律不产出金额。
 *   · 取整一律**向下**（cent 截断）：估算偏保守，不得向上取整放大。
 *   · 不做 FX 换算；不跨币种合并；无网络 / 无 DB / 无端口。
 */

import { isDecimalString, type CustomsEntryFact } from './customs-entry-contract';
import { assertReadOnlyEntryFact, CustomsDutyTruthError } from './customs-duty-truth';
import type { CustomsEligibilityAssessment } from './customs-recovery-eligibility';

export const CUSTOMS_ESTIMATE_STATUSES = ['ESTIMATED', 'NOT_ESTIMATED', 'INDETERMINATE'] as const;
export type CustomsEstimateStatus = (typeof CUSTOMS_ESTIMATE_STATUSES)[number];

export const CUSTOMS_ESTIMATE_REASONS = [
  'OK',
  'NOT_ELIGIBLE_INPUT',
  'ELIGIBILITY_INDETERMINATE',
  'NO_DISPUTED_AMOUNT',
  'RATIO_NOT_DEFINED_FOR_CURRENCY',
  'CAP_NOT_DEFINED_FOR_CURRENCY',
  'BELOW_MIN_ESTIMATE',
  'CAPPED_AT_POLICY_LIMIT',
] as const;
export type CustomsEstimateReason = (typeof CUSTOMS_ESTIMATE_REASONS)[number];

export const CUSTOMS_ESTIMATE_ERROR_CODES = [
  'NOT_A_READ_ONLY_FACT',
  'INVALID_POLICY',
  'INVALID_RATIO',
  'INVALID_CAP',
  'INVALID_MIN_ESTIMATE',
] as const;
export type CustomsEstimateErrorCode = (typeof CUSTOMS_ESTIMATE_ERROR_CODES)[number];

export class CustomsEstimateError extends Error {
  readonly code: CustomsEstimateErrorCode;
  readonly path: string;

  constructor(code: CustomsEstimateErrorCode, fieldPath: string, detail: string) {
    super(code + ' @ ' + fieldPath + ': ' + detail);
    this.name = 'CustomsEstimateError';
    this.code = code;
    this.path = fieldPath;
  }
}

export interface CustomsEstimatePolicy {
  policyId: string;
  policyVersion: string;
  /** 每币种估算比例（0 ≤ ratio ≤ 1）；缺失 → INDETERMINATE。 */
  ratioByCurrency: Readonly<Record<string, string>>;
  /** 每币种绝对上限；缺失 → INDETERMINATE。 */
  capByCurrency: Readonly<Record<string, string>>;
  /** 低于该值则估算为 0（并记录 BELOW_MIN_ESTIMATE）。 */
  minEstimateByCurrency: Readonly<Record<string, string>>;
}

export interface CustomsCurrencyEstimate {
  currency: string;
  disputedAmount: string;
  appliedRatio: string;
  appliedCap: string;
  rawEstimate: string;
  estimatedAmount: string;
  capped: boolean;
  belowMinimum: boolean;
}

export interface CustomsRecoveryEstimate {
  entryNumber: string;
  policyId: string;
  policyVersion: string;
  status: CustomsEstimateStatus;
  reasons: readonly { code: CustomsEstimateReason; detail: string }[];
  byCurrency: readonly CustomsCurrencyEstimate[];
  readonly estimateOnly: true;
  readonly finalAmountDerived: false;
  readonly billable: false;
  readonly feeDerived: false;
  readonly appliesFxConversion: false;
  readonly filingPerformed: false;
  readonly paymentPerformed: false;
  readonly productionCredentials: 'ABSENT';
}

const SCALE = 6;

function fail(code: CustomsEstimateErrorCode, fieldPath: string, detail: string): never {
  throw new CustomsEstimateError(code, fieldPath, detail);
}

function toScaled(amount: string): bigint {
  const negative = amount.startsWith('-');
  const digits = negative ? amount.slice(1) : amount;
  const [whole, fraction = ''] = digits.split('.');
  const scaled = BigInt(whole + fraction.padEnd(SCALE, '0').slice(0, SCALE));
  return negative ? -scaled : scaled;
}

function formatScaled(total: bigint): string {
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(SCALE + 1, '0');
  const whole = digits.slice(0, digits.length - SCALE);
  const fraction = digits.slice(digits.length - SCALE).replace(/0+$/, '');
  const shown = fraction.length >= 2 ? fraction : fraction.padEnd(2, '0');
  return (negative ? '-' : '') + whole + '.' + shown;
}

/** 精确十进制乘法（BigInt，scale 6，**向下截断**）。 */
export function multiplyDecimalStrings(left: string, right: string): string {
  if (!isDecimalString(left) || !isDecimalString(right)) {
    fail('INVALID_RATIO', 'multiplyDecimalStrings', 'both operands must be decimal strings');
  }
  const product = (toScaled(left) * toScaled(right)) / 10n ** BigInt(SCALE);
  return formatScaled(product);
}

/** 向下取整到分（cent）——估算只允许保守方向。 */
export function floorToCent(amount: string): string {
  if (!isDecimalString(amount)) fail('INVALID_RATIO', 'floorToCent', 'amount must be a decimal string');
  const scaled = toScaled(amount);
  const truncated = (scaled / 10000n) * 10000n;
  return formatScaled(truncated);
}

function compareDecimal(left: string, right: string): number {
  const a = toScaled(left);
  const b = toScaled(right);
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function minDecimal(left: string, right: string): string {
  return compareDecimal(left, right) <= 0 ? left : right;
}

function normalizeDecimalMap(value: unknown, fieldPath: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_POLICY', fieldPath, 'expected a currency-keyed object');
  }
  const result: Record<string, string> = {};
  for (const [currency, amount] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Z]{3}$/.test(currency)) fail('INVALID_POLICY', fieldPath, 'invalid currency key');
    if (!isDecimalString(amount)) fail('INVALID_POLICY', fieldPath + '.' + currency, 'value must be a decimal string');
    result[currency] = String(amount).trim();
  }
  return result;
}

function normalizePolicy(policy: unknown): CustomsEstimatePolicy {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    fail('INVALID_POLICY', 'policy', 'expected a plain object');
  }
  const record = policy as Record<string, unknown>;
  const policyId = record.policyId;
  const policyVersion = record.policyVersion;
  if (typeof policyId !== 'string' || policyId.trim() === '') fail('INVALID_POLICY', 'policy.policyId', 'expected a non-empty id');
  if (typeof policyVersion !== 'string' || policyVersion.trim() === '') {
    fail('INVALID_POLICY', 'policy.policyVersion', 'expected a non-empty version');
  }
  const ratios = normalizeDecimalMap(record.ratioByCurrency, 'policy.ratioByCurrency');
  for (const [currency, ratio] of Object.entries(ratios)) {
    if (compareDecimal(ratio, '0.00') < 0 || compareDecimal(ratio, '1.00') > 0) {
      fail('INVALID_RATIO', 'policy.ratioByCurrency.' + currency, 'ratio must be between 0 and 1');
    }
  }
  const caps = normalizeDecimalMap(record.capByCurrency, 'policy.capByCurrency');
  for (const [currency, cap] of Object.entries(caps)) {
    if (compareDecimal(cap, '0.00') < 0) fail('INVALID_CAP', 'policy.capByCurrency.' + currency, 'cap must not be negative');
  }
  const minimums = normalizeDecimalMap(record.minEstimateByCurrency ?? {}, 'policy.minEstimateByCurrency');
  for (const [currency, minimum] of Object.entries(minimums)) {
    if (compareDecimal(minimum, '0.00') < 0) {
      fail('INVALID_MIN_ESTIMATE', 'policy.minEstimateByCurrency.' + currency, 'minimum must not be negative');
    }
  }
  return {
    policyId: policyId.trim(),
    policyVersion: policyVersion.trim(),
    ratioByCurrency: ratios,
    capByCurrency: caps,
    minEstimateByCurrency: minimums,
  };
}

/**
 * 估算可追回金额（**仅**在 C4 = ELIGIBLE 时产出金额；estimateOnly，不可计费）。
 */
export function estimateCustomsRecovery(input: {
  fact: CustomsEntryFact;
  assessment: CustomsEligibilityAssessment;
  policy: CustomsEstimatePolicy;
}): CustomsRecoveryEstimate {
  const fact = input?.fact;
  try {
    assertReadOnlyEntryFact(fact);
  } catch (error) {
    if (error instanceof CustomsDutyTruthError) fail('NOT_A_READ_ONLY_FACT', error.path, error.message);
    throw error;
  }
  const policy = normalizePolicy(input.policy);
  const assessment = input?.assessment;
  const reasons: { code: CustomsEstimateReason; detail: string }[] = [];

  // CHANGE B：只消费 C4 已裁定的**正向多缴候选**金额，绝不把负差额取绝对值当可追回金额。
  const disputedByCurrency: Record<string, string> = { ...(assessment?.overpaymentCandidateAmountByCurrency ?? {}) };

  const base = {
    entryNumber: fact.entryNumber,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    estimateOnly: true,
    finalAmountDerived: false,
    billable: false,
    feeDerived: false,
    appliesFxConversion: false,
    filingPerformed: false,
    paymentPerformed: false,
    productionCredentials: 'ABSENT',
  } as const;

  if (assessment?.status !== 'ELIGIBLE') {
    reasons.push({
      code: assessment?.status === 'INDETERMINATE' ? 'ELIGIBILITY_INDETERMINATE' : 'NOT_ELIGIBLE_INPUT',
      detail: 'eligibility status is ' + String(assessment?.status ?? 'MISSING'),
    });
    return {
      ...base,
      status: assessment?.status === 'INDETERMINATE' ? 'INDETERMINATE' : 'NOT_ESTIMATED',
      reasons,
      byCurrency: [],
    };
  }

  const currencies = Object.keys(disputedByCurrency).sort();
  if (currencies.length === 0) {
    reasons.push({ code: 'NO_DISPUTED_AMOUNT', detail: 'no observed disputed amount to estimate from' });
    return { ...base, status: 'NOT_ESTIMATED', reasons, byCurrency: [] };
  }

  const byCurrency: CustomsCurrencyEstimate[] = [];
  let indeterminate = false;

  for (const currency of currencies) {
    const disputedAmount = disputedByCurrency[currency];
    const ratio = policy.ratioByCurrency[currency];
    const cap = policy.capByCurrency[currency];
    const minimum = policy.minEstimateByCurrency[currency] ?? '0.00';

    if (ratio === undefined) {
      reasons.push({ code: 'RATIO_NOT_DEFINED_FOR_CURRENCY', detail: 'policy defines no ratio for ' + currency });
      indeterminate = true;
      continue;
    }
    if (cap === undefined) {
      reasons.push({ code: 'CAP_NOT_DEFINED_FOR_CURRENCY', detail: 'policy defines no cap for ' + currency });
      indeterminate = true;
      continue;
    }

    const rawEstimate = floorToCent(multiplyDecimalStrings(disputedAmount, ratio));
    const cappedAmount = minDecimal(rawEstimate, floorToCent(cap));
    const capped = compareDecimal(cappedAmount, rawEstimate) < 0;
    const belowMinimum = compareDecimal(cappedAmount, minimum) < 0;
    const estimatedAmount = belowMinimum ? '0.00' : cappedAmount;

    if (capped) reasons.push({ code: 'CAPPED_AT_POLICY_LIMIT', detail: 'estimate for ' + currency + ' capped at ' + cappedAmount });
    if (belowMinimum) reasons.push({ code: 'BELOW_MIN_ESTIMATE', detail: 'estimate for ' + currency + ' below policy minimum ' + minimum });

    byCurrency.push({
      currency,
      disputedAmount,
      appliedRatio: ratio,
      appliedCap: cap,
      rawEstimate,
      estimatedAmount,
      capped,
      belowMinimum,
    });
  }

  let status: CustomsEstimateStatus = indeterminate ? 'INDETERMINATE' : 'ESTIMATED';
  if (status === 'ESTIMATED') reasons.push({ code: 'OK', detail: 'estimate produced for ' + String(byCurrency.length) + ' currency/currencies' });
  if (status === 'INDETERMINATE' && byCurrency.length === 0) {
    return { ...base, status, reasons, byCurrency };
  }
  return { ...base, status, reasons, byCurrency };
}
