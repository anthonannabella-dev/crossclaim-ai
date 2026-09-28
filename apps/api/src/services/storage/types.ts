/**
 * 存储适配层契约（C-0003 / Gate 1 · 第 1 项 Storage Adapter）
 * ---------------------------------------------------------------
 * 为什么需要它：
 *   `FileAsset` 只记录"字节 + 元数据"，但字节究竟落在本地磁盘还是 S3 兼容
 *   对象存储，属于**部署细节**，不能渗进业务逻辑 —— 业务只认 `storageKey`
 *   与**签名 URL**。
 *
 * 硬约束（ARCHITECTURE_CONTRACT §5.1）：
 *   1. 任何读写都必须带 `organizationId`，且 key 必须属于该租户
 *   2. 禁止把裸 `storageKey` 交给前端；对外只发签名 URL
 *   3. 签名 URL 必须带过期时间，且由本服务校验签名后才放行
 *   4. 凭据只以"引用名"出现在配置里，真实值由密钥管理注入
 */

export type StorageDriver = 'local' | 's3';

export interface StoragePutInput {
  organizationId: string;
  fileAssetId: string;
  body: Buffer;
  contentType?: string;
  /** 可选：调用方已知的 sha256。不一致则拒绝写入（防止内容与登记不符） */
  expectedSha256?: string;
}

export interface StoredObject {
  storageKey: string;
  size: number;
  sha256: string;
  contentType?: string;
}

export interface ObjectMetadata {
  storageKey: string;
  size: number;
  contentType?: string;
}

export interface SignedUrlOptions {
  /** 秒；超过实现上限会被夹到上限 */
  ttlSeconds?: number;
  disposition?: 'inline' | 'attachment';
  /** 仅用于下载文件名，不参与存储 key */
  filename?: string;
}

export interface SignedUrl {
  url: string;
  token: string;
  expiresAt: string;
}

export interface StorageAdapter {
  readonly driver: StorageDriver;

  /** 写入对象；key 由实现按租户规则生成并返回 */
  put(input: StoragePutInput): Promise<StoredObject>;

  /** 读取对象；key 必须属于给定租户，否则抛 StorageAccessError */
  get(storageKey: string, organizationId: string): Promise<{ body: Buffer; metadata: ObjectMetadata }>;

  /** 只取元数据；不存在返回 null（key 不属于该租户仍然抛错） */
  head(storageKey: string, organizationId: string): Promise<ObjectMetadata | null>;

  /** 签发限时下载地址；裸 key 不对外 */
  createSignedUrl(
    storageKey: string,
    organizationId: string,
    options?: SignedUrlOptions,
  ): Promise<SignedUrl>;

  /**
   * 用下载令牌换取对象内容（签名校验 + 过期校验 + 租户校验都在实现内部完成）。
   * 这样 HTTP 层不需要接触签名密钥。
   */
  openSignedUrl(token: string): Promise<{
    body: Buffer;
    metadata: ObjectMetadata;
    /** 令牌里带的租户 —— 审计直接用它，避免再解析 */
    organizationId: string;
    /** 令牌里带的 fileAssetId —— 供审计直接使用，不必在审计层解析 storageKey */
    fileAssetId: string;
    disposition: 'inline' | 'attachment';
    filename?: string;
  }>;
}

/** 租户串线 / key 非法：一律拒绝，不区分对外措辞 */
export class StorageAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageAccessError';
  }
}

export class StorageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageNotFoundError';
  }
}

/** 内容与登记不一致（sha256 不符） */
export class StorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageIntegrityError';
  }
}
