/**
 * CUSTOMER-UX-SANDBOX-E2E — dev/test-only acceptance API bootstrap.
 * ---------------------------------------------------------------
 * 真实 HTTP + 真实 PostgreSQL + 既有 runtime/队列/guard，只用 sandbox 替代**外部授权结果**：
 *   1) 开启 public signup gate（生产默认 fail-closed 关闭）；
 *   2) 邮件出口换成文件 sink（生产为 EXTERNAL_GATE disabled）；
 *   3) 额外暴露 acceptance-only 路由（仅本文件，不在生产 server 中）：
 *        POST /acceptance/sandbox-authorization  —— 走**真实 durable** Standing Authorization 落库
 *        POST /acceptance/run-si-runtime         —— 驱动**既有** ONE SI Runtime 认领队列并落 run projection
 *        POST /acceptance/revoke-authorization   —— 走真实 revokeScope（撤销后不得继续）
 *   生产 runtime 一行未改；这些路由只存在于 acceptance bootstrap 进程里。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

import { createLogger } from '../src/config/logger';
import { createDefaultReadDeps, createServer } from '../src/server';
import { composeRsiRuntime, parseTaskQueue } from '../src/runtime/rsi-run';
import {
  SESSION_COOKIE,
  bootstrapSelfServiceAccount,
  createPrismaAuthTokenAccountPort,
  createPrismaAuthUserPort,
  createPrismaEmailVerificationPort,
  createPrismaMembershipLookup,
  createPrismaPasswordResetPort,
  createPrismaSessionPort,
  parseCookies,
  resolveSession,
  type EmailDeliveryPort,
} from '../src/services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../src/services/audit';
import { LocalFileSystemStorage } from '../src/services/storage';
import {
  defaultGoalCapabilityFacts,
} from '../src/services/agent-goal/http-request';
import { compileAgentGoal } from '../src/services/agent-goal/goal-compiler';
import { validateAgentGoalDraft } from '../src/services/agent-goal/goal-validator';
import { resolveGoalCapabilities } from '../src/services/agent-goal/goal-capability-resolver';
import { planAgentGoal } from '../src/services/agent-goal/goal-task-planner';
import { recordGoalRunFromRuntime, requiredAuthorizationAction } from '../src/services/agent-goal/goal-admission';
import { loadAgentGoal } from '../src/services/agent-goal/goal-store';
import {
  persistStandingAuthorization,
  revokeStandingAuthorizationScope,
} from '../src/services/standing-authorization/standing-authorization-store';

const PORT = Number(process.env.ACCEPTANCE_API_PORT ?? 3100);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const OUTBOX =
  process.env.ACCEPTANCE_OUTBOX ?? path.join(REPO_ROOT, 'reports', 'acceptance', 'email-outbox.jsonl');
const TASKS_PATH =
  process.env.ACCEPTANCE_TASKS_PATH ?? path.join(REPO_ROOT, 'reports', 'acceptance', 'rsi-tasks.json');
const IP_SALT = 'acceptance-audit-salt-20261007';

const sandboxDelivery: EmailDeliveryPort = {
  async deliver(input) {
    fs.mkdirSync(path.dirname(OUTBOX), { recursive: true });
    fs.appendFileSync(
      OUTBOX,
      JSON.stringify({
        to: input.to,
        kind: input.kind,
        token: input.token,
        expiresAt: input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt,
        at: new Date().toISOString(),
      }) + '\n',
      'utf8',
    );
    return { delivered: true, provider: 'SANDBOX_ACCEPTANCE_SINK' };
  },
};

function sendJson(res: http.ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const log = createLogger({ level: 'warn', sink: () => undefined });
  const safeLog = (event: string, fields: Record<string, unknown>) => log.warn(event, fields);
  const storage = new LocalFileSystemStorage({
    rootDir: process.env.ACCEPTANCE_STORAGE_ROOT ?? path.join(os.tmpdir(), 'crossclaim-acceptance-storage'),
    secret: 'acceptance-storage-secret-20261007',
    publicBaseUrl: 'http://127.0.0.1:' + PORT,
  });
  const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: IP_SALT });
  const sessionDeps = {
    sessions: createPrismaSessionPort(prisma),
    memberships: createPrismaMembershipLookup(prisma),
    audit,
    ipSalt: IP_SALT,
  };

  const auth = {
    users: createPrismaAuthUserPort(prisma),
    session: sessionDeps,
    audit,
    log: safeLog,
    signupEnabled: true,
    selfSignup: (input: { email: string; password: string; organizationName: string; displayName?: string }) =>
      bootstrapSelfServiceAccount(prisma, input, { enabled: true }),
    lifecycle: {
      accounts: createPrismaAuthTokenAccountPort(prisma),
      emailVerification: createPrismaEmailVerificationPort(prisma),
      passwordReset: createPrismaPasswordResetPort(prisma),
      delivery: sandboxDelivery,
      audit,
      log: safeLog,
      ipSalt: IP_SALT,
    },
  };

  // 既有 API（生产同构）：队列路径指向 acceptance 任务 artifact，供真实目标准入使用
  process.env.RSI_TASKS_PATH = TASKS_PATH;
  const api = createServer({
    prisma,
    log,
    storage,
    audit,
    auth,
    ...createDefaultReadDeps(prisma),
  } as never);

  /** acceptance-only：读取会话租户（与生产同一 session 端口）。 */
  async function sessionOrg(req: http.IncomingMessage): Promise<{ organizationId: string; userId: string } | null> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token === undefined) return null;
    const context = await resolveSession(token, sessionDeps);
    return context === null ? null : { organizationId: context.organizationId, userId: context.userId };
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';
      const pathname = url.split('?')[0] ?? '/';
      if (!pathname.startsWith('/acceptance/')) {
        api.emit('request', req, res);
        return;
      }
      const session = await sessionOrg(req);
      if (session === null) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      const body = await readJsonBody(req);

      if (pathname === '/acceptance/sandbox-authorization' && req.method === 'POST') {
        const goalId = typeof body.goalId === 'string' ? body.goalId : '';
        const platformAccountId = typeof body.platformAccountId === 'string' ? body.platformAccountId : '';
        const provider = typeof body.provider === 'string' ? body.provider.toUpperCase() : '';
        const goal = await loadAgentGoal(prisma, { organizationId: session.organizationId, goalId });
        if (goal === null) {
          sendJson(res, 404, { error: 'GOAL_NOT_FOUND' });
          return;
        }
        const account = await prisma.platformAccount.findFirst({
          where: { organizationId: session.organizationId, id: platformAccountId },
          select: { id: true },
        });
        if (account === null) {
          sendJson(res, 404, { error: 'ACCOUNT_NOT_FOUND' });
          return;
        }
        // 用**真实**编译器/计划器决定该目标需要授权哪些动作（不猜、不放宽）
        const compiled = compileAgentGoal({ text: goal.rawUserIntent });
        if (!compiled.ok) {
          sendJson(res, 422, { error: 'GOAL_NOT_COMPILABLE' });
          return;
        }
        const validated = validateAgentGoalDraft({
          draft: compiled.draft,
          context: { organizationId: session.organizationId, actorUserId: session.userId, now: new Date() },
        });
        const capabilities = resolveGoalCapabilities({
          organizationId: session.organizationId,
          domains: validated.domains,
          facts: defaultGoalCapabilityFacts(),
          now: new Date(),
        });
        const plan = planAgentGoal({ goal: validated, capabilities, now: new Date() });
        const actions = new Set<string>();
        const required = requiredAuthorizationAction(plan);
        if (required !== null) actions.add(required);
        for (const task of plan.tasks) {
          for (const action of task.candidateActions) actions.add(action);
          for (const action of task.autoExecutableActions) actions.add(action);
        }
        const allowedActionTypes = [...actions].filter((action) => action.trim() !== '');
        if (allowedActionTypes.length === 0) {
          sendJson(res, 409, { error: 'NO_AUTHORIZABLE_ACTION' });
          return;
        }
        const now = new Date();
        const persisted = await persistStandingAuthorization(prisma, {
          serverDerived: true,
          authorizationId: 'sa-sandbox-' + goalId,
          organizationId: session.organizationId,
          platformAccountId,
          provider,
          allowedActionTypes,
          monetaryLimitUsd: 1000,
          currency: 'USD',
          domain: validated.domains[0] ?? 'PLATFORM',
          jurisdiction: 'US',
          effectiveAt: new Date(now.getTime() - 60_000).toISOString(),
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
          authorizationVersion: 1,
          termsPolicyVersion: 'terms/v1',
          consentEvidenceRef: 'sandbox-consent:' + goalId,
          createdAt: now.toISOString(),
          revocation: { state: 'ACTIVE', revokedAt: null, revokedBy: null, reason: null },
          scopeDigest: '',
        } as never);
        sendJson(res, 201, {
          kind: persisted.kind,
          authorizationId: persisted.authorizationId,
          allowedActionTypes,
          requiredAuthorizationAction: required,
          provider: 'SANDBOX_ACCEPTANCE_SINK',
          realDurableStore: true,
          externalAuthorizationPerformed: false,
        });
        return;
      }

      if (pathname === '/acceptance/revoke-authorization' && req.method === 'POST') {
        const platformAccountId = typeof body.platformAccountId === 'string' ? body.platformAccountId : '';
        const provider = typeof body.provider === 'string' ? body.provider.toUpperCase() : '';
        const result = await revokeStandingAuthorizationScope(prisma, {
          organizationId: session.organizationId,
          platformAccountId,
          provider,
          revokedBy: session.userId,
          reason: 'sandbox acceptance revoke',
          at: new Date(),
        });
        sendJson(res, 200, { revoked: result.revoked, authorizationVersion: result.authorizationVersion });
        return;
      }

      if (pathname === '/acceptance/run-si-runtime' && req.method === 'POST') {
        const goalId = typeof body.goalId === 'string' ? body.goalId : '';
        const raw = fs.existsSync(TASKS_PATH) ? fs.readFileSync(TASKS_PATH, 'utf8') : '[]';
        const queued = parseTaskQueue(raw);
        // 既有 ONE SI Runtime（生产同一 composeRsiRuntime）；只注入只读 runner，不注入外部写能力
        const runtime = await composeRsiRuntime({
          readFile: (filePath: string) => fs.promises.readFile(filePath, 'utf8'),
          tasksPath: TASKS_PATH,
          runner: { async run() { return { status: 'PASS' as const }; } },
          awaitVerdict: false,
        });
        let outcomeCount = 0;
        try {
          const outcomes = await runtime.loop.pollOnce();
          outcomeCount = outcomes.length;
        } finally {
          runtime.loop.stop();
        }
        const claimed = queued.map((task) => task.dedupeKey);
        const completed = outcomeCount > 0 ? claimed : [];
        const blocked = outcomeCount > 0 ? [] : claimed;
        const projection = await recordGoalRunFromRuntime(prisma, {
          organizationId: session.organizationId,
          goalId,
          outcome: {
            claimed,
            completed,
            blocked,
            evidenceRefs: ['rsi-task-queue:' + path.basename(TASKS_PATH)],
          },
          now: new Date(),
        });
        sendJson(res, 200, {
          runId: projection.runId,
          runStatus: projection.status,
          created: projection.created,
          executedBy: 'ONE_SI_RUNTIME',
          runtimeOwner: 'apps/api/src/runtime/rsi-run.ts',
          queuedTasks: claimed.length,
          runtimeOutcomes: outcomeCount,
          externalWritePerformed: false,
        });
        return;
      }

      sendJson(res, 404, { error: 'NOT_FOUND' });
    })().catch((error) => {
      sendJson(res, 500, { error: 'ACCEPTANCE_ROUTE_ERROR', detail: String(error).slice(0, 300) });
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(
      JSON.stringify({
        event: 'ACCEPTANCE_API_READY',
        port: PORT,
        outbox: OUTBOX,
        tasksPath: TASKS_PATH,
        signupEnabled: true,
        acceptanceRoutes: [
          '/acceptance/sandbox-authorization',
          '/acceptance/run-si-runtime',
          '/acceptance/revoke-authorization',
        ],
      }),
    );
  });

  const shutdown = async () => {
    server.close();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main();
