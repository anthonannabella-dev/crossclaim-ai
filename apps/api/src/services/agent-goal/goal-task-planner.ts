// AGENT EXPERIENCE LAYER / P1 — Task Planner（goal → 既有 task namespace 的任务草案）
// ---------------------------------------------------------------------------
// 规划器只产出**任务草案**：域 + 既有保留命名空间 `task:recovery:` 下的 dedupeKey + 候选动作。
//   * 不新增 runtime / scheduler / workflow engine；
//   * 不抢占 `task:recovery:*`（suffix 由本模块确定性生成，调用方不得自定义）；
//   * 幂等：同一 goal（digest 相同）重复规划 → 同一 dedupeKey → 既有调度去重，不产生重复任务。

import { digestOf } from '../config-execution-durability/digests';
import { RECOVERY_TASK_DEDUPE_PREFIX } from '../../runtime/rsi-domain-pack';
import { STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES } from '../standing-authorization/standing-authorization';
import type { GoalCapabilityResolution } from './goal-capability-resolver';
import { AGENT_GOAL_VERSION, type GoalDomain, type ValidatedAgentGoal } from './goal-contract';

export const GOAL_TASK_PLANNER_VERSION = 'agent-goal-planner/v1';

export interface GoalTaskDraft {
  readonly domain: GoalDomain;
  /** 既有保留命名空间：`task:recovery:<DOMAIN>:<suffix>` */
  readonly dedupeKey: string;
  readonly candidateActions: readonly string[];
  /** 有效授权下可能自动执行的动作（仍受 Action Guard / 风险分级 / HITL 约束） */
  readonly autoExecutableActions: readonly string[];
  readonly blockedActions: readonly string[];
  readonly executionMode: ValidatedAgentGoal['executionMode'];
  readonly requiresStandingAuthorizationForAutoExecution: boolean;
}

export interface GoalPlan {
  readonly kind: 'AGENT_GOAL_PLAN';
  readonly version: string;
  readonly goalId: string;
  readonly goalDigest: string;
  readonly organizationId: string;
  readonly domains: readonly GoalDomain[];
  readonly timeRange: ValidatedAgentGoal['timeRange'];
  readonly executionMode: ValidatedAgentGoal['executionMode'];
  readonly approvalThresholdPreference: ValidatedAgentGoal['approvalThresholdPreference'];
  readonly tasks: readonly GoalTaskDraft[];
  readonly executionPolicy: {
    readonly authority: 'ACTION_GUARD';
    readonly standingAuthorizationMaySatisfy: readonly string[];
    readonly nonBypassableGates: readonly string[];
    readonly highValueHitl: 'KEEP';
    readonly customsPoaSatisfiableByStandingAuthorization: false;
    readonly externalWritePerformed: false;
  };
  readonly externalActionPerformed: false;
  readonly createdRuntime: false;
  readonly plannedAt: string;
  readonly planDigest: string;
}

export function buildGoalTaskDedupeKey(input: { goalDigest: string; domain: GoalDomain }): string {
  return `${RECOVERY_TASK_DEDUPE_PREFIX}${input.domain}:goal:${input.goalDigest.slice(0, 24)}`;
}

/**
 * goal + capability resolution → 任务草案（只读投影，不产生任何副作用）。
 * 幂等：相同 goal 与相同域 → 相同 dedupeKey。
 */
export function planAgentGoal(input: {
  goal: ValidatedAgentGoal;
  capabilities: GoalCapabilityResolution;
  now: Date;
}): GoalPlan {
  if (input.capabilities.organizationId !== input.goal.organizationId) {
    throw new Error('GOAL_PLAN_TENANT_MISMATCH: capability resolution 与 goal 不属于同一租户');
  }

  const tasks: GoalTaskDraft[] = input.goal.domains.map((domain) => {
    const capability = input.capabilities.domains.find((entry) => entry.domain === domain);
    const candidateActions = [...(capability?.executableActions ?? [])];
    const autoExecutableActions = [...(capability?.autoExecutableActions ?? [])];
    const blockedActions = [...(capability?.blockedActions ?? [])];
    return {
      domain,
      dedupeKey: buildGoalTaskDedupeKey({ goalDigest: input.goal.goalDigest, domain }),
      candidateActions,
      autoExecutableActions,
      blockedActions,
      executionMode: input.goal.executionMode,
      requiresStandingAuthorizationForAutoExecution: input.goal.requiresStandingAuthorizationForAutoExecution,
    };
  });

  const body = {
    version: AGENT_GOAL_VERSION,
    plannerVersion: GOAL_TASK_PLANNER_VERSION,
    goalId: input.goal.goalId,
    goalDigest: input.goal.goalDigest,
    organizationId: input.goal.organizationId,
    domains: input.goal.domains,
    timeRange: input.goal.timeRange,
    executionMode: input.goal.executionMode,
    approvalThresholdPreference: input.goal.approvalThresholdPreference,
    tasks,
    executionPolicy: {
      authority: 'ACTION_GUARD' as const,
      standingAuthorizationMaySatisfy: ['humanApproval'],
      nonBypassableGates: [...STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES],
      highValueHitl: 'KEEP' as const,
      customsPoaSatisfiableByStandingAuthorization: false as const,
      externalWritePerformed: false as const,
    },
    plannedAt: input.now.toISOString(),
  };

  return {
    kind: 'AGENT_GOAL_PLAN',
    ...body,
    externalActionPerformed: false,
    createdRuntime: false,
    planDigest: digestOf(body),
  };
}

export const GOAL_TASK_PLANNER_BOUNDARY = {
  version: GOAL_TASK_PLANNER_VERSION,
  createsRuntime: false,
  createsScheduler: false,
  createsWorkflowEngine: false,
  createsSecondFactSource: false,
  taskNamespace: RECOVERY_TASK_DEDUPE_PREFIX,
  callerSuppliedDedupeKey: 'FORBIDDEN（dedupeKey 由规划器确定性生成）',
  idempotentAcrossReplanning: true,
  externalActionPerformed: false,
  forbidden: [
    'planning tasks outside the reserved recovery namespace',
    'letting a caller supply its own dedupeKey or task namespace',
    'bypassing the Action Guard or the standing authorization at plan time',
    'treating the plan as an execution result',
  ],
} as const;
