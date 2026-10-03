/**
 * Prisma-backed ports for the C-0008-A auth foundation.
 * Tenant-scoped lookups only; token/password material is never logged.
 */

import type { PrismaClient } from '@prisma/client';

import type { AuthUserPort } from './login';
import type {
  InvitationMembershipPort,
  InvitationPort,
  InvitationUserPort,
} from './invitation';
import type { ActiveMembership, MembershipLookupPort, SessionPort } from './session';
import type {
  AuthTokenAccountPort,
  EmailVerificationPort,
  PasswordResetPort,
} from './email-verification';

export function createPrismaAuthUserPort(prisma: PrismaClient): AuthUserPort {
  return {
    async findByEmail(email) {
      const user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          passwordHash: true,
          status: true,
          emailVerified: true,
          failedLogins: true,
          lockedUntil: true,
        },
      });
      return user ?? null;
    },

    async recordLoginSuccess(userId, at) {
      await prisma.user.update({
        where: { id: userId },
        data: { failedLogins: 0, lockedUntil: null, lastLoginAt: at },
      });
    },

    async recordLoginFailure(userId, failedLogins, lockedUntil) {
      await prisma.user.update({
        where: { id: userId },
        data: { failedLogins, lockedUntil },
      });
    },
  };
}

export function createPrismaSessionPort(prisma: PrismaClient): SessionPort {
  return {
    async create(row) {
      const created = await prisma.session.create({
        data: {
          organizationId: row.organizationId,
          userId: row.userId,
          tokenHash: row.tokenHash,
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          expiresAt: row.expiresAt,
          ipHash: row.ipHash,
          userAgent: row.userAgent,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async findByTokenHash(tokenHash) {
      const row = await prisma.session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          organizationId: true,
          userId: true,
          createdAt: true,
          lastSeenAt: true,
          expiresAt: true,
          revokedAt: true,
        },
      });
      return row ?? null;
    },

    async touch(id, at) {
      await prisma.session.update({ where: { id }, data: { lastSeenAt: at } });
    },

    async revoke(id, at) {
      await prisma.session.update({ where: { id }, data: { revokedAt: at, lastRotatedAt: at } });
    },

    async revokeAllForUser(userId, at) {
      const result = await prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: at },
      });
      return result.count;
    },
  };
}

export function createPrismaMembershipLookup(prisma: PrismaClient): MembershipLookupPort {
  return {
    async findActive(organizationId, userId): Promise<ActiveMembership | null> {
      const row = await prisma.membership.findFirst({
        where: { organizationId, userId, isActive: true },
        select: { organizationId: true, userId: true, role: true },
      });
      return row ?? null;
    },

    async listActiveForUser(userId): Promise<ActiveMembership[]> {
      const rows = await prisma.membership.findMany({
        where: { userId, isActive: true },
        select: { organizationId: true, userId: true, role: true },
        orderBy: { joinedAt: 'asc' },
      });
      return rows;
    },
  };
}

export function createPrismaInvitationPort(prisma: PrismaClient): InvitationPort {
  return {
    async create(row) {
      const created = await prisma.userInvitation.create({
        data: {
          organizationId: row.organizationId,
          email: row.email,
          role: row.role as never,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async findByTokenHash(tokenHash) {
      const row = await prisma.userInvitation.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          organizationId: true,
          email: true,
          role: true,
          expiresAt: true,
          revokedAt: true,
          acceptedAt: true,
          attemptCount: true,
        },
      });
      return row ?? null;
    },

    async findPending(organizationId, email) {
      const row = await prisma.userInvitation.findFirst({
        where: { organizationId, email, revokedAt: null, acceptedAt: null },
        select: {
          id: true,
          organizationId: true,
          email: true,
          role: true,
          expiresAt: true,
          revokedAt: true,
          acceptedAt: true,
          attemptCount: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      return row ?? null;
    },

    async incrementAttempts(id) {
      const updated = await prisma.userInvitation.update({
        where: { id },
        data: { attemptCount: { increment: 1 } },
        select: { attemptCount: true },
      });
      return updated.attemptCount;
    },

    async markAccepted(id, at, userId) {
      await prisma.userInvitation.update({
        where: { id },
        data: { acceptedAt: at, acceptedByUserId: userId },
      });
    },

    async revoke(id, at) {
      await prisma.userInvitation.update({ where: { id }, data: { revokedAt: at } });
    },
  };
}

export function createPrismaInvitationUserPort(prisma: PrismaClient): InvitationUserPort {
  return {
    async findByEmail(email) {
      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, status: true },
      });
      return user ?? null;
    },

    async createUser(row) {
      const created = await prisma.user.create({
        data: {
          email: row.email,
          passwordHash: row.passwordHash,
          displayName: row.displayName,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async markEmailVerified(userId, at) {
      await prisma.user.update({
        where: { id: userId },
        data: { emailVerified: true, passwordChangedAt: at },
      });
    },
  };
}

export function createPrismaInvitationMembershipPort(
  prisma: PrismaClient,
): InvitationMembershipPort {
  return {
    async findActive(organizationId, userId) {
      const row = await prisma.membership.findFirst({
        where: { organizationId, userId, isActive: true },
        select: { id: true },
      });
      return row ?? null;
    },

    async create(row) {
      const created = await prisma.membership.create({
        data: {
          organizationId: row.organizationId,
          userId: row.userId,
          role: row.role as never,
          invitedBy: row.invitedBy,
        },
        select: { id: true },
      });
      return { id: created.id };
    },
  };
}

const AUTH_ACCOUNT_SELECT = { id: true, email: true, emailVerified: true, status: true } as const;

/** PC-01B：账号解析端口（带主租户，用于审计归属；无成员身份时 organizationId = null）。 */
export function createPrismaAuthTokenAccountPort(prisma: PrismaClient): AuthTokenAccountPort {
  const withOrganization = async (
    row: { id: string; email: string; emailVerified: boolean; status: string } | null,
  ) => {
    if (!row) return null;
    const membership = await prisma.membership.findFirst({
      where: { userId: row.id, isActive: true },
      select: { organizationId: true },
      orderBy: { joinedAt: 'asc' },
    });
    return { ...row, organizationId: membership?.organizationId ?? null };
  };
  return {
    async findByEmail(email) {
      return withOrganization(await prisma.user.findUnique({ where: { email }, select: AUTH_ACCOUNT_SELECT }));
    },
    async findById(userId) {
      return withOrganization(await prisma.user.findUnique({ where: { id: userId }, select: AUTH_ACCOUNT_SELECT }));
    },
  };
}

/** PC-01B：邮箱验证令牌端口（C：consume 与 emailVerified 在同一事务内）。 */
export function createPrismaEmailVerificationPort(prisma: PrismaClient): EmailVerificationPort {
  return {
    async supersedeUnconsumed(userId, at) {
      const result = await prisma.emailVerificationToken.updateMany({
        where: { userId, consumedAt: null, supersededAt: null },
        data: { supersededAt: at },
      });
      return result.count;
    },

    async create(row) {
      const created = await prisma.emailVerificationToken.create({
        data: {
          userId: row.userId,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          requesterIpHash: row.requesterIpHash,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async consumeAndVerify(input) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.emailVerificationToken.findUnique({
          where: { tokenHash: input.tokenHash },
          select: { id: true, userId: true, expiresAt: true, consumedAt: true, supersededAt: true },
        });
        if (!row) return { outcome: 'INVALID' as const, userId: null };
        if (row.consumedAt) return { outcome: 'ALREADY_CONSUMED' as const, userId: row.userId };
        if (row.supersededAt) return { outcome: 'SUPERSEDED' as const, userId: row.userId };
        if (row.expiresAt.getTime() <= input.at.getTime()) {
          return { outcome: 'EXPIRED' as const, userId: row.userId };
        }
        const claimed = await tx.emailVerificationToken.updateMany({
          where: { id: row.id, consumedAt: null, supersededAt: null },
          data: { consumedAt: input.at },
        });
        if (claimed.count !== 1) return { outcome: 'ALREADY_CONSUMED' as const, userId: row.userId };
        // D：只置 emailVerified；不得改写 passwordChangedAt
        await tx.user.update({ where: { id: row.userId }, data: { emailVerified: true } });
        return { outcome: 'OK' as const, userId: row.userId };
      });
    },
  };
}

/** PC-01B：密码重置令牌端口（E：consume + hash + passwordChangedAt + 撤销全部 session 同事务）。 */
export function createPrismaPasswordResetPort(prisma: PrismaClient): PasswordResetPort {
  return {
    async supersedeUnconsumed(userId, at) {
      const result = await prisma.passwordResetToken.updateMany({
        where: { userId, consumedAt: null, supersededAt: null },
        data: { supersededAt: at },
      });
      return result.count;
    },

    async create(row) {
      const created = await prisma.passwordResetToken.create({
        data: {
          userId: row.userId,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          requesterIpHash: row.requesterIpHash,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async consumeAndResetPassword(input) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.passwordResetToken.findUnique({
          where: { tokenHash: input.tokenHash },
          select: { id: true, userId: true, expiresAt: true, consumedAt: true, supersededAt: true },
        });
        if (!row) return { outcome: 'INVALID' as const, userId: null, revokedSessions: 0 };
        if (row.consumedAt) {
          return { outcome: 'ALREADY_CONSUMED' as const, userId: row.userId, revokedSessions: 0 };
        }
        if (row.supersededAt) {
          return { outcome: 'SUPERSEDED' as const, userId: row.userId, revokedSessions: 0 };
        }
        if (row.expiresAt.getTime() <= input.at.getTime()) {
          return { outcome: 'EXPIRED' as const, userId: row.userId, revokedSessions: 0 };
        }
        const claimed = await tx.passwordResetToken.updateMany({
          where: { id: row.id, consumedAt: null, supersededAt: null },
          data: { consumedAt: input.at },
        });
        if (claimed.count !== 1) {
          return { outcome: 'ALREADY_CONSUMED' as const, userId: row.userId, revokedSessions: 0 };
        }
        await tx.user.update({
          where: { id: row.userId },
          data: {
            passwordHash: input.newPasswordHash,
            passwordChangedAt: input.at,
            failedLogins: 0,
            lockedUntil: null,
          },
        });
        const revoked = await tx.session.updateMany({
          where: { userId: row.userId, revokedAt: null },
          data: { revokedAt: input.at, lastRotatedAt: input.at },
        });
        return { outcome: 'OK' as const, userId: row.userId, revokedSessions: revoked.count };
      });
    },
  };
}
