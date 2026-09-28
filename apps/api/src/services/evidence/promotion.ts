/**
 * Evidence promotion (C-0005 / Gate 3).
 * ---------------------------------------------------------------
 * Hard rule (ARCHITECTURE_CONTRACT §6): a `FileAsset` is **not** Evidence, and
 * neither is raw API data. Evidence is only created by an explicit promotion,
 * because "we stored bytes" and "this is claim-grade evidence" are different
 * claims.
 *
 * Two promotion sources:
 *   - FILE_ASSET : a stored snapshot (FileAsset) becomes EvidenceArtifact
 *   - EXTERNAL   : an external reference (e.g. carrier portal URL) is promoted
 *                  without materialising a FileAsset
 *
 * Provenance: the promoted evidence keeps `fileAssetId` and/or `connectionId`,
 * so it can always be traced back to the acquisition mode it came from.
 */

import type { EvidenceKind, FileKind } from '@prisma/client';

import type { AuditWriter } from '../audit';
import { describeError } from '../acquisition';

export type EvidencePromotionErrorCode =
  | 'FILE_ASSET_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'INVALID_PROMOTION_INPUT';

export class EvidencePromotionError extends Error {
  readonly code: EvidencePromotionErrorCode;

  constructor(code: EvidencePromotionErrorCode, message: string) {
    super(message);
    this.name = 'EvidencePromotionError';
    this.code = code;
  }
}

export interface FileAssetSnapshot {
  id: string;
  organizationId: string;
  connectionId: string | null;
  kind: FileKind;
  originalName: string;
  createdAt: Date;
}

export interface EvidenceDraft {
  organizationId: string;
  kind: EvidenceKind;
  fileAssetId: string | null;
  connectionId: string | null;
  externalUrl: string | null;
  title: string;
  description: string | null;
  capturedAt: Date;
}

export interface EvidencePromotionPorts {
  fileAssets: {
    find(organizationId: string, fileAssetId: string): Promise<FileAssetSnapshot | null>;
  };
  evidence: {
    /** Same organization + same FileAsset + same kind ⇒ already promoted. */
    findExisting(
      organizationId: string,
      fileAssetId: string,
      kind: EvidenceKind,
    ): Promise<{ id: string } | null>;
    create(draft: EvidenceDraft): Promise<{ id: string }>;
    linkCase(input: {
      organizationId: string;
      caseId: string;
      evidenceId: string;
      role: string;
    }): Promise<void>;
  };
  cases: {
    find(organizationId: string, caseId: string): Promise<{ id: string } | null>;
  };
  audit: AuditWriter;
  now?: () => Date;
}

export type PromotionSource =
  | { type: 'FILE_ASSET'; fileAssetId: string }
  | { type: 'EXTERNAL'; externalUrl: string; connectionId?: string };

export interface PromoteEvidenceInput {
  organizationId: string;
  kind: EvidenceKind;
  title: string;
  source: PromotionSource;
  description?: string;
  capturedAt?: Date;
  /** Optional case link; the case must belong to the same organization. */
  caseId?: string;
  role?: string;
}

export interface PromoteEvidenceResult {
  evidenceId: string;
  reused: boolean;
  caseLinked: boolean;
  fileAssetId: string | null;
  connectionId: string | null;
}

export async function promoteEvidence(
  input: PromoteEvidenceInput,
  deps: EvidencePromotionPorts,
): Promise<PromoteEvidenceResult> {
  const now = deps.now ?? (() => new Date());
  const title = input.title.trim();
  if (!title || title.length > 512) {
    throw new EvidencePromotionError('INVALID_PROMOTION_INPUT', 'title 必填且不超过 512 字符');
  }

  let fileAssetId: string | null = null;
  let connectionId: string | null = null;
  let capturedAt = input.capturedAt ?? now();

  if (input.source.type === 'FILE_ASSET') {
    const fileAsset = await deps.fileAssets.find(input.organizationId, input.source.fileAssetId);
    if (!fileAsset) {
      throw new EvidencePromotionError(
        'FILE_ASSET_NOT_FOUND',
        `FileAsset ${input.source.fileAssetId} 不存在或不属于该租户`,
      );
    }
    fileAssetId = fileAsset.id;
    connectionId = fileAsset.connectionId;
    if (!input.capturedAt) capturedAt = fileAsset.createdAt;
  } else {
    const externalUrl = input.source.externalUrl.trim();
    if (!externalUrl) {
      throw new EvidencePromotionError('INVALID_PROMOTION_INPUT', 'externalUrl 必填');
    }
    connectionId = input.source.connectionId ?? null;
  }

  // Validate the case link before creating anything: a cross-tenant or missing
  // case must not leave an orphan evidence row behind.
  if (input.caseId) {
    const kase = await deps.cases.find(input.organizationId, input.caseId);
    if (!kase) {
      throw new EvidencePromotionError(
        'CASE_NOT_FOUND',
        `Case ${input.caseId} 不存在或不属于该租户`,
      );
    }
  }

  let evidenceId: string | undefined;
  let reused = false;

  if (fileAssetId) {
    const existing = await deps.evidence.findExisting(input.organizationId, fileAssetId, input.kind);
    if (existing) {
      evidenceId = existing.id;
      reused = true;
      await deps.audit.record({
        organizationId: input.organizationId,
        actorType: 'SYSTEM',
        actorRef: 'evidence-promotion-service',
        action: 'evidence.promotion_reused',
        entityType: 'EvidenceArtifact',
        entityId: evidenceId,
        changes: {
          kind: input.kind,
          fileAssetId,
          connectionId,
          ...(input.caseId ? { caseId: input.caseId } : {}),
        },
      });
    }
  }

  if (evidenceId === undefined) {
    try {
      const created = await deps.evidence.create({
        organizationId: input.organizationId,
        kind: input.kind,
        fileAssetId,
        connectionId,
        externalUrl: input.source.type === 'EXTERNAL' ? input.source.externalUrl.trim() : null,
        title,
        description: input.description ?? null,
        capturedAt,
      });
      evidenceId = created.id;
    } catch (err) {
      const failure = describeError(err);
      await deps.audit
        .record({
          organizationId: input.organizationId,
          actorType: 'SYSTEM',
          actorRef: 'evidence-promotion-service',
          action: 'evidence.promotion_failed',
          entityType: 'EvidenceArtifact',
          entityId: fileAssetId ?? input.organizationId,
          changes: { kind: input.kind, fileAssetId, failure },
        })
        .catch(() => undefined);
      throw err;
    }

    await deps.audit.record({
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: 'evidence-promotion-service',
      action: 'evidence.created',
      entityType: 'EvidenceArtifact',
      entityId: evidenceId,
      changes: {
        kind: input.kind,
        fileAssetId,
        connectionId,
        externalUrl: input.source.type === 'EXTERNAL' ? input.source.externalUrl.trim() : null,
        capturedAt: capturedAt.toISOString(),
        ...(input.caseId ? { caseId: input.caseId } : {}),
      },
    });
  }

  let caseLinked = false;
  if (input.caseId) {
    await deps.evidence.linkCase({
      organizationId: input.organizationId,
      caseId: input.caseId,
      evidenceId,
      role: input.role ?? input.kind,
    });
    caseLinked = true;
    await deps.audit.record({
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: 'evidence-promotion-service',
      action: 'evidence.case_linked',
      entityType: 'CaseEvidence',
      entityId: evidenceId,
      changes: { caseId: input.caseId, evidenceId, role: input.role ?? input.kind },
    });
  }

  return { evidenceId, reused, caseLinked, fileAssetId, connectionId };
}
