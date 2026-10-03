/**
 * CUSTOMS GAP G4 / C4（MASTER GAP CLOSURE）— Customs Recovery Eligibility（确定性政策判定）。
 * ---------------------------------------------------------------
 * 输入：C1 只读事实 + C2 duty 真值 + C3 差异报告 + **显式政策**（版本化、可审计、无 AI 判断）。
 * 输出：ELIGIBLE / NOT_ELIGIBLE / INDETERMINATE + 原因码 + 观察到的差异金额（**不是** recoverable amount）。
 *
 * 硬边界：
 *   · 判定只来自显式政策字段与确定性比较；**无模型推断**、无金额裁决、无 success fee。
 *   · recoverableAmountDerived=false / feeDerived=false：observedDiscrepancyAmountByCurrency 只是差异观测值。
 *   · 不做 FX 换算；不跨币种合并；不 filing；不 payment；productionCredentials=ABSENT。
 *   · 无网络 / 无 DB / 无端口。
 */

import {
  isDecimalString,
  sumDecimalStrings,
  type CustomsEntryFact,
  type CustomsEntrySource,
} from './customs-entry-contract';
import { assertReadOnlyEntryFact, CustomsDutyTruthError, type CustomsDutyTruth } from './customs-duty-truth';
import type {
  CustomsClassificationDiscrepancyReport,
  CustomsDiscrepancyCode,
} from './customs-classification-discrepancy';

export type CustomsEligibilityStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'INDETERMINATE';

export const CUSTOMS_ELIGIBILITY_REASONS = [
  'OK',
  'JURISDICTION_NOT_SUPPORTED',
  'SOURCE_NOT_ALLOWED',
  'ENTRY_TOO_OLD',
  'NO_DUTY_LINES',
  'REQUIRED_DISCREPANCY_MISSING',
  'BELOW_MIN_DISPUTED_AMOUNT',
  'MIN_THRESHOLD_NOT_DEFINED_FOR_CURRENCY',
  'OTHER_KIND_LINES_PRESENT',
] as const;
export type CustomsEligibilityReason = (typeof CUSTOMS_ELIGIBILITY_REASONS)[number];

export const CUSTOMS_ELIGIBILITY_ERROR_CODES = [
  'NOT_A_READ_ONLY_FACT',
  'INVALID_TRUTH',
  'INVALID_DISCREPANCY_REPORT',
  'INVALID_POLICY',
  'INVALID_THRESHOLD_AMOUNT',
] as const;
export type CustomsEligibilityErrorCode = (typeof CUSTOMS_ELIGIBILITY_ERROR_CODES)[number];

export class CustomsEligibilityError extends Error {
  readonly code: CustomsEligibilityErrorCode;
  readonly path: string;

  constructor(code: CustomsEligibilityErrorCode, fieldPath: string, detail: string) {
    super(code + ' @ ' + fieldPath + ': ' + detail);
    this.name = 'CustomsEligibilityError';
    this.code = code;
    this.path = fieldPath;
  }
}

export interface CustomsEligibilityPolicy {
  policyId: string;
  policyVersion: string;
  jurisdiction: string;
  allowedSources: readonly CustomsEntrySource[];
  /** entry 到 observedAt 的最大天数（时效）。 */
  maxEntryAgeDays: number;
  /** 至少命中其中之一的差异码；空数组表示不要求差异。 */
  requiredDiscrepancyCodes: readonly CustomsDiscrepancyCode[];
  /** 每币种最小争议金额；缺币种 → INDETERMINATE（fail-closed）。 */
  minDisputedAmountByCurrency: Readonly<Record<string, string>>;
  /** 是否允许 kind=OTHER 的行参与（true 时仅记录，不判定）。 */
  allowOtherKindLines: boolean;
}

export interface CustomsEligibilityReasonEntry {
  code: CustomsEligibilityReason;
  detail: string;
}

export interface CustomsEligibilityAssessment {
  entryNumber: string;
  policyId: string;
  policyVersion: string;
  status: CustomsEligibilityStatus;
  reasons: readonly CustomsEligibilityReasonEntry[];
  entryAgeDays: number | null;
  observedDiscrepancyAmountByCurrency: Readonly<Record<string, string>>;
  examinedLineCount: number;
  readonly eligibilityDetermined: true;
  readonly adjudicationPerformed: false;
  readonly recoverableAmountDerived: false;
  readonly feeDerived: false;
  readonly appliesFxConversion: false;
  readonly filingPerformed: false;
  readonly paymentPerformed: false;
  readonly productionCredentials: 'ABSENT';
}

const NOT_ELIGIBLE_REASONS: readonly CustomsEligibilityReason[] = [
  'JURISDICTION_NOT_SUPPORTED',
  'SOURCE_NOT_ALLOWED',
  'ENTRY_TOO_OLD',
  'NO_DUTY_LINES',
  'REQUIRED_DISCREPANCY_MISSING',
  'BELOW_MIN_DISPUTED_AMOUNT',
];
const INDETERMINATE_REASONS: readonly CustomsEligibilityReason[] = [
  'MIN_THRESHOLD_NOT_DEFINED_FOR_CURRENCY',
  'OTHER_KIND_LINES_PRESENT',
];

function fail(code: CustomsEligibilityErrorCode, fieldPath: string, detail: string): never {
  throw new CustomsEligibilityError(code, fieldPath, detail);
}

function normalizePolicy(policy: unknown): CustomsEligibilityPolicy {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    fail('INVALID_POLICY', 'policy', 'expected a plain object');
  }
  const record = policy as Record<string, unknown>;
  const policyId = record.policyId;
  const policyVersion = record.policyVersion;
  const jurisdiction = record.jurisdiction;
  if (typeof policyId !== 'string' || policyId.trim() === '') fail('INVALID_POLICY', 'policy.policyId', 'expected a non-empty id');
  if (typeof policyVersion !== 'string' || policyVersion.trim() === '') {
    fail('INVALID_POLICY', 'policy.policyVersion', 'expected a non-empty version');
  }
  if (typeof jurisdiction !== 'string' || !/^[A-Z]{2,3}$/.test(jurisdiction)) {
    fail('INVALID_POLICY', 'policy.jurisdiction', 'expected an uppercase jurisdiction code');
  }
  if (!Array.isArray(record.allowedSources) || record.allowedSources.length === 0) {
    fail('INVALID_POLICY', 'policy.allowedSources', 'expected a non-empty source allowlist');
  }
  if (typeof record.maxEntryAgeDays !== 'number' || !Number.isInteger(record.maxEntryAgeDays) || record.maxEntryAgeDays < 0) {
    fail('INVALID_POLICY', 'policy.maxEntryAgeDays', 'expected a non-negative integer');
  }
  if (!Array.isArray(record.requiredDiscrepancyCodes)) {
    fail('INVALID_POLICY', 'policy.requiredDiscrepancyCodes', 'expected an array');
  }
  if (typeof record.allowOtherKindLines !== 'boolean') {
    fail('INVALID_POLICY', 'policy.allowOtherKindLines', 'expected a boolean');
  }
  const thresholdsRaw = record.minDisputedAmountByCurrency;
  if (typeof thresholdsRaw !== 'object' || thresholdsRaw === null || Array.isArray(thresholdsRaw)) {
    fail('INVALID_POLICY', 'policy.minDisputedAmountByCurrency', 'expected a currency-keyed object');
  }
  const thresholds: Record<string, string> = {};
  for (const [currency, amount] of Object.entries(thresholdsRaw as Record<string, unknown>)) {
    if (!/^[A-Z]{3}$/.test(currency)) fail('INVALID_POLICY', 'policy.minDisputedAmountByCurrency', 'invalid currency key');
    if (!isDecimalString(amount)) {
      fail('INVALID_THRESHOLD_AMOUNT', 'policy.minDisputedAmountByCurrency.' + currency, 'threshold must be a decimal string');
    }
    thresholds[currency] = String(amount).trim();
  }
  return {
    policyId: policyId.trim(),
    policyVersion: policyVersion.trim(),
    jurisdiction,
    allowedSources: record.allowedSources as readonly CustomsEntrySource[],
    maxEntryAgeDays: record.maxEntryAgeDays,
    requiredDiscrepancyCodes: record.requiredDiscrepancyCodes as readonly CustomsDiscrepancyCode[],
    minDisputedAmountByCurrency: thresholds,
    allowOtherKindLines: record.allowOtherKindLines,
  };
}

function absoluteDecimal(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

function compareDecimal(left: string, right: string): number {
  const scale = 6;
  const toScaled = (input: string): bigint => {
    const negative = input.startsWith('-');
    const digits = negative ? input.slice(1) : input;
    const [whole, fraction = ''] = digits.split('.');
    const scaled = BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale));
    return negative ? -scaled : scaled;
  };
  const a = toScaled(left);
  const b = toScaled(right);
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function computeEntryAgeDays(entryDate: string, observedAt: string): number | null {
  const entryMs = Date.parse(entryDate + 'T00:00:00.000Z');
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(entryMs) || Number.isNaN(observedMs)) return null;
  return Math.floor((observedMs - entryMs) / 86400000);
}

/**
 * 确定性资格判定（无 AI、无外部调用）。政策缺失的判定维度 → INDETERMINATE（fail-closed，不猜测）。
 */
export function evaluateCustomsEligibility(input: {
  fact: CustomsEntryFact;
  truth: CustomsDutyTruth;
  discrepancy: CustomsClassificationDiscrepancyReport;
  policy: CustomsEligibilityPolicy;
}): CustomsEligibilityAssessment {
  const fact = input?.fact;
  try {
    assertReadOnlyEntryFact(fact);
  } catch (error) {
    if (error instanceof CustomsDutyTruthError) fail('NOT_A_READ_ONLY_FACT', error.path, error.message);
    throw error;
  }
  const truth = input?.truth;
  if (!truth || !Array.isArray(truth.currencies) || truth.filingPerformed !== false) {
    fail('INVALID_TRUTH', 'truth', 'expected a customs duty truth produced by computeCustomsDutyTruth');
  }
  const discrepancy = input?.discrepancy;
  if (!discrepancy || !Array.isArray(discrepancy.items)) {
    fail('INVALID_DISCREPANCY_REPORT', 'discrepancy', 'expected a discrepancy report');
  }
  const policy = normalizePolicy(input.policy);

  const reasons: CustomsEligibilityReasonEntry[] = [];

  if (fact.jurisdiction !== policy.jurisdiction) {
    reasons.push({
      code: 'JURISDICTION_NOT_SUPPORTED',
      detail: 'fact jurisdiction ' + fact.jurisdiction + ' is not covered by policy jurisdiction ' + policy.jurisdiction,
    });
  }

  if (!policy.allowedSources.includes(fact.source)) {
    reasons.push({ code: 'SOURCE_NOT_ALLOWED', detail: 'source ' + fact.source + ' is not in the policy allowlist' });
  }

  const lineCount = fact.dutyLines.length;
  if (lineCount === 0) reasons.push({ code: 'NO_DUTY_LINES', detail: 'entry has no duty lines' });

  const entryAgeDays = computeEntryAgeDays(fact.entryDate, fact.observedAt);
  if (entryAgeDays !== null && entryAgeDays > policy.maxEntryAgeDays) {
    reasons.push({
      code: 'ENTRY_TOO_OLD',
      detail: 'entry age ' + String(entryAgeDays) + 'd exceeds policy limit ' + String(policy.maxEntryAgeDays) + 'd',
    });
  }

  const observedDiscrepancyAmountByCurrency: Record<string, string> = {};
  for (const item of discrepancy.items) {
    if (item.code !== 'AMOUNT_MISMATCH' || !item.currency || !item.deltaAmount) continue;
    const current = observedDiscrepancyAmountByCurrency[item.currency];
    const absolute = absoluteDecimal(item.deltaAmount);
    observedDiscrepancyAmountByCurrency[item.currency] = current
      ? sumDecimalStrings([current, absolute])
      : sumDecimalStrings([absolute]);
  }

  if (policy.requiredDiscrepancyCodes.length > 0) {
    const present = new Set(discrepancy.items.map((item) => item.code));
    const matched = policy.requiredDiscrepancyCodes.filter((code) => present.has(code));
    if (matched.length === 0) {
      reasons.push({
        code: 'REQUIRED_DISCREPANCY_MISSING',
        detail: 'none of the required discrepancy codes are present',
      });
    }
  }

  const currencies = truth.currencies.map((entry) => entry.currency).sort();
  for (const currency of currencies) {
    const threshold = policy.minDisputedAmountByCurrency[currency];
    const observed = observedDiscrepancyAmountByCurrency[currency] ?? '0.00';
    if (threshold === undefined) {
      reasons.push({
        code: 'MIN_THRESHOLD_NOT_DEFINED_FOR_CURRENCY',
        detail: 'policy defines no minimum disputed amount for ' + currency,
      });
      continue;
    }
    if (compareDecimal(observed, threshold) < 0) {
      reasons.push({
        code: 'BELOW_MIN_DISPUTED_AMOUNT',
        detail: 'observed disputed amount ' + observed + ' ' + currency + ' is below policy minimum ' + threshold,
      });
    }
  }

  if (!policy.allowOtherKindLines) {
    const hasOtherKind = fact.dutyLines.some((dutyLine) => dutyLine.kind === 'OTHER');
    if (hasOtherKind) {
      reasons.push({
        code: 'OTHER_KIND_LINES_PRESENT',
        detail: 'entry contains OTHER-kind duty lines and policy does not allow them',
      });
    }
  }

  let status: CustomsEligibilityStatus = 'ELIGIBLE';
  if (reasons.some((reason) => NOT_ELIGIBLE_REASONS.includes(reason.code))) status = 'NOT_ELIGIBLE';
  else if (reasons.some((reason) => INDETERMINATE_REASONS.includes(reason.code))) status = 'INDETERMINATE';
  if (status === 'ELIGIBLE') reasons.push({ code: 'OK', detail: 'all policy conditions satisfied' });

  return {
    entryNumber: fact.entryNumber,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    status,
    reasons,
    entryAgeDays,
    observedDiscrepancyAmountByCurrency,
    examinedLineCount: lineCount,
    eligibilityDetermined: true,
    adjudicationPerformed: false,
    recoverableAmountDerived: false,
    feeDerived: false,
    appliesFxConversion: false,
    filingPerformed: false,
    paymentPerformed: false,
    productionCredentials: 'ABSENT',
  };
}
