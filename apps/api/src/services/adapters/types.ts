/**
 * 外部平台适配器契约（C-0003 / Gate 1 · Checkpoint 2 · 第 2 项 Adapter interface）
 * ---------------------------------------------------------------
 * 依据 ARCHITECTURE_CONTRACT §6（Adapter 契约）与架构方 Checkpoint 2 的边界：
 *
 *   authenticate / read → fetch external data → map into canonical ingest format
 *
 * 四条硬边界：
 *   1. Amazon / UPS / FedEx / DHL 等**平台特有字段不得进入核心领域模型**；
 *      平台字段只能出现在 `AdapterRecord.source`（作为证据原样保留）。
 *   2. 适配器只输出**规范导入格式**（见 canonical.ts），
 *      解析、校验、幂等、租户归属、批次状态机全部由 Import foundation 负责。
 *   3. Phase 1 只读：不得向任何第三方平台写入。`supportsClaimSubmission`
 *      在类型上恒为 false，提交一律走 NEEDS_MANUAL 人工卡口。
 *   4. 凭据只以**引用名**出现在代码与配置里，真实值由 SecretProvider 注入；
 *      适配器不得把凭据值写进日志、错误信息或 source 载荷。
 */

import type { Channel, RecoveryDomain } from '@prisma/client';

/** 凭据引用：只有引用名与主体标识，没有密钥值 */
export interface AdapterCredentialRef {
  /** 密钥管理系统中的引用名（如 `CROSSCLAIM_AMAZON_SP_RO`）；真实值不进入代码/配置/日志 */
  secretRef: string;
  /** 该凭据对应的主体标识（如卖家 ID / 账号 ID），用于审计对齐；不含密钥 */
  subject?: string;
}

/** 取密钥的端口：实现方可以是环境变量、Vault、KMS */
export interface SecretProvider {
  resolve(secretRef: string): Promise<string>;
}

export interface AdapterCapabilities {
  /** 稳定的平台标识，如 'amazon-sp' / 'ups' / 'fedex' / 'dhl' */
  readonly platform: string;
  readonly displayName: string;
  readonly domains: readonly RecoveryDomain[];
  readonly channels: readonly Channel[];
  readonly supportsIncrementalPull: boolean;
  readonly supportsPagination: boolean;
  /**
   * Phase 1 硬闸门：外部平台写入（自动提交 Claim / Appeal）一律未开启。
   *
   * 类型上锁死为 `false`。改成 `true` 属于「Adapter 获得第三方写权限」，
   * 属于必须回架构方审计的动作，不在 Codex 自主权限内（ARCHITECTURE_CONTRACT §6）。
   */
  readonly supportsClaimSubmission: false;
  /** 适配器自报的单页上限，供调用方限流参考 */
  readonly maxPageSize: number;
}

/** 认证后的会话句柄。核心层完全不解释 handle，只透传给 pull()；不得放凭据明文 */
export interface AdapterSession {
  readonly platform: string;
  readonly handle: unknown;
  readonly expiresAt?: string;
}

export interface AdapterPullRequest {
  readonly organizationId: string;
  readonly connectionId?: string;
  readonly domain: RecoveryDomain;
  readonly channel: Channel;
  /** 增量拉取起点（ISO 8601） */
  readonly since?: string;
  /** 增量拉取终点（ISO 8601） */
  readonly until?: string;
  readonly cursor?: string | null;
  readonly pageSize?: number;
}

/**
 * 平台记录 → 规范字段的中间形态。
 * 金额只接受十进制字符串（number 仅在能被安全表示时接受，见 canonicalAmount）；
 * 平台特有字段一律进 `source`，不得新增规范字段。
 */
export interface AdapterRecord {
  externalId?: string | number | null;
  referenceType?: string | null;
  occurredAt?: string | Date | null;
  amount?: string | number | null;
  currency?: string | null;
  /** 平台原始载荷（证据）。必须 JSON 可序列化，且不得含凭据明文 */
  source?: unknown;
}

export interface AdapterPullPage {
  readonly records: readonly AdapterRecord[];
  /** 下一页游标；没有下一页时必须为 null */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** 平台侧总数（可选，仅供观测） */
  readonly total?: number;
}

export type AdapterSubmissionResult =
  | { readonly status: 'NEEDS_MANUAL'; readonly reason: string }
  | { readonly status: 'SUBMITTED'; readonly externalRef: string };

export interface AdapterClaimSubmission {
  readonly organizationId: string;
  readonly claimId: string;
  /** 规范化后的提交内容（业务层生成，适配器只负责投递） */
  readonly payload: unknown;
}

/**
 * Phase 1 活跃接口：**只读**外部适配器。
 *
 * C-0003 Checkpoint 2 Round 1 / CHANGE #28：第三方写入闸门必须是「调用前拒绝」，
 * 不能「写完才报警」。因此活跃接口里**不存在** submitClaim() ——
 * 适配器在结构上就没有可执行的真实写入方法。
 */
export interface ExternalAdapter {
  readonly platform: string;

  capabilities(): AdapterCapabilities;

  /** 获取 / 刷新凭据。凭据真实值由 SecretProvider 提供，句柄不得暴露给核心层 */
  authenticate(credentials: AdapterCredentialRef): Promise<AdapterSession>;

  /** 拉取数据（分页、增量、限流由适配器内部处理，错误用 AdapterError 表达） */
  pull(request: AdapterPullRequest, session: AdapterSession): Promise<AdapterPullPage>;
}

/**
 * **Phase 1 未启用**的外部写入面（自动提交 Claim / Appeal）。
 *
 * 当前代码库中不允许存在任何实现该接口的适配器：
 *   - 注册表拒绝注册带写入面的适配器（ADAPTER_WRITE_NOT_ALLOWED）
 *   - 提交闸门永不调用 submitClaim()，只返回 NEEDS_MANUAL
 * 未来开放前必须先经架构方审计，并单独设计事务与审计边界。
 */
export interface ExternalWriteAdapter extends ExternalAdapter {
  submitClaim(
    request: AdapterClaimSubmission,
    session: AdapterSession,
  ): Promise<AdapterSubmissionResult>;
}

/** Phase 1 运行时判定：适配器是否实现了写入面（用于注册表拒绝） */
export function implementsWriteSurface(adapter: ExternalAdapter): boolean {
  return typeof (adapter as Partial<ExternalWriteAdapter>).submitClaim === 'function';
}

export class AdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export class AdapterAuthError extends AdapterError {
  constructor(message: string) {
    super('AUTH_FAILED', message);
    this.name = 'AdapterAuthError';
  }
}

export class AdapterRateLimitError extends AdapterError {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super('RATE_LIMITED', message);
    this.name = 'AdapterRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AdapterResponseError extends AdapterError {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super('RESPONSE_ERROR', message);
    this.name = 'AdapterResponseError';
    this.status = status;
  }
}

export class AdapterCapabilityError extends AdapterError {
  constructor(message: string) {
    super('UNSUPPORTED', message);
    this.name = 'AdapterCapabilityError';
  }
}

export class AdapterWriteNotAllowedError extends AdapterError {
  constructor(message = 'Phase 1 不允许向外部平台写入；提交必须走 NEEDS_MANUAL 人工卡口') {
    super('WRITE_NOT_ALLOWED', message);
    this.name = 'AdapterWriteNotAllowedError';
  }
}

/** 平台载荷映射到规范格式时的不合法输入（如把浮点金额当十进制用） */
export class AdapterMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterMappingError';
  }
}

/** 平台来源载荷（AdapterRecord.source）触碰安全/JSON 边界时的拒绝错误 */
export class AdapterSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterSourceError';
  }
}

export class AdapterRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterRegistryError';
  }
}

export class AdapterNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterNotFoundError';
  }
}
