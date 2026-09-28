import { Client as MinioClient } from 'minio';
import { env } from './env';
import { logger } from './logger';

let minio: MinioClient | null = null;
let minioFailed = false;

import fs from 'fs';
import path from 'path';

const LOCAL_STORAGE = path.join(process.cwd(), 'uploads');

function ensureLocalDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getMinio(): MinioClient | null {
  if (minioFailed) return null;
  if (!minio) {
    const config = env();
    try {
      minio = new MinioClient({
        endPoint: config.MINIO_ENDPOINT,
        port: config.MINIO_PORT,
        useSSL: false,
        accessKey: config.MINIO_ACCESS_KEY,
        secretKey: config.MINIO_SECRET_KEY,
      });
    } catch {
      minioFailed = true;
      logger.warn('MinIO unavailable, using local filesystem storage');
      return null;
    }
  }
  return minio;
}

export async function ensureTenantBucket(tenantId: string): Promise<void> {
  const client = getMinio();
  if (!client) {
    ensureLocalDir(path.join(LOCAL_STORAGE, tenantId));
    return;
  }
  const bucketName = `tenant-${tenantId}`;
  try {
    const exists = await client.bucketExists(bucketName);
    if (!exists) {
      await client.makeBucket(bucketName);
    }
  } catch { /* MinIO not available */ }
}

export function tenantBucket(tenantId: string): string {
  return `tenant-${tenantId}`;
}

export async function putObject(bucket: string, objectName: string, buffer: Buffer): Promise<void> {
  const client = getMinio();
  if (!client) {
    const tenantId = bucket.replace('tenant-', '');
    const filePath = path.join(LOCAL_STORAGE, tenantId, objectName);
    ensureLocalDir(path.dirname(filePath));
    fs.writeFileSync(filePath, buffer);
    return;
  }
  try {
    await client.putObject(bucket, objectName, buffer);
  } catch {
    const tenantId = bucket.replace('tenant-', '');
    const filePath = path.join(LOCAL_STORAGE, tenantId, objectName);
    ensureLocalDir(path.dirname(filePath));
    fs.writeFileSync(filePath, buffer);
  }
}
