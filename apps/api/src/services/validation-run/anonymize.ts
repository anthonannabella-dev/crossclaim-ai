/**
 * C-0009.1 Validation Run Toolkit — 脱敏（deterministic，无秘密）
 * ---------------------------------------------------------------
 * 目的：把真实 / 脱敏真实结构输入变成**可验证但不泄露原值**的输入。
 *
 * 注意（MSG-20260928-110 REVISE-1）：这里的 sha256 截断**不是加盐**——
 * salt 需要随机秘密值；本函数是**确定性指纹**：
 *   · 同一原值两次运行得到同一标识（可 join、可复现）
 *   · 8 位十六进制用于占位足够，但不是密码学意义上的匿名化保证
 *
 * 标识展示规则**复用**生产掩码（services/workflow/masking.ts），
 * 不另起一套，避免与 UI 展示口径漂移。
 */

import { createHash } from 'node:crypto';

import { maskIdentifier } from '../workflow/masking';

export const FINGERPRINT_LENGTH = 8;

/** 确定性指纹：sha256(normalizedValue) 前 8 位（不是盐，不依赖任何秘密）。 */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value.trim(), 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/** MSG-20260928-110：claimOutcome 是枚举，禁止自由文本（否则无法统计）。 */
export const CLAIM_OUTCOMES = [
  'NOT_STARTED',
  'IDENTIFIED',
  'SUBMITTED_MANUAL',
  'RECOVERED',
  'REJECTED',
  'UNKNOWN',
] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

/** 脚手架输入列（架构方批准 + REVISE 追加 settlementRef / claimOutcome）。 */
export const VALIDATION_COLUMNS = [
  'orderId',
  'trackingNo',
  'invoiceNo',
  'channel',
  'promisedDeliveredAt',
  'actualDeliveredAt',
  'billedAmount',
  'billedCurrency',
  'invoiceAmount',
  'invoiceCurrency',
  'evidenceRef',
  'settlementRef',
  'claimOutcome',
  'note',
] as const;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s()-]{7,}\d/g;
const ADDRESS_HINT_RE = /(?:street|st\.|road|rd\.|avenue|ave\.|lane|ln\.|drive|dr\.|floor|suite|室|路|街|号|大厦)/i;

/** 自由文本脱敏：邮箱 / 电话 / 地址线索一律替换。 */
export function maskFreeText(value: string): string {
  return value
    .replace(EMAIL_RE, '***@***')
    .replace(PHONE_RE, '***')
    .replace(ADDRESS_HINT_RE, '<address>');
}

export type ValidationRow = Record<string, string>;

/**
 * 单行脱敏：
 * → orderId / trackingNo：复用生产掩码规则（与 UI 展示一致）
 * → invoiceNo / 金额 / 币种 / 日期 / 渠道：**保留**（验证必需，且非客户 PII）
 * → evidenceRef / settlementRef：只保留确定性占位（文件路径与赔付单号可能含客户信息）
 * → note：自由文本脱敏；claimOutcome 必须是枚举值（非法值原样保留，交给校验器报错）
 */
export function anonymizeRow(row: ValidationRow): ValidationRow {
  const out: ValidationRow = {};
  for (const column of VALIDATION_COLUMNS) out[column] = (row[column] ?? '').trim();

  out.orderId = maskIdentifier(row.orderId ?? '', 'ORDER_ID') ?? '';
  out.trackingNo = maskIdentifier(row.trackingNo ?? '', 'TRACKING') ?? '';
  out.evidenceRef = row.evidenceRef && row.evidenceRef.trim() ? `evref-${fingerprint(row.evidenceRef)}` : '';
  out.settlementRef = row.settlementRef && row.settlementRef.trim() ? `settle-${fingerprint(row.settlementRef)}` : '';
  out.note = maskFreeText(row.note ?? '');
  if (!out.claimOutcome) out.claimOutcome = 'NOT_STARTED';

  return out;
}

export function anonymizeRows(rows: ValidationRow[]): ValidationRow[] {
  return rows.map(anonymizeRow);
}
