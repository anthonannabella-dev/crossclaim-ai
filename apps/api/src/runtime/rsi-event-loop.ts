/**
 * RSI 宿主侧事件循环（事件驱动 + 60s 兜底）
 * ---------------------------------------------------------------
 * 职责：把宿主提供的**只读**结果源（CI 结果、测试结果、verdict）转成续跑事件，
 * 经指纹去重后驱动控制器；没有新事件时 **SILENT**，绝不 busy loop。
 *
 * 触发模型（对应 OWNER 要求）：
 *   · `pollOnce()`：一次拉取 → 去重 → `controller.emit()`（事件驱动，秒级）；
 *   · `start()`：周期 tick（默认 60s）仅作**兜底**——事件丢失 / worker idle / lease 超时；
 *   · 禁止 while(true) 高频轮询：只有一个 interval，且无新事件时不产生任何输出。
 */

import type { RsiControllerContinuation } from './rsi-controller-continuation';
import {
  createEventFingerprintGate,
  deriveContinuationEvents,
  type RsiCiOutcome,
  type RsiVerdictOutcome,
} from './rsi-event-sources';
import type { RsiContinuationOutcome } from '../services/autonomy/rsi-continuation-engine';

export interface RsiEventSources {
  /** 只读：最近的 CI 运行结果（宿主负责真实读取）。 */
  readCi?: () => Promise<readonly RsiCiOutcome[] | undefined>;
  /** 只读：最近一次测试结果。 */
  readTests?: () => Promise<{ fingerprint: string; passed: boolean } | undefined>;
  /** 只读：最近一条裁决（若已消费则返回 undefined）。 */
  readVerdict?: () => Promise<RsiVerdictOutcome | undefined>;
}

export interface RsiEventLoopHandle {
  pollOnce(): Promise<readonly RsiContinuationOutcome[]>;
  start(): void;
  stop(): void;
  polls(): number;
  silentPolls(): number;
}

export function createRsiEventLoop(options: {
  controller: RsiControllerContinuation;
  sources: RsiEventSources;
  intervalMs?: number;
  setIntervalImpl?: (handler: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}): RsiEventLoopHandle {
  const intervalMs = options.intervalMs ?? 60_000;
  const gate = createEventFingerprintGate();
  let timer: unknown = null;
  let polls = 0;
  let silentPolls = 0;

  const pollOnce = async (): Promise<readonly RsiContinuationOutcome[]> => {
    polls += 1;
    const [ci, tests, verdict] = await Promise.all([
      options.sources.readCi?.() ?? Promise.resolve(undefined),
      options.sources.readTests?.() ?? Promise.resolve(undefined),
      options.sources.readVerdict?.() ?? Promise.resolve(undefined),
    ]);

    const accepted = gate.accept(deriveContinuationEvents({ ci, tests, verdict }));
    if (accepted.length === 0) {
      // 没有新事件 → 交给 60s 兜底；本次静默（不输出噪声）。
      silentPolls += 1;
      return [];
    }

    const outcomes: RsiContinuationOutcome[] = [];
    for (const derived of accepted) {
      outcomes.push(await options.controller.emit(derived.event));
    }
    return outcomes;
  };

  return {
    pollOnce,
    start(): void {
      if (timer !== null) return; // 防重复起停（exactly-one loop）
      const setIntervalFn = options.setIntervalImpl ?? ((handler, ms) => setInterval(handler, ms));
      timer = setIntervalFn(() => {
        void (async () => {
          const outcomes = await pollOnce();
          // 无新事件时用 60s tick 兜底（事件丢失 / idle+队列非空 / lease 超时）
          if (outcomes.length === 0) await options.controller.tick();
        })();
      }, intervalMs);
    },
    stop(): void {
      if (timer === null) return;
      const clearFn = options.clearIntervalImpl ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
      clearFn(timer);
      timer = null;
    },
    polls: () => polls,
    silentPolls: () => silentPolls,
  };
}

export const RSI_EVENT_LOOP_BOUNDARY = {
  eventDrivenFirst: true,
  watchdogFallbackOnly: true,
  busyLoop: false,
  watchdogIntervalMs: 60_000,
  silentWhenNoEvents: true,
} as const;
