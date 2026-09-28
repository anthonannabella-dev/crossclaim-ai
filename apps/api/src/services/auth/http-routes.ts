/**
 * C-0008-A — internal auth HTTP endpoints.
 * ---------------------------------------------------------------
 * The API deliberately stays framework-free (Node http). These routes are the
 * minimum the web app needs, and they are **internal only** (no public
 * deployment in this gate):
 *
 *   POST /auth/login   → session cookie (HttpOnly, SameSite=Lax)
 *   POST /auth/logout  → revoke + clear cookie
 *   GET  /auth/me      → current session context (tenant + role)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuditWriter } from '../audit';
import { AuthError, loginWithPassword, type AuthUserPort } from './login';
import { resolveSession, revokeSession, type SessionDeps } from './session';

export const SESSION_COOKIE = 'cc_session';
export const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;

export interface AuthRouteDeps {
  users: AuthUserPort;
  session: SessionDeps;
  audit: AuditWriter;
  now?: () => Date;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export function sessionCookieHeader(
  token: string,
  maxAgeSeconds = SESSION_COOKIE_MAX_AGE_SECONDS,
): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new AuthError('INVALID_CREDENTIALS', '请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new AuthError('INVALID_CREDENTIALS', '请求体不是合法 JSON');
  }
}

function sendJson(
  res: ServerResponse,
  code: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthRouteDeps,
): Promise<boolean> {
  const url = req.url ?? '/';
  const path = url.split('?')[0];
  if (!path.startsWith('/auth/')) return false;

  const method = req.method ?? 'GET';

  if (path === '/auth/login' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const email = typeof body.email === 'string' ? body.email : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const organizationId =
        typeof body.organizationId === 'string' && body.organizationId.trim() !== ''
          ? body.organizationId
          : undefined;

      const result = await loginWithPassword(
        {
          email,
          password,
          ...(organizationId ? { organizationId } : {}),
          ...(req.socket.remoteAddress ? { ip: req.socket.remoteAddress } : {}),
          ...(typeof req.headers['user-agent'] === 'string'
            ? { userAgent: req.headers['user-agent'] }
            : {}),
        },
        {
          users: deps.users,
          session: deps.session,
          audit: deps.audit,
          ...(deps.now ? { now: deps.now } : {}),
        },
      );

      sendJson(
        res,
        200,
        { userId: result.userId, organizationId: result.organizationId, role: result.role },
        { 'set-cookie': sessionCookieHeader(result.token) },
      );
      return true;
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'INVALID_CREDENTIALS';
      sendJson(res, code === 'ACCOUNT_LOCKED' || code === 'ACCOUNT_DISABLED' ? 403 : 401, {
        error: code,
        message: error instanceof AuthError ? error.message : '邮箱或密码不正确',
      });
      return true;
    }
  }

  if (path === '/auth/logout' && method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const context = await resolveSession(token, deps.session);
      if (context) {
        await revokeSession(
          { sessionId: context.sessionId, organizationId: context.organizationId, reason: 'LOGOUT' },
          deps.session,
        );
      }
    }
    sendJson(res, 204, {}, { 'set-cookie': clearSessionCookieHeader() });
    return true;
  }

  if (path === '/auth/me' && method === 'GET') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const context = token ? await resolveSession(token, deps.session) : null;
    if (!context) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    sendJson(res, 200, {
      userId: context.userId,
      organizationId: context.organizationId,
      role: context.role,
    });
    return true;
  }

  sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  return true;
}
