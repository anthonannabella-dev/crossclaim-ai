/**
 * RSI Controller × 续跑引擎接线（事件驱动 + 60s Watchdog）
 * ---------------------------------------------------------------
 * 目的：让控制器的推进由**事件**驱动，Watchdog 只做兜底；替换「等 5 分钟心跳」。
 *
 * 设计：
 *   · `emit(event)`：事件到达 → 引擎 claim 下一任务 → 立即调用注入的 runner；
 *   · `tick()`：Watchdog（默认 60s）→ 只在事件丢失/worker idle/lease 超时时补跑；
 *   · runner 由宿主注入（本地 Codex / AgentRunnerPort 均可），本层不持有任何凭据；
 *   · 无变化返回 SILENT，不打印噪声状态。
 */

import {
  RSI_CONTINUATION_BOUNDARY,
  createRsiContinuationEngine,
  type RsiContinuationEvent,
  type RsiContinuationOutcome,
  type RsiSafeTask,
} from '../services/autonomy/rsi-continuation-engine';

export interface RsiTaskRunner {
  run(task: RsiSafeTask): Promise<{ status: 'PASS' | 'REVISE' | 'BLOCK' }>;
}

export interface RsiControllerContinuation {
  emit(event: RsiContinuationEvent): Promise<RsiContinuationOutcome>;
  tick(): Promise<RsiContinuationOutcome>;
  state(): ReturnType<ReturnType<typeof createRsiContinuationEngine>['state']>;
  /** 标记进入「等待裁决」状态（裁决轮询器据此决定是否短轮询）。 */
  markWaitingForVerdict(verdict: 'PASS' | 'REVISE' | 'BLOCK' | null): void;
  /** 已记录的事件→领取延迟（毫秒），用于验证「秒级而非 5 分钟」。 */
  latencies(): readonly number[];
}

export function attachContinuationToController(options: {
  tasks: readonly RsiSafeTask[];
  runner: RsiTaskRunner;
  now?: () => number;
  leaseMs?: number;
}): RsiControllerContinuation {
  const engine = createRsiContinuationEngine({
    tasks: options.tasks,
    now: options.now,
    leaseMs: options.leaseMs,
  });
  const observed: number[] = [];

  const dispatch = async (outcome: RsiContinuationOutcome): Promise<RsiContinuationOutcome> => {
    if (outcome.claimed === null) return outcome; // SILENT / 无进展
    if (outcome.transitionLatencyMs !== null) observed.push(outcome.transitionLatencyMs);
    const result = await options.runner.run(outcome.claimed);
    engine.completeCurrent(result.status === 'REVISE' ? 'REVISE' : 'PASS');
    return outcome;
  };

  return {
    async emit(event) {
      const outcome = engine.handleEvent(event);
      return dispatch(outcome);
    },
    async tick() {
      const outcome = engine.watchdogTick();
      return dispatch(outcome);
    },
    state: () => engine.state(),
    markWaitingForVerdict: (verdict) => engine.markWaitingForVerdict(verdict),
    latencies: () => observed,
  };
}

export const RSI_CONTROLLER_CONTINUATION_BOUNDARY = {
  eventDriven: true,
  watchdogIntervalMs: RSI_CONTINUATION_BOUNDARY.watchdogIntervalMs,
  heartbeatDrivesExecution: RSI_CONTINUATION_BOUNDARY.heartbeatDrivesExecution,
  runnerInjectedByHost: true,
  holdsProviderCredentials: false,
  writesDatabase: false,
} as const;
