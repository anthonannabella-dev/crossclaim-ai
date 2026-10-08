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
  /** RSI-RT-05：被判 BLOCK 的任务数（既不完成、也不重试），用于区分「失败」与「完成」。 */
  blockedCount: number;
  /** PHASE 1：运行时动态采纳（durable 队列 → 本引擎）的累计任务数（只增，用于可观测性）。 */
  adoptedCount: number;
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

  /** BLOCK 过的任务：既不标记完成，也不重复领取（等待宿主/裁决处理）。 */
  const blockedKeys = new Set<string>();
  /** PHASE 1：动态采纳累计计数（可观测性；仅统计真正进入队列的次数）。 */
  let adoptedTotal = 0;

  /**
   * PHASE 1（SI/RSI 客户自治执行）—— 动态采纳：
   * 把**运行时新出现**的 durable 任务并入本引擎的队列，使运行中的实例无需重启即可消费。
   *
   * 去重口径（与 claimNextSafeTask 完全一致，避免重复执行）：
   *   · 已完成（completedKeys）→ 忽略；
   *   · 已 BLOCK（blockedKeys）→ 忽略（等宿主/裁决处理，不重复领取）；
   *   · 已在队列中 → 忽略；
   *   · 正被当前租约持有 → 忽略。
   * 本方法不创建任何新的 worker / loop / scheduler：只是把任务放进**同一个**队列，
   * 仍由既有的 claimNextSafeTask() 依据 priority + lease 领取。
   */
  const adoptTasks = (incoming: readonly RsiSafeTask[]): readonly string[] => {
    const adopted: string[] = [];
    for (const task of incoming) {
      if (completedKeys.has(task.dedupeKey)) continue;
      if (blockedKeys.has(task.dedupeKey)) continue;
      if (queue.some((existing) => existing.dedupeKey === task.dedupeKey)) continue;
      if (leased !== null && leased.dedupeKey === task.dedupeKey) continue;
      queue = [...queue, task];
      adoptedTotal += 1;
      adopted.push(task.dedupeKey);
    }
    return adopted;
  };

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
      .filter((task) => !completedKeys.has(task.dedupeKey) && !blockedKeys.has(task.dedupeKey))
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

  /**
   * 只有显式结果才结束当前任务，且**没有默认值**（旧实现的默认 PASS 是伪成功来源）：
   *   PASS  → 标记 dedupeKey 完成；
   *   REVISE→ 标记完成并插入 P0 修订任务（可重试）；
   *   BLOCK → **既不标记完成、也不插入修订**，转入 blocked（不会被重复领取）。
   */
  const completeCurrent = (outcome: 'PASS' | 'REVISE' | 'BLOCK'): void => {
    const task = leased;
    leased = null;
    leaseExpiresAt = 0;
    lastCompletedAt = now();
    if (task === null) return;
    if (outcome === 'PASS') {
      completedKeys.add(task.dedupeKey);
      return;
    }
    if (outcome === 'REVISE') {
      completedKeys.add(task.dedupeKey);
      const at = now();
      queue = [{ id: `revision-${at}`, priority: 'P0', dedupeKey: `REVISION:${at}` }, ...queue];
      return;
    }
    blockedKeys.add(task.dedupeKey);
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
      // 事件只驱动「领取下一个」；它**不能**替在飞任务宣告完成。
      const outcome = claimNextSafeTask();
      // 未领取到任务时保留底层原因（ACTIVE_LEASE / QUEUE_EMPTY / ALL_DEDUPED）。
      return { ...outcome, reason: outcome.claimed === null ? outcome.reason : event };
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
      return {
        worker: leased === null ? 'IDLE' : 'RUNNING',
        waitingForVerdict,
        verdict,
        queueLength: queue.length,
        blockedCount: blockedKeys.size,
        adoptedCount: adoptedTotal,
      };
    },
    adoptTasks,
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
