/**
 * RSI Adapter 安全过滤（输入 + 输出双向前置，fail-closed）
 * ---------------------------------------------------------------
 * 裁定依据：MSG-20261005-09（RSI Model Router → Provider Adapter 设计 = PASS WITH REVISE）
 *   · INPUT_SENSITIVE_DATA_FILTER = REQUIRED
 *   · OUTPUT_SENSITIVE_DATA_FILTER = REQUIRED
 *   · 任一步失败 fail-closed
 *
 * 本模块只返回**发现码**，绝不回传命中的原文片段，也不落任何原始内容。
 */

import { createHash } from 'node:crypto';

export const RSI_SENSITIVE_KINDS = [
  'SECRET',
  'PII_EMAIL',
  'PII_PHONE',
  'PII_PAYMENT_CARD',
  'PII_GOV_ID',
  'CUSTOMER_RECORD',
] as const;
export type RsiSensitiveKind = (typeof RSI_SENSITIVE_KINDS)[number];

export interface RsiSensitiveScan {
  clean: boolean;
  /** 稳定发现码，只含种类，不含命中的原文 */
  findings: RsiSensitiveKind[];
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/i,
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const GOV_ID = /\b\d{3}-\d{2}-\d{4}\b/;
const CUSTOMER_RECORD =
  /\b(?:case|claim|order|tracking|invoice|consignee|importer)[-_ ]?(?:id|no|number|ref)\s*[:=]\s*[A-Za-z0-9-]{6,}\b/i;
const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

const luhnValid = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
};

const hasPaymentCard = (text: string): boolean => {
  const candidates = text.match(CARD_CANDIDATE);
  if (candidates === null) return false;
  return candidates.some((candidate) => luhnValid(candidate.replace(/[^\d]/g, '')));
};

/** 扫描一段文本；空串视为干净（不产生发现码） */
export function scanSensitiveData(text: string): RsiSensitiveScan {
  if (typeof text !== 'string' || text === '') return { clean: true, findings: [] };
  const findings = new Set<RsiSensitiveKind>();
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) findings.add('SECRET');
  }
  if (EMAIL.test(text)) findings.add('PII_EMAIL');
  if (PHONE.test(text)) findings.add('PII_PHONE');
  if (GOV_ID.test(text)) findings.add('PII_GOV_ID');
  if (CUSTOMER_RECORD.test(text)) findings.add('CUSTOMER_RECORD');
  if (hasPaymentCard(text)) findings.add('PII_PAYMENT_CARD');
  return { clean: findings.size === 0, findings: [...findings].sort() };
}

/** 递归扫描结构化载荷（只在字符串叶子与 key 上做匹配） */
export function scanSensitivePayload(value: unknown, depth = 0): RsiSensitiveScan {
  if (depth > 6 || value === null || value === undefined) return { clean: true, findings: [] };
  if (typeof value === 'string') return scanSensitiveData(value);
  if (typeof value !== 'object') return { clean: true, findings: [] };
  const findings = new Set<RsiSensitiveKind>();
  const absorb = (scan: RsiSensitiveScan): void => {
    for (const finding of scan.findings) findings.add(finding);
  };
  if (Array.isArray(value)) {
    for (const entry of value) absorb(scanSensitivePayload(entry, depth + 1));
  } else {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      absorb(scanSensitiveData(key));
      absorb(scanSensitivePayload(nested, depth + 1));
    }
  }
  return { clean: findings.size === 0, findings: [...findings].sort() };
}

/** promptDigest / outputDigest 统一口径：utf8 的 sha256 十六进制 */
export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const RSI_ADAPTER_SAFETY_BOUNDARY = {
  returnsFindingCodesOnly: true,
  returnsMatchedText: false,
  failClosed: true,
  recordsCustomerData: false,
} as const;
