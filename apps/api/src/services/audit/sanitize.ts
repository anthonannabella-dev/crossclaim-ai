/**
 * 审计载荷脱敏
 * ---------------------------------------------------------------
 * 审计最容易变成泄露源：把请求体原样写进 `changes` 就等于把密钥抄了一份。
 * 因此写入前统一过一遍：
 *   - 复用 logger 的敏感键名识别（password / token / secret / apiKey ...）
 *   - 额外掩掉 **storageKey**（形如 `<uuid>/<xx>/<uuid>`），只留掩码
 *   - 长字符串截断、超深对象截断，避免审计表被塞爆
 */

import { createHash } from 'node:crypto';
import { isSensitiveKey } from '../../config/logger';

export const REDACTED = '[REDACTED]';
export const STORAGE_KEY_MASK = '[STORAGE_KEY]';
export const DEFAULT_MAX_STRING = 512;
const MAX_DEPTH = 4;

/** 形如 `<uuid>/<2 位十六进制>/<uuid>` 的存储 key */
const STORAGE_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bearer / Basic 授权串、常见密钥前缀 */
const SECRET_LOOKING =
  /(^(bearer|basic)\s+\S+$)|(^sk-[A-Za-z0-9_-]{8,}$)|(^gh[pousr]_[A-Za-z0-9]{8,}$)|(^AKIA[0-9A-Z]{12,}$)/i;

export function maskStorageKey(value: string): string {
  return STORAGE_KEY_RE.test(value) ? STORAGE_KEY_MASK : value;
}

export function truncate(value: string, max: number = DEFAULT_MAX_STRING): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max}]`;
}

export function looksLikeSecret(value: string): boolean {
  return SECRET_LOOKING.test(value);
}

/** 加盐哈希：审计里保留"同一 IP 可关联"，但不保存原始 IP */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${ip}`, 'utf8').digest('hex').slice(0, 32);
}

function sanitizeValue(value: unknown, depth: number, maxString: number): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[DEPTH_LIMIT]';

  if (typeof value === 'string') {
    if (looksLikeSecret(value)) return REDACTED;
    return truncate(maskStorageKey(value), maxString);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[UNSUPPORTED]';

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1, maxString));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(item, depth + 1, maxString);
  }
  return out;
}

export function sanitizeChanges(
  changes: Record<string, unknown>,
  options: { maxString?: number } = {},
): Record<string, unknown> {
  const maxString = options.maxString ?? DEFAULT_MAX_STRING;
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    return { value: sanitizeValue(changes, 0, maxString) as unknown } as Record<string, unknown>;
  }
  return sanitizeValue(changes, 0, maxString) as Record<string, unknown>;
}
