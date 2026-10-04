/**
 * RSI-RT-05 端到端（证据新鲜度）：runner 报 PASS，但证据陈旧 → 任务被判 BLOCK（不是完成）。
 * blockedCount 使「失败」与「完成」可观测区分。
 */

import { describe, expect, it } from 'vitest';

import { attachContinuationToController } from '../runtime/rsi-controller-continuation';
import { verifyRunnerEvidence } from '../runtime/rsi-evidence-verifier';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const CLAIMED_AT = Date.parse('2026-10-05T10:00:00.000Z');
const task = (id: string): RsiSafeTask => ({ id, priority: 'P1', dedupeKey: `task:${id}` });

const ciAt = (completedAt: string) => [
  { runId: '1', head: 'abcdef1', status: 'completed', conclusion: 'success', completedAt },
];

const compose = (completedAt: string) =>
  attachContinuationToController({
    tasks: [task('A'), task('B')],
    now: () => CLAIMED_AT,
    runner: {
      async run() {
        return { status: 'PASS', evidenceRef: 'exit-0:abcd1234' } as unknown as { status: 'PASS' };
      },
    },
    verifyEvidence: async (ref, at) =>
      verifyRunnerEvidence(ref, { ciResults: ciAt(completedAt), testResults: [] }, {
        claimedAt: at,
        requireFreshness: true,
      }),
  });

describe('RSI 证据新鲜度端到端', () => {
  it('STALE_EVIDENCE_BLOCKS：runner 报 PASS 但证据早于 claim → BLOCK（不是完成）', async () => {
    const controller = compose('2026-10-05T09:00:00.000Z'); // 一小时前
    const outcome = await controller.emit('CI_RESULT');
    expect(outcome.claimed?.id).toBe('A');
    expect(controller.state().blockedCount).toBe(1);
  });

  it('FRESH_EVIDENCE_COMPLETES：claim 之后的成功证据 → 任务完成（blockedCount 保持 0）', async () => {
    const controller = compose('2026-10-05T10:01:00.000Z');
    const outcome = await controller.emit('CI_RESULT');
    expect(outcome.claimed?.id).toBe('A');
    expect(controller.state().blockedCount).toBe(0);
  });
});
