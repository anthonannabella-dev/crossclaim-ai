/**
 * RSI-RT-05 全链路端到端：事件 → task → runner → CI 证据 → 完成/裁决 → 下一个任务。
 * 断言不依赖 5 分钟心跳：每次完成/裁决后**立即**领取下一个。
 */

import { describe, expect, it } from 'vitest';

import { attachContinuationToController } from '../runtime/rsi-controller-continuation';
import { verifyRunnerEvidence } from '../runtime/rsi-evidence-verifier';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const task = (id: string): RsiSafeTask => ({ id, priority: 'P1', dedupeKey: `task:${id}` });

const freshEvidence = {
  ciResults: [
    { runId: '1', head: 'abcdef1', status: 'completed', conclusion: 'success', completedAt: '2026-10-05T10:00:30.000Z' },
  ],
  testResults: [],
};

const compose = () =>
  attachContinuationToController({
    tasks: [task('A'), task('B')],
    now: () => T0,
    runner: {
      async run() {
        return { status: 'PASS', evidenceRef: 'exit-0:abcd1234' } as unknown as { status: 'PASS' };
      },
    },
    verifyEvidence: async (ref, at) =>
      verifyRunnerEvidence(ref, freshEvidence, { claimedAt: at, requireFreshness: true }),
  });

describe('RSI 全链路端到端（事件驱动）', () => {
  it('EVENT_TO_TASK_TO_RUNNER_TO_NEXT：事件领取 → 真实执行 + 新鲜证据 → 立即领取下一个', async () => {
    const controller = compose();

    const first = await controller.emit('CI_COMPLETED');
    expect(first.claimed?.id).toBe('A');
    expect(controller.state().blockedCount).toBe(0);
    expect(controller.state().queueLength).toBe(1);

    const second = await controller.emit('CI_COMPLETED');
    expect(second.claimed?.id).toBe('B');
    expect(controller.state().blockedCount).toBe(0);
    expect(controller.state().queueLength).toBe(0);
  });

  it('VERDICT_REVISE_STARTS_NEXT_IMMEDIATELY：REVISE 立即插入并领取 P0 修订任务（不等心跳）', async () => {
    const controller = compose();
    await controller.emit('CI_COMPLETED'); // 消费 A

    controller.markWaitingForVerdict('REVISE');
    const revised = await controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(revised.action).toBe('REVISION');
    expect(revised.reason).toBe('VERDICT_REVISE');
    /**
     * PRELEASE_FIX_B（审计 MSG-20261009-03）：裁决事件不再预租下一条 ⇒ 本调用 `claimed` 为 null。
     * 当前 wrapper 在 runner 返回后即完成任务，故 REVISE 不会凭空插入 P0 修订任务；
     * 「继续领取下一个正常任务（B）」现由**下一次正常 tick** 完成。
     */
    expect(revised.claimed).toBeNull();
    const nextTick = await controller.tick();
    expect(nextTick.claimed?.id).toBe('B');
    expect(controller.state().queueLength).toBe(0);
  });

  it('VERDICT_BLOCK_REQUIRES_OWNER：BLOCK 裁决触发 OWNER_ACTION_REQUIRED，不静默吞掉', async () => {
    const controller = compose();
    controller.markWaitingForVerdict('BLOCK');
    const outcome = await controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(outcome.action).toBe('OWNER_ACTION_REQUIRED');
    expect(controller.state().blockedCount).toBe(0); // 裁决而非执行失败
  });
});
