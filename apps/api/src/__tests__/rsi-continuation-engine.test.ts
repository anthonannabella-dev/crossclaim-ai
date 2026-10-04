/** 事件驱动续跑引擎验收：E2E A（连续 3 任务秒级）、B（Watchdog 兜底）、C（事件+watchdog 只 claim 一次）、D（REVISE 立即执行）。 */

import { describe, expect, it } from 'vitest';

import { RSI_CONTINUATION_BOUNDARY, createRsiContinuationEngine, type RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const task = (id: string, priority: RsiSafeTask['priority'] = 'P1'): RsiSafeTask => ({
  id,
  priority,
  dedupeKey: `task:${id}`,
});

/** 可控时钟：验证延迟是「秒级」而不是「接近 5 分钟」。 */
const makeClock = (start = 1_000_000) => {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
};

describe('RSI 事件驱动续跑引擎', () => {
  it('E2E_A_TASK_COMPLETE_TO_NEXT_START_IS_SECONDS：A→B→C 由事件驱动，延迟远小于 5 分钟', () => {
    const clock = makeClock();
    const engine = createRsiContinuationEngine({
      tasks: [task('A'), task('B'), task('C')],
      now: clock.now,
    });

    const first = engine.claimNextSafeTask();
    expect(first.claimed?.id).toBe('A');
    clock.advance(400); // 执行 A 用了 400ms

    engine.completeCurrent('PASS');
    const toB = engine.handleEvent('TASK_COMPLETED');
    expect(toB.claimed?.id).toBe('B');
    expect(toB.transitionLatencyMs).toBeLessThan(5_000); // 秒级，不是 5 分钟

    clock.advance(300);
    engine.completeCurrent('PASS');
    const toC = engine.handleEvent('TASK_COMPLETED');
    expect(toC.claimed?.id).toBe('C');
    expect(toC.transitionLatencyMs).toBeLessThan(5_000);

    expect(engine.state().worker).toBe('RUNNING');
    expect(RSI_CONTINUATION_BOUNDARY.heartbeatDrivesExecution).toBe(false);
    expect(RSI_CONTINUATION_BOUNDARY.watchdogIntervalMs).toBe(60_000);
  });

  it('E2E_B_WATCHDOG_RECOVERS_LOST_EVENT：事件丢失时，最迟由 Watchdog 恢复执行', () => {
    const clock = makeClock();
    const engine = createRsiContinuationEngine({ tasks: [task('A'), task('B')], now: clock.now });

    engine.claimNextSafeTask(); // 领取 A
    clock.advance(1_000);
    engine.completeCurrent('PASS'); // A 完成，但 TASK_COMPLETED 事件丢失（未调用 handleEvent）
    expect(engine.state().worker).toBe('IDLE');
    expect(engine.state().queueLength).toBe(1);

    const recovered = engine.watchdogTick();
    expect(recovered.claimed?.id).toBe('B');
    expect(recovered.reason).toBe('WATCHDOG_IDLE_RESUME');
  });

  it('E2E_C_EVENT_AND_WATCHDOG_CLAIM_EXACTLY_ONCE：事件与 Watchdog 同触发只能 claim 一次', () => {
    const clock = makeClock();
    const engine = createRsiContinuationEngine({ tasks: [task('A'), task('B')], now: clock.now });
    engine.claimNextSafeTask();
    clock.advance(10);

    const byEvent = engine.handleEvent('TASK_COMPLETED'); // 事件先到，claim B
    const byWatchdog = engine.watchdogTick(); // watchdog 随后触发
    expect(byEvent.claimed).toBeNull(); // 有在飞任务时事件不得再 claim（exactly-one-worker）
    expect(byEvent.reason).toBe('ACTIVE_LEASE');
    expect(byWatchdog.claimed).toBeNull(); // lease 生效 → 不重复领取
    expect(['ACTIVE_LEASE', 'NO_CHANGE']).toContain(byWatchdog.reason);
    expect(engine.state().worker).toBe('RUNNING');

    // lease 过期后才允许安全重领，且不会被 dedupe 重复消费
    clock.advance(10 * 60 * 1000);
    const reclaimed = engine.watchdogTick();
    expect(reclaimed.reason).toBe('WATCHDOG_LEASE_RECLAIM');
    expect(reclaimed.claimed?.id).toBe('A'); // A 未被显式完成，故回收 A 而非 B
  });

  it('E2E_D_REVISE_STARTS_IMMEDIATELY：verdict=REVISE 到达即创建修订任务并立即执行，不等心跳', () => {
    const clock = makeClock();
    const engine = createRsiContinuationEngine({ tasks: [task('A'), task('B')], now: clock.now });
    engine.claimNextSafeTask();
    engine.markWaitingForVerdict('REVISE');
    clock.advance(500);

    const outcome = engine.handleEvent('JUDGE_VERDICT_RECEIVED');
    expect(outcome.action).toBe('REVISION');
    expect(outcome.claimed?.priority).toBe('P0'); // 修订任务最高优先
    expect(outcome.transitionLatencyMs).toBeLessThan(5_000);

    // BLOCK → OWNER_ACTION_REQUIRED；无变化 → SILENT（不产生噪声）
    const blockEngine = createRsiContinuationEngine({ tasks: [], now: clock.now });
    blockEngine.markWaitingForVerdict('BLOCK');
    expect(blockEngine.handleEvent('JUDGE_VERDICT_RECEIVED').action).toBe('OWNER_ACTION_REQUIRED');
    expect(blockEngine.watchdogTick().action).toBe('SILENT');
  });
});
