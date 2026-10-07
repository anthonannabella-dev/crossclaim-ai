// AGENT EXPERIENCE LAYER / P3 — 最小 Goal 持久化（Customer Intent + Execution Projection）
// ---------------------------------------------------------------------------
// 定位（HOST P3 明文）：
//   * `AgentGoal` = 客户意图记录；`AgentGoalRun` = 一次执行投影；
//   * 二者**只是** intent + projection —— **不是** Opportunity / Case / Claim / Evidence /
//     Money / Settlement 的 SSOT，也不复制任何业务事实；
//   * Run 只引用既有 task / opportunity / case lineage（summary 里放引用与业务语言摘要，
//     不放判定真值）；
//   * 不存凭据（复用 Experience Memory 的禁用内容检查）；
//   * 不授予任何权限、不执行任何外部动作、不构成第二事实源。

import { Prisma, type PrismaClient } from '@prisma/client';

import { digestOf } from '../config-execution-durability/digests';
import { assertNoForbiddenExperienceContent } from '../experience-memory/experience-memory';

export const AGENT_GOAL_STORE_VERSION = 'agent-goal-store/v1';

export const AGENT_GOAL_STATUSES = [
  'PROPOSED',
  'ADMITTED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type AgentGoalStatus = (typeof AGENT_GOAL_STATUSES)[number];

export const AGENT_GOAL_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
] as const;
export type AgentGoalRunStatus = (typeof AGENT_GOAL_RUN_STATUSES)[number];

/** goal 生命周期（**不是** Recovery 状态机；Recovery 状态机仍归既有 canonical/case 模型） */
const GOAL_TRANSITIONS: Record<AgentGoalStatus, readonly AgentGoalStatus[]> = {
  PROPOSED: ['ADMITTED', 'CANCELLED'],
  ADMITTED: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

const RUN_TRANSITIONS: Record<AgentGoalRunStatus, readonly AgentGoalRunStatus[]> = {
  QUEUED: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  BLOCKED: [],
  FAILED: [],
  CANCELLED: [],
};

export const AGENT_GOAL_TERMINAL_STATUSES: readonly AgentGoalStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
export const AGENT_GOAL_RUN_TERMINAL_STATUSES: readonly AgentGoalRunStatus[] = [
  'COMPLETED',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
];

export const AGENT_GOAL_MAX_INTENT_LENGTH = 600;

export type AgentGoalStoreErrorCode =
  | 'AGENT_GOAL_STORE_NOT_FOUND'
  | 'AGENT_GOAL_STORE_MALFORMED'
  | 'AGENT_GOAL_STORE_CONFLICT'
  | 'AGENT_GOAL_STORE_INVALID_TRANSITION'
  | 'AGENT_GOAL_STORE_FORBIDDEN_CONTENT';

export class AgentGoalStoreError extends Error {
  readonly code: AgentGoalStoreErrorCode;

  constructor(code: AgentGoalStoreErrorCode, message: string) {
    super(message);
    this.name = 'AgentGoalStoreError';
    this.code = code;
  }
}

export interface AgentGoalView {
  readonly goalId: string;
  readonly organizationId: string;
  readonly createdBy: string;
  readonly rawUserIntent: string;
  readonly normalizedGoal: unknown;
  readonly status: AgentGoalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentGoalRunView {
  readonly runId: string;
  readonly organizationId: string;
  readonly goalId: string;
  readonly status: AgentGoalRunStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly summary: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentGoalRow {
  id: string;
  organizationId: string;
  createdBy: string;
  rawUserIntent: string;
  normalizedGoal: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentGoalRunRow {
  id: string;
  organizationId: string;
  goalId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  summary: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function assertStatus(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new AgentGoalStoreError('AGENT_GOAL_STORE_MALFORMED', `${field} 取值非法：${value}`);
  }
}

export function toAgentGoalView(row: AgentGoalRow): AgentGoalView {
  assertStatus(row.status, AGENT_GOAL_STATUSES, 'AgentGoal.status');
  return {
    goalId: row.id,
    organizationId: row.organizationId,
    createdBy: row.createdBy,
    rawUserIntent: row.rawUserIntent,
    normalizedGoal: row.normalizedGoal,
    status: row.status as AgentGoalStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAgentGoalRunView(row: AgentGoalRunRow): AgentGoalRunView {
  assertStatus(row.status, AGENT_GOAL_RUN_STATUSES, 'AgentGoalRun.status');
  return {
    runId: row.id,
    organizationId: row.organizationId,
    goalId: row.goalId,
    status: row.status as AgentGoalRunStatus,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 同一 (org, 原文, 规范化目标) → 同一 goalId（重复提交幂等，不产生第二条意图记录） */
export function computeAgentGoalId(input: {
  organizationId: string;
  rawUserIntent: string;
  normalizedGoal: unknown;
}): string {
  return (
    'agentgoal-' +
    digestOf({
      organizationId: input.organizationId,
      rawUserIntent: input.rawUserIntent.trim(),
      normalizedGoal: input.normalizedGoal,
    }).slice(0, 24)
  );
}

function assertGoalInput(input: {
  organizationId: string;
  createdBy: string;
  rawUserIntent: string;
  normalizedGoal: unknown;
}): string {
  if (input.organizationId.trim() === '' || input.createdBy.trim() === '') {
    throw new AgentGoalStoreError('AGENT_GOAL_STORE_MALFORMED', 'AgentGoal 必须带 organizationId 与 createdBy。');
  }
  const intent = input.rawUserIntent.trim();
  if (intent === '' || intent.length > AGENT_GOAL_MAX_INTENT_LENGTH) {
    throw new AgentGoalStoreError(
      'AGENT_GOAL_STORE_MALFORMED',
      `rawUserIntent 长度必须为 1..${AGENT_GOAL_MAX_INTENT_LENGTH}。`,
    );
  }
  if (typeof input.normalizedGoal !== 'object' || input.normalizedGoal === null || Array.isArray(input.normalizedGoal)) {
    throw new AgentGoalStoreError('AGENT_GOAL_STORE_MALFORMED', 'normalizedGoal 必须是对象。');
  }
  try {
    assertNoForbiddenExperienceContent(intent + '|' + JSON.stringify(input.normalizedGoal));
  } catch {
    throw new AgentGoalStoreError(
      'AGENT_GOAL_STORE_FORBIDDEN_CONTENT',
      'AgentGoal 禁止保存凭据类内容（token / secret / password / cookie / raw credential）。',
    );
  }
  return intent;
}

export interface PersistAgentGoalResult {
  readonly kind: 'CREATED' | 'REUSED';
  readonly goalId: string;
}

/** 落库：server-derived（tenant / actor 由调用方以服务端上下文传入；客户端不得自报） */
export async function persistAgentGoal(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    createdBy: string;
    rawUserIntent: string;
    normalizedGoal: unknown;
    now: Date;
  },
): Promise<PersistAgentGoalResult> {
  const intent = assertGoalInput(input);
  const goalId = computeAgentGoalId({
    organizationId: input.organizationId,
    rawUserIntent: intent,
    normalizedGoal: input.normalizedGoal,
  });
  const existing = await prisma.agentGoal.findFirst({
    where: { organizationId: input.organizationId, id: goalId },
  });
  if (existing !== null) {
    const sameIntent = existing.rawUserIntent === intent;
    const sameGoal = digestOf(existing.normalizedGoal) === digestOf(input.normalizedGoal);
    if (sameIntent && sameGoal) return { kind: 'REUSED', goalId };
    throw new AgentGoalStoreError('AGENT_GOAL_STORE_CONFLICT', '同一 goalId 的内容不一致（禁止静默改写意图）。');
  }
  try {
    await prisma.agentGoal.create({
      data: {
        id: goalId,
        organizationId: input.organizationId,
        createdBy: input.createdBy,
        rawUserIntent: intent,
        normalizedGoal: input.normalizedGoal as Prisma.InputJsonValue,
        status: 'PROPOSED',
        createdAt: input.now,
        updatedAt: input.now,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    return { kind: 'REUSED', goalId };
  }
  return { kind: 'CREATED', goalId };
}

export async function loadAgentGoal(
  prisma: PrismaClient,
  input: { organizationId: string; goalId: string },
): Promise<AgentGoalView | null> {
  const row = await prisma.agentGoal.findFirst({
    where: { organizationId: input.organizationId, id: input.goalId },
  });
  return row === null ? null : toAgentGoalView(row);
}

export async function listAgentGoals(
  prisma: PrismaClient,
  input: { organizationId: string; status?: AgentGoalStatus | null; limit?: number },
): Promise<AgentGoalView[]> {
  const rows = await prisma.agentGoal.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.status === undefined || input.status === null ? {} : { status: input.status }),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
  return rows.map((row) => toAgentGoalView(row));
}

/** 状态迁移（fail-closed：非法迁移直接拒绝，终态不可再变） */
export async function updateAgentGoalStatus(
  prisma: PrismaClient,
  input: { organizationId: string; goalId: string; nextStatus: AgentGoalStatus; now: Date },
): Promise<AgentGoalView> {
  const current = await prisma.agentGoal.findFirst({
    where: { organizationId: input.organizationId, id: input.goalId },
  });
  if (current === null) {
    throw new AgentGoalStoreError('AGENT_GOAL_STORE_NOT_FOUND', 'AgentGoal 不存在（或不属于该租户）。');
  }
  assertStatus(current.status, AGENT_GOAL_STATUSES, 'AgentGoal.status');
  assertStatus(input.nextStatus, AGENT_GOAL_STATUSES, 'nextStatus');
  if (!GOAL_TRANSITIONS[current.status as AgentGoalStatus].includes(input.nextStatus)) {
    throw new AgentGoalStoreError(
      'AGENT_GOAL_STORE_INVALID_TRANSITION',
      `非法状态迁移：${current.status} → ${input.nextStatus}`,
    );
  }
  const updated = await prisma.agentGoal.update({
    where: { id: input.goalId },
    data: { status: input.nextStatus, updatedAt: input.now },
  });
  return toAgentGoalView(updated);
}

export async function createAgentGoalRun(
  prisma: PrismaClient,
  input: { organizationId: string; goalId: string; now: Date },
): Promise<AgentGoalRunView> {
  const goal = await prisma.agentGoal.findFirst({
    where: { organizationId: input.organizationId, id: input.goalId },
    select: { id: true },
  });
  if (goal === null) {
    throw new AgentGoalStoreError('AGENT_GOAL_STORE_NOT_FOUND', 'AgentGoal 不存在（或不属于该租户）。');
  }
  const created = await prisma.agentGoalRun.create({
    data: {
      organizationId: input.organizationId,
      goalId: input.goalId,
      status: 'QUEUED',
      startedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
  return toAgentGoalRunView(created);
}

export async function updateAgentGoalRunStatus(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    runId: string;
    nextStatus: AgentGoalRunStatus;
    summary?: unknown;
    now: Date;
  },
): Promise<AgentGoalRunView> {
  const current = await prisma.agentGoalRun.findFirst({
    where: { organizationId: input.organizationId, id: input.runId },
  });
  if (current === null) {
    throw new AgentGoalStoreError('AGENT_GOAL_STORE_NOT_FOUND', 'AgentGoalRun 不存在（或不属于该租户）。');
  }
  assertStatus(current.status, AGENT_GOAL_RUN_STATUSES, 'AgentGoalRun.status');
  assertStatus(input.nextStatus, AGENT_GOAL_RUN_STATUSES, 'nextStatus');
  if (!RUN_TRANSITIONS[current.status as AgentGoalRunStatus].includes(input.nextStatus)) {
    throw new AgentGoalStoreError(
      'AGENT_GOAL_STORE_INVALID_TRANSITION',
      `非法 Run 状态迁移：${current.status} → ${input.nextStatus}`,
    );
  }
  const terminal = AGENT_GOAL_RUN_TERMINAL_STATUSES.includes(input.nextStatus);
  const updated = await prisma.agentGoalRun.update({
    where: { id: input.runId },
    data: {
      status: input.nextStatus,
      updatedAt: input.now,
      ...(terminal ? { completedAt: input.now } : {}),
      ...(input.summary === undefined ? {} : { summary: input.summary as Prisma.InputJsonValue }),
    },
  });
  return toAgentGoalRunView(updated);
}

export async function listAgentGoalRuns(
  prisma: PrismaClient,
  input: { organizationId: string; goalId: string },
): Promise<AgentGoalRunView[]> {
  const rows = await prisma.agentGoalRun.findMany({
    where: { organizationId: input.organizationId, goalId: input.goalId },
    orderBy: { startedAt: 'desc' },
  });
  return rows.map((row) => toAgentGoalRunView(row));
}

/** 边界断言：goal / run 不得被当成业务事实真值使用 */
export function assertGoalRecordIsNotBusinessTruth(record: {
  usedAsOpportunitySsot?: boolean;
  usedAsCaseSsot?: boolean;
  usedAsMoneySsot?: boolean;
}): void {
  if (record.usedAsOpportunitySsot === true || record.usedAsCaseSsot === true || record.usedAsMoneySsot === true) {
    throw new AgentGoalStoreError(
      'AGENT_GOAL_STORE_MALFORMED',
      'AgentGoal / AgentGoalRun 只是客户意图与执行投影，不得作为业务事实 SSOT。',
    );
  }
}

export const AGENT_GOAL_PERSISTENCE_BOUNDARY = {
  version: AGENT_GOAL_STORE_VERSION,
  isCustomerIntent: true,
  isExecutionProjection: true,
  isOpportunitySsot: false,
  isCaseSsot: false,
  isClaimSsot: false,
  isEvidenceSsot: false,
  isMoneySsot: false,
  isSettlementSsot: false,
  isRecoveryStateMachine: false,
  createsSecondFactSource: false,
  storesCredentials: false,
  grantsPermissions: false,
  performsExternalAction: false,
  goalTransitions: GOAL_TRANSITIONS,
  runTransitions: RUN_TRANSITIONS,
  forbidden: [
    'treating a goal or run as Opportunity / Case / Claim / Evidence / Money / Settlement truth',
    'storing credentials, cookies or raw provider payloads in the intent text',
    'deriving eligibility, recoverable amount or success-fee from a goal record',
    'granting any permission or external write capability from a goal record',
    'rewriting goal identity in place instead of creating a new goal / run',
  ],
} as const;
