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
