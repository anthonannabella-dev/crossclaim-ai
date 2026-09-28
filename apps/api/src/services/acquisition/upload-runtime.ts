/**
 * C-0007 Gate 5 / Phase 2 — Upload Runtime.
 * ---------------------------------------------------------------
 *   Upload request → content scan → duplicate check → Storage Adapter
 *                 → FileAsset → ImportBatch → SourceTransaction → CanonicalFact
 *
 * Approved boundaries:
 *   - internal / test entry only (never expose publicly, no auth system here)
 *   - fail closed on every negative scan result; nothing is stored or imported
 *   - duplicate upload (same organization + sha256) never creates a second
 *     business asset
 *   - FileAsset is still NOT Evidence; only promoteEvidence() may create evidence
 */

import type { PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import type { ImportRepository, ImportResult } from '../ingest';
import type { StorageAdapter } from '../storage';
import { AcquisitionError, type FileAssetPort, type SourceConnectionPort } from './types';
import { DEFAULT_SCAN_MAX_BYTES, scanUploadContent, type ContentScanResult } from './content-scan';
import { uploadFileAndImport, type FileUploadInput } from './file-upload-service';

export interface FileAssetLookupPort {
  findBySha256(
    organizationId: string,
    sha256: string,
  ): Promise<{ id: string; storageKey: string } | null>;
}

export interface ScannedUploadDeps {
  connections: SourceConnectionPort;
  fileAssets: FileAssetPort;
  fileAssetLookup?: FileAssetLookupPort;
  storage: StorageAdapter;
  imports: ImportRepository;
  audit: AuditWriter;
  maxBytes?: number;
  now?: () => Date;
}

export interface ScannedUploadResult {
  status: 'IMPORTED' | 'DUPLICATE';
  fileAssetId: string;
  scan: ContentScanResult;
  import: ImportResult | null;
  duplicateOf?: string;
}

export async function uploadWithScan(
  input: FileUploadInput & { declaredMime?: string | null },
  deps: ScannedUploadDeps,
): Promise<ScannedUploadResult> {
  const maxBytes = deps.maxBytes ?? DEFAULT_SCAN_MAX_BYTES;
  const scan = scanUploadContent({
    body: input.body,
    fileName: input.originalName,
    declaredMime: input.declaredMime ?? input.mimeType ?? null,
    kind: input.kind,
    maxBytes,
  });

  if (scan.status === 'REJECTED') {
    await deps.audit
      .record({
        organizationId: input.organizationId,
        actorType: 'SYSTEM',
        actorRef: 'upload-runtime',
        action: 'file.upload_failed',
        entityType: 'FileAsset',
        entityId: input.connectionId,
        changes: {
          connectionId: input.connectionId,
          source: 'FILE_UPLOAD',
          scanStatus: scan.status,
          scanReason: scan.reason,
          detectedMime: scan.detectedMime,
          declaredMime: scan.declaredMime,
          sha256: scan.sha256,
          sizeBytes: scan.sizeBytes,
          ...(scan.detail ? { detail: scan.detail } : {}),
        },
      })
      .catch(() => undefined);
    throw new AcquisitionError(
      'FILE_KIND_UNSUPPORTED',
      `上传被拒绝（${scan.reason ?? 'UNKNOWN'}）：detectedMime=${scan.detectedMime}`,
    );
  }

  await deps.audit.record({
    organizationId: input.organizationId,
    actorType: 'SYSTEM',
    actorRef: 'upload-runtime',
    action: 'file.scan_passed',
    entityType: 'FileAsset',
    entityId: input.connectionId,
    changes: {
      connectionId: input.connectionId,
      scanStatus: scan.status,
      detectedMime: scan.detectedMime,
      declaredMime: scan.declaredMime,
      sha256: scan.sha256,
      sizeBytes: scan.sizeBytes,
    },
  });

  const duplicate = deps.fileAssetLookup
    ? await deps.fileAssetLookup.findBySha256(input.organizationId, scan.sha256)
    : null;
  if (duplicate) {
    await deps.audit.record({
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: 'upload-runtime',
      action: 'file.upload_duplicate',
      entityType: 'FileAsset',
      entityId: duplicate.id,
      changes: {
        connectionId: input.connectionId,
        existingFileAssetId: duplicate.id,
        sha256: scan.sha256,
        sizeBytes: scan.sizeBytes,
      },
    });
    return {
      status: 'DUPLICATE',
      fileAssetId: duplicate.id,
      scan,
      import: null,
      duplicateOf: duplicate.id,
    };
  }

  const uploaded = await uploadFileAndImport(input, deps);
  return { status: 'IMPORTED', fileAssetId: uploaded.fileAssetId, scan, import: uploaded.import };
}

export function createPrismaFileAssetLookup(prisma: PrismaClient): FileAssetLookupPort {
  return {
    async findBySha256(organizationId, sha256) {
      const row = await prisma.fileAsset.findFirst({
        where: { organizationId, sha256 },
        select: { id: true, storageKey: true },
        orderBy: { createdAt: 'asc' },
      });
      return row ?? null;
    },
  };
}
