// AGENT EXPERIENCE LAYER / P2 — Goal → 现有 ONE SI Runtime 接线
// ---------------------------------------------------------------------------
// 关键判断（先扫描既有实现后得出）：Goal 计划**不得**直接调用 runner。
//   既有 runtime（`apps/api/src/runtime/rsi-run.ts`）的唯一执行入口是它的**任务队列**：
//   `composeRsiRuntime` 从 `tasksPath` 读任务 → controller/event-loop 认领（claim/lease）→
//   runner mux 把 `task:recovery:*` **永远**交给 Recovery domain dispatch（保留 pack `recovery-si`）。
//   因此本模块只做「把计划并入既有队列」这一件事：
//     * 不创建 runtime / scheduler / event loop / player；
//     * 不直接 runner.run（否则会绕过 claim/lease/park-for-judge 与 Recovery routing）；
//     * 入队 ≠ 执行 —— 返回体显式 `admissionOnly = true`、`externalActionPerformed = false`；
//     * 非 `task:recovery:*` 命名空间一律拒绝（不得抢占、不得绕过 Recovery routing）。

import { RECOVERY_TASK_DEDUPE_PREFIX } from '../../runtime/rsi-domain-pack';
import type { GoalTaskDraft, GoalPlan } from './goal-task-planner';

/** 只允许既有保留命名空间（`task:recovery:`）——不得抢占 / 不得绕到别的命名空间 */
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

export const GOAL_RUNTIME_BINDING_VERSION = 'agent-goal-runtime-binding/v1';

/** 既有 runtime 任务队列的注入端口（队列 artifact 由 host 拥有；本模块不新建队列实现） */
export interface GoalTaskQueuePort {
  admit(input: {
    organizationId: string;
    tasks: readonly GoalTaskDraft[];
  }): Promise<{ admitted: readonly string[]; alreadyPresent: readonly string[] }>;
}

export interface GoalPlanAdmissionResult {
  readonly kind: 'AGENT_GOAL_PLAN_ADMITTED';
  readonly version: string;
  readonly goalId: string;
  readonly organizationId: string;
  readonly admitted: readonly string[];
  readonly alreadyPresent: readonly string[];
  /** 执行者恒为既有 ONE SI Runtime（本层不执行） */
  readonly executedBy: 'ONE_SI_RUNTIME';
  readonly runtimeOwner: 'apps/api/src/runtime/rsi-run.ts';
  /** 入队 ≠ 执行：结果只有认领/裁决之后才可能产生 */
  readonly admissionOnly: true;
  readonly externalActionPerformed: false;
  readonly createdRuntime: false;
  readonly admittedAt: string;
}

export interface GoalRuntimeBinding {
  describe(): {
    version: string;
    runtimeOwner: string;
    entryPoint: 'existing-task-queue';
    createsRuntime: false;
    createsScheduler: false;
    createsEventLoop: false;
    callsRunnerDirectly: false;
    recoveryNamespace: string;
  };
  admit(plan: GoalPlan, options?: { now?: Date }): Promise<GoalPlanAdmissionResult>;
}

export function createGoalRuntimeBinding(input: { queue: GoalTaskQueuePort }): GoalRuntimeBinding {
  if (!input?.queue || typeof input.queue.admit !== 'function') {
    throw new Error('GOAL_TASK_QUEUE_PORT_REQUIRED: 必须注入既有任务队列端口（不得自建 runtime / 队列）');
  }
  return {
    describe: () => ({
      version: GOAL_RUNTIME_BINDING_VERSION,
      runtimeOwner: 'apps/api/src/runtime/rsi-run.ts' as const,
      entryPoint: 'existing-task-queue' as const,
      createsRuntime: false as const,
      createsScheduler: false as const,
      createsEventLoop: false as const,
      callsRunnerDirectly: false as const,
      recoveryNamespace: 'task:recovery:',
    }),
    async admit(plan, options) {
      // ① 命名空间保护：只允许既有保留路由
      assertRecoveryNamespaceOnly(plan);
      // ② 任务必须是「草案」（不得携带结果字段）
      for (const task of plan.tasks) {
        if (typeof task.dedupeKey !== 'string' || !task.dedupeKey.startsWith('task:recovery:')) {
          throw new Error('GOAL_TASK_NAMESPACE_NOT_ALLOWED: ' + String(task.dedupeKey));
        }
      }
      // ③ 并入既有队列（host 端口；本层不执行、不裁决）
      const admitted = await input.queue.admit({
        organizationId: plan.organizationId,
        tasks: plan.tasks,
      });
      return {
        kind: 'AGENT_GOAL_PLAN_ADMITTED',
        version: GOAL_RUNTIME_BINDING_VERSION,
        goalId: plan.goalId,
        organizationId: plan.organizationId,
        admitted: [...admitted.admitted],
        alreadyPresent: [...admitted.alreadyPresent],
        executedBy: 'ONE_SI_RUNTIME',
        runtimeOwner: 'apps/api/src/runtime/rsi-run.ts',
        admissionOnly: true,
        externalActionPerformed: false,
        createdRuntime: false,
        admittedAt: (options?.now ?? new Date()).toISOString(),
      };
    },
  };
}

/** 边界断言：入队结果不得被当成执行结果使用 */
export function assertAdmissionIsNotExecution(result: {
  admissionOnly?: boolean;
  externalActionPerformed?: boolean;
}): void {
  if (result.admissionOnly !== true || result.externalActionPerformed === true) {
    throw new Error('GOAL_ADMISSION_TREATED_AS_EXECUTION: 入队不等于执行');
  }
}

export const GOAL_RUNTIME_BINDING_BOUNDARY = {
  version: GOAL_RUNTIME_BINDING_VERSION,
  createsRuntime: false,
  createsScheduler: false,
  createsEventLoop: false,
  createsWorkflowEngine: false,
  createsSecondGuard: false,
  createsSecondPolicyEngine: false,
  callsRunnerDirectly: false,
  entryPoint: 'existing-task-queue',
  runtimeOwner: 'apps/api/src/runtime/rsi-run.ts',
  recoveryNamespaceReserved: 'task:recovery:',
  admissionIsNotExecution: true,
  externalActionPerformed: false,
  forbidden: [
    'invoking the runner directly (bypasses claim/lease/park-for-judge and recovery routing)',
    'admitting tasks outside the reserved recovery namespace',
    'creating a goal-runtime-loop / agent-runtime / scheduler',
    'reporting an admission as an execution result',
  ],
} as const;
