// AGENT EXPERIENCE LAYER / CUSTOMER-UX FINAL2 — Goal Admission（目标准入，真实接线）
// ---------------------------------------------------------------------------
// 目的（独立终审 MSG-20261007-03 CHANGE 2 / CHANGE 3）：
//   把客户 Goal 真正接入**既有** ONE SI Runtime：
//     Goal → goal admission → createGoalRuntimeBinding() → 既有任务队列准入
//          → ONE SI Runtime 认领（由既有 runtime 执行）→ AgentGoalRun / run projection 持久化
//
// 边界（不得违反）：
//   * 不创建第二 runtime / scheduler / event loop / guard / 队列；
//   * 不直接调用 runner（准入只并入既有队列）；
//   * 外部写恒不发生（externalActionPerformed = false）；
//   * 授权只走**既有** durable Standing Authorization + 既有 Action Guard 目录；
//     Standing Authorization 永远不能满足非可绕过 gate（productionGate / platformEnablement /
//     hostApproval / killSwitch / credential / provider capability / customs POA / regulatory / isolation）。

import { readFile, writeFile } from 'node:fs/promises';

import type { PrismaClient } from '@prisma/client';

import { ACTION_GUARD_CATALOG, type ActionRiskClass } from '../action-guard/action-guard';
import {
  evaluateStandingAuthorization,
  type StandingAuthorizationRecord,
  type StandingAuthorizationRequest,
} from '../standing-authorization/standing-authorization';
import { compileAgentGoal } from './goal-compiler';
import { defaultGoalCapabilityFacts } from './http-request';
import { resolveGoalCapabilities, type GoalCapabilityFacts } from './goal-capability-resolver';
import { validateAgentGoalDraft } from './goal-validator';
import {
  AGENT_GOAL_TERMINAL_STATUSES,
  createAgentGoalRun,
  listAgentGoalRuns,
  loadAgentGoal,
  updateAgentGoalRunStatus,
  updateAgentGoalStatus,
  type AgentGoalRunStatus,
} from './goal-store';
import { createGoalRuntimeBinding, type GoalTaskQueuePort } from './goal-runtime-binding';
import { planAgentGoal, type GoalPlan } from './goal-task-planner';

export const GOAL_ADMISSION_VERSION = 'agent-goal-admission/v1';
export const GOAL_ADMISSION_PATH_SUFFIX = '/admit';

/** 只有这些 requiredGates 允许由 Standing Authorization（TIER_1 低风险）满足；其余一律不可绕过 */
const AUTHORIZATION_SATISFIABLE_GATES: readonly string[] = ['humanApproval'];

export type GoalAdmissionKind =
  | 'ADMITTED'
  | 'ALREADY_ADMITTED'
  | 'REQUIRES_AUTHORIZATION'
  | 'DENIED'
  | 'NOT_FOUND';

export interface GoalAdmissionView {
  readonly kind: GoalAdmissionKind;
  readonly version: string;
  readonly goalId: string | null;
  readonly organizationId: string;
  /** 已存在或新建的执行投影（准入本身不产生投影；投影只由既有 runtime 结果落库） */
  readonly runId: string | null;
  readonly goalStatus: string | null;
  readonly admitted: readonly string[];
  readonly alreadyPresent: readonly string[];
  readonly requiresAuthorization: boolean;
  readonly requiredAuthorizationAction: string | null;
  readonly reasonCodes: readonly string[];
  readonly executedBy: 'ONE_SI_RUNTIME';
  /** 准入 ≠ 执行 */
  readonly admissionOnly: true;
  /** 恒为 false：本层不执行任何外部动作 */
  readonly externalActionPerformed: false;
  readonly createdRuntime: false;
  readonly createdAt: string;
}

export interface GoalAdmissionDeps {
  /** 既有 runtime 任务队列端口（队列 artifact 由 host 拥有） */
  queue: GoalTaskQueuePort | null;
  /** 既有 durable Standing Authorization 读取（tenant/account scoped） */
  loadAuthorization: (
    query: { organizationId: string; platformAccountId: string; provider: string },
  ) => Promise<StandingAuthorizationRecord | null>;
  /** 队列入队记录器（可选：仅用于审计日志，不参与判定） */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** 服务端事实快照（生产闸门 / 写开关 / Kill Switch / POA 等）；缺省为最保守取值 */
  capabilityFacts?: (input: { organizationId: string }) => Promise<GoalCapabilityFacts>;
}

export interface AdmitAgentGoalInput {
  organizationId: string;
  goalId: string;
  /** 目标作用域（必须属于同一租户；跨租户一律 NOT_FOUND/拒绝） */
  platformAccountId: string;
  provider: string;
  now: Date;
}

export class GoalAdmissionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoalAdmissionError';
    this.code = code;
  }
}

/** 计划里真正需要授权的动作（第一个可自动执行动作，否则取第一个候选动作）。 */
export function requiredAuthorizationAction(plan: GoalPlan): string | null {
  for (const task of plan.tasks) {
    for (const action of task.autoExecutableActions) {
      if (typeof action === 'string' && action !== '') return action;
    }
  }
  for (const task of plan.tasks) {
    for (const action of task.candidateActions) {
      if (typeof action === 'string' && action !== '') return action;
    }
  }
  return null;
}

/**
 * 计划中是否包含**不得由准入放行**的动作（非可绕过 gate 未满足即拒绝，不猜测、不放行）。
 * 依据：既有 Action Guard 目录（唯一动作权威），不新建第二套策略。
 */
export function findNonAdmissibleActions(plan: GoalPlan): { action: string; gates: readonly string[] }[] {
  const blocked: { action: string; gates: readonly string[] }[] = [];
  const seen = new Set<string>();
  for (const task of plan.tasks) {
    for (const action of [...task.autoExecutableActions, ...task.candidateActions]) {
      if (seen.has(action)) continue;
      seen.add(action);
      const entry = Object.prototype.hasOwnProperty.call(ACTION_GUARD_CATALOG, action)
        ? ACTION_GUARD_CATALOG[action]
        : undefined;
      if (entry === undefined) {
        blocked.push({ action, gates: ['UNKNOWN_ACTION'] });
        continue;
      }
      const nonBypassable = entry.requires.filter((gate) => !AUTHORIZATION_SATISFIABLE_GATES.includes(gate));
      // 高风险动作（EXTERNAL_WRITE / MONEY_MOVEMENT / SECRET_ACCESS）不得由目标准入自动放行。
      const highRisk = entry.risk !== 'READ_ONLY' && entry.risk !== 'INTERNAL_WRITE';
      if (nonBypassable.length > 0 || highRisk) {
        blocked.push({ action, gates: [...nonBypassable, ...(highRisk ? [entry.risk as ActionRiskClass] : [])] });
      }
    }
  }
  return blocked;
}

/**
 * 目标准入：把计划并入**既有**任务队列。
 * 幂等：同一 goal 只要已有未失败/未取消的执行投影，就不再入队、不再产生第二条投影。
 */
export async function admitAgentGoal(
  prisma: PrismaClient,
  input: AdmitAgentGoalInput,
  deps: GoalAdmissionDeps,
): Promise<GoalAdmissionView> {
  const base = {
    version: GOAL_ADMISSION_VERSION,
    organizationId: input.organizationId,
    executedBy: 'ONE_SI_RUNTIME' as const,
    admissionOnly: true as const,
    externalActionPerformed: false as const,
    createdRuntime: false as const,
    createdAt: input.now.toISOString(),
  };

  const goal = await loadAgentGoal(prisma, {
    organizationId: input.organizationId,
    goalId: input.goalId,
  });
  if (goal === null) {
    return {
      ...base,
      kind: 'NOT_FOUND',
      goalId: null,
      runId: null,
      goalStatus: null,
      admitted: [],
      alreadyPresent: [],
      requiresAuthorization: false,
      requiredAuthorizationAction: null,
      reasonCodes: ['GOAL_NOT_FOUND'],
    };
  }

  // 幂等：已有执行投影 → 直接返回，不重复入队 / 不重复投影。
  const runs = await listAgentGoalRuns(prisma, {
    organizationId: input.organizationId,
    goalId: input.goalId,
  });
  const live = runs.find((run) => run.status !== 'FAILED' && run.status !== 'CANCELLED');
  if (live !== undefined) {
    return {
      ...base,
      kind: 'ALREADY_ADMITTED',
      goalId: goal.goalId,
      runId: live.runId,
      goalStatus: goal.status,
      admitted: [],
      alreadyPresent: [],
      requiresAuthorization: false,
      requiredAuthorizationAction: null,
      reasonCodes: ['GOAL_ALREADY_ADMITTED'],
    };
  }

  if ((AGENT_GOAL_TERMINAL_STATUSES as readonly string[]).includes(goal.status)) {
    return {
      ...base,
      kind: 'DENIED',
      goalId: goal.goalId,
      runId: null,
      goalStatus: goal.status,
      admitted: [],
      alreadyPresent: [],
      requiresAuthorization: false,
      requiredAuthorizationAction: null,
      reasonCodes: ['GOAL_TERMINAL'],
    };
  }

  // 用**确定性编译器**重建计划，并校验 durable lineage（digest 不一致即拒绝）。
  const compiled = compileAgentGoal({ text: goal.rawUserIntent });
  if (!compiled.ok) {
    return {
      ...base,
      kind: 'DENIED',
      goalId: goal.goalId,
      runId: null,
      goalStatus: goal.status,
      admitted: [],
      alreadyPresent: [],
      requiresAuthorization: false,
      requiredAuthorizationAction: null,
      reasonCodes: ['GOAL_NOT_COMPILABLE'],
    };
  }
  let validated;
  try {
    validated = validateAgentGoalDraft({
      draft: compiled.draft,
      context: {
        organizationId: input.organizationId,
        actorUserId: goal.createdBy,
        now: input.now,
      },
    });
  } catch {
    return {
      ...base,
      kind: 'DENIED',
      goalId: goal.goalId,
      runId: null,
      goalStatus: goal.status,
      admitted: [],
      alreadyPresent: [],
      requiresAuthorization: false,
      requiredAuthorizationAction: null,
      reasonCodes: ['GOAL_VALIDATION_FAILED'],
    };
  }
  const storedDigest = (goal.normalizedGoal as { goalDigest?: unknown } | null)?.goalDigest;
  if (typeof storedDigest === 'string' && storedDigest !== '' && storedDigest !== validated.goalDigest) {
    return {
      ...base,
      kind: 'DENIED',
      goalId: goal.goalId,
      runId: null,
      goalStatus: goal.status,
      admitted: [],
      alreadyPresent: [],
      requiresAuthorization: false,
      requiredAuthorizationAction: null,
      reasonCodes: ['GOAL_DIGEST_MISMATCH'],
    };
  }

  const facts =
    deps.capabilityFacts === undefined
      ? defaultGoalCapabilityFacts()
      : await deps.capabilityFacts({ organizationId: input.organizationId });
  const capabilities = resolveGoalCapabilities({
    organizationId: input.organizationId,
    domains: validated.domains,
    facts,
    now: input.now,
  });
  const plan = planAgentGoal({ goal: validated, capabilities, now: input.now });

  // 非可绕过 gate / 高风险动作：准入一律不放行（不猜测、不越权）。
  const nonAdmissible = findNonAdmissibleActions(plan);
  if (nonAdmissible.length > 0) {
    return {
      ...base,
      kind: 'DENIED',
      goalId: goal.goalId,
      runId: null,
      goalStatus: goal.status,
      admitted: [],
      alreadyPresent: [],
      requiresAuthorization: false,
      requiredAuthorizationAction: null,
      reasonCodes: [
        'NON_ADMISSIBLE_ACTION:' +
          nonAdmissible.map((entry) => entry.action + '(' + entry.gates.join('|') + ')').join(','),
      ],
    };
  }

  const requiredAction = requiredAuthorizationAction(plan);
  if (requiredAction !== null) {
    const authorization = await deps.loadAuthorization({
      organizationId: input.organizationId,
      platformAccountId: input.platformAccountId,
      provider: input.provider,
    });
    if (authorization === null) {
      return {
        ...base,
        kind: 'REQUIRES_AUTHORIZATION',
        goalId: goal.goalId,
        runId: null,
        goalStatus: goal.status,
        admitted: [],
        alreadyPresent: [],
        requiresAuthorization: true,
        requiredAuthorizationAction: requiredAction,
        reasonCodes: ['STANDING_AUTHORIZATION_REQUIRED'],
      };
    }
    const request: StandingAuthorizationRequest = {
      organizationId: input.organizationId,
      platformAccountId: input.platformAccountId,
      provider: input.provider,
      action: requiredAction,
      amountUsd: 0,
      currency: 'USD',
      domain: validated.domains[0] ?? 'PLATFORM',
      jurisdiction: authorization.jurisdiction,
      expectedAuthorizationVersion: authorization.authorizationVersion,
      expectedTermsPolicyVersion: authorization.termsPolicyVersion,
    };
    const evaluation = evaluateStandingAuthorization({
      authorization,
      request,
      now: input.now,
    });
    if (evaluation.decision !== 'SATISFIED') {
      return {
        ...base,
        kind: evaluation.decision === 'DENY' ? 'DENIED' : 'REQUIRES_AUTHORIZATION',
        goalId: goal.goalId,
        runId: null,
        goalStatus: goal.status,
        admitted: [],
        alreadyPresent: [],
        requiresAuthorization: evaluation.decision !== 'DENY',
        requiredAuthorizationAction: requiredAction,
        reasonCodes: [...evaluation.reasonCodes, 'AUTHORIZATION_' + evaluation.decision],
      };
    }
  }

  if (deps.queue === null) {
    return {
      ...base,
      kind: 'DENIED',
      goalId: goal.goalId,
      runId: null,
      goalStatus: goal.status,
      admitted: [],
      alreadyPresent: [],
      requiresAuthorization: false,
      requiredAuthorizationAction: requiredAction,
      reasonCodes: ['TASK_QUEUE_NOT_CONFIGURED'],
    };
  }

  const binding = createGoalRuntimeBinding({ queue: deps.queue });
  const admission = await binding.admit(plan, { now: input.now });
  deps.log?.('agent_goal_admitted', {
    organizationId: input.organizationId,
    goalId: goal.goalId,
    admitted: admission.admitted.length,
    alreadyPresent: admission.alreadyPresent.length,
    externalActionPerformed: false,
  });

  let goalStatus = goal.status;
  if (goal.status === 'PROPOSED') {
    const updated = await updateAgentGoalStatus(prisma, {
      organizationId: input.organizationId,
      goalId: goal.goalId,
      nextStatus: 'ADMITTED',
      now: input.now,
    });
    goalStatus = updated.status;
  }

  return {
    ...base,
    kind: 'ADMITTED',
    goalId: goal.goalId,
    runId: null,
    goalStatus,
    admitted: admission.admitted,
    alreadyPresent: admission.alreadyPresent,
    requiresAuthorization: false,
    requiredAuthorizationAction: requiredAction,
    reasonCodes: ['GOAL_ADMITTED_TO_EXISTING_QUEUE'],
  };
}

/**
 * 既有 ONE SI Runtime 认领/执行之后，把结果投影成 AgentGoalRun（run projection）。
 * 幂等：同一 goal 已有 COMPLETED/RUNNING/BLOCKED 投影时不再新建（绝不产生第二次执行记录）。
 */
export async function recordGoalRunFromRuntime(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    goalId: string;
    outcome: {
      claimed: readonly string[];
      completed: readonly string[];
      blocked: readonly string[];
      /** 既有 runtime 的证据引用（只放引用/摘要，不放判定真值） */
      evidenceRefs?: readonly string[];
    };
    now: Date;
  },
): Promise<{ runId: string; status: AgentGoalRunStatus; created: boolean }> {
  const existing = await listAgentGoalRuns(prisma, {
    organizationId: input.organizationId,
    goalId: input.goalId,
  });
  const live = existing.find((run) => run.status !== 'FAILED' && run.status !== 'CANCELLED');
  if (live !== undefined) {
    return { runId: live.runId, status: live.status, created: false };
  }

  const created = await createAgentGoalRun(prisma, {
    organizationId: input.organizationId,
    goalId: input.goalId,
    now: input.now,
  });
  await updateAgentGoalRunStatus(prisma, {
    organizationId: input.organizationId,
    runId: created.runId,
    nextStatus: 'RUNNING',
    now: input.now,
  });
  const summary = {
    executedBy: 'ONE_SI_RUNTIME',
    admittedTasks: input.outcome.claimed.length,
    completedTasks: input.outcome.completed.length,
    blockedTasks: input.outcome.blocked.length,
    evidenceRefs: [...(input.outcome.evidenceRefs ?? [])],
    /** 客户目标推进只做只读/准备类工作；外部写恒未发生 */
    externalWritePerformed: false,
    admissionOnly: false,
  };
  const nextStatus: AgentGoalRunStatus = input.outcome.blocked.length > 0 ? 'BLOCKED' : 'COMPLETED';
  const finished = await updateAgentGoalRunStatus(prisma, {
    organizationId: input.organizationId,
    runId: created.runId,
    nextStatus,
    summary,
    now: input.now,
  });

  if (nextStatus === 'COMPLETED') {
    const goal = await loadAgentGoal(prisma, {
      organizationId: input.organizationId,
      goalId: input.goalId,
    });
    if (goal !== null && goal.status === 'ADMITTED') {
      await updateAgentGoalStatus(prisma, {
        organizationId: input.organizationId,
        goalId: input.goalId,
        nextStatus: 'RUNNING',
        now: input.now,
      });
    }
  }

  return { runId: finished.runId, status: finished.status, created: true };
}

/** 既有 runtime 任务队列 artifact（JSON 数组：`{id, dedupeKey, priority}`）的准入端口。 */
export function createJsonTaskQueuePort(input: {
  tasksPath: string;
  now?: () => Date;
}): GoalTaskQueuePort {
  const now = input.now ?? (() => new Date());
  return {
    async admit(admissionInput) {
      let queue: Array<{ id: string; dedupeKey: string; priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' }> = [];
      try {
        const raw = await readFile(input.tasksPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          queue = parsed.filter(
            (row): row is { id: string; dedupeKey: string; priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' } =>
              row !== null &&
              typeof row === 'object' &&
              typeof (row as { id?: unknown }).id === 'string' &&
              typeof (row as { dedupeKey?: unknown }).dedupeKey === 'string' &&
              ['P0', 'P1', 'P2', 'P3', 'P4'].includes(String((row as { priority?: unknown }).priority)),
          );
        }
      } catch {
        queue = [];
      }

      const admitted: string[] = [];
      const alreadyPresent: string[] = [];
      const at = now().toISOString();
      for (const task of admissionInput.tasks) {
        if (queue.some((row) => row.dedupeKey === task.dedupeKey)) {
          alreadyPresent.push(task.dedupeKey);
          continue;
        }
        queue.push({
          id: 'goal-' + task.dedupeKey.replace(/[^a-zA-Z0-9]+/g, '-') + '-' + at.slice(0, 10),
          dedupeKey: task.dedupeKey,
          priority: 'P2',
        });
        admitted.push(task.dedupeKey);
      }
      if (admitted.length > 0) {
        await writeFile(input.tasksPath, JSON.stringify(queue, null, 2) + '\n', 'utf8');
      }
      return { admitted, alreadyPresent };
    },
  };
}

export const GOAL_ADMISSION_BOUNDARY = {
  version: GOAL_ADMISSION_VERSION,
  reusesExistingRuntime: true,
  createsRuntime: false,
  createsScheduler: false,
  createsGuard: false,
  createsQueue: false,
  callsRunnerDirectly: false,
  admissionOnly: true,
  externalActionPerformed: false,
  standingAuthorizationCannotSatisfy: [
    'productionGate',
    'platformEnablement',
    'hostApproval',
    'killSwitch',
    'providerCapability',
    'credentialGate',
    'customsPoaGate',
    'regulatoryRestriction',
    'tenantAccountIsolation',
  ],
  forbidden: [
    'admitting a goal while a non-bypassable gate is unproven',
    'admitting external-write or money-movement actions from the goal console',
    'creating a second execution record for the same goal',
    'executing an action from the admission layer',
  ],
} as const;
