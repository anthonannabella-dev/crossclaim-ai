/**
 * 幂等键：与 DOMAIN_MODEL §4.3 完全一致
 * ---------------------------------------------------------------
 *   dedupeKey = sha256(organizationId | connectionId | referenceType | externalId | rowFingerprint)
 *   rowFingerprint = 原始行归一化后的稳定指纹
 *
 * 目的：同一张账单/运单行重复导入不产生第二条 SourceTransaction，
 *       进而不会重复产出 RecoveryOpportunity。
 */

import { createHash } from 'node:crypto';
import type { RawRow } from './types';

/**
 * 行指纹：按列名排序后拼接 `key=value`，值去掉首尾空白并压缩内部空白。
 * 与列顺序无关，与全角/半角空白差异无关（压缩后比较）。
 */
export function rowFingerprint(raw: RawRow): string {
  const entries = Object.keys(raw)
    .sort()
    .map((key) => `${key.trim().toLowerCase()}=${(raw[key] ?? '').trim().replace(/\s+/g, ' ')}`);
  return createHash('sha256').update(entries.join('\u0001'), 'utf8').digest('hex');
}

export interface DedupeKeyInput {
  organizationId: string;
  connectionId?: string | null;
  referenceType?: string | null;
  externalId?: string | null;
  rowFingerprint: string;
}

export function dedupeKey(input: DedupeKeyInput): string {
  const parts = [
    input.organizationId,
    input.connectionId ?? '',
    input.referenceType ?? '',
    input.externalId ?? '',
    input.rowFingerprint,
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}
