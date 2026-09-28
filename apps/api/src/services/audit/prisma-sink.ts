/**
 * Prisma 版审计端口实现
 * ---------------------------------------------------------------
 * 只做"我方行结构 → Prisma 入参"的翻译，不含业务判断，
 * 便于审计逻辑本体在无数据库环境下被完整测试。
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuditLogInsert, AuditLogRow, AuditQueryArgs, AuditRecord, AuditSink } from './types';

export function createPrismaAuditSink(prisma: PrismaClient): AuditSink {
  return {
    async insert(row: AuditLogInsert): Promise<AuditRecord> {
      const created = await prisma.auditLog.create({
        data: {
          organizationId: row.organizationId,
          actorType: row.actorType,
          actorId: row.actorId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: row.ip,
          userAgent: row.userAgent,
          createdAt: row.createdAt,
        },
      });
      return { id: created.id, createdAt: created.createdAt };
    },

    async query(args: AuditQueryArgs): Promise<AuditLogRow[]> {
      const where: Prisma.AuditLogWhereInput = { organizationId: args.organizationId };
      if (args.entityType) where.entityType = args.entityType;
      if (args.entityId) where.entityId = args.entityId;
      if (args.action) where.action = args.action;
      if (args.before) where.createdAt = { lt: args.before };

      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: args.take,
      });

      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId ?? '',
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        changes: (row.changes ?? null) as Record<string, unknown> | null,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: row.createdAt,
      }));
    },
  };
}
