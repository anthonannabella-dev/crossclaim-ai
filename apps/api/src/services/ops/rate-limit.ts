/**
 * TRACK A / PC-08 — 最小 rate limit 基线（MSG-20261003-93 PC-08）。
 * ---------------------------------------------------------------
 * 目的：为最敏感的匿名入口（/auth/login、/auth/signup）提供**进程内**固定窗口限流基线，
 * 防止暴力尝试与注册滥用；不引入外部依赖，不改变业务流程语义。
 *
 * 边界：
 *   · 这是 baseline，不是分布式限流（多实例部署时仍需网关/共享存储层，属后续运维事项）。
 *   · 默认参数保守（足够宽松，不影响正常使用）；可通过环境变量覆盖。
 *   · 只用于拒绝过量请求，不记录凭据、不记录请求体。
 */

export interface RateLimitPolicy {
  enabled: boolean;
  windowMs: number;
  max: number;
  scope: readonly string[];
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 60;

export const DEFAULT_RATE_LIMIT_SCOPE: readonly string[] = ['/auth/login', '/auth/signup'];

export function rateLimitPolicyFromEnv(env: Record<string, string | undefined> = process.env): RateLimitPolicy {
  const enabled = env.RATE_LIMIT_ENABLED !== 'false';
  const windowMs = Number(env.RATE_LIMIT_WINDOW_MS ?? DEFAULT_WINDOW_MS);
  const max = Number(env.RATE_LIMIT_MAX ?? DEFAULT_MAX);
  return {
    enabled,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS,
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX,
    scope: DEFAULT_RATE_LIMIT_SCOPE,
  };
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface WindowState {
  windowStart: number;
  count: number;
}

/**
 * 进程内固定窗口限流器（key = scope + clientKey）。
 * 时钟与存储都可注入，便于测试与将来的共享存储实现。
 */
export function createRateLimiter(
  policy: RateLimitPolicy,
  deps: { now?: () => number } = {},
): {
  check: (scope: string, clientKey: string) => RateLimitDecision;
  reset: () => void;
} {
  const now = deps.now ?? (() => Date.now());
  const windows = new Map<string, WindowState>();

  const check = (scope: string, clientKey: string): RateLimitDecision => {
    if (!policy.enabled || !policy.scope.includes(scope)) {
      return { allowed: true, remaining: policy.max, retryAfterMs: 0 };
    }
    const key = scope + '|' + clientKey;
    const at = now();
    const existing = windows.get(key);
    if (!existing || at - existing.windowStart >= policy.windowMs) {
      windows.set(key, { windowStart: at, count: 1 });
      return { allowed: true, remaining: policy.max - 1, retryAfterMs: 0 };
    }
    if (existing.count >= policy.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(policy.windowMs - (at - existing.windowStart), 0),
      };
    }
    existing.count += 1;
    return { allowed: true, remaining: policy.max - existing.count, retryAfterMs: 0 };
  };

  return {
    check,
    reset: () => windows.clear(),
  };
}
