/**
 * 服务端版本化提交快照（platform-write-request/v1）
 * ---------------------------------------------------------------
 * 与 appeal-submission/v1 同一形状：键排序的规范化 JSON + sha256。
 * 审批创建与执行核验必须复用同一函数，保证「审批时事实」与「执行时事实」逐字节可比。
 */

import { createHash } from 'node:crypto';

import {
  PLATFORM_WRITE_SNAPSHOT_VERSION,
  PlatformWriteError,
  type PlatformWriteSnapshot,
  type PlatformWriteTargetKind,
} from './types';

function canonicalize(value: unknown, at: string): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    const numeric = value as number;
    if (!Number.isFinite(numeric)) {
      throw new PlatformWriteError('PAYLOAD_NOT_CANONICAL', '非有限数字，无法规范化: ' + at);
    }
    return JSON.stringify(numeric);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item, index) => canonicalize(item, at + '[' + index + ']')).join(',') + ']';
  }
  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    return (
      '{' +
      entries.map(([key, item]) => JSON.stringify(key) + ':' + canonicalize(item, at + '.' + key)).join(',') +
      '}'
    );
  }
  throw new PlatformWriteError('PAYLOAD_NOT_CANONICAL', '不支持的取值类型: ' + at);
}

/** 键排序规范化 JSON：字段顺序不同但语义相同 → 同一字符串 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, '$');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function payloadDigest(payload: Record<string, unknown>): string {
  return sha256(canonicalJson(payload));
}

export interface PlatformWriteSnapshotInput {
  organizationId: string;
  caseId: string;
  targetKind: PlatformWriteTargetKind;
  targetId: string;
  platform: string;
  payload: Record<string, unknown>;
}

export function buildPlatformWriteSnapshot(input: PlatformWriteSnapshotInput): PlatformWriteSnapshot {
  const organizationId = String(input.organizationId ?? '').trim();
  const caseId = String(input.caseId ?? '').trim();
  const targetId = String(input.targetId ?? '').trim();
  const platform = String(input.platform ?? '').trim();
  if (!organizationId) throw new PlatformWriteError('SNAPSHOT_INPUT_INVALID', 'organizationId 必填');
  if (!caseId) throw new PlatformWriteError('SNAPSHOT_INPUT_INVALID', 'caseId 必填');
  if (!targetId) throw new PlatformWriteError('SNAPSHOT_INPUT_INVALID', 'targetId 必填');
  if (!platform) throw new PlatformWriteError('SNAPSHOT_INPUT_INVALID', 'platform 必填');

  const serialized = canonicalJson(input.payload);
  return {
    version: PLATFORM_WRITE_SNAPSHOT_VERSION,
    organizationId,
    caseId,
    targetKind: input.targetKind,
    targetId,
    platform,
    payloadDigest: sha256(serialized),
    payloadLength: Buffer.byteLength(serialized, 'utf8'),
  };
}

/** 快照摘要：审批 basisReference 与幂等键都由它派生 */
export function snapshotDigest(snapshot: PlatformWriteSnapshot): string {
  return sha256(canonicalJson(snapshot as unknown as Record<string, unknown>));
}

/**
 * 幂等键：**同一载荷与同一目标**永远派生同一键（不随尝试次数变化），
 * 这样重试对上游而言是同一次提交，不会二次落账。
 */
export function deriveIdempotencyKey(digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(String(digest ?? ''))) {
    throw new PlatformWriteError('IDEMPOTENCY_KEY_INPUT_INVALID', '快照摘要必须是 64 位十六进制');
  }
  return 'pw1-' + sha256(PLATFORM_WRITE_SNAPSHOT_VERSION + '|' + digest).slice(0, 40);
}
