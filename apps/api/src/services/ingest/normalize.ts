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

  const dateOnly = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date;
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
