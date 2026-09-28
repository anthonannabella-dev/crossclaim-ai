/**
 * C-0008-A — invite-only email + password login.
 * ---------------------------------------------------------------
 * Rules: 5 failed attempts → 15 minute lock (reusing User.failedLogins /
 * lockedUntil); every attempt is audited, and no password / token / hash ever
 * reaches the audit payload or the logs.
 */

import type { AuditWriter } from '../audit';
import { verifyPassword } from './password';
import { issueSession, type IssuedSession, type SessionDeps } from './session';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_DISABLED'
  | 'NO_MEMBERSHIP'
  | 'AMBIGUOUS_ORGANIZATION';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export interface AuthUserRow {
  id: string;
  email: string;
  passwordHash: string | null;
  status: string;
  failedLogins: number;
  lockedUntil: Date | null;
}

export interface AuthUserPort {
  findByEmail(email: string): Promise<AuthUserRow | null>;
  recordLoginSuccess(userId: string, at: Date): Promise<void>;
  recordLoginFailure(userId: string, failedLogins: number, lockedUntil: Date | null): Promise<void>;
}

export interface LoginDeps {
  users: AuthUserPort;
  session: SessionDeps;
  audit: AuditWriter;
  now?: () => Date;
}

export interface LoginResult extends IssuedSession {
  userId: string;
  role: string;
}

async function auditLoginFailed(
  deps: LoginDeps,
  input: { organizationId?: string; userId?: string; reason: string; failedLogins?: number },
): Promise<void> {
  // AuditLog is tenant-scoped, so a failure can only be recorded once a tenant is
  // known: either the caller supplied it, or the user has an active membership.
  // An unknown email therefore has no tenant context and stays unlogged here
  // (documented in the C-0008-A report; it also avoids user enumeration).
  const organizationId =
    input.organizationId ??
    (input.userId
      ? (await deps.session.memberships.listActiveForUser(input.userId))[0]?.organizationId
      : undefined);
  if (!organizationId) return;

  // No email in the payload keeps the audit readable without becoming a user list.
  await deps.audit
    .record({
      organizationId,
      actorType: 'SYSTEM',
      actorRef: 'auth-service',
      action: 'auth.login_failed',
      entityType: 'User',
      entityId: input.userId ?? 'unknown',
      changes: {
        reason: input.reason,
        ...(input.failedLogins !== undefined ? { failedLogins: input.failedLogins } : {}),
      },
    })
    .catch(() => undefined);
}

export async function loginWithPassword(
  input: {
    email: string;
    password: string;
    organizationId?: string;
    ip?: string;
    userAgent?: string;
  },
  deps: LoginDeps,
): Promise<LoginResult> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const email = input.email.trim().toLowerCase();
  const user = await deps.users.findByEmail(email);

  if (!user || !user.passwordHash) {
    await auditLoginFailed(deps, { reason: 'NO_SUCH_USER' });
    throw new AuthError('INVALID_CREDENTIALS', '邮箱或密码不正确');
  }
  if (user.status !== 'ACTIVE') {
    await auditLoginFailed(deps, { userId: user.id, reason: 'ACCOUNT_DISABLED' });
    throw new AuthError('ACCOUNT_DISABLED', '账号已被停用');
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > at.getTime()) {
    await auditLoginFailed(deps, { userId: user.id, reason: 'ACCOUNT_LOCKED' });
    throw new AuthError('ACCOUNT_LOCKED', '账号已临时锁定，请稍后再试');
  }

  if (!verifyPassword(input.password, user.passwordHash)) {
    const failedLogins = user.failedLogins + 1;
    const lockedUntil =
      failedLogins >= MAX_FAILED_LOGINS ? new Date(at.getTime() + LOCK_DURATION_MS) : null;
    await deps.users.recordLoginFailure(user.id, failedLogins, lockedUntil);
    await auditLoginFailed(deps, { userId: user.id, reason: 'BAD_PASSWORD', failedLogins });
    throw new AuthError('INVALID_CREDENTIALS', '邮箱或密码不正确');
  }

  const memberships = input.organizationId
    ? await deps.session.memberships.findActive(input.organizationId, user.id).then((m) => (m ? [m] : []))
    : await deps.session.memberships.listActiveForUser(user.id);

  if (memberships.length === 0) {
    await auditLoginFailed(deps, { userId: user.id, reason: 'NO_MEMBERSHIP' });
    throw new AuthError('NO_MEMBERSHIP', '该账号没有任何有效组织成员关系');
  }
  if (memberships.length > 1 && !input.organizationId) {
    await auditLoginFailed(deps, { userId: user.id, reason: 'AMBIGUOUS_ORGANIZATION' });
    throw new AuthError('AMBIGUOUS_ORGANIZATION', '该账号属于多个组织，请指定组织');
  }

  const membership = memberships[0];
  await deps.users.recordLoginSuccess(user.id, at);

  const session = await issueSession(
    {
      organizationId: membership.organizationId,
      userId: user.id,
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    },
    deps.session,
  );

  await deps.audit.record({
    organizationId: membership.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'auth-service',
    action: 'auth.login_succeeded',
    entityType: 'Session',
    entityId: session.sessionId,
    changes: {
      userId: user.id,
      organizationId: membership.organizationId,
      role: membership.role,
      expiresAt: session.expiresAt.toISOString(),
    },
  });

  return { ...session, userId: user.id, role: membership.role };
}
