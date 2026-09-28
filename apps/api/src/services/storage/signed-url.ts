/**
 * 限时下载令牌（自签，不依赖对象存储自身的预签名能力）
 * ---------------------------------------------------------------
 * 为什么自签：
 *   - 两种驱动（本地磁盘 / S3 兼容）行为一致，业务与测试只需一套语义
 *   - 租户校验始终发生在**我们自己的代码里**，不受存储侧配置影响
 *   - 未来要换成 S3 预签名只是实现优化，不改变对外契约
 *
 * 令牌格式：`base64url(payloadJson) + "." + base64url(hmacSha256(payloadJson))`
 * payload 里带 storageKey / organizationId / 过期时间 / 下载处置方式。
 * 校验时必须同时满足：签名正确（常量时间比较） + 未过期 + key 属于该租户。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { StorageAccessError, type SignedUrl, type SignedUrlOptions } from './types';
import { assertTenantScopedKey, fileAssetIdFromKey } from './keys';

export interface SignedTokenPayload {
  storageKey: string;
  /** 直接带上 fileAssetId，避免审计层解析 storageKey */
  fileAssetId: string;
  organizationId: string;
  expiresAt: number;
  disposition?: 'inline' | 'attachment';
  filename?: string;
}

export const DEFAULT_TTL_SECONDS = 300;
export const MAX_TTL_SECONDS = 900;

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function hmac(payloadJson: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadJson).digest();
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new StorageAccessError('签名密钥未配置或过短');
  }
}

function normalizeTtl(ttlSeconds?: number): number {
  if (ttlSeconds === undefined) return DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new StorageAccessError('ttlSeconds 非法');
  }
  return Math.min(Math.floor(ttlSeconds), MAX_TTL_SECONDS);
}

export function signToken(payload: SignedTokenPayload, secret: string): string {
  assertSecret(secret);
  const payloadJson = JSON.stringify(payload);
  return `${base64url(payloadJson)}.${base64url(hmac(payloadJson, secret))}`;
}

export function verifyToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): SignedTokenPayload {
  assertSecret(secret);
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    throw new StorageAccessError('令牌非法');
  }
  const parts = token.split('.');
  if (parts.length !== 2) throw new StorageAccessError('令牌格式非法');

  const payloadBuf = fromBase64url(parts[0]);
  const payloadJson = payloadBuf.toString('utf8');
  const provided = fromBase64url(parts[1]);
  const expected = hmac(payloadJson, secret);

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new StorageAccessError('令牌签名不匹配');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new StorageAccessError('令牌载荷非法');
  }

  const payload = parsed as Partial<SignedTokenPayload>;
  if (
    typeof payload.storageKey !== 'string' ||
    typeof payload.fileAssetId !== 'string' ||
    typeof payload.organizationId !== 'string' ||
    typeof payload.expiresAt !== 'number'
  ) {
    throw new StorageAccessError('令牌载荷字段缺失');
  }
  if (fileAssetIdFromKey(payload.storageKey) !== payload.fileAssetId) {
    throw new StorageAccessError('令牌载荷与 storageKey 不一致');
  }
  if (payload.expiresAt <= now) {
    throw new StorageAccessError('令牌已过期');
  }
  return {
    storageKey: payload.storageKey,
    fileAssetId: payload.fileAssetId,
    organizationId: payload.organizationId,
    expiresAt: payload.expiresAt,
    ...(payload.disposition ? { disposition: payload.disposition } : {}),
    ...(payload.filename ? { filename: payload.filename } : {}),
  };
}

export interface IssueSignedUrlConfig {
  secret: string;
  publicBaseUrl: string;
  now?: () => number;
}

export function issueSignedUrl(
  config: IssueSignedUrlConfig,
  input: { storageKey: string; organizationId: string; options?: SignedUrlOptions },
): SignedUrl {
  assertTenantScopedKey(input.storageKey, input.organizationId);
  const ttl = normalizeTtl(input.options?.ttlSeconds);
  const now = config.now ? config.now() : Date.now();
  const expiresAt = now + ttl * 1000;

  const token = signToken(
    {
      storageKey: input.storageKey,
      fileAssetId: fileAssetIdFromKey(input.storageKey),
      organizationId: input.organizationId,
      expiresAt,
      ...(input.options?.disposition ? { disposition: input.options.disposition } : {}),
      ...(input.options?.filename ? { filename: sanitizeFilename(input.options.filename) } : {}),
    },
    config.secret,
  );

  const base = config.publicBaseUrl.replace(/\/+$/, '');
  return {
    url: `${base}/files/${token}`,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** 文件名只允许出现在响应头里；这里先剥掉路径与危险字符 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'download';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'download';
}
