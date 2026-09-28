/**
 * S3 兼容驱动（SeaweedFS / MinIO / AWS S3）
 * ---------------------------------------------------------------
 * 覆盖 Gate 1 需要的三种操作：PUT（写入）、GET（读取）、HEAD（元数据）。
 * 明确不做：分片上传、批量删除、桶管理 —— 需要时单独提审计，不夹带。
 *
 * 凭据：构造函数只接收**取凭据的函数**，配置里永远只有引用名；
 *       真实密钥由密钥管理注入，且不会出现在日志里。
 * 下载地址：仍使用本服务自签令牌（与本地驱动一致），不依赖存储侧预签名配置。
 */

import {
  StorageAccessError,
  StorageNotFoundError,
  type ObjectMetadata,
  type SignedUrl,
  type SignedUrlOptions,
  type StorageAdapter,
  type StorageDriver,
  type StoragePutInput,
  type StoredObject,
} from './types';
import {
  assertFileAssetId,
  assertOrganizationId,
  assertTenantScopedKey,
  buildStorageKey,
  sha256Hex,
} from './keys';
import { issueSignedUrl, openToken } from './signed-url';
import { sha256HexOfBuffer, sha256HexOfString, signRequest, type AwsCredentials } from './sigv4';

export interface S3StorageOptions {
  endpoint: string;
  bucket: string;
  region: string;
  /** 凭据提供者（引用名 → 真实值由密钥管理解析） */
  credentials: () => Promise<AwsCredentials>;
  /** 本服务自签下载令牌的密钥 */
  secret: string;
  publicBaseUrl: string;
  /** 可选：令牌加密专用密钥（未提供则由 secret 派生） */
  tokenKey?: string;
  now?: () => number;
  /** SeaweedFS / MinIO 默认走 path-style；AWS 可设 false */
  forcePathStyle?: boolean;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
}

export class S3CompatibleStorage implements StorageAdapter {
  public readonly driver: StorageDriver = 's3';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: S3StorageOptions) {
    if (!options.endpoint || !options.bucket || !options.region) {
      throw new StorageAccessError('S3 端点 / 桶 / 区域未配置');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private objectUrl(storageKey: string): URL {
    const endpoint = this.options.endpoint.replace(/\/+$/, '');
    const pathStyle = this.options.forcePathStyle ?? true;
    if (pathStyle) {
      return new URL(`${endpoint}/${this.options.bucket}/${storageKey}`);
    }
    const url = new URL(endpoint);
    url.hostname = `${this.options.bucket}.${url.hostname}`;
    url.pathname = `/${storageKey}`;
    return url;
  }

  private async signedHeaders(
    method: string,
    url: URL,
    payloadHash: string,
    extra: Record<string, string>,
  ): Promise<Record<string, string>> {
    const credentials = await this.options.credentials();
    return signRequest({
      method,
      url,
      headers: extra,
      payloadHash,
      region: this.options.region,
      service: 's3',
      credentials,
      ...(this.options.now ? { date: new Date(this.options.now()) } : {}),
    });
  }

  async put(input: StoragePutInput): Promise<StoredObject> {
    assertOrganizationId(input.organizationId);
    assertFileAssetId(input.fileAssetId);
    if (!Buffer.isBuffer(input.body)) {
      throw new StorageAccessError('body 必须是 Buffer');
    }

    const sha256 = sha256Hex(input.body);
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
      throw new StorageAccessError('内容 sha256 与登记不符');
    }

    const storageKey = buildStorageKey({
      organizationId: input.organizationId,
      fileAssetId: input.fileAssetId,
      sha256,
    });
    const url = this.objectUrl(storageKey);
    const extra: Record<string, string> = { 'content-length': String(input.body.byteLength) };
    if (input.contentType) extra['content-type'] = input.contentType;

    const headers = await this.signedHeaders('PUT', url, sha256HexOfBuffer(input.body), extra);
    const response = await this.fetchImpl(url, { method: 'PUT', headers, body: input.body });
    if (!response.ok) {
      throw new StorageAccessError(`对象写入失败（HTTP ${response.status}）`);
    }

    return {
      storageKey,
      size: input.body.byteLength,
      sha256,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    };
  }

  private async request(
    method: 'GET' | 'HEAD',
    storageKey: string,
    organizationId: string,
  ): Promise<Response> {
    // 与本地驱动一致：读写前先证明 key 属于该租户（不依赖存储侧权限配置）
    assertTenantScopedKey(storageKey, organizationId);
    const url = this.objectUrl(storageKey);
    const emptyHash = sha256HexOfString('');
    const headers = await this.signedHeaders(method, url, emptyHash, {});
    return this.fetchImpl(url, { method, headers });
  }

  async get(
    storageKey: string,
    organizationId: string,
  ): Promise<{ body: Buffer; metadata: ObjectMetadata }> {
    const response = await this.request('GET', storageKey, organizationId);
    if (response.status === 404) throw new StorageNotFoundError('对象不存在');
    if (!response.ok) throw new StorageAccessError(`对象读取失败（HTTP ${response.status}）`);

    const body = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? undefined;
    return {
      body,
      metadata: {
        storageKey,
        size: body.byteLength,
        ...(contentType ? { contentType } : {}),
      },
    };
  }

  async head(storageKey: string, organizationId: string): Promise<ObjectMetadata | null> {
    const response = await this.request('HEAD', storageKey, organizationId);
    if (response.status === 404) return null;
    if (!response.ok) throw new StorageAccessError(`对象元数据读取失败（HTTP ${response.status}）`);

    const contentType = response.headers.get('content-type') ?? undefined;
    const length = response.headers.get('content-length');
    return {
      storageKey,
      size: length ? Number(length) : 0,
      ...(contentType ? { contentType } : {}),
    };
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
    organizationId: string;
    fileAssetId: string;
    disposition: 'inline' | 'attachment';
    filename?: string;
  }> {
    const payload = openToken(
      token,
      this.options.secret,
      this.options.now ? this.options.now() : Date.now(),
      this.options.tokenKey,
    );
    const { body, metadata } = await this.get(payload.storageKey, payload.organizationId);
    return {
      body,
      metadata,
      organizationId: payload.organizationId,
      fileAssetId: payload.fileAssetId,
      disposition: payload.disposition ?? 'attachment',
      ...(payload.filename ? { filename: payload.filename } : {}),
    };
  }
}
