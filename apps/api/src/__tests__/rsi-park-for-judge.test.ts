/** RSI-RT-05：park-for-judge 让 REVISE 真正闭环（上一批记录的缺口）。 */

import { describe, expect, it } from 'vitest';

import { attachContinuationToController } from '../runtime/rsi-controller-continuation';
import { verifyRunnerEvidence } from '../runtime/rsi-evidence-verifier';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const task = (id: string): RsiSafeTask => ({ id, priority: 'P1', dedupeKey: `task:${id}` });
const fresh = {
  ciResults: [{ runId: '1', head: 'abcdef1', status: 'completed', conclusion: 'success', completedAt: '2026-10-05T10:00:30.000Z' }],
  testResults: [],
};

const compose = () =>
  attachContinuationToController({
    tasks: [task('A'), task('B')],
    now: () => T0,
    awaitVerdict: true,
    runner: {
      async run() {
        return { status: 'PASS', evidenceRef: 'exit-0:abcd1234' } as unknown as { status: 'PASS' };
      },
    },
    verifyEvidence: async (ref, at) => verifyRunnerEvidence(ref, fresh, { claimedAt: at, requireFreshness: true }),
  });

describe('RSI park-for-judge', () => {
  it('PARKED_NOT_COMPLETED：runner 返回后任务停在等待裁决，不被立即完成', async () => {
    const controller = compose();
    const parked = await controller.emit('CI_COMPLETED');
    expect(parked.claimed?.id).toBe('A');
    expect(parked.reason).toBe('AWAITING_VERDICT');
    expect(controller.state().waitingForVerdict).toBe(true);
    expect(controller.state().worker).toBe('RUNNING'); // 仍持有 A
    expect(controller.state().blockedCount).toBe(0);
  });

  it('REVISE_CLOSES_THE_LOOP：裁决 REVISE → 插入 P0 修订任务并立即领取', async () => {
    const controller = compose();
    await controller.emit('CI_COMPLETED');
    controller.markWaitingForVerdict('REVISE');
    const revised = await controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(revised.action).toBe('REVISION');
    expect(revised.claimed?.priority).toBe('P0');
    expect(revised.transitionLatencyMs!).toBeLessThan(5_000);
    expect(controller.state().queueLength).toBe(1); // 还剩 B
  });

  it('PASS_CLOSES_AND_CONTINUES：裁决 PASS → 完成任务并领取下一个', async () => {
    const controller = compose();
    await controller.emit('CI_COMPLETED');
    controller.markWaitingForVerdict('PASS');
    const next = await controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(next.claimed?.id).toBe('B');
    expect(controller.state().queueLength).toBe(0);
  });
});
