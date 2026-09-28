/**
 * 存储适配层工厂
 * ---------------------------------------------------------------
 * 业务代码只拿 `StorageAdapter`，不关心驱动。
 * 驱动选择来自配置（STORAGE_DRIVER），默认 `local`，因此 CI 与本地开发
 * 无需任何对象存储即可跑通全部存储测试。
 */

import { LocalFileSystemStorage } from './local-file-storage';
import { S3CompatibleStorage } from './s3-storage';
import type { AwsCredentials } from './sigv4';
import type { StorageAdapter, StorageDriver } from './types';

export * from './types';
export { buildStorageKey, assertTenantScopedKey, fileAssetIdFromKey, sha256Hex } from './keys';
export { sealToken, openToken, issueSignedUrl, sanitizeFilename } from './signed-url';
export { LocalFileSystemStorage } from './local-file-storage';
export { S3CompatibleStorage } from './s3-storage';
export { signRequest, type AwsCredentials } from './sigv4';

export interface StorageEnvLike {
  STORAGE_DRIVER?: string;
  STORAGE_LOCAL_ROOT?: string;
  STORAGE_PUBLIC_BASE_URL?: string;
  STORAGE_URL_SECRET?: string;
  STORAGE_TOKEN_KEY?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
}

export interface StorageFactoryDeps {
  /** S3 驱动的凭据提供者；缺省时使用 S3 驱动会直接报错（不静默降级） */
  credentials?: () => Promise<AwsCredentials>;
  fetchImpl?: typeof fetch;
}

export function createStorageAdapter(
  env: StorageEnvLike,
  deps: StorageFactoryDeps = {},
): StorageAdapter {
  const driver = (env.STORAGE_DRIVER ?? 'local') as StorageDriver;
  const publicBaseUrl = env.STORAGE_PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const secret = env.STORAGE_URL_SECRET ?? '';
  const tokenKey = env.STORAGE_TOKEN_KEY;

  if (driver === 'local') {
    return new LocalFileSystemStorage({
      rootDir: env.STORAGE_LOCAL_ROOT ?? './.storage',
      secret,
      publicBaseUrl,
      ...(tokenKey ? { tokenKey } : {}),
    });
  }

  if (driver === 's3') {
    if (!deps.credentials) {
      throw new Error('S3 驱动需要注入凭据提供者（配置里只放引用名，真实值由密钥管理提供）');
    }
    return new S3CompatibleStorage({
      endpoint: env.S3_ENDPOINT ?? '',
      bucket: env.S3_BUCKET ?? '',
      region: env.S3_REGION ?? 'us-east-1',
      credentials: deps.credentials,
      secret,
      publicBaseUrl,
      ...(tokenKey ? { tokenKey } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }

  throw new Error(`未知的存储驱动: ${String(driver)}`);
}
