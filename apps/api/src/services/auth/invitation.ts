/**
 * C-0008-A — invite-only onboarding.
 * ---------------------------------------------------------------
 * No public registration: an administrator creates an invitation, the invitee
 * receives a one-time token (only its hash is stored) and sets a password.
 *
 *   admin → UserInvitation(tokenHash, expiresAt, role, attemptCount)
 *   invitee → accept(token, password) → User + Membership + audit
 *
 * `attemptCount` makes the invitation link a first-class security surface.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { AuditWriter } from '../audit';
import {
  DEFAULT_SCRYPT_PARAMS,
  assertPasswordPolicy,
  hashPassword,
  type ScryptParams,
} from './password';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INVITATION_ATTEMPTS = 10;

export type InvitationErrorCode =
  | 'INVALID_INVITATION'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_REVOKED'
  | 'INVITATION_ALREADY_ACCEPTED'
  | 'TOO_MANY_ATTEMPTS'
  | 'USER_ALREADY_MEMBER';

export class InvitationError extends Error {
  readonly code: InvitationErrorCode;

  constructor(code: InvitationErrorCode, message: string) {
    super(message);
    this.name = 'InvitationError';
    this.code = code;
  }
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface InvitationRow {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  expiresAt: Date;
  revokedAt: Date | null;
  acceptedAt: Date | null;
  attemptCount: number;
}

export interface InvitationPort {
  create(row: {
    organizationId: string;
    email: string;
    role: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string;
    createdAt: Date;
  }): Promise<{ id: string }>;
  findByTokenHash(tokenHash: string): Promise<InvitationRow | null>;
  findPending(organizationId: string, email: string): Promise<InvitationRow | null>;
  incrementAttempts(id: string): Promise<number>;
  markAccepted(id: string, at: Date, userId: string): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
}

export interface InvitationUserPort {
  findByEmail(email: string): Promise<{ id: string; status: string } | null>;
  createUser(row: { email: string; passwordHash: string; displayName: string }): Promise<{ id: string }>;
  markEmailVerified(userId: string, at: Date): Promise<void>;
}

export interface InvitationMembershipPort {
  findActive(organizationId: string, userId: string): Promise<{ id: string } | null>;
  create(row: {
    organizationId: string;
    userId: string;
    role: string;
    invitedBy: string;
  }): Promise<{ id: string }>;
}

export interface InvitationDeps {
  invitations: InvitationPort;
  users: InvitationUserPort;
  memberships: InvitationMembershipPort;
  audit: AuditWriter;
  scrypt?: ScryptParams;
  now?: () => Date;
}

export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createInvitation(
  input: {
    organizationId: string;
    email: string;
    role: string;
    createdBy: string;
  },
  deps: InvitationDeps,
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new InvitationError('INVALID_INVITATION', '邮箱格式不正确');
  }

  // Replace any pending invitation for the same tenant + email (token rotation).
  const pending = await deps.invitations.findPending(input.organizationId, email);
  if (pending) await deps.invitations.revoke(pending.id, at);

  const token = newInvitationToken();
  const expiresAt = new Date(at.getTime() + INVITATION_TTL_MS);
  const created = await deps.invitations.create({
    organizationId: input.organizationId,
    email,
    role: input.role,
    tokenHash: hashInvitationToken(token),
    expiresAt,
    createdBy: input.createdBy,
    createdAt: at,
  });

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'USER',
    actorUserId: input.createdBy,
    action: 'user.invited',
    entityType: 'UserInvitation',
    entityId: created.id,
    changes: {
      email,
      role: input.role,
      expiresAt: expiresAt.toISOString(),
      replacedPendingInvitationId: pending?.id ?? null,
    },
  });

  return { invitationId: created.id, token, expiresAt };
}

export async function acceptInvitation(
  input: { token: string; password: string; displayName?: string },
  deps: InvitationDeps,
): Promise<{ userId: string; organizationId: string; membershipCreated: boolean; role: string }> {
  const now = deps.now ?? (() => new Date());
  const at = now();

  const invitation = await deps.invitations.findByTokenHash(hashInvitationToken(input.token));
  if (!invitation) {
    throw new InvitationError('INVALID_INVITATION', '邀请链接无效');
  }

  const rejected = async (code: InvitationErrorCode, message: string, reason: string) => {
    const attempts = await deps.invitations.incrementAttempts(invitation.id);
    await deps.audit
      .record({
        organizationId: invitation.organizationId,
        actorType: 'SYSTEM',
        actorRef: 'auth-service',
        action: 'user.invitation_failed',
        entityType: 'UserInvitation',
        entityId: invitation.id,
        changes: { reason, attempts },
      })
      .catch(() => undefined);
    if (attempts > MAX_INVITATION_ATTEMPTS) {
      await deps.invitations.revoke(invitation.id, at).catch(() => undefined);
      throw new InvitationError('TOO_MANY_ATTEMPTS', '邀请尝试次数过多，已被吊销');
    }
    throw new InvitationError(code, message);
  };

  if (invitation.revokedAt) await rejected('INVITATION_REVOKED', '邀请已被吊销', 'REVOKED');
  if (invitation.acceptedAt) await rejected('INVITATION_ALREADY_ACCEPTED', '邀请已被使用', 'ALREADY_ACCEPTED');
  if (invitation.expiresAt.getTime() <= at.getTime()) {
    await rejected('INVITATION_EXPIRED', '邀请已过期', 'EXPIRED');
  }

  assertPasswordPolicy(input.password);

  const existingUser = await deps.users.findByEmail(invitation.email);
  const membership = existingUser
    ? await deps.memberships.findActive(invitation.organizationId, existingUser.id)
    : null;
  if (membership) {
    await rejected('USER_ALREADY_MEMBER', '该用户已是组织成员', 'ALREADY_MEMBER');
  }

  const passwordHash = hashPassword(input.password, deps.scrypt ?? DEFAULT_SCRYPT_PARAMS);
  const user =
    existingUser ??
    (await deps.users.createUser({
      email: invitation.email,
      passwordHash,
      displayName: input.displayName?.trim() || invitation.email.split('@')[0],
    }));
  await deps.users.markEmailVerified(user.id, at).catch(() => undefined);

  await deps.memberships.create({
    organizationId: invitation.organizationId,
    userId: user.id,
    role: invitation.role,
    invitedBy: 'invitation',
  });
  await deps.invitations.markAccepted(invitation.id, at, user.id);

  await deps.audit.record({
    organizationId: invitation.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'auth-service',
    action: 'user.invitation_accepted',
    entityType: 'UserInvitation',
    entityId: invitation.id,
    changes: { userId: user.id, role: invitation.role, emailVerified: true },
  });

  return {
    userId: user.id,
    organizationId: invitation.organizationId,
    membershipCreated: true,
    role: invitation.role,
  };
}
