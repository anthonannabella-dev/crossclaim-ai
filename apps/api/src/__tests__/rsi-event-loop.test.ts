/** 事件循环验收：新事件即 emit、同源重复不重发、无新事件静默、兜底 tick 可触发。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_EVENT_LOOP_BOUNDARY,
  createRsiEventLoop,
  type RsiEventSources,
} from '../runtime/rsi-event-loop';
import { attachContinuationToController } from '../runtime/rsi-controller-continuation';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const task = (id: string): RsiSafeTask => ({ id, priority: 'P1', dedupeKey: `task:${id}` });

const makeController = (ids: string[]) => {
  const ran: string[] = [];
  const controller = attachContinuationToController({
    tasks: ids.map(task),
    runner: {
      async run(t) {
        ran.push(t.id);
        return { status: 'PASS' };
      },
    },
  });
  return { controller, ran };
};

describe('RSI 事件循环', () => {
  it('RSI_LOOP_EMITS_NEW_EVENTS_ONLY_ONCE：同一 CI 结果只驱动一次，新结果再驱动', async () => {
    const { controller, ran } = makeController(['A', 'B']);
    let ci = [{ runId: '1', head: 'aaa', status: 'completed' as const, conclusion: 'success' as const }];
    const sources: RsiEventSources = { readCi: async () => ci };
    const loop = createRsiEventLoop({ controller, sources, intervalMs: 60_000 });

    const first = await loop.pollOnce();
    expect(first).toHaveLength(1);
    expect(ran).toEqual(['A']);

    // 同源重复轮询 → 指纹去重 → 不产生新事件、不重复执行
    const second = await loop.pollOnce();
    expect(second).toEqual([]);
    expect(ran).toEqual(['A']);

    // 新 CI 结果 → 立即驱动下一任务
    ci = [{ runId: '2', head: 'bbb', status: 'completed', conclusion: 'success' }];
    const third = await loop.pollOnce();
    expect(third).toHaveLength(1);
    expect(ran).toEqual(['A', 'B']);
  });

  it('RSI_LOOP_SILENT_WHEN_NO_EVENTS：无新事件时不输出（静默）并计入 silentPolls', async () => {
    const { controller } = makeController(['A']);
    const loop = createRsiEventLoop({ controller, sources: {}, intervalMs: 60_000 });
    expect(await loop.pollOnce()).toEqual([]);
    expect(loop.polls()).toBe(1);
    expect(loop.silentPolls()).toBe(1);
    expect(RSI_EVENT_LOOP_BOUNDARY.silentWhenNoEvents).toBe(true);
    expect(RSI_EVENT_LOOP_BOUNDARY.busyLoop).toBe(false);
  });

  it('RSI_LOOP_WATCHDOG_FALLBACK_ONLY：无事件时由 60s tick 兜底领取 idle 队列', async () => {
    const { controller, ran } = makeController(['A']);
    let ticks = 0;
    const recording = {
      ...controller,
      async tick() {
        ticks += 1;
        return controller.tick();
      },
    };

    let handler: (() => void) | null = null;
    const loop = createRsiEventLoop({
      controller: recording,
      sources: {},
      intervalMs: 60_000,
      setIntervalImpl: (fn) => {
        handler = fn;
        return 'timer-1';
      },
      clearIntervalImpl: () => {
        handler = null;
      },
    });

    loop.start();
    loop.start(); // 重复 start 不得创建第二个 timer（exactly-one loop）
    expect(handler).not.toBeNull();
    handler!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ticks).toBe(1);
    expect(ran).toEqual(['A']); // Watchdog 兜底领取了 idle 任务

    loop.stop();
    expect(handler).toBeNull();
    expect(RSI_EVENT_LOOP_BOUNDARY.watchdogFallbackOnly).toBe(true);
    expect(RSI_EVENT_LOOP_BOUNDARY.watchdogIntervalMs).toBe(60_000);
  });
});
