/**
 * 本地磁盘驱动（开发 / CI / 单机部署）
 * ---------------------------------------------------------------
 * 定位：让"存储"这件事在没有任何对象存储的机器上也能真实跑通 ——
 * 测试、CI、本地开发都用它，因此它是**真实现**，不是占位。
 *
 * 安全实现：
 *   - 写前用 `path.resolve(root, key)` 再校验前缀，双保险挡住路径穿越
 *   - 写文件用"临时文件 + rename"，避免半截文件被读到
 *   - 元数据（contentType）落在旁路 `.meta.json`，不改对象本体
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  StorageAccessError,
  StorageIntegrityError,
  StorageNotFoundError,
  type ObjectMetadata,
  type SignedUrl,
  type SignedUrlOptions,
  type StorageAdapter,
  type StorageDriver,
  type StoragePutInput,
  type StoredObject,
} from './types';
import { assertFileAssetId, assertOrganizationId, assertTenantScopedKey, buildStorageKey, sha256Hex } from './keys';
import { issueSignedUrl, verifyToken } from './signed-url';

export interface LocalFileStorageOptions {
  rootDir: string;
  secret: string;
  publicBaseUrl: string;
  now?: () => number;
}

interface SidecarMeta {
  contentType?: string;
  size: number;
}

export class LocalFileSystemStorage implements StorageAdapter {
  public readonly driver: StorageDriver = 'local';
  private readonly rootDir: string;

  constructor(private readonly options: LocalFileStorageOptions) {
    if (!options.rootDir || options.rootDir.trim() === '') {
      throw new StorageAccessError('本地存储根目录未配置');
    }
    this.rootDir = path.resolve(options.rootDir);
  }

  private resolveObjectPath(storageKey: string, organizationId: string): string {
    assertTenantScopedKey(storageKey, organizationId);
    const full = path.resolve(this.rootDir, storageKey);
    if (full !== this.rootDir && !full.startsWith(this.rootDir + path.sep)) {
      throw new StorageAccessError('storageKey 解析后逃出存储根目录');
    }
    return full;
  }

  private metaPath(objectPath: string): string {
    return `${objectPath}.meta.json`;
  }

  private async writeAtomic(objectPath: string, body: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    const tmp = `${objectPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, objectPath);
  }

  async put(input: StoragePutInput): Promise<StoredObject> {
    assertOrganizationId(input.organizationId);
    assertFileAssetId(input.fileAssetId);
    if (!Buffer.isBuffer(input.body)) {
      throw new StorageAccessError('body 必须是 Buffer');
    }

    const sha256 = sha256Hex(input.body);
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
      throw new StorageIntegrityError('内容 sha256 与登记不符');
    }

    const storageKey = buildStorageKey({
      organizationId: input.organizationId,
      fileAssetId: input.fileAssetId,
      sha256,
    });
    const objectPath = this.resolveObjectPath(storageKey, input.organizationId);

    await this.writeAtomic(objectPath, input.body);
    const meta: SidecarMeta = { size: input.body.byteLength };
    if (input.contentType) meta.contentType = input.contentType;
    await this.writeAtomic(this.metaPath(objectPath), Buffer.from(JSON.stringify(meta), 'utf8'));

    return {
      storageKey,
      size: input.body.byteLength,
      sha256,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    };
  }

  private async readMeta(objectPath: string): Promise<Partial<SidecarMeta>> {
    try {
      const raw = await fs.readFile(this.metaPath(objectPath), 'utf8');
      return JSON.parse(raw) as Partial<SidecarMeta>;
    } catch {
      return {};
    }
  }

  async get(
    storageKey: string,
    organizationId: string,
  ): Promise<{ body: Buffer; metadata: ObjectMetadata }> {
    const objectPath = this.resolveObjectPath(storageKey, organizationId);
    let body: Buffer;
    try {
      body = await fs.readFile(objectPath);
    } catch {
      throw new StorageNotFoundError('对象不存在');
    }
    const meta = await this.readMeta(objectPath);
    return {
      body,
      metadata: {
        storageKey,
        size: body.byteLength,
        ...(meta.contentType ? { contentType: meta.contentType } : {}),
      },
    };
  }

  async head(storageKey: string, organizationId: string): Promise<ObjectMetadata | null> {
    const objectPath = this.resolveObjectPath(storageKey, organizationId);
    try {
      const stat = await fs.stat(objectPath);
      const meta = await this.readMeta(objectPath);
      return {
        storageKey,
        size: stat.size,
        ...(meta.contentType ? { contentType: meta.contentType } : {}),
      };
    } catch {
      return null;
    }
  }

  async createSignedUrl(
    storageKey: string,
    organizationId: string,
    options?: SignedUrlOptions,
  ): Promise<SignedUrl> {
    return issueSignedUrl(
      {
        secret: this.options.secret,
        publicBaseUrl: this.options.publicBaseUrl,
        ...(this.options.now ? { now: this.options.now } : {}),
      },
      { storageKey, organizationId, ...(options ? { options } : {}) },
    );
  }

  async openSignedUrl(token: string): Promise<{
    body: Buffer;
    metadata: ObjectMetadata;
    disposition: 'inline' | 'attachment';
    filename?: string;
  }> {
    const payload = verifyToken(token, this.options.secret, this.options.now ? this.options.now() : Date.now());
    const { body, metadata } = await this.get(payload.storageKey, payload.organizationId);
    return {
      body,
      metadata,
      disposition: payload.disposition ?? 'attachment',
      ...(payload.filename ? { filename: payload.filename } : {}),
    };
  }
}
