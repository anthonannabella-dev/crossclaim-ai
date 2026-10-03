/**
 * CUSTOMS GAP G4 / C3（MASTER GAP CLOSURE）— Classification / Rate Discrepancy（只暴露差异，不裁决）。
 * ---------------------------------------------------------------
 * 输入：C1 只读事实 CustomsEntryFact + 外部**预期**（rate table / broker quote / vendor estimate / manual）。
 * 输出：逐行差异清单（code + 实际值 + 预期值 + delta），**不判定谁对谁错**，不产生 recoverable amount。
 *
 * 硬边界：
 *   · adjudicationPerformed=false（不做“谁对”的裁决）；recoverableAmountDerived=false。
 *   · 不调用任何外部系统（无端口、无网络、无 DB）；不做 FX 换算；不跨币种比较金额。
 *   · 事实必须仍是 C1 只读事实（readOnly=true / 无 filing / 无 payment / productionCredentials=ABSENT）。
 *   · 预期输入 fail-closed：形状非法 / 金额非法 / 键重复 一律抛错，不静默跳过。
 */

import {
  CUSTOMS_DUTY_LINE_KINDS,
  isDecimalString,
  type CustomsDutyLineKind,
  type CustomsEntryFact,
} from './customs-entry-contract';
import { assertReadOnlyEntryFact, CustomsDutyTruthError } from './customs-duty-truth';

export const CUSTOMS_RATE_EXPECTATION_SOURCES = ['RATE_TABLE', 'BROKER_QUOTE', 'VENDOR_ESTIMATE', 'MANUAL'] as const;
export type CustomsRateExpectationSource = (typeof CUSTOMS_RATE_EXPECTATION_SOURCES)[number];

export interface CustomsRateExpectation {
  /** 与 C1 duty line.rawCode 对齐的机器可读键。 */
  lineRawCode: string;
  /** HTS / 税则分类码（预期值；只作对照，不写回事实）。 */
  htsCode: string;
  expectedKind: CustomsDutyLineKind;
  expectedAmount: string;
  currency: string;
  source: CustomsRateExpectationSource;
  reference: string;
}

export const CUSTOMS_DISCREPANCY_CODES = [
  'NO_EXPECTATION_DATA',
  'MISSING_EXPECTATION',
  'UNMATCHED_EXPECTATION',
  'KIND_MISMATCH',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
] as const;
export type CustomsDiscrepancyCode = (typeof CUSTOMS_DISCREPANCY_CODES)[number];

export const CUSTOMS_DISCREPANCY_ERROR_CODES = [
  'NOT_A_READ_ONLY_FACT',
  'INVALID_EXPECTATION',
  'INVALID_AMOUNT_IN_EXPECTATION',
  'DUPLICATE_EXPECTATION_KEY',
  'INVALID_DUTY_LINE_IN_FACT',
] as const;
export type CustomsDiscrepancyErrorCode = (typeof CUSTOMS_DISCREPANCY_ERROR_CODES)[number];

export class CustomsDiscrepancyError extends Error {
  readonly code: CustomsDiscrepancyErrorCode;
  readonly path: string;

  constructor(code: CustomsDiscrepancyErrorCode, fieldPath: string, detail: string) {
    super(code + ' @ ' + fieldPath + ': ' + detail);
    this.name = 'CustomsDiscrepancyError';
    this.code = code;
    this.path = fieldPath;
  }
}

export interface CustomsDiscrepancyItem {
  code: CustomsDiscrepancyCode;
  lineRawCode: string | null;
  htsCode: string | null;
  currency: string | null;
  actualAmount: string | null;
  expectedAmount: string | null;
  /** actual − expected（仅 AMOUNT_MISMATCH 有值）。 */
  deltaAmount: string | null;
  detail: string;
}

export interface CustomsClassificationDiscrepancyReport {
  entryNumber: string;
  jurisdiction: string;
  expectationCount: number;
  lineCount: number;
  matchedLineCount: number;
  items: readonly CustomsDiscrepancyItem[];
  discrepanciesFound: boolean;
  readonly adjudicationPerformed: false;
  readonly recoverableAmountDerived: false;
  readonly appliesFxConversion: false;
  readonly filingPerformed: false;
  readonly paymentPerformed: false;
  readonly productionCredentials: 'ABSENT';
}

const SCALE = 6;

function fail(code: CustomsDiscrepancyErrorCode, fieldPath: string, detail: string): never {
  throw new CustomsDiscrepancyError(code, fieldPath, detail);
}

function toScaled(amount: string): bigint {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
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

/** 精确十进制减法（BigInt，scale 6；输出最少 2 位小数）。 */
export function subtractDecimalStrings(minuend: string, subtrahend: string): string {
  if (!isDecimalString(minuend) || !isDecimalString(subtrahend)) {
    fail('INVALID_AMOUNT_IN_EXPECTATION', 'subtractDecimalStrings', 'both operands must be decimal strings');
  }
  return formatScaled(toScaled(minuend) - toScaled(subtrahend));
}

function requireText(value: unknown, fieldPath: string, maxLength: number): string {
  if (typeof value !== 'string') fail('INVALID_EXPECTATION', fieldPath, 'expected a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) fail('INVALID_EXPECTATION', fieldPath, 'expected a non-empty string');
  if (trimmed.length > maxLength) fail('INVALID_EXPECTATION', fieldPath, 'value too long');
  return trimmed;
}

function normalizeExpectation(value: unknown, index: number): CustomsRateExpectation {
  const fieldPath = 'expectations[' + index + ']';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_EXPECTATION', fieldPath, 'expected a plain object');
  }
  const record = value as Record<string, unknown>;
  const lineRawCode = requireText(record.lineRawCode, fieldPath + '.lineRawCode', 32);
  const htsCode = requireText(record.htsCode, fieldPath + '.htsCode', 32);
  const expectedKindRaw = requireText(record.expectedKind, fieldPath + '.expectedKind', 16).toUpperCase();
  if (!(CUSTOMS_DUTY_LINE_KINDS as readonly string[]).includes(expectedKindRaw)) {
    fail('INVALID_EXPECTATION', fieldPath + '.expectedKind', 'unknown expected duty kind');
  }
  if (!isDecimalString(record.expectedAmount)) {
    fail('INVALID_AMOUNT_IN_EXPECTATION', fieldPath + '.expectedAmount', 'expected amount must be a decimal string');
  }
  const currency = requireText(record.currency, fieldPath + '.currency', 3);
  if (!/^[A-Z]{3}$/.test(currency)) fail('INVALID_EXPECTATION', fieldPath + '.currency', 'currency must be a 3-letter uppercase code');
  const sourceRaw = requireText(record.source, fieldPath + '.source', 24).toUpperCase();
  if (!(CUSTOMS_RATE_EXPECTATION_SOURCES as readonly string[]).includes(sourceRaw)) {
    fail('INVALID_EXPECTATION', fieldPath + '.source', 'unknown expectation source');
  }
  return {
    lineRawCode,
    htsCode,
    expectedKind: expectedKindRaw as CustomsDutyLineKind,
    expectedAmount: String(record.expectedAmount).trim(),
    currency,
    source: sourceRaw as CustomsRateExpectationSource,
    reference: requireText(record.reference, fieldPath + '.reference', 64),
  };
}

function normalizeExpectations(expectations: readonly unknown[]): readonly CustomsRateExpectation[] {
  if (!Array.isArray(expectations)) fail('INVALID_EXPECTATION', 'expectations', 'expectations must be an array');
  const normalized = expectations.map((value, index) => normalizeExpectation(value, index));
  const seen = new Set<string>();
  normalized.forEach((expectation, index) => {
    const key = expectation.currency + '::' + expectation.lineRawCode;
    if (seen.has(key)) {
      fail('DUPLICATE_EXPECTATION_KEY', 'expectations[' + index + ']', 'duplicate expectation key (currency + lineRawCode)');
    }
    seen.add(key);
  });
  return normalized;
}

/**
 * 比对报关单事实与外部预期，**只输出差异**（不裁决、不产生 recoverable amount）。
 */
export function compareCustomsClassification(input: {
  fact: CustomsEntryFact;
  expectations: readonly CustomsRateExpectation[];
}): CustomsClassificationDiscrepancyReport {
  const fact = input?.fact;
  try {
    assertReadOnlyEntryFact(fact);
  } catch (error) {
    if (error instanceof CustomsDutyTruthError) {
      fail('NOT_A_READ_ONLY_FACT', error.path, error.message);
    }
    throw error;
  }
  if (!Array.isArray(fact.dutyLines)) fail('INVALID_DUTY_LINE_IN_FACT', 'fact.dutyLines', 'dutyLines must be an array');

  const expectations = normalizeExpectations(input.expectations as readonly unknown[]);
  const items: CustomsDiscrepancyItem[] = [];
  const matchedExpectationKeys = new Set<string>();
  let matchedLineCount = 0;

  if (expectations.length === 0) {
    if (fact.dutyLines.length > 0) {
      items.push({
        code: 'NO_EXPECTATION_DATA',
        lineRawCode: null,
        htsCode: null,
        currency: null,
        actualAmount: null,
        expectedAmount: null,
        deltaAmount: null,
        detail: 'no external expectation supplied for ' + String(fact.dutyLines.length) + ' duty lines',
      });
    }
  }

  for (const line of fact.dutyLines) {
    if (!line || typeof line !== 'object') fail('INVALID_DUTY_LINE_IN_FACT', 'fact.dutyLines', 'expected duty line objects');
    const sameKey = expectations.find(
      (expectation) => expectation.lineRawCode === line.rawCode && expectation.currency === line.currency,
    );
    if (!sameKey) {
      const otherCurrency = expectations.find((expectation) => expectation.lineRawCode === line.rawCode);
      if (otherCurrency) {
        items.push({
          code: 'CURRENCY_MISMATCH',
          lineRawCode: line.rawCode,
          htsCode: otherCurrency.htsCode,
          currency: line.currency,
          actualAmount: line.amount.trim(),
          expectedAmount: otherCurrency.expectedAmount,
          deltaAmount: null,
          detail: 'expectation currency ' + otherCurrency.currency + ' differs from fact currency ' + line.currency,
        });
        continue;
      }
      if (expectations.length > 0) {
        items.push({
          code: 'MISSING_EXPECTATION',
          lineRawCode: line.rawCode,
          htsCode: null,
          currency: line.currency,
          actualAmount: line.amount.trim(),
          expectedAmount: null,
          deltaAmount: null,
          detail: 'no expectation for line ' + line.rawCode,
        });
      }
      continue;
    }

    matchedExpectationKeys.add(sameKey.currency + '::' + sameKey.lineRawCode);
    matchedLineCount += 1;

    if (sameKey.expectedKind !== line.kind) {
      items.push({
        code: 'KIND_MISMATCH',
        lineRawCode: line.rawCode,
        htsCode: sameKey.htsCode,
        currency: line.currency,
        actualAmount: line.amount.trim(),
        expectedAmount: sameKey.expectedAmount,
        deltaAmount: null,
        detail: 'expected kind ' + sameKey.expectedKind + ' but fact kind is ' + line.kind,
      });
    }

    const actual = line.amount.trim();
    if (toScaled(actual) !== toScaled(sameKey.expectedAmount)) {
      items.push({
        code: 'AMOUNT_MISMATCH',
        lineRawCode: line.rawCode,
        htsCode: sameKey.htsCode,
        currency: line.currency,
        actualAmount: actual,
        expectedAmount: sameKey.expectedAmount,
        deltaAmount: subtractDecimalStrings(actual, sameKey.expectedAmount),
        detail: 'actual amount differs from expected amount',
      });
    }
  }

  for (const expectation of expectations) {
    const key = expectation.currency + '::' + expectation.lineRawCode;
    if (matchedExpectationKeys.has(key)) continue;
    if (items.some((item) => item.code === 'CURRENCY_MISMATCH' && item.lineRawCode === expectation.lineRawCode)) continue;
    items.push({
      code: 'UNMATCHED_EXPECTATION',
      lineRawCode: expectation.lineRawCode,
      htsCode: expectation.htsCode,
      currency: expectation.currency,
      actualAmount: null,
      expectedAmount: expectation.expectedAmount,
      deltaAmount: null,
      detail: 'expectation has no matching fact line',
    });
  }

  return {
    entryNumber: fact.entryNumber,
    jurisdiction: fact.jurisdiction,
    expectationCount: expectations.length,
    lineCount: fact.dutyLines.length,
    matchedLineCount,
    items,
    discrepanciesFound: items.length > 0,
    adjudicationPerformed: false,
    recoverableAmountDerived: false,
    appliesFxConversion: false,
    filingPerformed: false,
    paymentPerformed: false,
    productionCredentials: 'ABSENT',
  };
}
