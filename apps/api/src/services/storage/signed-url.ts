/**
 * 限时下载令牌（自签 + **加密**，不依赖对象存储自身的预签名能力）
 * ---------------------------------------------------------------
 * CHANGE #22：早期实现是 `base64url(payloadJson) + "." + HMAC`。
 * 签名只能防篡改、**不能保密** —— 任何人把令牌第一段 base64url 解码就能看到
 * storageKey，这与「禁止把裸 storageKey 交给前端」的契约自相矛盾。
 *
 * 现在改为带认证加密：
 *   `base64url(iv) + "." + base64url(ciphertext) + "." + base64url(authTag)`
 *   - AES-256-GCM：机密性与完整性一起保证
 *   - 密钥优先取 STORAGE_TOKEN_KEY；未配置则从 STORAGE_URL_SECRET 经 scrypt 派生
 *   - 令牌对外不透明：解不开、猜不出、改不动
 *
 * 校验顺序：GCM 认证 → 载荷字段 → fileAssetId 与 storageKey 一致 → 未过期。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
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
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_INFO = 'crossclaim-storage-token-v1';

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new StorageAccessError('签名密钥未配置或过短');
  }
}

/** 令牌密钥：优先专用 STORAGE_TOKEN_KEY，否则从 STORAGE_URL_SECRET 派生 */
function tokenKey(secret: string, dedicatedKey?: string): Buffer {
  assertSecret(secret);
  const material = dedicatedKey && dedicatedKey.length >= 16 ? dedicatedKey : secret;
  return scryptSync(material, KEY_INFO, 32);
}

function normalizeTtl(ttlSeconds?: number): number {
  if (ttlSeconds === undefined) return DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new StorageAccessError('ttlSeconds 非法');
  }
  return Math.min(Math.floor(ttlSeconds), MAX_TTL_SECONDS);
}

/** 生成不透明令牌（AES-256-GCM） */
export function sealToken(
  payload: SignedTokenPayload,
  secret: string,
  dedicatedKey?: string,
): string {
  const key = tokenKey(secret, dedicatedKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${base64url(iv)}.${base64url(ciphertext)}.${base64url(tag)}`;
}

/** 解开令牌；认证失败 / 载荷损坏 / 过期一律抛 StorageAccessError */
export function openToken(
  token: string,
  secret: string,
  now: number = Date.now(),
  dedicatedKey?: string,
): SignedTokenPayload {
  const key = tokenKey(secret, dedicatedKey);
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    throw new StorageAccessError('令牌非法');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new StorageAccessError('令牌格式非法');

  const iv = fromBase64url(parts[0]);
  const ciphertext = fromBase64url(parts[1]);
  const tag = fromBase64url(parts[2]);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new StorageAccessError('令牌格式非法');
  }

  let parsed: unknown;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    // 认证失败（篡改 / 换密钥 / 截断）与载荷损坏统一措辞，避免被用来探测
    throw new StorageAccessError('令牌校验失败');
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
  /** 可选：专用令牌密钥（未提供则由 secret 派生） */
  tokenKey?: string;
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

  const token = sealToken(
    {
      storageKey: input.storageKey,
      fileAssetId: fileAssetIdFromKey(input.storageKey),
      organizationId: input.organizationId,
      expiresAt,
      ...(input.options?.disposition ? { disposition: input.options.disposition } : {}),
      ...(input.options?.filename ? { filename: sanitizeFilename(input.options.filename) } : {}),
    },
    config.secret,
    config.tokenKey,
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
