// AGENT EXPERIENCE LAYER / P1/P2 — Goal → 既有 ONE SI Runtime 适配器
// ---------------------------------------------------------------------------
// 硬约束：**不新增 runtime**。适配器只把规划好的任务草案交给既有 runner（`createRsiDomainPackRunner`
// 产出的 runner，owner = `apps/api/src/runtime/rsi-run.ts`），并把结果如实回传。
//   * 不得创建事件循环 / 调度器 / 轮询；
//   * 不得抢占 `task:recovery:*`（只允许把该命名空间的任务交给既有 runtime）；
//   * 不得绕过 Action Guard / Standing Authorization / HITL（本适配器不判定权限，只转发）；
//   * 不执行任何外部写。

import { RECOVERY_TASK_DEDUPE_PREFIX } from '../../runtime/rsi-domain-pack';
import type { GoalPlan } from './goal-task-planner';

export const GOAL_RUNTIME_ADAPTER_VERSION = 'agent-goal-runtime-adapter/v1';

/** 与既有 `RsiEvidenceRunner` 同形的最小端口（避免复制 runtime 类型） */
export interface GoalRuntimePort {
  run(task: { id: string; dedupeKey: string; priority: string }): Promise<{ status: string; evidenceRef: string }>;
}

export interface GoalDispatchOutcome {
  readonly dedupeKey: string;
  readonly domain: string;
  readonly status: string;
  readonly evidenceRef: string;
}

export interface GoalDispatchResult {
  readonly kind: 'AGENT_GOAL_DISPATCH_RESULT';
  readonly goalId: string;
  readonly organizationId: string;
  readonly dispatched: readonly GoalDispatchOutcome[];
  /** 恒为 false：适配器只转发，不执行外部动作 */
  readonly externalActionPerformed: false;
  readonly createdRuntime: false;
  readonly runtimeOwner: 'apps/api/src/runtime/rsi-run.ts';
  readonly dispatchedAt: string;
}

export interface GoalRuntimeAdapter {
  describe(): {
    version: string;
    runtimeOwner: string;
    createsRuntime: false;
    createsScheduler: false;
    createsEventLoop: false;
    recoveryNamespace: string;
  };
  dispatch(plan: GoalPlan, options?: { now?: Date }): Promise<GoalDispatchResult>;
}

/** 断言：规划结果只能落在既有保留命名空间内 */
export function assertRecoveryNamespaceOnly(plan: GoalPlan): void {
  for (const task of plan.tasks) {
    if (!task.dedupeKey.startsWith(RECOVERY_TASK_DEDUPE_PREFIX)) {
      throw new Error('GOAL_TASK_NAMESPACE_NOT_ALLOWED: ' + task.dedupeKey);
    }
  }
}

/** 断言：本层不得创建第二 runtime */
export function assertNoSecondRuntime(members: { secondRuntime?: number }): void {
  if (members.secondRuntime !== undefined && members.secondRuntime !== 0) {
    throw new Error('GOAL_SECOND_RUNTIME_FORBIDDEN');
  }
}

/**
 * 创建适配器。**runtime 必须由调用方注入既有 runner** —— 本函数不构造任何循环 / 调度。
 */
export function createGoalRuntimeAdapter(input: {
  runtime: GoalRuntimePort;
  log?: (line: string) => void;
}): GoalRuntimeAdapter {
  if (!input?.runtime || typeof input.runtime.run !== 'function') {
    throw new Error('GOAL_RUNTIME_PORT_REQUIRED: 必须注入既有 runner（不得自建 runtime）');
  }
  return {
    describe: () => ({
      version: GOAL_RUNTIME_ADAPTER_VERSION,
      runtimeOwner: 'apps/api/src/runtime/rsi-run.ts' as const,
      createsRuntime: false as const,
      createsScheduler: false as const,
      createsEventLoop: false as const,
      recoveryNamespace: RECOVERY_TASK_DEDUPE_PREFIX,
    }),
    async dispatch(plan, options) {
      assertRecoveryNamespaceOnly(plan);
      const dispatched: GoalDispatchOutcome[] = [];
      for (const task of plan.tasks) {
        const outcome = await input.runtime.run({
          id: task.dedupeKey,
          dedupeKey: task.dedupeKey,
          priority: 'P2',
        });
        input.log?.(`GOAL_TASK_DISPATCHED ${task.dedupeKey} -> ${outcome.status}`);
        dispatched.push({
          dedupeKey: task.dedupeKey,
          domain: task.domain,
          status: outcome.status,
          evidenceRef: outcome.evidenceRef,
        });
      }
      return {
        kind: 'AGENT_GOAL_DISPATCH_RESULT',
        goalId: plan.goalId,
        organizationId: plan.organizationId,
        dispatched,
        externalActionPerformed: false,
        createdRuntime: false,
        runtimeOwner: 'apps/api/src/runtime/rsi-run.ts',
        dispatchedAt: (options?.now ?? new Date()).toISOString(),
      };
    },
  };
}

export const GOAL_RUNTIME_ADAPTER_BOUNDARY = {
  version: GOAL_RUNTIME_ADAPTER_VERSION,
  createsRuntime: false,
  createsScheduler: false,
  createsEventLoop: false,
  createsWorkflowEngine: false,
  createsSecondGuard: false,
  createsSecondPolicyEngine: false,
  dispatchesIntoExistingRuntimeOnly: true,
  recoveryNamespaceReserved: RECOVERY_TASK_DEDUPE_PREFIX,
  runtimeOwner: 'apps/api/src/runtime/rsi-run.ts',
  runLoopOwner: 'apps/api/src/runtime/rsi-event-loop.ts',
  externalActionPerformed: false,
  forbidden: [
    'starting a second runtime, agent-runtime or goal-runtime-loop',
    'creating a scheduler or polling loop',
    'hijacking the reserved task:recovery:* namespace',
    'calling a provider or performing an external write from the adapter',
    'letting a caller runner bypass recovery routing',
  ],
} as const;
