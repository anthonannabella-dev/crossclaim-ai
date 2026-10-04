/** 控制器接线验收：事件到达即跑下一任务（秒级）、Watchdog 兜底、runner 注入、无凭据。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_CONTROLLER_CONTINUATION_BOUNDARY,
  attachContinuationToController,
} from '../runtime/rsi-controller-continuation';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const task = (id: string): RsiSafeTask => ({ id, priority: 'P1', dedupeKey: `task:${id}` });

const clock = (start = 1_000_000) => {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
};

describe('RSI Controller 续跑接线', () => {
  it('RSI_CONTROLLER_EVENT_DRIVES_RUNNER：事件到达即执行下一任务，延迟秒级', async () => {
    const c = clock();
    const ran: string[] = [];
    const controller = attachContinuationToController({
      tasks: [task('A'), task('B')],
      runner: {
        async run(t) {
          ran.push(t.id);
          return { status: 'PASS' };
        },
      },
      now: c.now,
    });

    // 首个任务由事件触发（等价 TASK_COMPLETED 语义）
    await controller.emit('TASK_COMPLETED');
    expect(ran).toEqual(['A']);
    c.advance(250);
    await controller.emit('TEST_COMPLETED');
    expect(ran).toEqual(['A', 'B']);
    expect(controller.latencies().every((latency) => latency < 5_000)).toBe(true);
    expect(controller.state().queueLength).toBe(0);
  });

  it('RSI_CONTROLLER_WATCHDOG_RECOVERS_WITHOUT_EVENTS：事件丢失时由 tick 补跑', async () => {
    const c = clock();
    const ran: string[] = [];
    const controller = attachContinuationToController({
      tasks: [task('A')],
      runner: {
        async run(t) {
          ran.push(t.id);
          return { status: 'PASS' };
        },
      },
      now: c.now,
    });

    // 无任何事件 → Watchdog 兜底领取
    const outcome = await controller.tick();
    expect(outcome.reason).toBe('WATCHDOG_IDLE_RESUME');
    expect(ran).toEqual(['A']);
    // 队列空且无变化 → SILENT
    expect((await controller.tick()).action).toBe('SILENT');
  });

  it('RSI_CONTROLLER_BOUNDARY_NO_SECRETS：边界自证 + REVISE 结果会重新入队执行', async () => {
    const c = clock();
    const ran: string[] = [];
    let first = true;
    const controller = attachContinuationToController({
      tasks: [task('A')],
      runner: {
        async run(t) {
          ran.push(t.id);
          if (first) {
            first = false;
            return { status: 'REVISE' };
          }
          return { status: 'PASS' };
        },
      },
      now: c.now,
    });

    await controller.emit('TASK_COMPLETED'); // 跑 A 并返回 REVISE → 生成 P0 修订任务入队
    expect(ran).toEqual(['A']);
    c.advance(100);
    await controller.emit('TASK_COMPLETED'); // 立即消费修订任务
    expect(ran.length).toBe(2);
    expect(ran[1]).toMatch(/^revision-/);

    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.eventDriven).toBe(true);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.heartbeatDrivesExecution).toBe(false);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.watchdogIntervalMs).toBe(60_000);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.holdsProviderCredentials).toBe(false);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.writesDatabase).toBe(false);
  });
});
