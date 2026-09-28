/**
 * 存储 key 的构造与校验
 * ---------------------------------------------------------------
 * key 形如：`<organizationId>/<sha256 前 2 位>/<fileAssetId>`
 *
 * 设计要点：
 *   - **租户前缀是强制的**：读写前必须校验 `key` 以 `<organizationId>/` 开头，
 *     否则任何一次"手滑"都会变成跨租户读写（P0 缺陷）。
 *   - **不信任调用方传入的 key**：所有 key 都要过 `assertTenantScopedKey`，
 *     禁止 `..`、绝对路径、反斜杠、NUL/控制字符与 URL 编码占位。
 *   - 目录按 sha256 前两位打散，避免单目录塞满（对象存储侧无意义，但本地驱动有用）。
 */

import { createHash } from 'node:crypto';
import { StorageAccessError } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEY_LENGTH = 512;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function assertOrganizationId(organizationId: string): void {
  if (typeof organizationId !== 'string' || !isUuid(organizationId)) {
    throw new StorageAccessError('organizationId 必须是 UUID');
  }
}

export function assertFileAssetId(fileAssetId: string): void {
  if (typeof fileAssetId !== 'string' || !isUuid(fileAssetId)) {
    throw new StorageAccessError('fileAssetId 必须是 UUID');
  }
}

export function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** 由实现方构造 key —— 业务代码不自己拼 key */
export function buildStorageKey(input: {
  organizationId: string;
  fileAssetId: string;
  sha256: string;
}): string {
  assertOrganizationId(input.organizationId);
  assertFileAssetId(input.fileAssetId);
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) {
    throw new StorageAccessError('sha256 必须是 64 位十六进制');
  }
  const shard = input.sha256.slice(0, 2).toLowerCase();
  return `${input.organizationId}/${shard}/${input.fileAssetId}`;
}

/**
 * key 必须属于该租户，且不得包含任何可穿越/可混淆的字符。
 * 校验失败一律抛 StorageAccessError（不区分原因，避免探测）。
 */
export function assertTenantScopedKey(storageKey: string, organizationId: string): void {
  assertOrganizationId(organizationId);

  if (typeof storageKey !== 'string' || storageKey.length === 0 || storageKey.length > MAX_KEY_LENGTH) {
    throw new StorageAccessError('storageKey 非法');
  }
  // 控制字符 / NUL / 反斜杠 / URL 编码
  if (/[\u0000-\u001f\u007f\\%]/.test(storageKey)) {
    throw new StorageAccessError('storageKey 含非法字符');
  }
  if (storageKey.startsWith('/') || storageKey.endsWith('/') || storageKey.includes('//')) {
    throw new StorageAccessError('storageKey 形状非法');
  }

  const segments = storageKey.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new StorageAccessError('storageKey 含非法路径段');
    }
  }

  const prefix = `${organizationId}/`;
  if (!storageKey.startsWith(prefix)) {
    throw new StorageAccessError('storageKey 不属于该租户');
  }
}
