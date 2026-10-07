// AGENT EXPERIENCE LAYER / P4 — Goal HTTP 入口（编译 + 校验 + 落库 + 计划预览；**不执行**）
// ---------------------------------------------------------------------------
// 职责：把客户的目标文本变成**服务端可审计**的目标记录与计划预览。
//   * 只做 compile / validate / persist / preview —— **不执行任何动作**；
//   * tenant / actor 一律来自服务端会话（客户端不得自报）；
//   * 未知意图 / 注入 / 越权字段 → 明确错误码（UI 映射为客户语言）；
//   * 计划只给出候选与阻断原因，最终执行权仍在既有 Action Guard + Standing Authorization + HITL。

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import { compileAgentGoal } from './goal-compiler';
import { resolveGoalCapabilities, type GoalCapabilityFacts } from './goal-capability-resolver';
import { listAgentGoals, persistAgentGoal, type AgentGoalView } from './goal-store';
import { planAgentGoal } from './goal-task-planner';
import { validateAgentGoalDraft } from './goal-validator';

export const AGENT_GOAL_PATH = /^\/agent-goals$/;

export interface AgentGoalSession {
  userId: string;
  organizationId: string;
}

export interface AgentGoalRouteDeps {
  prisma: PrismaClient;
  session: AgentGoalSession;
  /** 服务端事实快照（生产闸门 / 写开关 / Kill Switch / POA …）；缺省为最保守取值 */
  capabilityFacts?: (input: { organizationId: string }) => Promise<GoalCapabilityFacts>;
  now?: () => Date;
}

/** 缺省事实：**保守**（生产闸门未满足、写关闭、无功能开关）；调用方可覆盖为真实 server truth */
export function defaultGoalCapabilityFacts(): GoalCapabilityFacts {
  return {
    productionGate: 'NOT_SATISFIED',
    writeEnabled: false,
    tenantEnabled: true,
    featureEnabled: {},
    platformEnablement: {},
    killSwitchActive: false,
    providerCapabilityReady: {},
    customsPoaSatisfied: false,
    regulatoryRestriction: null,
    standingAuthorizationValid: false,
    standingAuthorizationLimitUsd: null,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 64 * 1024) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('BODY_NOT_OBJECT');
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

/** 客户可见的目标记录（跨租户恒不可见；只回传本租户自己的记录） */
export function toCustomerGoalView(view: AgentGoalView) {
  return {
    goalId: view.goalId,
    status: view.status,
    intent: view.rawUserIntent,
    interpretation: view.normalizedGoal,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

/**
 * `GET /agent-goals`  → 本租户目标列表
 * `POST /agent-goals` → { intent } → 编译 + 校验 + 落库 + 计划预览（零执行）
 */
export async function handleAgentGoalRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentGoalRouteDeps,
): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  const now = deps.now?.() ?? new Date();

  if (method === 'GET') {
    const goals = await listAgentGoals(deps.prisma, { organizationId: deps.session.organizationId });
    sendJson(res, 200, { items: goals.map(toCustomerGoalView) });
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'INVALID_INPUT' });
    return true;
  }

  // 只接受 intent；其它字段一律忽略（服务端不信任任何客户端 scope / 权限 / 动作声明）
  const intent = typeof body.intent === 'string' ? body.intent : '';
  const compiled = compileAgentGoal({ text: intent });
  if (!compiled.ok) {
    sendJson(res, 422, { error: compiled.reason });
    return true;
  }

  let goal;
  try {
    goal = validateAgentGoalDraft({
      draft: compiled.draft,
      context: { organizationId: deps.session.organizationId, actorUserId: deps.session.userId, now },
    });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'GOAL_MALFORMED';
    sendJson(res, 422, { error: code });
    return true;
  }

  const persisted = await persistAgentGoal(deps.prisma, {
    organizationId: deps.session.organizationId,
    createdBy: deps.session.userId,
    rawUserIntent: goal.domains.length > 0 ? intent : intent,
    normalizedGoal: {
      goalType: goal.goalType,
      domains: goal.domains,
      timeRange: goal.timeRange,
      executionMode: goal.executionMode,
      approvalThreshold: goal.approvalThresholdPreference,
      policyVersion: goal.policyVersion,
      goalDigest: goal.goalDigest,
    },
    now,
  });

  const facts = deps.capabilityFacts
    ? await deps.capabilityFacts({ organizationId: deps.session.organizationId })
    : defaultGoalCapabilityFacts();
  const capabilities = resolveGoalCapabilities({
    organizationId: deps.session.organizationId,
    domains: goal.domains,
    facts,
    now,
  });
  const plan = planAgentGoal({ goal, capabilities, now });

  sendJson(res, 201, {
    goalId: persisted.goalId,
    recordKind: persisted.kind,
    status: 'PROPOSED',
    interpretation: {
      goalType: goal.goalType,
      domains: goal.domains,
      timeRange: goal.timeRange,
      executionMode: goal.executionMode,
      approvalThreshold: goal.approvalThresholdPreference,
    },
    plan: {
      tasks: plan.tasks.map((task) => ({
        domain: task.domain,
        dedupeKey: task.dedupeKey,
        candidateActions: task.candidateActions,
        autoExecutableActions: task.autoExecutableActions,
        blockedActions: task.blockedActions,
      })),
      executionAuthority: plan.executionPolicy.authority,
      highValueHitl: plan.executionPolicy.highValueHitl,
      standingAuthorizationRequiredForAutoExecution: goal.requiresStandingAuthorizationForAutoExecution,
    },
    /** 恒为 false：本入口只做编译 / 落库 / 预览 */
    executionPerformed: false,
    externalActionPerformed: false,
  });
  return true;
}

export const AGENT_GOAL_HTTP_BOUNDARY = {
  path: '/agent-goals',
  compilesAndPersistsOnly: true,
  executionPerformed: false,
  externalActionPerformed: false,
  tenantFromSessionOnly: true,
  clientScopeAccepted: false,
  acceptsOnlyIntentField: true,
  unknownIntentFailsClosed: true,
  planIsPreviewOnly: true,
  forbidden: [
    'accepting client-declared tenant, scope, limit, actions or permissions',
    'executing an action from the goal endpoint',
    'returning provider submission success fields',
    'bypassing the Action Guard / Standing Authorization / HITL',
  ],
} as const;
