/** RSI supervisor 崩溃/重启策略验收（防 crash loop → DEGRADED 并通知 OWNER）。 */

import { describe, expect, it } from 'vitest';

import { RSI_DEFAULT_RESTART_POLICY, decideRsiRestart } from '../runtime/rsi-supervisor-policy';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const crash = (secondsAgo: number, uptimeMs = 1_000) => ({
  crashedAt: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
  uptimeMs,
});

describe('RSI supervisor 重启策略', () => {
  it('RSI_SUPERVISOR_FIRST_CRASH_RESTARTS_IMMEDIATELY：首次崩溃立即重启（无退避）', () => {
    const decision = decideRsiRestart({ history: [], now: NOW });
    expect(decision).toEqual({ action: 'RESTART', delayMs: 0, restartsInWindow: 0, reason: 'FIRST_CRASH' });
  });

  it('RSI_SUPERVISOR_BACKOFF_IS_EXPONENTIAL_AND_CAPPED：窗口内连续崩溃指数退避且有上限', () => {
    const first = decideRsiRestart({ history: [crash(10)], now: NOW });
    expect(first.action).toBe('RESTART');
    expect(first).toMatchObject({ delayMs: RSI_DEFAULT_RESTART_POLICY.baseDelayMs, restartsInWindow: 1 });

    const second = decideRsiRestart({ history: [crash(20), crash(10)], now: NOW });
    expect(second).toMatchObject({ delayMs: RSI_DEFAULT_RESTART_POLICY.baseDelayMs * 2, restartsInWindow: 2 });

    // 超过上限 → 取 maxDelayMs 封顶
    const many = [crash(40), crash(30), crash(20), crash(10)];
    const capped = decideRsiRestart({ history: many, now: NOW });
    expect(capped).toMatchObject({ action: 'RESTART', delayMs: RSI_DEFAULT_RESTART_POLICY.baseDelayMs * 8 });
    expect((capped as { delayMs: number }).delayMs).toBeLessThanOrEqual(RSI_DEFAULT_RESTART_POLICY.maxDelayMs);
  });

  it('RSI_SUPERVISOR_CRASH_LOOP_GOES_DEGRADED_AND_NOTIFIES_OWNER：达阈值停止自动重启并通知 OWNER', () => {
    const history = [crash(50), crash(40), crash(30), crash(20), crash(10)];
    const decision = decideRsiRestart({ history, now: NOW });
    expect(decision).toEqual({
      action: 'DEGRADED_STOP',
      restartsInWindow: 5,
      reason: 'CRASH_LOOP',
      notifyOwner: true,
    });

    // 窗口外的旧崩溃不计入（不会因为很久以前的崩溃而永久压制）
    const old = [crash(60 * 60 * 24), crash(60 * 60 * 24), crash(60 * 60 * 24), crash(60 * 60 * 24), crash(60 * 60 * 24)];
    expect(decideRsiRestart({ history: old, now: NOW }).action).toBe('RESTART');
  });

  it('RSI_SUPERVISOR_STABLE_RESET：长期稳定运行后历史清零，不继续压制重启', () => {
    const stable = [crash(10, RSI_DEFAULT_RESTART_POLICY.stableResetMs)];
    expect(decideRsiRestart({ history: stable, now: NOW })).toEqual({
      action: 'NONE',
      restartsInWindow: 0,
      reason: 'STABLE_RESET',
    });
  });
});
