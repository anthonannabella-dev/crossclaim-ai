// P6-PROD-U1 —— 确定性摘要工具（canonical JSON + sha256）
// 所有 durable 身份（reservationKey / immutableBasisDigest / payloadDigest / resultDigest /
// eventKey / deliveryKey）都由这里计算，保证「同样的输入 → 同样的身份」，可重放比对。

import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      '{' +
      entries.map(([key, v]) => JSON.stringify(key) + ':' + canonicalJson(v)).join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

// unknown post identity（两列皆 null）与「已知的空值」必须可区分：
// 统一编码成 UNKNOWN 或 fingerprint@version，避免下游把 UNKNOWN 误读成未变更。
export function postIdentityToken(
  fingerprint: string | null,
  version: string | null,
): string {
  if (fingerprint === null && version === null) return 'UNKNOWN';
  return String(fingerprint) + '@' + String(version);
}
