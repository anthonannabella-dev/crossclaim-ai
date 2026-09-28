/**
 * 限时下载令牌：不透明（AES-256-GCM）+ **密钥只派生一次**
 * ---------------------------------------------------------------
 * CHANGE #22：令牌必须是不可解的密文，而不是 base64url(JSON) + HMAC。
 * CHANGE #26：scrypt 属于慢速 KDF，**绝不能出现在公网下载热路径**。
 *             因此密钥在 TokenCodec 创建时派生一次（适配器构造阶段），
 *             之后每次签发 / 解开都复用同一个 32 字节密钥。
 * CHANGE #25：签发与解开必须使用**同一份密钥材料**，
 *             统一规则 effective material = STORAGE_TOKEN_KEY ?? STORAGE_URL_SECRET；
 *             配置了专用密钥就真正使用它，过短直接 fail fast，不静默回退。
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
const KEY_BYTES = 32;
const KEY_INFO = 'crossclaim-storage-token-v1';
const MIN_SECRET_LENGTH = 16;

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function assertSecret(secret: string, label: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new StorageAccessError(`${label} 未配置或过短（至少 ${MIN_SECRET_LENGTH} 位）`);
  }
}

function normalizeTtl(ttlSeconds: number | undefined, fallback: number): number {
  const ttl = ttlSeconds === undefined ? fallback : ttlSeconds;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new StorageAccessError('ttlSeconds 非法');
  }
  return Math.min(Math.floor(ttl), MAX_TTL_SECONDS);
}

export interface TokenCodecOptions {
  /** 必填：STORAGE_URL_SECRET（作为默认密钥材料） */
  secret: string;
  /** 可选：STORAGE_TOKEN_KEY。配置后**真正生效**，过短直接抛错 */
  tokenKey?: string;
  /** 签发默认有效期（来自 STORAGE_SIGNED_URL_TTL_SECONDS） */
  defaultTtlSeconds?: number;
  now?: () => number;
}

export interface TokenCodec {
  readonly defaultTtlSeconds: number;
  seal(payload: SignedTokenPayload): string;
  open(token: string, now?: number): SignedTokenPayload;
}

/**
 * 创建令牌编解码器：**构造时派生密钥一次**，之后零 KDF。
 * 这是唯一的密钥入口 —— 驱动必须复用同一个 codec。
 */
export function createTokenCodec(options: TokenCodecOptions): TokenCodec {
  assertSecret(options.secret, 'STORAGE_URL_SECRET');
  let material = options.secret;
  if (options.tokenKey !== undefined) {
    if (options.tokenKey === '') {
      throw new StorageAccessError('STORAGE_TOKEN_KEY 配置为空字符串，请删除该变量或填入合法密钥');
    }
    assertSecret(options.tokenKey, 'STORAGE_TOKEN_KEY');
    material = options.tokenKey;
  }

  // 唯一一次慢速 KDF（scrypt）：之后签发 / 解开都复用 derivedKey
  const derivedKey = scryptSync(material, KEY_INFO, KEY_BYTES);
  const defaultTtlSeconds = normalizeTtl(options.defaultTtlSeconds, DEFAULT_TTL_SECONDS);

  return {
    defaultTtlSeconds,

    seal(payload: SignedTokenPayload): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
        cipher.final(),
      ]);
      return `${base64url(iv)}.${base64url(ciphertext)}.${base64url(cipher.getAuthTag())}`;
    },

    open(token: string, now?: number): SignedTokenPayload {
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
        const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
        decipher.setAuthTag(tag);
        const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        parsed = JSON.parse(json);
      } catch {
        // 认证失败（篡改 / 换密钥 / 截断）与载荷损坏统一措辞，避免被探测
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
      const currentTime = now ?? (options.now ? options.now() : Date.now());
      if (payload.expiresAt <= currentTime) {
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
    },
  };
}

/* ------------------------------------------------------------------
 * 便捷封装：每次调用创建 codec（会跑一次 scrypt）。
 * **仅供单元测试 / 一次性脚本使用**，不要放进请求热路径。
 * ------------------------------------------------------------------ */

export function sealToken(
  payload: SignedTokenPayload,
  secret: string,
  dedicatedKey?: string,
): string {
  return createTokenCodec({
    secret,
    ...(dedicatedKey !== undefined ? { tokenKey: dedicatedKey } : {}),
  }).seal(payload);
}

export function openToken(
  token: string,
  secret: string,
  now: number = Date.now(),
  dedicatedKey?: string,
): SignedTokenPayload {
  return createTokenCodec({
    secret,
    ...(dedicatedKey !== undefined ? { tokenKey: dedicatedKey } : {}),
  }).open(token, now);
}

export interface IssueSignedUrlOptions {
  publicBaseUrl: string;
  now?: () => number;
}

export function issueSignedUrl(
  codec: TokenCodec,
  options: IssueSignedUrlOptions,
  input: { storageKey: string; organizationId: string; options?: SignedUrlOptions },
): SignedUrl {
  assertTenantScopedKey(input.storageKey, input.organizationId);
  const ttl = normalizeTtl(input.options?.ttlSeconds, codec.defaultTtlSeconds);
  const now = options.now ? options.now() : Date.now();
  const expiresAt = now + ttl * 1000;

  const token = codec.seal({
    storageKey: input.storageKey,
    fileAssetId: fileAssetIdFromKey(input.storageKey),
    organizationId: input.organizationId,
    expiresAt,
    ...(input.options?.disposition ? { disposition: input.options.disposition } : {}),
    ...(input.options?.filename ? { filename: sanitizeFilename(input.options.filename) } : {}),
  });

  const base = options.publicBaseUrl.replace(/\/+$/, '');
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
