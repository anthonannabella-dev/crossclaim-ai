/**
 * RSI 事件驱动续跑引擎（Continuation Engine）
 * OWNER 要求：5 分钟心跳驱动 → 事件驱动立即续跑 + 60s Watchdog 兜底。
 *   · 事件到达即 claim 下一安全任务（秒级延迟，不等心跳）；
 *   · Heartbeat 降级为 60s Watchdog：只兜底 worker 挂起 / 事件丢失 / lease 超时 / 未 reconcile / idle+队列非空；
 *   · 事件与 Watchdog 走**同一个** claimNextSafeTask()，由 lease + dedupeKey 保证 exactly-once；
 *   · 无变化 → SILENT。
 * 纯内存实现（clock 可注入）；持久化 lease 属 Schema Delta（RSI-RT-06 待裁决）。
 */

export const RSI_CONTINUATION_EVENTS = [
  'TASK_COMPLETED',
  'TEST_COMPLETED',
  'CI_COMPLETED',
  'JUDGE_VERDICT_RECEIVED',
  'CANDIDATE_VALIDATED',
  'INCIDENT_RESOLVED',
  'AGENT_RESULT_RECEIVED',
] as const;
export type RsiContinuationEvent = (typeof RSI_CONTINUATION_EVENTS)[number];

export const RSI_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export type RsiPriority = (typeof RSI_PRIORITIES)[number];

export interface RsiSafeTask {
  id: string;
  priority: RsiPriority;
  dedupeKey: string;
}

export interface RsiContinuationState {
  worker: 'RUNNING' | 'IDLE';
  waitingForVerdict: boolean;
  verdict: 'PASS' | 'REVISE' | 'BLOCK' | null;
  queueLength: number;
}

export interface RsiContinuationOutcome {
  action: 'CONTINUE' | 'REVISION' | 'CONSUME_VERDICT' | 'OWNER_ACTION_REQUIRED' | 'SILENT';
  claimed: RsiSafeTask | null;
  transitionLatencyMs: number | null;
  reason: string;
}

export function createRsiContinuationEngine(options: {
  tasks: readonly RsiSafeTask[];
  now?: () => number;
  leaseMs?: number;
}) {
  const now = options.now ?? (() => Date.now());
  const leaseMs = options.leaseMs ?? 5 * 60 * 1000;
  let queue: RsiSafeTask[] = [...options.tasks];
  let leased: RsiSafeTask | null = null;
  let leaseExpiresAt = 0;
  /** 已完成任务的去重键：防止同一任务被重复创建/重复执行；**lease 过期重领不受它限制**。 */
  const completedKeys = new Set<string>();
  let lastCompletedAt: number | null = null;
  let waitingForVerdict = false;
  let verdict: RsiContinuationState['verdict'] = null;

  const rank = (priority: RsiPriority): number => RSI_PRIORITIES.indexOf(priority);

  const claimNextSafeTask = (): RsiContinuationOutcome => {
    const at = now();
    if (leased !== null && at < leaseExpiresAt) {
      return { action: 'SILENT', claimed: null, transitionLatencyMs: null, reason: 'ACTIVE_LEASE' };
    }
    if (leased !== null && at >= leaseExpiresAt) {
      const expired = leased;
      queue = [expired, ...queue.filter((task) => task.id !== expired.id)];
      leased = null;
    }
    if (queue.length === 0) {
      return { action: 'SILENT', claimed: null, transitionLatencyMs: null, reason: 'QUEUE_EMPTY' };
    }
    const next = [...queue]
      .filter((task) => !completedKeys.has(task.dedupeKey))
      .sort((a, b) => rank(a.priority) - rank(b.priority) || (a.id < b.id ? -1 : 1))[0];
    if (next === undefined) {
      return { action: 'SILENT', claimed: null, transitionLatencyMs: null, reason: 'ALL_DEDUPED' };
    }
    queue = queue.filter((task) => task.id !== next.id);
    leased = next;
    leaseExpiresAt = at + leaseMs;
    return {
      action: 'CONTINUE',
      claimed: next,
      transitionLatencyMs: lastCompletedAt === null ? null : at - lastCompletedAt,
      reason: 'CLAIMED',
    };
  };

  const completeCurrent = (outcome: 'PASS' | 'REVISE' = 'PASS'): void => {
    if (leased !== null) completedKeys.add(leased.dedupeKey);
    leased = null;
    leaseExpiresAt = 0;
    lastCompletedAt = now();
    if (outcome === 'REVISE') {
      const at = now();
      queue = [{ id: `revision-${at}`, priority: 'P0', dedupeKey: `REVISION:${at}` }, ...queue];
    }
  };

  const engine = {
    claimNextSafeTask,
    completeCurrent,
    handleEvent(event: RsiContinuationEvent): RsiContinuationOutcome {
      if (event === 'JUDGE_VERDICT_RECEIVED') {
        if (verdict === 'BLOCK') {
          waitingForVerdict = false;
          return { action: 'OWNER_ACTION_REQUIRED', claimed: null, transitionLatencyMs: null, reason: 'VERDICT_BLOCK' };
        }
        const revise = verdict === 'REVISE';
        completeCurrent(revise ? 'REVISE' : 'PASS');
        waitingForVerdict = false;
        const outcome = claimNextSafeTask();
        return { ...outcome, action: revise ? 'REVISION' : 'CONSUME_VERDICT', reason: revise ? 'VERDICT_REVISE' : 'VERDICT_PASS' };
      }
      completeCurrent('PASS');
      const outcome = claimNextSafeTask();
      return { ...outcome, reason: event };
    },
    watchdogTick(): RsiContinuationOutcome {
      if (waitingForVerdict && verdict !== null) {
        return { ...engine.handleEvent('JUDGE_VERDICT_RECEIVED'), reason: 'WATCHDOG_VERDICT_PENDING' };
      }
      const at = now();
      if (leased !== null && at >= leaseExpiresAt) {
        const outcome = claimNextSafeTask();
        return { ...outcome, reason: outcome.claimed === null ? 'SILENT' : 'WATCHDOG_LEASE_RECLAIM' };
      }
      if (leased === null && queue.length > 0) {
        const outcome = claimNextSafeTask();
        return { ...outcome, reason: outcome.claimed === null ? 'SILENT' : 'WATCHDOG_IDLE_RESUME' };
      }
      return { action: 'SILENT', claimed: null, transitionLatencyMs: null, reason: 'NO_CHANGE' };
    },
    markWaitingForVerdict(next: RsiContinuationState['verdict']): void {
      waitingForVerdict = true;
      verdict = next;
    },
    state(): RsiContinuationState {
      return { worker: leased === null ? 'IDLE' : 'RUNNING', waitingForVerdict, verdict, queueLength: queue.length };
    },
  };
  return engine;
}

export const RSI_CONTINUATION_BOUNDARY = {
  heartbeatDrivesExecution: false,
  eventDrivenContinuation: true,
  watchdogIntervalMs: 60_000,
  exactlyOneActiveWorker: true,
  persistsLeaseToDatabase: false,
} as const;
