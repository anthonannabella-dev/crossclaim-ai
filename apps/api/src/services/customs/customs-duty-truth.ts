/**
 * CUSTOMS GAP G4 / C2（MASTER GAP CLOSURE）— Duty Calculation Truth（只读计算真值平面）。
 * ---------------------------------------------------------------
 * 输入：C1 归一化后的 CustomsEntryFact（**只读事实**）。
 * 输出：每币种 / 每 kind 的确定性合计 + 结构化 observation（**只暴露异常，不裁决**）。
 *
 * 硬边界：
 *   · calculationPerformed=true（纯 BigInt 确定性求和）；**adjudicationPerformed=false**（不判定谁对谁错）。
 *   · 不推导 eligibility / recoverableAmount / claim package / successFee；不做 FX 换算；不跨币种相加。
 *   · 传入的事实必须仍是只读事实（readOnly=true / filingPerformed=false / paymentPerformed=false /
 *     productionCredentials='ABSENT'），否则 fail-closed（NOT_READ_ONLY_FACT）。
 *   · 纯函数：无端口、无网络、无 DB。
 */

import {
  CUSTOMS_DUTY_LINE_KINDS,
  isDecimalString,
  sumDecimalStrings,
  type CustomsDutyLineKind,
  type CustomsEntryFact,
} from './customs-entry-contract';

/** 计算层 observation（≠ 错误；只暴露结构，不裁决）。 */
export const CUSTOMS_DUTY_OBSERVATIONS = [
  'EMPTY_ENTRY',
  'NO_DUTY_LINE',
  'NEGATIVE_AMOUNT_LINE',
  'ZERO_AMOUNT_LINE',
  'DUPLICATE_RAW_CODE',
  'OTHER_KIND_PRESENT',
  'MULTI_CURRENCY_FACT',
  'DUTY_TOTAL_MISMATCH',
] as const;
export type CustomsDutyObservation = (typeof CUSTOMS_DUTY_OBSERVATIONS)[number];

export const CUSTOMS_DUTY_TRUTH_ERROR_CODES = [
  'NOT_A_READ_ONLY_FACT',
  'INVALID_AMOUNT_IN_FACT',
  'INVALID_DUTY_LINE_IN_FACT',
] as const;
export type CustomsDutyTruthErrorCode = (typeof CUSTOMS_DUTY_TRUTH_ERROR_CODES)[number];

export class CustomsDutyTruthError extends Error {
  readonly code: CustomsDutyTruthErrorCode;
  readonly path: string;

  constructor(code: CustomsDutyTruthErrorCode, fieldPath: string, detail: string) {
    super(code + ' @ ' + fieldPath + ': ' + detail);
    this.name = 'CustomsDutyTruthError';
    this.code = code;
    this.path = fieldPath;
  }
}

export interface CustomsDutyLineRef {
  kind: CustomsDutyLineKind;
  rawCode: string;
  amount: string;
}

export interface CustomsCurrencyDutyTruth {
  currency: string;
  lineCount: number;
  byKind: Readonly<Record<CustomsDutyLineKind, string | null>>;
  totalAmount: string;
  /** C1 事实中声明的合计（若存在）；仅用于比对，不覆盖计算值。 */
  declaredTotalAmount: string | null;
}

export interface CustomsDutyTruth {
  entryNumber: string;
  jurisdiction: string;
  currencies: readonly CustomsCurrencyDutyTruth[];
  dutyLineRefs: readonly CustomsDutyLineRef[];
  observations: readonly CustomsDutyObservation[];
  readonly calculationPerformed: true;
  readonly adjudicationPerformed: false;
  readonly recoverableAmountDerived: false;
  readonly appliesFxConversion: false;
  readonly filingPerformed: false;
  readonly paymentPerformed: false;
  readonly productionCredentials: 'ABSENT';
}

function fail(code: CustomsDutyTruthErrorCode, fieldPath: string, detail: string): never {
  throw new CustomsDutyTruthError(code, fieldPath, detail);
}

/** 只读事实守卫：C2 只消费 C1 产出的只读事实，任何越界事实一律 fail-closed。 */
export function assertReadOnlyEntryFact(fact: CustomsEntryFact): void {
  if (!fact || typeof fact !== 'object') fail('NOT_A_READ_ONLY_FACT', 'fact', 'expected a normalized customs entry fact');
  if (fact.readOnly !== true) fail('NOT_A_READ_ONLY_FACT', 'fact.readOnly', 'fact must be a read-only fact');
  if (fact.filingPerformed !== false) fail('NOT_A_READ_ONLY_FACT', 'fact.filingPerformed', 'fact must not have performed a filing');
  if (fact.paymentPerformed !== false) fail('NOT_A_READ_ONLY_FACT', 'fact.paymentPerformed', 'fact must not have performed a payment');
  if (fact.productionCredentials !== 'ABSENT') {
    fail('NOT_A_READ_ONLY_FACT', 'fact.productionCredentials', 'fact must not carry production credentials');
  }
}

function emptyByKind(): Record<CustomsDutyLineKind, string | null> {
  const record = {} as Record<CustomsDutyLineKind, string | null>;
  for (const kind of CUSTOMS_DUTY_LINE_KINDS) record[kind] = null;
  return record;
}

/**
 * 计算报关单 duty/tax 真值（确定性、只读、无裁决）。
 */
export function computeCustomsDutyTruth(fact: CustomsEntryFact): CustomsDutyTruth {
  assertReadOnlyEntryFact(fact);

  const rawLines = Array.isArray(fact.dutyLines) ? fact.dutyLines : fail('INVALID_DUTY_LINE_IN_FACT', 'fact.dutyLines', 'dutyLines must be an array');
  const observations = new Set<CustomsDutyObservation>();
  const lineRefs: CustomsDutyLineRef[] = [];
  const perCurrency = new Map<string, { amounts: Map<CustomsDutyLineKind, string[]>; lineCount: number }>();
  const seenRawCodes = new Set<string>();

  rawLines.forEach((line, index) => {
    const fieldPath = 'fact.dutyLines[' + index + ']';
    if (!line || typeof line !== 'object') fail('INVALID_DUTY_LINE_IN_FACT', fieldPath, 'expected a duty line object');
    if (!isDecimalString(line.amount)) fail('INVALID_AMOUNT_IN_FACT', fieldPath + '.amount', 'amount must be a decimal string');
    if (!(CUSTOMS_DUTY_LINE_KINDS as readonly string[]).includes(line.kind)) {
      fail('INVALID_DUTY_LINE_IN_FACT', fieldPath + '.kind', 'unknown duty line kind');
    }
    if (typeof line.currency !== 'string' || !/^[A-Z]{3}$/.test(line.currency)) {
      fail('INVALID_DUTY_LINE_IN_FACT', fieldPath + '.currency', 'currency must be a 3-letter uppercase code');
    }

    const amount = line.amount.trim();
    if (amount.startsWith('-')) observations.add('NEGATIVE_AMOUNT_LINE');
    if (/^0+(\.0+)?$/.test(amount)) observations.add('ZERO_AMOUNT_LINE');
    if (line.kind === 'OTHER') observations.add('OTHER_KIND_PRESENT');

    const rawCodeKey = line.currency + '::' + line.rawCode;
    if (seenRawCodes.has(rawCodeKey)) observations.add('DUPLICATE_RAW_CODE');
    seenRawCodes.add(rawCodeKey);

    let bucket = perCurrency.get(line.currency);
    if (!bucket) {
      bucket = { amounts: new Map<CustomsDutyLineKind, string[]>(), lineCount: 0 };
      perCurrency.set(line.currency, bucket);
    }
    const amounts = bucket.amounts.get(line.kind) ?? [];
    amounts.push(amount);
    bucket.amounts.set(line.kind, amounts);
    bucket.lineCount += 1;

    lineRefs.push({ kind: line.kind, rawCode: line.rawCode, amount });
  });

  if (lineRefs.length === 0) observations.add('EMPTY_ENTRY');
  else if (!lineRefs.some((line) => line.kind === 'DUTY')) observations.add('NO_DUTY_LINE');
  if (perCurrency.size > 1) observations.add('MULTI_CURRENCY_FACT');

  const declaredTotals = fact.totalDutyAmountByCurrency ?? {};
  const currencies = [...perCurrency.keys()].sort();
  const currencyTruths: CustomsCurrencyDutyTruth[] = currencies.map((currency) => {
    const bucket = perCurrency.get(currency);
    const byKind = emptyByKind();
    let allAmounts: string[] = [];
    for (const kind of CUSTOMS_DUTY_LINE_KINDS) {
      const amounts = bucket?.amounts.get(kind);
      if (!amounts || amounts.length === 0) continue;
      byKind[kind] = sumDecimalStrings(amounts);
      allAmounts = allAmounts.concat(amounts);
    }
    const totalAmount = sumDecimalStrings(allAmounts);
    const declaredTotalAmount = typeof declaredTotals[currency] === 'string' ? declaredTotals[currency] : null;
    if (declaredTotalAmount !== null && isDecimalString(declaredTotalAmount)) {
      if (sumDecimalStrings([declaredTotalAmount]) !== totalAmount) observations.add('DUTY_TOTAL_MISMATCH');
    }
    return {
      currency,
      lineCount: bucket?.lineCount ?? 0,
      byKind,
      totalAmount,
      declaredTotalAmount,
    };
  });

  const orderedObservations = CUSTOMS_DUTY_OBSERVATIONS.filter((observation) => observations.has(observation));

  return {
    entryNumber: fact.entryNumber,
    jurisdiction: fact.jurisdiction,
    currencies: currencyTruths,
    dutyLineRefs: lineRefs,
    observations: orderedObservations,
    calculationPerformed: true,
    adjudicationPerformed: false,
    recoverableAmountDerived: false,
    appliesFxConversion: false,
    filingPerformed: false,
    paymentPerformed: false,
    productionCredentials: 'ABSENT',
  };
}
