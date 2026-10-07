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
import {
  normalizeAuthEmail,
  requestEmailVerification,
  requestPasswordReset,
  resetPasswordWithToken,
  verifyEmailWithToken,
  type AuthLifecycleDeps,
} from './email-verification';

export const SESSION_COOKIE = 'cc_session';
export const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;

export interface AuthRouteDeps {
  users: AuthUserPort;
  session: SessionDeps;
  audit: AuditWriter;
  /** 应用安全日志端口（不得写 email / password / token 明文） */
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => Date;
  /** PC-01A（MSG-20261002-81 H）：public self-signup 默认关闭，fail-closed。 */
  signupEnabled?: boolean;
  /** PC-01A：bootstrap 端口（服务层实现见 services/auth/self-signup.ts）。 */
  selfSignup?: (input: {
    email: string;
    password: string;
    organizationName: string;
    displayName?: string;
  }) => Promise<{ userId: string; organizationId: string; role: string; emailVerified: boolean }>;
  /** PC-01B：邮箱验证 / 密码重置生命周期（未装配时相关端点 fail-closed 503）。 */
  lifecycle?: AuthLifecycleDeps;
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

/** 支持的生产 cookie 名（`__Host-` 前缀要求 Secure + Path=/ + 无 Domain）。 */
export const HOST_SESSION_COOKIE = '__Host-' + SESSION_COOKIE;

/** 读取端同时接受两种名字，切换命名时不会踢掉既有会话。 */
export function readSessionToken(cookies: Record<string, string>): string | undefined {
  return cookies[SESSION_COOKIE] ?? cookies[HOST_SESSION_COOKIE];
}

/**
 * P1-6：生产/HTTPS 上下文自动启用 Secure。
 * 判定顺序：显式 cookieName/secure 选项 → `x-forwarded-proto: https` → `NODE_ENV === production`。
 * 开发环境（localhost / NODE_ENV!=production / 非 https）保持不加 Secure，避免破坏本地登录。
 */
export function isSecureCookieContext(input: { nodeEnv?: string | undefined; forwardedProto?: string | undefined }): boolean {
  const proto = String(input.forwardedProto ?? '').split(',')[0]?.trim().toLowerCase();
  if (proto === 'https') return true;
  return input.nodeEnv === 'production';
}

export interface SessionCookieOptions {
  secure?: boolean;
  name?: string;
}

function cookieAttributes(options: SessionCookieOptions): string {
  return '; Path=/; HttpOnly; SameSite=Lax' + (options.secure === true ? '; Secure' : '');
}

export function sessionCookieHeader(
  token: string,
  maxAgeSeconds = SESSION_COOKIE_MAX_AGE_SECONDS,
  options: SessionCookieOptions = {},
): string {
  const name = options.name ?? SESSION_COOKIE;
  return `${name}=${token}${cookieAttributes(options)}; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookieHeader(options: SessionCookieOptions = {}): string {
  const name = options.name ?? SESSION_COOKIE;
  return `${name}=${cookieAttributes(options)}; Max-Age=0`;
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

/** 生产启用 Secure；`SESSION_COOKIE_HOST_PREFIX=true` 时使用 `__Host-` 名（默认保持 cc_session）。 */
function cookieOptionsFor(req: IncomingMessage): SessionCookieOptions {
  const secure = isSecureCookieContext({
    nodeEnv: process.env.NODE_ENV,
    forwardedProto: (req.headers['x-forwarded-proto'] as string | undefined) ?? undefined,
  });
  const useHostPrefix = secure && process.env.SESSION_COOKIE_HOST_PREFIX === 'true';
  return { secure, ...(useHostPrefix ? { name: HOST_SESSION_COOKIE } : {}) };
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
          ...(deps.log ? { log: deps.log } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
      );

      sendJson(
        res,
        200,
        { userId: result.userId, organizationId: result.organizationId, role: result.role },
        { 'set-cookie': sessionCookieHeader(result.token, SESSION_COOKIE_MAX_AGE_SECONDS, cookieOptionsFor(req)) },
      );
      return true;
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'INVALID_CREDENTIALS';
      sendJson(res, code === 'ACCOUNT_LOCKED' || code === 'ACCOUNT_DISABLED' || code === 'EMAIL_NOT_VERIFIED' ? 403 : 401, {
        error: code,
        message: error instanceof AuthError ? error.message : '邮箱或密码不正确',
      });
      return true;
    }
  }

  if (path === '/auth/signup' && method === 'POST') {
    // H：feature gate 默认关闭；关闭时不暴露任何注册能力（不建 User / 不建 Organization）。
    if (deps.signupEnabled !== true || !deps.selfSignup) {
      sendJson(res, 403, { error: 'SIGNUP_DISABLED', message: '自助注册当前不可用' });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const result = await deps.selfSignup({
        email: typeof body.email === 'string' ? body.email : '',
        password: typeof body.password === 'string' ? body.password : '',
        organizationName:
          typeof body.organizationName === 'string' ? body.organizationName : '',
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      });
      // CUSTOMER-UX（acceptance P0）：注册成功后立即**尝试**发出验证邮件。
      // best-effort：不改变鉴权语义；邮件通道未接入时 delivered=false，由响应如实告知，
      // 前端不得假装已经发出（外部通道仍是 EXTERNAL_GATE / HOLD）。
      let verificationEmailRequested = false;
      let verificationEmailDelivered = false;
      if (deps.lifecycle) {
        try {
          const issued = await requestEmailVerification(
            { userId: result.userId, ip: req.socket.remoteAddress ?? undefined },
            deps.lifecycle,
          );
          verificationEmailRequested = issued.issued;
          verificationEmailDelivered = issued.delivery?.delivered === true;
        } catch {
          verificationEmailRequested = false;
        }
      }
      // G：未验证邮箱不发放 session；明确告知下一步是邮箱验证。
      sendJson(res, 201, {
        userId: result.userId,
        organizationId: result.organizationId,
        role: result.role,
        emailVerified: result.emailVerified,
        sessionIssued: false,
        nextStep: 'EMAIL_VERIFICATION_REQUIRED',
        verificationEmail: {
          requested: verificationEmailRequested,
          delivered: verificationEmailDelivered,
        },
      });
      return true;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? 'INVALID_INPUT';
      const status =
        code === 'EMAIL_ALREADY_REGISTERED' ? 409 : code === 'SIGNUP_DISABLED' ? 403 : 400;
      sendJson(res, status, {
        error: code,
        message: error instanceof Error ? error.message : '注册失败',
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
    sendJson(res, 204, {}, { 'set-cookie': clearSessionCookieHeader(cookieOptionsFor(req)) });
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

  if (path === '/auth/verify-email' && method === 'POST') {
    if (!deps.lifecycle) {
      sendJson(res, 503, { error: 'EMAIL_LIFECYCLE_UNAVAILABLE' });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { verified: false, error: 'INVALID_INPUT' });
      return true;
    }
    const result = await verifyEmailWithToken({ token: body.token }, deps.lifecycle);
    if (result.outcome === 'OK') {
      sendJson(res, 200, { verified: true });
      return true;
    }
    // B/C：过期与非法/已消费/被替代分别给出稳定 code，不泄漏账号信息
    sendJson(res, result.outcome === 'EXPIRED' ? 410 : 400, {
      verified: false,
      error: result.outcome,
    });
    return true;
  }

  if (path === '/auth/resend-verification' && method === 'POST') {
    if (!deps.lifecycle) {
      sendJson(res, 503, { error: 'EMAIL_LIFECYCLE_UNAVAILABLE' });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'INVALID_INPUT' });
      return true;
    }
    const account = await deps.lifecycle.accounts.findByEmail(normalizeAuthEmail(body.email));
    if (account && !account.emailVerified) {
      await requestEmailVerification(
        { userId: account.id, ip: req.socket.remoteAddress ?? undefined },
        deps.lifecycle,
      );
    }
    // B：统一口径（不暴露邮箱是否存在 / 是否已验证）
    sendJson(res, 202, { accepted: true });
    return true;
  }

  if (path === '/auth/forgot-password' && method === 'POST') {
    if (!deps.lifecycle) {
      sendJson(res, 503, { error: 'EMAIL_LIFECYCLE_UNAVAILABLE' });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'INVALID_INPUT' });
      return true;
    }
    await requestPasswordReset(
      { email: body.email, ip: req.socket.remoteAddress ?? undefined },
      deps.lifecycle,
    );
    // F：永远同一响应（不暴露邮箱是否存在）
    sendJson(res, 202, { accepted: true });
    return true;
  }

  if (path === '/auth/reset-password' && method === 'POST') {
    if (!deps.lifecycle) {
      sendJson(res, 503, { error: 'EMAIL_LIFECYCLE_UNAVAILABLE' });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { reset: false, error: 'INVALID_INPUT' });
      return true;
    }
    try {
      const result = await resetPasswordWithToken(
        { token: body.token, newPassword: body.password },
        deps.lifecycle,
      );
      if (result.outcome === 'OK') {
        sendJson(res, 200, { reset: true, revokedSessions: result.revokedSessions });
        return true;
      }
      sendJson(res, result.outcome === 'EXPIRED' ? 410 : 400, { reset: false, error: result.outcome });
      return true;
    } catch (error) {
      sendJson(res, 400, {
        reset: false,
        error: 'PASSWORD_POLICY',
        message: error instanceof Error ? error.message : '密码不满足安全策略',
      });
      return true;
    }
  }
  sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  return true;
}
