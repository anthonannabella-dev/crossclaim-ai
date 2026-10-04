/**
 * RSI Runtime —— 崩溃/重启策略（纯函数，RSI-RT-02）
 * ---------------------------------------------------------------
 * OWNER 要求：RSI 崩溃由 supervisor 自动拉起，但**必须防止 crash loop → 无限重启 → 影响生产**；
 * 达到阈值后进入 RSI_DEGRADED 并通知 OWNER。
 *
 * 本模块只做决策（不执行重启、不写库、不通知），供 supervisor 或外部编排调用：
 *   · 指数退避重启；
 *   · 时间窗内重启次数达阈值 → 停止自动重启并进入 DEGRADED（需 OWNER 介入）；
 *   · 长期稳定运行后自动清零历史（避免历史旧崩溃永久压制）。
 *
 * 注意：本仓库没有 docker-compose / PM2 / systemd 配置，部署以 `DEPLOYMENT.md` 描述的方式手工执行，
 * 且**生产部署是 HOST APPROVAL REQUIRED**。因此这里只提供策略，不新增第二套部署体系。
 */

export interface RsiRestartPolicy {
  /** 时间窗（毫秒）：窗口内的崩溃次数用于判定 crash loop。 */
  windowMs: number;
  /** 窗口内允许的最大自动重启次数；达到即进入 DEGRADED。 */
  maxRestartsInWindow: number;
  /** 退避基数（毫秒）。 */
  baseDelayMs: number;
  /** 退避上限（毫秒）。 */
  maxDelayMs: number;
  /** 稳定运行超过该时长（毫秒）后，历史重启记录视为已清零。 */
  stableResetMs: number;
}

export const RSI_DEFAULT_RESTART_POLICY: RsiRestartPolicy = {
  windowMs: 10 * 60 * 1000,
  maxRestartsInWindow: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  stableResetMs: 30 * 60 * 1000,
};

export interface RsiCrashRecord {
  crashedAt: string;
  /** 上一次启动到崩溃的存活时长（毫秒）。 */
  uptimeMs: number;
}

export type RsiSupervisorDecision =
  | { action: 'RESTART'; delayMs: number; restartsInWindow: number; reason: 'BACKOFF' | 'FIRST_CRASH' }
  | { action: 'DEGRADED_STOP'; restartsInWindow: number; reason: 'CRASH_LOOP'; notifyOwner: true }
  | { action: 'NONE'; restartsInWindow: number; reason: 'STABLE_RESET' };

/**
 * 决策：是否需要重启、退避多久、还是进入 DEGRADED 等 OWNER。
 * 纯函数：只读历史与 now，不产生副作用。
 */
export function decideRsiRestart(input: {
  history: readonly RsiCrashRecord[];
  now: Date;
  policy?: Partial<RsiRestartPolicy>;
}): RsiSupervisorDecision {
  const policy: RsiRestartPolicy = { ...RSI_DEFAULT_RESTART_POLICY, ...(input.policy ?? {}) };
  const nowMs = input.now.getTime();

  // 稳定运行足够久 → 历史清零（返回 NONE：不因陈旧崩溃继续压制）
  const lastCrash = input.history.at(-1);
  if (lastCrash && lastCrash.uptimeMs >= policy.stableResetMs) {
    return { action: 'NONE', restartsInWindow: 0, reason: 'STABLE_RESET' };
  }

  const inWindow = input.history.filter((record) => {
    const at = Date.parse(record.crashedAt);
    return Number.isFinite(at) && nowMs - at <= policy.windowMs;
  });

  // crash loop：窗口内重启次数已达阈值 → 停止自动重启，进入 DEGRADED 并通知 OWNER
  if (inWindow.length >= policy.maxRestartsInWindow) {
    return {
      action: 'DEGRADED_STOP',
      restartsInWindow: inWindow.length,
      reason: 'CRASH_LOOP',
      notifyOwner: true,
    };
  }

  if (inWindow.length === 0) {
    return { action: 'RESTART', delayMs: 0, restartsInWindow: 0, reason: 'FIRST_CRASH' };
  }

  const delayMs = Math.min(policy.baseDelayMs * 2 ** (inWindow.length - 1), policy.maxDelayMs);
  return { action: 'RESTART', delayMs, restartsInWindow: inWindow.length, reason: 'BACKOFF' };
}
