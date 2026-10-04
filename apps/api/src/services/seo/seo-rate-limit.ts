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
