// AGENT EXPERIENCE LAYER / CUSTOMER-UX FINAL2 — Goal Admission HTTP 入口
// ---------------------------------------------------------------------------
// `POST /agent-goals/:id/admit`
//   * tenant / actor 只来自会话（客户端自报一律忽略）；
//   * 作用域（platformAccountId / provider）服务端校验属于本租户，否则 404（不泄露存在性）；
//   * 只做「并入既有队列 + 目标准入」，**不执行**任何外部动作（externalActionPerformed=false）。

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import {
  GOAL_ADMISSION_VERSION,
  admitAgentGoal,
  type GoalAdmissionDeps,
} from './goal-admission';

export const AGENT_GOAL_ADMISSION_PATH = /^\/agent-goals\/[^/]+\/admit$/;

const MAX_BODY_BYTES = 16 * 1024;

export interface AgentGoalAdmissionHttpDeps {
  prisma: PrismaClient;
  session: { userId: string; organizationId: string };
  admission: GoalAdmissionDeps;
  now?: () => Date;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return {};
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

export async function handleAgentGoalAdmissionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentGoalAdmissionHttpDeps,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (!AGENT_GOAL_ADMISSION_PATH.test(path)) return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const goalId = path.split('/')[2] ?? '';
  const body = await readJsonBody(req);
  const platformAccountId = typeof body.platformAccountId === 'string' ? body.platformAccountId.trim() : '';
  // FINAL3：provider 是 server-owned 事实（取自 PlatformAccount.platform）；客户端字段只作断言
  const clientProvider = typeof body.provider === 'string' ? body.provider.trim().toUpperCase() : '';
  if (goalId === '' || platformAccountId === '') {
    sendJson(res, 400, { error: 'INVALID_INPUT' });
    return true;
  }

  // 作用域血缘：账户必须属于本租户（跨租户 404，不泄露存在性）
  const account = await deps.prisma.platformAccount.findFirst({
    where: { organizationId: deps.session.organizationId, id: platformAccountId },
    select: { id: true },
  });
  if (account === null) {
    sendJson(res, 404, { error: 'NOT_FOUND' });
    return true;
  }

  const now = deps.now?.() ?? new Date();
  const result = await admitAgentGoal(
    deps.prisma,
    {
      organizationId: deps.session.organizationId,
      goalId,
      platformAccountId,
      ...(clientProvider === '' ? {} : { provider: clientProvider }),
      now,
    },
    deps.admission,
  );

  const status =
    result.kind === 'ADMITTED' || result.kind === 'ALREADY_ADMITTED'
      ? 200
      : result.kind === 'REQUIRES_AUTHORIZATION'
        ? 409
        : result.kind === 'DENIED'
          ? 403
          : 404;
  sendJson(res, status, result);
  return true;
}

export const AGENT_GOAL_ADMISSION_HTTP_BOUNDARY = {
  version: GOAL_ADMISSION_VERSION + '+http',
  path: '/agent-goals/:id/admit',
  tenantFromSessionOnly: true,
  accountMustBelongToTenant: true,
  admissionOnly: true,
  executionPerformed: false,
  externalActionPerformed: false,
  requiresExistingSession: true,
} as const;
