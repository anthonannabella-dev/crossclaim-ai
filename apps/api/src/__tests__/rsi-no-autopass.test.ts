/** RSI-RT-01/05：伪成功消除的合同（claimed→PASS / BLOCK→PASS / 事件完成在飞任务）。 */

import { describe, expect, it } from 'vitest';

import { RSI_CONTROLLER_CONTINUATION_BOUNDARY } from '../runtime/rsi-controller-continuation';
import { createRsiContinuationEngine, type RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const task = (id: string): RsiSafeTask => ({ id, priority: 'P1', dedupeKey: `task:${id}` });

describe('RSI 伪成功消除', () => {
  it('EVENTS_DO_NOT_COMPLETE_INFLIGHT：事件在飞时只报 ACTIVE_LEASE，不完成也不换任务', () => {
    let now = 1_000_000;
    const engine = createRsiContinuationEngine({ tasks: [task('A'), task('B')], now: () => now });
    expect(engine.claimNextSafeTask().claimed?.id).toBe('A');
    now += 10;
    const byEvent = engine.handleEvent('TASK_COMPLETED');
    expect(byEvent.claimed).toBeNull();
    expect(byEvent.reason).toBe('ACTIVE_LEASE');
    now += 10 * 60 * 1000;
    // A 从未被显式完成 → 回收的仍是 A，而不是跳到 B
    const reclaimed = engine.watchdogTick();
    expect(reclaimed.claimed?.id).toBe('A');
  });

  it('COMPLETE_REQUIRES_EXPLICIT_STATUS：显式 PASS 后才领取下一个', () => {
    let now = 2_000_000;
    const engine = createRsiContinuationEngine({ tasks: [task('A'), task('B')], now: () => now });
    engine.claimNextSafeTask();
    now += 300;
    engine.completeCurrent('PASS');
    const next = engine.handleEvent('TASK_COMPLETED');
    expect(next.claimed?.id).toBe('B');
    expect(next.transitionLatencyMs).toBeLessThan(5_000);
  });

  it('BOUNDARY：BLOCK 永不写成 PASS、PASS 必须有证据、事件不完成在飞任务', () => {
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.blockIsNeverPass).toBe(true);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.passRequiresEvidence).toBe(true);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.eventsDoNotCompleteInflight).toBe(true);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_CONTROLLER_CONTINUATION_BOUNDARY.holdsProviderCredentials).toBe(false);
  });
});
