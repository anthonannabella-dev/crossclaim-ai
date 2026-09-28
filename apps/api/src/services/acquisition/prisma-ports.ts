/**
 * Prisma-backed ports for the acquisition services.
 * ---------------------------------------------------------------
 * Only structural mapping; every lookup is tenant-scoped so a connection of
 * another organization can never be reached through an id alone.
 */

import type { PrismaClient } from '@prisma/client';

import type { FileAssetDraft, FileAssetPort, SourceConnectionPort } from './types';

export function createPrismaSourceConnectionPort(prisma: PrismaClient): SourceConnectionPort {
  return {
    async find(organizationId, connectionId) {
      if (!organizationId || !connectionId) return null;
      const connection = await prisma.sourceConnection.findFirst({
        where: { id: connectionId, organizationId },
        select: {
          id: true,
          organizationId: true,
          kind: true,
          status: true,
          domain: true,
          channel: true,
        },
      });
      return connection ?? null;
    },

    async markSynced(connectionId, at) {
      await prisma.sourceConnection.update({
        where: { id: connectionId },
        data: { lastSyncAt: at, lastError: null, lastErrorAt: null },
      });
    },

    async markError(connectionId, message, at) {
      await prisma.sourceConnection.update({
        where: { id: connectionId },
        data: { lastError: message.slice(0, 500), lastErrorAt: at },
      });
    },
  };
}

export function createPrismaFileAssetPort(prisma: PrismaClient): FileAssetPort {
  return {
    async create(draft: FileAssetDraft) {
      const created = await prisma.fileAsset.create({
        data: {
          id: draft.id,
          organizationId: draft.organizationId,
          connectionId: draft.connectionId,
          kind: draft.kind,
          storageKey: draft.storageKey,
          originalName: draft.originalName,
          mimeType: draft.mimeType ?? null,
          sizeBytes: draft.sizeBytes,
          sha256: draft.sha256,
          uploadedBy: draft.uploadedBy ?? null,
          sourceRef: draft.sourceRef ?? null,
        },
      });
      return { id: created.id };
    },
  };
}
