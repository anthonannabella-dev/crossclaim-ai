/**
 * C-0008-B1 — internal workflow HTTP endpoints (human opportunity review).
 * ---------------------------------------------------------------
 *   POST /opportunities/:id/qualify   → DETECTED → QUALIFIED
 *   POST /opportunities/:id/reject    → DETECTED → REJECTED (body.reason required)
 *
 * Every request is resolved through the same three-step session check as the
 * C-0008-A endpoints (cookie → Session tokenHash → Membership). The review
 * itself is delegated to services/workflow, so the approved permission matrix,
 * the state machine and the same-transaction AuditLog (actorUserId) are the
 * single implementation of this transition.
 *
 * The endpoints stay internal to this machine; no public exposure in Gate 6.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import { parseCookies, SESSION_COOKIE } from '../auth/http-routes';
import { resolveSession, type SessionContext, type SessionDeps } from '../auth/session';
import {
  createManagedConnection,
  listConnections,
  rotateConnectionCredentialRef,
  setConnectionStatus,
} from './connection-management';
import { REJECT_REASONS, WorkflowError, reviewOpportunity } from './opportunity-review';
import { ForbiddenError } from './permissions';

const MAX_BODY_BYTES = 16 * 1024;
const REVIEW_PATH = /^\/opportunities\/([^/]+)\/(qualify|reject)$/;
const CONNECTION_PATH = /^\/connections(?:\/([^/]+)\/(status|credential-ref))?$/;

/** 请求体层面的错误（与领域状态无关），统一映射为 400。 */
class HttpBodyError extends Error {
  readonly code = 'INVALID_BODY';

  constructor(message: string) {
    super(message);
    this.name = 'HttpBodyError';
  }
}

export interface WorkflowRouteDeps {
  prisma: PrismaClient;
  session: SessionDeps;
  /** Platforms of the adapters registered in this deployment (API connections only). */
  registeredPlatforms?: readonly string[];
  now?: () => Date;
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpBodyError('请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new HttpBodyError('请求体不是合法 JSON');
  }
}

function statusFor(error: unknown): { code: number; error: string } {
  if (error instanceof HttpBodyError) return { code: 400, error: error.code };
  if (error instanceof ForbiddenError) return { code: 403, error: error.code };
  if (error instanceof WorkflowError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return { code: 404, error: error.code };
      case 'ILLEGAL_TRANSITION':
      case 'DUPLICATE_CONNECTION':
        return { code: 409, error: error.code };
      case 'FORBIDDEN':
        return { code: 403, error: error.code };
      case 'REASON_REQUIRED':
      case 'INVALID_REASON':
      case 'INVALID_INPUT':
      case 'SECRET_NOT_ACCEPTED':
      case 'PLATFORM_NOT_REGISTERED':
        return { code: 400, error: error.code };
      default:
        return { code: 400, error: 'INVALID_REQUEST' };
    }
  }
  return { code: 500, error: 'WORKFLOW_ERROR' };
}

function requireString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export async function handleWorkflowRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WorkflowRouteDeps,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  const review = REVIEW_PATH.exec(path);
  const connection = CONNECTION_PATH.exec(path);
  if (!review && !connection) return false;

  const method = req.method ?? 'GET';
  const allowed = connection && !connection[2] ? ['GET', 'POST'] : ['POST'];
  if (!allowed.includes(method)) {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const context: SessionContext | null = token ? await resolveSession(token, deps.session) : null;
  if (!context) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return true;
  }

  const actor = {
    organizationId: context.organizationId,
    actorUserId: context.userId,
    role: context.role,
  };

  try {
    if (connection) {
      const connectionId = connection[1];
      const sub = connection[2];

      if (!connectionId) {
        if (method === 'GET') {
          sendJson(res, 200, { items: await listConnections(deps.prisma, actor) });
          return true;
        }
        const body = await readJsonBody(req);
        const created = await createManagedConnection(
          deps.prisma,
          {
            ...actor,
            label: body.label,
            kind: body.kind,
            domain: body.domain,
            channel: body.channel,
            platform: body.platform,
            credentialRef: body.credentialRef,
          },
          { ...(deps.registeredPlatforms ? { registeredPlatforms: deps.registeredPlatforms } : {}), ...(deps.now ? { now: deps.now } : {}) },
        );
        sendJson(res, 201, created);
        return true;
      }

      const body = await readJsonBody(req);
      if (sub === 'status') {
        const result = await setConnectionStatus(
          deps.prisma,
          { ...actor, connectionId, to: body.to, reason: body.reason },
          { ...(deps.now ? { now: deps.now } : {}) },
        );
        sendJson(res, 200, result);
        return true;
      }

      const result = await rotateConnectionCredentialRef(
        deps.prisma,
        {
          ...actor,
          connectionId,
          credentialRef: body.credentialRef === undefined ? null : body.credentialRef,
        },
        { ...(deps.now ? { now: deps.now } : {}) },
      );
      sendJson(res, 200, result);
      return true;
    }

    const opportunityId = review?.[1] ?? '';
    const decision = review?.[2] === 'reject' ? 'REJECT' : 'QUALIFY';
    let reason: string | undefined;
    if (decision === 'REJECT') {
      const body = await readJsonBody(req);
      reason = requireString(body, 'reason');
    }

    const result = await reviewOpportunity(
      deps.prisma,
      {
        ...actor,
        opportunityId,
        decision,
        ...(reason !== undefined ? { reason } : {}),
      },
      deps.now,
    );

    sendJson(res, 200, {
      opportunityId: result.opportunityId,
      from: result.from,
      to: result.to,
      reason: result.reason,
    });
    return true;
  } catch (error) {
    const { code, error: name } = statusFor(error);
    sendJson(res, code, {
      error: name,
      ...(code === 400 && review?.[2] === 'reject' ? { allowedReasons: [...REJECT_REASONS] } : {}),
    });
    return true;
  }
}
