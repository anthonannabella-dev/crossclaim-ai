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
import { REJECT_REASONS, WorkflowError, reviewOpportunity } from './opportunity-review';
import { ForbiddenError } from './permissions';

const MAX_BODY_BYTES = 16 * 1024;
const REVIEW_PATH = /^\/opportunities\/([^/]+)\/(qualify|reject)$/;

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
        return { code: 409, error: error.code };
      case 'FORBIDDEN':
        return { code: 403, error: error.code };
      case 'REASON_REQUIRED':
      case 'INVALID_REASON':
        return { code: 400, error: error.code };
      default:
        return { code: 400, error: 'INVALID_REQUEST' };
    }
  }
  return { code: 500, error: 'WORKFLOW_ERROR' };
}

export async function handleWorkflowRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WorkflowRouteDeps,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  const match = REVIEW_PATH.exec(path);
  if (!match) return false;

  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const context: SessionContext | null = token ? await resolveSession(token, deps.session) : null;
  if (!context) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return true;
  }

  const opportunityId = match[1] ?? '';
  const decision = match[2] === 'reject' ? 'REJECT' : 'QUALIFY';
  try {
    let reason: string | undefined;
    if (decision === 'REJECT') {
      const body = await readJsonBody(req);
      reason = typeof body.reason === 'string' ? body.reason : undefined;
    }

    const result = await reviewOpportunity(
      deps.prisma,
      {
        organizationId: context.organizationId,
        opportunityId,
        actorUserId: context.userId,
        role: context.role,
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
      ...(code === 400 && decision === 'REJECT' ? { allowedReasons: [...REJECT_REASONS] } : {}),
    });
    return true;
  }
}
