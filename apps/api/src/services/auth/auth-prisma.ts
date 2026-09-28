/**
 * Prisma-backed ports for the C-0008-A auth foundation.
 * Tenant-scoped lookups only; token/password material is never logged.
 */

import type { PrismaClient } from '@prisma/client';

import type { AuthUserPort } from './login';
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
