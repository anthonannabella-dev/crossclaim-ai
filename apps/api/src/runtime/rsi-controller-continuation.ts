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

/** 这些 evidenceRef 表示「没有拿到真实证据」，不能作为 PASS 依据。 */
const NO_EVIDENCE_TOKENS = new Set(['unconfigured', 'timeout', 'not-allowed', 'spawn-failed']);

export function attachContinuationToController(options: {
  tasks: readonly RsiSafeTask[];
  runner: RsiTaskRunner;
  /**
   * RSI-RT-05：开启后，runner 返回的结果**只作为提案** —— 任务停在「等待裁决」，
   * 由 JUDGE_VERDICT_RECEIVED 收口（PASS 完成 / REVISE 插入 P0 修订）。
   */
  awaitVerdict?: boolean;
  /** RSI-RT-05：配置后，PASS 还必须通过真实 CI/测试证据校验，否则降级为 BLOCK。 */
  verifyEvidence?: (evidenceRef: string | undefined, claimedAt: Date) => Promise<{ ok: boolean }>;
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
    const claimedAtMs = options.now?.() ?? Date.now();
    const claimedAt = new Date(claimedAtMs);
    if (outcome.transitionLatencyMs !== null) observed.push(outcome.transitionLatencyMs);
    const result = await options.runner.run(outcome.claimed);
    // 忠实映射：BLOCK 绝不写成 PASS；PASS 必须带可用证据。
    const evidenceRef = (result as { evidenceRef?: unknown }).evidenceRef;
    const hasToken = typeof evidenceRef === 'string' && evidenceRef !== '' && !NO_EVIDENCE_TOKENS.has(evidenceRef);
    const hasEvidence =
      hasToken &&
      (options.verifyEvidence === undefined || (await options.verifyEvidence(evidenceRef as string, claimedAt)).ok);
    const status: 'PASS' | 'REVISE' | 'BLOCK' =
      result.status === 'PASS' && hasEvidence ? 'PASS' : result.status === 'REVISE' ? 'REVISE' : 'BLOCK';
    if (options.awaitVerdict === true) {
      // park-for-judge：不完成，只登记「等待裁决」，裁决到达时才收口。
      engine.markWaitingForVerdict(status);
      // 只有在「刚领取普通任务」时才降级为 SILENT；裁决类动作（REVISION / CONSUME_VERDICT）必须保留。
      const parkAction = outcome.action === 'CONTINUE' ? 'SILENT' : outcome.action;
      const parkReason = outcome.action === 'CONTINUE' ? 'AWAITING_VERDICT' : outcome.reason;
      return { ...outcome, action: parkAction, reason: parkReason };
    }
    engine.completeCurrent(status);
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
  // RSI-RT-01/05：消除伪成功（claimed→PASS / BLOCK→PASS / 事件替在飞任务宣告完成）。
  blockIsNeverPass: true,
  passRequiresEvidence: true,
  claimedAtForwardedToEvidence: true,
  parkForJudgeSupported: true,
  parkForJudgeDefault: false,
  eventsDoNotCompleteInflight: true,
  eventDriven: true,
  watchdogIntervalMs: RSI_CONTINUATION_BOUNDARY.watchdogIntervalMs,
  heartbeatDrivesExecution: RSI_CONTINUATION_BOUNDARY.heartbeatDrivesExecution,
  runnerInjectedByHost: true,
  holdsProviderCredentials: false,
  writesDatabase: false,
} as const;
