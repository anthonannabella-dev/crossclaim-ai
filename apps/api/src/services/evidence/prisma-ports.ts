/**
 * Prisma-backed ports for evidence promotion (C-0005 / Gate 3).
 * Every lookup is tenant-scoped.
 */

import type { PrismaClient } from '@prisma/client';

import type { EvidenceDraft, EvidencePromotionPorts } from './promotion';
import { resolveAccountIdFromConnection } from './account-scope';

export function createPrismaEvidencePromotionPorts(
  prisma: PrismaClient,
): Omit<EvidencePromotionPorts, 'audit' | 'now'> {
  return {
    fileAssets: {
      async find(organizationId, fileAssetId) {
        const fileAsset = await prisma.fileAsset.findFirst({
          where: { id: fileAssetId, organizationId },
          select: {
            id: true,
            organizationId: true,
            connectionId: true,
            kind: true,
            originalName: true,
            createdAt: true,
          },
        });
        return fileAsset ?? null;
      },
    },

    evidence: {
      async findExisting(organizationId, fileAssetId, kind) {
        const existing = await prisma.evidenceArtifact.findFirst({
          where: { organizationId, fileAssetId, kind },
          select: { id: true },
        });
        return existing ?? null;
      },

      async create(draft: EvidenceDraft) {
        // MSG-20261002-68 CHANGE A：统一走共享解析器；无法唯一确定 account → fail-closed。
        const accountId = await resolveAccountIdFromConnection(prisma as never, {
          organizationId: draft.organizationId,
          connectionId: draft.connectionId,
        });
        const created = await prisma.evidenceArtifact.create({
          data: {
            organizationId: draft.organizationId,
            accountId,
            kind: draft.kind,
            fileAssetId: draft.fileAssetId,
            connectionId: draft.connectionId,
            externalUrl: draft.externalUrl,
            title: draft.title,
            description: draft.description,
            capturedAt: draft.capturedAt,
          },
        });
        return { id: created.id };
      },

      async linkCase({ organizationId, caseId, evidenceId, role }) {
        await prisma.caseEvidence.upsert({
          where: { caseId_evidenceId: { caseId, evidenceId } },
          update: { role },
          create: { organizationId, caseId, evidenceId, role },
        });
      },
    },

    cases: {
      async find(organizationId, caseId) {
        const kase = await prisma.case.findFirst({
          where: { id: caseId, organizationId },
          select: { id: true },
        });
        return kase ?? null;
      },
    },
  };
}
