/**
 * RSI 裁决轮询器（事件驱动的临时替代，OWNER 续跑规范第 7 节）
 * ---------------------------------------------------------------
 * 右侧 ChatGPT 审计链没有真正 callback，因此允许「**仅**在 WAITING_FOR_VERDICT=true 时」短轮询。
 * 硬规则：
 *   · `isWaiting() === false` 时**完全不读取**（不轮询整个系统）；
 *   · 同一 messageId 只投递一次（按 messageId+verdict 指纹去重）；
 *   · start 幂等 / stop 清理；不读凭据、不写库、不外写。
 */

import type { RsiVerdictOutcome } from './rsi-event-sources';

export interface RsiVerdictWatcher {
  pollOnce(): Promise<{ delivered: boolean; verdict: RsiVerdictOutcome | null }>;
  start(): void;
  stop(): void;
  reads(): number;
  deliveries(): number;
}

export function createVerdictWatcher(options: {
  readVerdict: () => Promise<RsiVerdictOutcome | undefined>;
  isWaiting: () => boolean;
  onVerdict: (verdict: RsiVerdictOutcome) => void | Promise<void>;
  intervalMs?: number;
  setIntervalImpl?: (handler: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}): RsiVerdictWatcher {
  const intervalMs = options.intervalMs ?? 15_000;
  const seen = new Set<string>();
  let timer: unknown = null;
  let reads = 0;
  let deliveries = 0;

  const pollOnce = async (): Promise<{ delivered: boolean; verdict: RsiVerdictOutcome | null }> => {
    // 关键：不在等待裁决时，连读都不读（避免全系统高频轮询）。
    if (!options.isWaiting()) return { delivered: false, verdict: null };
    reads += 1;
    const verdict = await options.readVerdict();
    if (verdict === undefined) return { delivered: false, verdict: null };
    const fingerprint = `${verdict.messageId}:${verdict.verdict}`;
    if (seen.has(fingerprint)) return { delivered: false, verdict };
    seen.add(fingerprint);
    deliveries += 1;
    await options.onVerdict(verdict);
    return { delivered: true, verdict };
  };

  return {
    pollOnce,
    start(): void {
      if (timer !== null) return; // 幂等
      const setIntervalFn = options.setIntervalImpl ?? ((handler, ms) => setInterval(handler, ms));
      timer = setIntervalFn(() => {
        void pollOnce();
      }, intervalMs);
    },
    stop(): void {
      if (timer === null) return;
      const clearFn = options.clearIntervalImpl ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
      clearFn(timer);
      timer = null;
    },
    reads: () => reads,
    deliveries: () => deliveries,
  };
}

export const RSI_VERDICT_WATCHER_BOUNDARY = {
  pollsOnlyWhileWaiting: true,
  dedupesByMessageAndVerdict: true,
  readsCredentials: false,
  writesDatabase: false,
  performsExternalWrite: false,
} as const;
