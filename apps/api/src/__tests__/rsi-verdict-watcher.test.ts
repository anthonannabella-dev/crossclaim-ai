/** 裁决轮询器验收：不等待时不读、同裁决只投递一次、start 幂等。 */

import { describe, expect, it } from 'vitest';

import { RSI_VERDICT_WATCHER_BOUNDARY, createVerdictWatcher } from '../runtime/rsi-verdict-watcher';

describe('RSI 裁决轮询器', () => {
  it('RSI_VERDICT_WATCHER_SILENT_WHEN_NOT_WAITING：非等待状态完全不读取', async () => {
    let readCalls = 0;
    const watcher = createVerdictWatcher({
      readVerdict: async () => {
        readCalls += 1;
        return { messageId: 'm1', verdict: 'PASS' };
      },
      isWaiting: () => false,
      onVerdict: () => {},
    });
    expect((await watcher.pollOnce()).delivered).toBe(false);
    expect(readCalls).toBe(0);
    expect(watcher.reads()).toBe(0);
  });

  it('RSI_VERDICT_WATCHER_DELIVERS_ONCE_PER_VERDICT：等待时读取，同 messageId+verdict 只投递一次', async () => {
    let verdict: { messageId: string; verdict: 'PASS' | 'REVISE' | 'BLOCK' } | undefined = undefined;
    const delivered: string[] = [];
    const watcher = createVerdictWatcher({
      readVerdict: async () => verdict,
      isWaiting: () => true,
      onVerdict: (v) => {
        delivered.push(`${v.messageId}:${v.verdict}`);
      },
    });

    // 尚未产生裁决 → 无投递
    expect((await watcher.pollOnce()).delivered).toBe(false);
    verdict = { messageId: 'm1', verdict: 'REVISE' };
    expect((await watcher.pollOnce()).delivered).toBe(true);
    // 同一裁决重复读到 → 不再投递
    expect((await watcher.pollOnce()).delivered).toBe(false);
    // 新裁决 → 投递
    verdict = { messageId: 'm2', verdict: 'PASS' };
    expect((await watcher.pollOnce()).delivered).toBe(true);
    expect(delivered).toEqual(['m1:REVISE', 'm2:PASS']);
    expect(watcher.reads()).toBe(4);
    expect(watcher.deliveries()).toBe(2);
  });

  it('RSI_VERDICT_WATCHER_IDEMPOTENT_START_AND_BOUNDARY：start 幂等、stop 清理、边界自证', () => {
    let handler: (() => void) | null = null;
    let timers = 0;
    const watcher = createVerdictWatcher({
      readVerdict: async () => undefined,
      isWaiting: () => true,
      onVerdict: () => {},
      intervalMs: 15_000,
      setIntervalImpl: (fn) => {
        timers += 1;
        handler = fn;
        return 'timer-1';
      },
      clearIntervalImpl: () => {
        handler = null;
      },
    });
    watcher.start();
    watcher.start();
    expect(timers).toBe(1);
    watcher.stop();
    expect(handler).toBeNull();

    expect(RSI_VERDICT_WATCHER_BOUNDARY.pollsOnlyWhileWaiting).toBe(true);
    expect(RSI_VERDICT_WATCHER_BOUNDARY.dedupesByMessageAndVerdict).toBe(true);
    expect(RSI_VERDICT_WATCHER_BOUNDARY.readsCredentials).toBe(false);
    expect(RSI_VERDICT_WATCHER_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_VERDICT_WATCHER_BOUNDARY.performsExternalWrite).toBe(false);
  });
});
