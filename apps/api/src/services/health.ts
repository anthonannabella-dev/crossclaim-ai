/**
 * 健康检查
 * ---------------------------------------------------------------
 * 契约：
 *   - 只读，不产生副作用
 *   - 区分 "ok"（全部依赖可用）与 "degraded"（部分依赖不可用）
 *   - 不泄露任何连接串/密钥，只报状态与耗时
 */

export interface CheckResult {
  status: 'ok' | 'degraded';
  checkedAt: string;
  version: string;
  checks: Record<string, { ok: boolean; latencyMs: number; detail?: string }>;
}

/** 最小依赖面：只要能用 $queryRaw 就行，便于测试注入桩 */
export interface DbLike {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
}

export interface HealthDeps {
  db: DbLike;
  version: string;
  now?: () => number;
}

async function timed<T>(fn: () => Promise<T>, now: () => number) {
  const start = now();
  try {
    await fn();
    return { ok: true, latencyMs: now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: now() - start,
      // 只保留错误消息，不保留堆栈/连接串
      detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
    };
  }
}

export async function checkHealth(deps: HealthDeps): Promise<CheckResult> {
  const now = deps.now ?? (() => Date.now());

  const database = await timed(() => deps.db.$queryRaw`SELECT 1`, now);

  const checks: CheckResult['checks'] = { database };
  const ok = Object.values(checks).every((c) => c.ok);

  return {
    status: ok ? 'ok' : 'degraded',
    checkedAt: new Date().toISOString(),
    version: deps.version,
    checks,
  };
}

/** HTTP 状态码：健康 200，降级 503（便于负载均衡摘除） */
export function healthHttpStatus(result: CheckResult): number {
  return result.status === 'ok' ? 200 : 503;
}
