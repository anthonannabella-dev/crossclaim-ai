/**
 * Prisma-backed lifecycle port for SourceConnection (C-0007 Phase 1).
 * Every write is tenant-scoped; an unknown/foreign connection updates 0 rows.
 */

import type { PrismaClient } from '@prisma/client';

import { AcquisitionError } from './types';
import type { ConnectionLifecyclePort, ConnectionRecord } from './connection-lifecycle';

export function createPrismaConnectionLifecyclePort(
  prisma: PrismaClient,
): ConnectionLifecyclePort {
  return {
    async find(organizationId, connectionId): Promise<ConnectionRecord | null> {
      const row = await prisma.sourceConnection.findFirst({
        where: { id: connectionId, organizationId },
        select: {
          id: true,
          organizationId: true,
          status: true,
          kind: true,
          domain: true,
          channel: true,
          label: true,
          credentialRef: true,
        },
      });
      return row ?? null;
    },

    async create(draft) {
      const created = await prisma.sourceConnection.create({
        data: {
          organizationId: draft.organizationId,
          domain: draft.domain,
          channel: draft.channel,
          kind: draft.kind,
          label: draft.label,
          credentialRef: draft.credentialRef,
          status: draft.status,
          platformAccountId: draft.platformAccountId ?? null,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async update(organizationId, connectionId, patch) {
      const result = await prisma.sourceConnection.updateMany({
        where: { id: connectionId, organizationId },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.credentialRef !== undefined ? { credentialRef: patch.credentialRef } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.lastErrorAt !== undefined ? { lastErrorAt: patch.lastErrorAt } : {}),
        },
      });
      if (result.count === 0) {
        throw new AcquisitionError('CONNECTION_NOT_FOUND', `连接 ${connectionId} 不存在或不属于该租户`);
      }
    },
  };
}
