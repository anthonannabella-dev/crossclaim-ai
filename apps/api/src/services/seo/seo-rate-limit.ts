/**
 * SEO-3 — PUBLIC RATE LIMIT（匿名公开工具的限流底座）
 * ---------------------------------------------------------------
 * 公开 Checker/Calculator 必须 rate limited。本模块只做**进程内**令牌桶 +
 * 匿名键哈希（不保存原始 IP），真实生产应换成共享存储实现同一端口语义。
 * 零外写、零租户数据、零 PII 落盘（只保留哈希）。
 */

import { createHash } from 'node:crypto';

export interface SeoRateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface SeoPublicRateLimiter {
  check(anonymousKeyHash: string): SeoRateLimitDecision;
}

export interface SeoRateLimiterOptions {
  /** 桶容量（突发上限）。 */
  capacity: number;
  /** 每分钟补充的令牌数。 */
  refillPerMinute: number;
  now?: () => Date;
}

/** 只保留哈希：原始 IP / UA 不进入存储，满足公开工具「无 PII」要求。 */
export function hashAnonymousKey(raw: string, salt: string): string {
  return createHash('sha256').update(salt + '|' + (raw ?? ''), 'utf8').digest('hex');
}

export function createInMemorySeoPublicRateLimiter(
  options: SeoRateLimiterOptions,
): SeoPublicRateLimiter & { size(): number } {
  const capacity = Math.max(1, Math.floor(options.capacity));
  const refillPerMs = Math.max(0, options.refillPerMinute) / 60000;
  const now = options.now ?? (() => new Date());
  const buckets = new Map<string, { tokens: number; updatedAtMs: number }>();

  return {
    check(anonymousKeyHash: string): SeoRateLimitDecision {
      const nowMs = now().getTime();
      const existing = buckets.get(anonymousKeyHash) ?? { tokens: capacity, updatedAtMs: nowMs };
      const elapsed = Math.max(0, nowMs - existing.updatedAtMs);
      const tokens = Math.min(capacity, existing.tokens + elapsed * refillPerMs);

      if (tokens < 1) {
        const missing = 1 - tokens;
        const waitMs = refillPerMs > 0 ? missing / refillPerMs : Number.POSITIVE_INFINITY;
        buckets.set(anonymousKeyHash, { tokens, updatedAtMs: nowMs });
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Number.isFinite(waitMs) ? Math.max(1, Math.ceil(waitMs / 1000)) : 3600,
        };
      }

      const remaining = tokens - 1;
      buckets.set(anonymousKeyHash, { tokens: remaining, updatedAtMs: nowMs });
      return { allowed: true, remaining: Math.floor(remaining), retryAfterSeconds: 0 };
    },
    size: () => buckets.size,
  };
}

/** 边界自证：限流层不产生任何外部写、不保存原始身份信息。 */
export const SEO_PUBLIC_RATE_LIMIT_BOUNDARY = {
  rawIdentifierStored: false,
  hashedIdentifierOnly: true,
  externalWritePerformed: false,
  tenantDataIncluded: false,
  productionCredentials: 'ABSENT',
} as const;

/**
 * 共享/边缘限流端口（架构方裁决：`IN_MEMORY_RATE_LIMIT = DEV/STAGING_ONLY`、
 * `SHARED_OR_EDGE_RATE_LIMIT = REQUIRED_FOR_PRODUCTION`）。
 *
 * 生产实现必须满足：
 *   · **原子**：同一匿名键的 check-and-consume 在跨进程/跨实例下不可超额；
 *   · 共享存储（Redis 等）或由 CDN/API Gateway 提供全局限流 + 应用层第二层；
 *   · 只接受匿名键哈希（绝不接触原始 IP）。
 */
export interface SeoSharedRateLimiter {
  /** 原子 check-and-consume；实现必须在共享存储上完成。 */
  checkShared(anonymousKeyHash: string): Promise<SeoRateLimitDecision>;
}

export type SeoRateLimiterMode = 'DEV_STAGING' | 'PRODUCTION';

export interface SeoRateLimiterDeploymentConfig {
  mode: SeoRateLimiterMode;
  hasSharedOrEdgeLimiter: boolean;
  /** 单机 canary 的全部前提（架构方给的清单）。 */
  canary?: {
    singleInstance: boolean;
    singleNodeProcess: boolean;
    noPm2Cluster: boolean;
    noAutoscaleOrServerless: boolean;
    upstreamGlobalRateLimit: boolean;
    mapHasTtlOrMaxSize: boolean;
    hasKillSwitch: boolean;
  };
}

export type SeoRateLimiterDeploymentVerdict =
  | { ok: true; reason: 'SHARED_LIMITER' | 'CANARY_ACCEPTED' | 'DEV_STAGING_ONLY' }
  | { ok: false; reason: 'SHARED_LIMITER_REQUIRED' | 'CANARY_PRECONDITION_MISSING' };

/**
 * 生产部署守卫：**进程内限流器不得用于多实例生产**。
 * 只有共享/边缘限流，或满足全部 canary 前提的单机试点，才允许在生产模式下运行。
 */
export function assertProductionRateLimiter(
  config: SeoRateLimiterDeploymentConfig,
): SeoRateLimiterDeploymentVerdict {
  if (config.mode !== 'PRODUCTION') return { ok: true, reason: 'DEV_STAGING_ONLY' };
  if (config.hasSharedOrEdgeLimiter) return { ok: true, reason: 'SHARED_LIMITER' };

  const canary = config.canary;
  if (canary === undefined) return { ok: false, reason: 'SHARED_LIMITER_REQUIRED' };
  const missing = [
    canary.singleInstance,
    canary.singleNodeProcess,
    canary.noPm2Cluster,
    canary.noAutoscaleOrServerless,
    canary.upstreamGlobalRateLimit,
    canary.mapHasTtlOrMaxSize,
    canary.hasKillSwitch,
  ].some((flag) => flag !== true);
  return missing
    ? { ok: false, reason: 'CANARY_PRECONDITION_MISSING' }
    : { ok: true, reason: 'CANARY_ACCEPTED' };
}
