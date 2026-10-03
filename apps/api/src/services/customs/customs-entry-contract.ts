/**
 * CUSTOMS GAP G4 / C1（MASTER GAP CLOSURE · 差集驱动）— Customs Entry Data / Evidence Contract（只读事实平面）。
 * ---------------------------------------------------------------
 * 目标：把外部来源（BROKER_DOCUMENT / ABI_VENDOR / EDI_SFTP / USER_UPLOAD）的报关单事实归一化为
 *       **确定性的** CustomsEntryFact，供后续 C2（duty calculation truth）/ C3（classification 差异）消费。
 *
 * 硬边界（与 C17 / C21 一致，TRANSPORT=false）：
 *   · 只归一化只读事实：readOnly=true · filingPerformed=false · paymentPerformed=false · productionCredentials='ABSENT'。
 *   · **不推导** eligibility / recoverableAmount / claim package / successFee；不做 FX 换算；不跨币种相加。
 *   · 金额一律十进制字符串（禁止 float / NaN / 科学计数法）；货币 3 位大写。
 *   · PII fail-closed：importerName / importerAddress / consignee* / contact* / accessToken / credential* / rawPayload
 *     一律拒绝（RAW_PII_NOT_ALLOWED），只允许 safe reference。
 *   · 纯函数：无端口、无网络、无 DB、无真实 provider 调用。
 */

/** 事实来源（只声明来源，不声明可信等级 / 不声明优先级）。 */
export const CUSTOMS_ENTRY_SOURCES = ['BROKER_DOCUMENT', 'ABI_VENDOR', 'EDI_SFTP', 'USER_UPLOAD'] as const;
export type CustomsEntrySource = (typeof CUSTOMS_ENTRY_SOURCES)[number];

/** duty line 归一化 kind；raw code 必须保留，未知归入 OTHER，不猜测。 */
export const CUSTOMS_DUTY_LINE_KINDS = ['DUTY', 'TAX', 'FEE', 'INTEREST', 'OTHER'] as const;
export type CustomsDutyLineKind = (typeof CUSTOMS_DUTY_LINE_KINDS)[number];

/** fail-closed 原因码（契约层唯一允许的错误语义）。 */
export const CUSTOMS_ENTRY_CONTRACT_REASONS = [
  'INVALID_REQUEST',
  'INVALID_ENTRY_NUMBER',
  'INVALID_DATE',
  'INVALID_CURRENCY',
  'INVALID_AMOUNT',
  'MIXED_CURRENCY_DUTY_LINES',
  'UNKNOWN_DUTY_LINE_KIND',
  'UNKNOWN_SOURCE',
  'RAW_PII_NOT_ALLOWED',
] as const;
export type CustomsEntryContractReason = (typeof CUSTOMS_ENTRY_CONTRACT_REASONS)[number];

export class CustomsEntryContractError extends Error {
  readonly code: CustomsEntryContractReason;
  readonly path: string;

  constructor(code: CustomsEntryContractReason, fieldPath: string, detail: string) {
    super(code + ' @ ' + fieldPath + ': ' + detail);
    this.name = 'CustomsEntryContractError';
    this.code = code;
    this.path = fieldPath;
  }
}

export interface CustomsEntryDutyLine {
  kind: CustomsDutyLineKind;
  rawCode: string;
  amount: string;
  currency: string;
}

export interface CustomsEntryFact {
  entryNumber: string;
  entryDate: string;
  jurisdiction: string;
  portOfEntry: string;
  importerOfRecordRef: string;
  source: CustomsEntrySource;
  rawReference: string;
  dutyLines: readonly CustomsEntryDutyLine[];
  totalDutyAmountByCurrency: Readonly<Record<string, string>>;
  observedAt: string;
  readonly readOnly: true;
  readonly filingPerformed: false;
  readonly paymentPerformed: false;
  readonly productionCredentials: 'ABSENT';
}

/** 契约边界常量：显式声明**没有**发生什么（供后续 gate / 测试断言消费）。 */
export const CUSTOMS_ENTRY_CONTRACT_BOUNDARY = {
  readOnly: true,
  filingPerformed: false,
  paymentPerformed: false,
  productionCredentials: 'ABSENT',
  transportEnabled: false,
  appliesFxConversion: false,
  derivesEligibility: false,
  derivesRecoverableAmount: false,
  buildsClaimPackage: false,
  performsFiling: false,
  performsPayment: false,
} as const;

/** 十进制缩放位数（与 billing / settlement 的十进制字符串口径一致；不使用浮点）。 */
export const CUSTOMS_ENTRY_DECIMAL_SCALE = 6;

const DECIMAL_STRING_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const JURISDICTION_PATTERN = /^[A-Z]{2,3}$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:@#-]{1,64}$/;
const ENTRY_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/-]{2,29}$/;
const PORT_OF_ENTRY_PATTERN = /^[A-Za-z0-9 .,'()/-]{2,64}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const RAW_CODE_PATTERN = /^[A-Za-z0-9._:/#-]{1,32}$/;

const FORBIDDEN_PII_KEYS = [
  'importername',
  'importeraddress',
  'consignee',
  'consigneename',
  'consigneeaddress',
  'contact',
  'contactname',
  'contactemail',
  'contactphone',
  'accesstoken',
  'credential',
  'credentials',
  'rawpayload',
  'password',
  'clientsecret',
  'apikey',
  'signature',
  'ssn',
];
const FORBIDDEN_PII_PREFIXES = ['consignee', 'contact'];
const FORBIDDEN_PII_SUBSTRINGS = ['accesstoken', 'credential', 'password', 'clientsecret', 'apikey'];

function fail(code: CustomsEntryContractReason, fieldPath: string, detail: string): never {
  throw new CustomsEntryContractError(code, fieldPath, detail);
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_STRING_PATTERN.test(value.trim()) && value.trim().length > 0;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isForbiddenPiiKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (FORBIDDEN_PII_KEYS.includes(normalized)) return true;
  if (FORBIDDEN_PII_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  return FORBIDDEN_PII_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

/** 递归扫描 PII / 凭据字段名；命中即 fail-closed（不做部分裁剪）。 */
function assertNoRawPii(value: unknown, fieldPath: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawPii(item, fieldPath + '[' + index + ']'));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenPiiKey(key)) {
      fail('RAW_PII_NOT_ALLOWED', fieldPath + '.' + key, 'raw PII / credential field is not allowed in customs entry facts');
    }
    assertNoRawPii(child, fieldPath + '.' + key);
  }
}

function requirePlainObject(value: unknown, fieldPath: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_REQUEST', fieldPath, 'expected a plain object');
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, fieldPath: string, maxLength: number): string {
  if (typeof value !== 'string') fail('INVALID_REQUEST', fieldPath, 'expected a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) fail('INVALID_REQUEST', fieldPath, 'expected a non-empty string');
  if (trimmed.length > maxLength) fail('INVALID_REQUEST', fieldPath, 'value too long');
  return trimmed;
}

function requireEntryNumber(value: unknown): string {
  const raw = requireNonEmptyString(value, 'entryNumber', 30);
  if (!ENTRY_NUMBER_PATTERN.test(raw)) {
    fail('INVALID_ENTRY_NUMBER', 'entryNumber', 'entry number must be 3-30 chars of [A-Za-z0-9/-]');
  }
  return raw.toUpperCase();
}

function isRealCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function requireIsoDate(value: unknown, fieldPath: string): string {
  const raw = requireNonEmptyString(value, fieldPath, 10);
  if (!isRealCalendarDate(raw)) fail('INVALID_DATE', fieldPath, 'expected a real calendar date YYYY-MM-DD');
  return raw;
}

function requireIsoInstant(value: unknown, fieldPath: string): string {
  const raw = requireNonEmptyString(value, fieldPath, 30);
  if (!ISO_INSTANT_PATTERN.test(raw) || Number.isNaN(Date.parse(raw))) {
    fail('INVALID_DATE', fieldPath, 'expected an ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS(.sss)Z)');
  }
  return raw;
}

function requireJurisdiction(value: unknown): string {
  const raw = requireNonEmptyString(value, 'jurisdiction', 3).toUpperCase();
  if (!JURISDICTION_PATTERN.test(raw)) {
    fail('INVALID_REQUEST', 'jurisdiction', 'jurisdiction must be a 2-3 letter uppercase country code');
  }
  return raw;
}

function requirePortOfEntry(value: unknown): string {
  const raw = requireNonEmptyString(value, 'portOfEntry', 64);
  if (!PORT_OF_ENTRY_PATTERN.test(raw)) fail('INVALID_REQUEST', 'portOfEntry', 'port of entry contains unsupported characters');
  return raw;
}

function requireSafeReference(value: unknown, fieldPath: string): string {
  const raw = requireNonEmptyString(value, fieldPath, 64);
  if (!SAFE_REFERENCE_PATTERN.test(raw)) {
    fail('INVALID_REQUEST', fieldPath, 'expected a machine-safe reference (no spaces / free text: PII not allowed)');
  }
  return raw;
}

function requireSource(value: unknown): CustomsEntrySource {
  if (typeof value !== 'string') fail('UNKNOWN_SOURCE', 'source', 'source must be one of the known customs entry sources');
  const raw = value.trim().toUpperCase();
  if (!(CUSTOMS_ENTRY_SOURCES as readonly string[]).includes(raw)) {
    fail('UNKNOWN_SOURCE', 'source', 'unknown customs entry source');
  }
  return raw as CustomsEntrySource;
}

function requireCurrency(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string') fail('INVALID_CURRENCY', fieldPath, 'currency must be a 3-letter uppercase code');
  const raw = value.trim();
  if (!CURRENCY_PATTERN.test(raw)) fail('INVALID_CURRENCY', fieldPath, 'currency must be a 3-letter uppercase code');
  return raw;
}

function requireAmount(value: unknown, fieldPath: string): string {
  if (!isDecimalString(value)) {
    fail('INVALID_AMOUNT', fieldPath, 'amount must be a decimal string (max 15 integer digits / 6 decimals)');
  }
  return String(value).trim();
}

function requireDutyLine(value: unknown, index: number): CustomsEntryDutyLine {
  const fieldPath = 'dutyLines[' + index + ']';
  const record = requirePlainObject(value, fieldPath);
  assertNoRawPii(record, fieldPath);

  const kindValue = requireNonEmptyString(record.kind, fieldPath + '.kind', 16).toUpperCase();
  if (!(CUSTOMS_DUTY_LINE_KINDS as readonly string[]).includes(kindValue)) {
    fail('UNKNOWN_DUTY_LINE_KIND', fieldPath + '.kind', 'unknown duty line kind (raw code must still be preserved)');
  }

  const rawCode = requireNonEmptyString(record.rawCode, fieldPath + '.rawCode', 32);
  if (!RAW_CODE_PATTERN.test(rawCode)) fail('INVALID_REQUEST', fieldPath + '.rawCode', 'raw code contains unsupported characters');

  return {
    kind: kindValue as CustomsDutyLineKind,
    rawCode,
    amount: requireAmount(record.amount, fieldPath + '.amount'),
    currency: requireCurrency(record.currency, fieldPath + '.currency'),
  };
}

function requireDutyLines(value: unknown): readonly CustomsEntryDutyLine[] {
  if (!Array.isArray(value)) fail('INVALID_REQUEST', 'dutyLines', 'dutyLines must be an array');
  const lines = value.map((item, index) => requireDutyLine(item, index));
  const currencies = new Set(lines.map((line) => line.currency));
  if (currencies.size > 1) {
    fail('MIXED_CURRENCY_DUTY_LINES', 'dutyLines', 'mixed currency duty lines must be split per currency before normalization');
  }
  return lines;
}

function toScaledBigInt(amount: string, scale: number): bigint {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = digits.split('.');
  const padded = fraction.padEnd(scale, '0').slice(0, scale);
  const scaled = BigInt(whole + padded);
  return negative ? -scaled : scaled;
}

function formatScaledBigInt(total: bigint, scale: number): string {
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  const shown = fraction.length >= 2 ? fraction : fraction.padEnd(2, '0');
  return (negative ? '-' : '') + whole + '.' + shown;
}

/** 精确十进制求和（BigInt，固定 scale 6；输出最少保留 2 位小数）。 */
export function sumDecimalStrings(values: readonly string[]): string {
  if (values.length === 0) return formatScaledBigInt(0n, CUSTOMS_ENTRY_DECIMAL_SCALE);
  let total = 0n;
  for (const value of values) {
    if (!isDecimalString(value)) fail('INVALID_AMOUNT', 'sumDecimalStrings', 'non-decimal value in sum input');
    total += toScaledBigInt(String(value), CUSTOMS_ENTRY_DECIMAL_SCALE);
  }
  return formatScaledBigInt(total, CUSTOMS_ENTRY_DECIMAL_SCALE);
}

/**
 * 归一化报关单事实（fail-closed）。**只读**：不写入任何存储，不推导 eligibility / recoverable amount。
 */
export function normalizeCustomsEntryFact(input: unknown): CustomsEntryFact {
  const record = requirePlainObject(input, 'input');
  assertNoRawPii(record, 'input');

  const entryNumber = requireEntryNumber(record.entryNumber);
  const entryDate = requireIsoDate(record.entryDate, 'entryDate');
  const jurisdiction = requireJurisdiction(record.jurisdiction);
  const portOfEntry = requirePortOfEntry(record.portOfEntry);
  const importerOfRecordRef = requireSafeReference(record.importerOfRecordRef, 'importerOfRecordRef');
  const source = requireSource(record.source);
  const rawReference = requireSafeReference(record.rawReference, 'rawReference');
  const observedAt = requireIsoInstant(record.observedAt, 'observedAt');
  const dutyLines = requireDutyLines(record.dutyLines);

  const totalDutyAmountByCurrency: Record<string, string> = {};
  if (dutyLines.length > 0) {
    const currency = dutyLines[0].currency;
    totalDutyAmountByCurrency[currency] = sumDecimalStrings(dutyLines.map((line) => line.amount));
  }

  return {
    entryNumber,
    entryDate,
    jurisdiction,
    portOfEntry,
    importerOfRecordRef,
    source,
    rawReference,
    dutyLines,
    totalDutyAmountByCurrency,
    observedAt,
    readOnly: true,
    filingPerformed: false,
    paymentPerformed: false,
    productionCredentials: 'ABSENT',
  };
}
