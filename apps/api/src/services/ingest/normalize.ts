/**
 * 归一化与校验（行级）
 * ---------------------------------------------------------------
 * 只做"把外部字段变成内部字段"以及**格式校验**：
 *   - 金额：必须是 >= 0 的数字，最多 4 位小数（与 Decimal(18,4) 对齐）；存字符串，避免浮点误差
 *   - 币种：3 位字母，缺省 USD
 *   - 日期：ISO 或 yyyy-mm-dd / yyyy/mm/dd；无法解析 → 记为行级问题（不猜）
 *   - externalId / referenceType：原样保留（不猜测业务含义）
 * 任何一行出问题都只影响该行：批次最终状态可能是 PARTIAL。
 */

import { dedupeKey, rowFingerprint } from './fingerprint';
import type { ColumnMapping, ImportContext, NormalizedTransaction, RawRow, RowIssue } from './types';

const AMOUNT_RE = /^-?\d+(\.\d{1,4})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
/** 只认 YYYY-MM-DD / YYYY/MM/DD，且必须做年月日往返校验 */
const DATE_ONLY_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
/** 时间戳只认带明确时区（Z 或 ±HH:MM）的 ISO 8601；分组用于**日历合法性**校验 */
const ISO_WITH_ZONE_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export interface NormalizeResult {
  transaction?: NormalizedTransaction;
  issues: RowIssue[];
}

export function parseAmount(value: string): string | null {
  const cleaned = value.replace(/[,¥$€£\s]/g, '');
  if (cleaned === '' || !AMOUNT_RE.test(cleaned)) return null;
  return cleaned;
}

export function parseOccurredAt(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const dateOnly = DATE_ONLY_RE.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(date.getTime())) return null;
    // 往返校验：JS Date 会把 2026-02-30 静默滚成 2026-03-02，这类"悄悄换一天"必须拒绝，
    // 否则错误日期会污染 SLA / Claim deadline / 争议窗口。
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  }

  // 不猜业务日期：无时区的自由格式（09/01/2026 这类）一律拒绝
  const iso = ISO_WITH_ZONE_RE.exec(trimmed);
  if (!iso) return null;
  const [, tsYear, tsMonth, tsDay, tsHour, tsMinute, tsSecond, , tsZone, , offsetHour, offsetMinute] =
    iso;
  const tsYearNum = Number(tsYear);
  const tsMonthNum = Number(tsMonth);
  const tsDayNum = Number(tsDay);
  // CHANGE #34：JS Date 会把 2026-02-30T10:00:00Z 静默滚成 2026-03-02，
  // 因此必须在 new Date() 之前按原字符串校验日历合法性，不能只靠 Date 判断。
  if (tsMonthNum < 1 || tsMonthNum > 12) return null;
  if (tsDayNum < 1 || tsDayNum > daysInMonth(tsYearNum, tsMonthNum)) return null;
  if (Number(tsHour) > 23 || Number(tsMinute) > 59) return null;
  if (tsSecond !== undefined && Number(tsSecond) > 59) return null;
  if (tsZone.toUpperCase() !== 'Z' && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) {
    return null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeRow(
  raw: RawRow,
  mapping: ColumnMapping,
  context: ImportContext,
  rowNumber: number,
): NormalizeResult {
  const issues: RowIssue[] = [];
  const read = (field: keyof ColumnMapping): string => {
    const column = mapping[field];
    return column === undefined ? '' : (raw[column] ?? '').trim();
  };

  if (Object.values(raw).every((v) => (v ?? '').trim() === '')) {
    return { issues: [{ row: rowNumber, field: 'row', code: 'EMPTY_ROW', message: '空行，已跳过' }] };
  }

  const amountRaw = read('amount');
  const amount = parseAmount(amountRaw);
  if (amount === null) {
    issues.push({
      row: rowNumber,
      field: 'amount',
      code: 'INVALID_AMOUNT',
      message: amountRaw === '' ? '金额为空' : '金额格式非法',
    });
  }

  const currencyRaw = read('currency').toUpperCase();
  const currency = currencyRaw === '' ? 'USD' : currencyRaw;
  if (!CURRENCY_RE.test(currency)) {
    issues.push({ row: rowNumber, field: 'currency', code: 'INVALID_CURRENCY', message: '币种必须是 3 位字母' });
  }

  const occurredRaw = read('occurredAt');
  const occurredAt = parseOccurredAt(occurredRaw);
  if (occurredRaw !== '' && occurredAt === null) {
    issues.push({ row: rowNumber, field: 'occurredAt', code: 'INVALID_DATE', message: '日期无法解析' });
  }

  const externalId = read('externalId') || null;
  const referenceType = read('referenceType') || null;

  if (issues.length > 0) return { issues };

  const fingerprint = rowFingerprint(raw);
  return {
    issues: [],
    transaction: {
      row: rowNumber,
      externalId,
      referenceType,
      occurredAt,
      amount,
      currency,
      raw,
      dedupeKey: dedupeKey({
        organizationId: context.organizationId,
        connectionId: context.connectionId ?? null,
        referenceType,
        externalId,
        rowFingerprint: fingerprint,
      }),
    },
  };
}
