/**
 * C-0008-A — server-side sessions.
 * ---------------------------------------------------------------
 * Approved rules:
 *   absolute lifetime 12h + idle timeout 30m; token is only stored as a hash
 *   (sha256) and never logged; `lastSeenAt` is refreshed at most every 5 minutes
 *   to avoid a write on every request.
 *
 * Tenant isolation is a mandatory three-step check (C-0008-A ruling):
 *   tokenHash → Session → Membership(organizationId, userId, isActive=true)
 * `Session.organizationId` alone is never sufficient.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { AuditWriter } from '../audit';

export interface SessionPolicy {
  absoluteMs: number;
  idleMs: number;
  touchIntervalMs: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  absoluteMs: 12 * 60 * 60 * 1000,
  idleMs: 30 * 60 * 1000,
  touchIntervalMs: 5 * 60 * 1000,
};

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionRow {
  id: string;
  organizationId: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface SessionPort {
  create(row: {
    organizationId: string;
    userId: string;
    tokenHash: string;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
    ipHash: string | null;
    userAgent: string | null;
  }): Promise<{ id: string }>;
  findByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  touch(id: string, at: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<number>;
}

export interface ActiveMembership {
  organizationId: string;
  userId: string;
  role: string;
}

export interface MembershipLookupPort {
  findActive(organizationId: string, userId: string): Promise<ActiveMembership | null>;
  listActiveForUser(userId: string): Promise<ActiveMembership[]>;
}

export interface SessionDeps {
  sessions: SessionPort;
  memberships: MembershipLookupPort;
  audit: AuditWriter;
  policy?: SessionPolicy;
  /** IP hashing salt; raw IP never leaves this layer. */
  ipSalt?: string;
  now?: () => Date;
}

export interface IssuedSession {
  sessionId: string;
  token: string;
  organizationId: string;
  expiresAt: Date;
}

export interface SessionContext {
  sessionId: string;
  organizationId: string;
  userId: string;
  role: string;
}

function hashIp(ip: string | undefined, salt: string | undefined): string | null {
  if (!ip || !salt) return null;
  return createHash('sha256').update(`${salt}|${ip}`, 'utf8').digest('hex').slice(0, 32);
}

export async function issueSession(
  input: {
    organizationId: string;
    userId: string;
    ip?: string;
    userAgent?: string;
  },
  deps: SessionDeps,
): Promise<IssuedSession> {
  const now = deps.now ?? (() => new Date());
  const policy = deps.policy ?? DEFAULT_SESSION_POLICY;
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + policy.absoluteMs);
  const token = newSessionToken();

  const created = await deps.sessions.create({
    organizationId: input.organizationId,
    userId: input.userId,
    tokenHash: hashSessionToken(token),
    createdAt: issuedAt,
    lastSeenAt: issuedAt,
    expiresAt,
    ipHash: hashIp(input.ip, deps.ipSalt),
    userAgent: input.userAgent ? input.userAgent.slice(0, 256) : null,
  });

  return { sessionId: created.id, token, organizationId: input.organizationId, expiresAt };
}

export async function resolveSession(
  token: string,
  deps: SessionDeps,
  expectedOrganizationId?: string,
): Promise<SessionContext | null> {
  const now = deps.now ?? (() => new Date());
  const policy = deps.policy ?? DEFAULT_SESSION_POLICY;
  const at = now();

  const session = await deps.sessions.findByTokenHash(hashSessionToken(token));
  if (!session) return null;
  if (session.revokedAt) return null;

  if (session.expiresAt.getTime() <= at.getTime()) {
    await deps.audit
      .record({
        organizationId: session.organizationId,
        actorType: 'SYSTEM',
        actorRef: 'auth-service',
        action: 'auth.session_expired',
        entityType: 'Session',
        entityId: session.id,
        changes: { reason: 'ABSOLUTE_EXPIRY', expiresAt: session.expiresAt.toISOString() },
      })
      .catch(() => undefined);
    return null;
  }

  if (at.getTime() - session.lastSeenAt.getTime() > policy.idleMs) {
    await deps.audit
      .record({
        organizationId: session.organizationId,
        actorType: 'SYSTEM',
        actorRef: 'auth-service',
        action: 'auth.session_expired',
        entityType: 'Session',
        entityId: session.id,
        changes: { reason: 'IDLE_TIMEOUT', lastSeenAt: session.lastSeenAt.toISOString() },
      })
      .catch(() => undefined);
    return null;
  }

  // Mandatory step 3: the session is only valid together with an active membership.
  const membership = await deps.memberships.findActive(session.organizationId, session.userId);
  if (!membership) return null;
  if (expectedOrganizationId && expectedOrganizationId !== session.organizationId) return null;

  // Throttled touch: at most one write per touchIntervalMs.
  if (at.getTime() - session.lastSeenAt.getTime() >= policy.touchIntervalMs) {
    await deps.sessions.touch(session.id, at);
  }

  return {
    sessionId: session.id,
    organizationId: session.organizationId,
    userId: session.userId,
    role: membership.role,
  };
}

export async function revokeSession(
  input: { sessionId: string; organizationId: string; reason: string },
  deps: SessionDeps,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  await deps.sessions.revoke(input.sessionId, at);
  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'auth-service',
    action: 'auth.session_revoked',
    entityType: 'Session',
    entityId: input.sessionId,
    changes: { reason: input.reason, at: at.toISOString() },
  });
}

export async function revokeAllSessionsForUser(
  input: { userId: string; organizationId: string; reason: string },
  deps: SessionDeps,
): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const revoked = await deps.sessions.revokeAllForUser(input.userId, at);
  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'auth-service',
    action: 'auth.session_revoked',
    entityType: 'User',
    entityId: input.userId,
    changes: { reason: input.reason, revokedCount: revoked, all: true, at: at.toISOString() },
  });
  return revoked;
}
