/**
 * C-0013-A — 来源指纹（source fingerprint v1）
 * ---------------------------------------------------------------
 * 架构方裁定（MSG-20260928-130 / -132 / -134）：
 *   sha256(platformType | claimType | occurredAtBucket | normalizedRef | currency)
 *   · occurredAtBucket = **UTC 日**（YYYY-MM-DD）：避免时区/秒级漂移，又能区分不同期事件
 *   · **不含金额**：平台更正金额属于同一事件，不产生新指纹（避免拆单污染覆盖率与残差）
 *   · 每个字段进哈希前必须先 canonicalize（否则 `SHIP-001` 与 `ship-001` 会变成两条）
 *   · 版本：当前恒为 `v1`（fingerprintVersion）
 * 纯函数、无 IO、可单测。
 */

import { createHash } from 'node:crypto';

export const FINGERPRINT_VERSION = 'v1';
export const FINGERPRINT_SEPARATOR = '|';

/** 字段内出现分隔符会破坏拼接的确定性，统一替换。 */
function neutralize(value: string): string {
  return value.split(FINGERPRINT_SEPARATOR).join('_');
}

export function canonicalPlatformType(value: string): string {
  return neutralize(value.trim().toLowerCase());
}

export function canonicalClaimType(value: string): string {
  return neutralize(value.trim().toLowerCase());
}

/** UTC 日：同一来源事件在平台时区/批处理时间漂移下仍指向同一天。 */
export function occurredAtBucket(occurredAt: Date): string {
  return new Date(occurredAt).toISOString().slice(0, 10);
}

export function canonicalNormalizedRef(value: string | null | undefined): string {
  if (!value) return '';
  // \p{C} 覆盖控制字符与不可见字符
  return neutralize(value.replace(/\p{C}/gu, '').trim().toLowerCase());
}

export function canonicalCurrency(value: string): string {
  return neutralize(value.trim().toUpperCase());
}

export interface SourceFingerprintInput {
  platformType: string;
  claimType: string;
  occurredAt: Date;
  normalizedRef?: string | null;
  currency: string;
}

export interface SourceFingerprintResult {
  fingerprint: string;
  version: typeof FINGERPRINT_VERSION;
  bucket: string;
  parts: readonly [string, string, string, string, string];
}

export function sourceFingerprintV1(input: SourceFingerprintInput): SourceFingerprintResult {
  const parts = [
    canonicalPlatformType(input.platformType),
    canonicalClaimType(input.claimType),
    occurredAtBucket(input.occurredAt),
    canonicalNormalizedRef(input.normalizedRef),
    canonicalCurrency(input.currency),
  ] as const;
  return {
    fingerprint: createHash('sha256').update(parts.join(FINGERPRINT_SEPARATOR), 'utf8').digest('hex'),
    version: FINGERPRINT_VERSION,
    bucket: parts[2],
    parts,
  };
}
