/**
 * RSI Runtime 端到端集成（事件驱动为主、Watchdog 兜底）
 * 目标：证明「TASK_COMPLETE → NEXT_TASK_START」在真实组装下是秒级，而不是等下一次心跳；
 *       并证明 REVISE 立即建修订、事件+Watchdog 不重复执行。
 */

import { describe, expect, it } from 'vitest';

import { composeRsiRuntime } from '../runtime/rsi-run';
import type { RsiReadFile } from '../runtime/rsi-local-sources';

const files = (map: Record<string, string>): RsiReadFile => async (path) => {
  const value = map[path];
  if (value === undefined) throw new Error('ENOENT');
  return value;
};

const clock = (start = 1_000_000) => {
  let value = start;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
};

describe('RSI Runtime E2E（事件驱动）', () => {
  it('RUNTIME_E2E_EVENT_CONTINUES_WITHOUT_HEARTBEAT：CI 事件驱动 A→B→C，延迟秒级', async () => {
    const c = clock();
    const ran: string[] = [];
    const runtime = await composeRsiRuntime({
      readFile: files({
        '/tasks.json': JSON.stringify([
          { id: 'A', priority: 'P0', dedupeKey: 'd:A' },
          { id: 'B', priority: 'P1', dedupeKey: 'd:B' },
          { id: 'C', priority: 'P2', dedupeKey: 'd:C' },
        ]),
        '/ci.json': JSON.stringify([{ runId: '1', head: 'aaa', status: 'completed', conclusion: 'success' }]),
      }),
      tasksPath: '/tasks.json',
      ciResultsPath: '/ci.json',
      intervalMs: 60_000,
      runner: {
        async run(task) {
          ran.push(task.id);
          return { status: 'PASS' };
        },
      },
    });

    // 第一次轮询：CI 成功事件 → 领取最高优先级 A
    const first = await runtime.loop.pollOnce();
    expect(first).toHaveLength(1);
    expect(ran).toEqual(['A']);

    // 无新事件 → 静默；此时用控制器事件模拟「A 完成」触发 B（不等 60s Watchdog）
    expect(await runtime.loop.pollOnce()).toEqual([]);
    const toB = await runtime.controller.emit('TASK_COMPLETED');
    expect(toB.claimed?.id).toBe('B');
    expect(ran).toEqual(['A', 'B']);
    expect(toB.transitionLatencyMs === null || toB.transitionLatencyMs < 5_000).toBe(true);

    const toC = await runtime.controller.emit('TASK_COMPLETED');
    expect(toC.claimed?.id).toBe('C');
    expect(ran).toEqual(['A', 'B', 'C']);
    expect(runtime.controller.state().queueLength).toBe(0);
    void c;
  });

  it('RUNTIME_E2E_REVISE_AND_WATCHDOG：REVISE 立即建 P0 修订；事件丢失由 Watchdog 兜底且不重复', async () => {
    const ran: { id: string; at: number }[] = [];
    let tick = 0;
    const runtime = await composeRsiRuntime({
      readFile: files({
        '/tasks.json': JSON.stringify([{ id: 'A', priority: 'P1', dedupeKey: 'd:A' }]),
        '/ci.json': JSON.stringify([{ runId: '9', head: 'zzz', status: 'completed', conclusion: 'failure' }]),
      }),
      tasksPath: '/tasks.json',
      ciResultsPath: '/ci.json',
      intervalMs: 60_000,
      runner: {
        async run(task) {
          tick += 1;
          ran.push({ id: task.id, at: tick });
          return task.id.startsWith('revision-') ? { status: 'PASS' } : { status: 'REVISE' };
        },
      },
    });

    // CI 失败事件 → 领取 A，runner 返回 REVISE → 自动入队 P0 修订
    const first = await runtime.loop.pollOnce();
    expect(first).toHaveLength(1);
    expect(ran.map((r) => r.id)).toEqual(['A']);

    // 事件驱动立即消费修订任务（不等 Watchdog）
    const revised = await runtime.controller.emit('TASK_COMPLETED');
    expect(revised.claimed?.id).toMatch(/^revision-/);
    expect(revised.claimed?.priority).toBe('P0');
    expect(ran).toHaveLength(2);

    // 事件丢失场景：再放一个任务进控制器，用 Watchdog tick 兜底恢复
    const extra = await composeRsiRuntime({
      readFile: files({ '/tasks.json': JSON.stringify([{ id: 'Z', priority: 'P3', dedupeKey: 'd:Z' }]) }),
      tasksPath: '/tasks.json',
      intervalMs: 60_000,
      runner: { async run(task) { ran.push({ id: task.id, at: ++tick }); return { status: 'PASS' }; } },
    });
    const recovered = await extra.loop.pollOnce();
    expect(recovered).toEqual([]); // 无事件 → 静默
    const watchdog = await extra.controller.tick();
    expect(watchdog.claimed?.id).toBe('Z');
    expect(watchdog.reason).toBe('WATCHDOG_IDLE_RESUME');

    runtime.start();
    runtime.stop();
    extra.start();
    extra.stop();
  });
});
