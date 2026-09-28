/**
 * FILE_UPLOAD acquisition (C-0005 / Gate 3).
 * ---------------------------------------------------------------
 *   bytes → Storage Adapter → FileAsset → ImportBatch → SourceTransaction
 *
 * Boundaries:
 *   - the SourceConnection must belong to the same organization and be kind=FILE_UPLOAD
 *   - FileAsset records bytes + metadata only; a FileAsset is **not** Evidence
 *   - parsing/normalising/validating stays in the canonical ingest core
 *   - this service never decides recovery and never writes money records
 *
 * Gate 3 first slice parses CSV only. Other file kinds fail closed before any
 * write; PDF/XLSX/IMAGE need a separate parser decision (dependency review).
 */

import { randomUUID } from 'node:crypto';

import type { Channel, FileKind, RecoveryDomain } from '@prisma/client';

import type { AuditWriter } from '../audit';
import { runImport, type ImportRepository, type ImportResult } from '../ingest';
import { sha256Hex, type StorageAdapter } from '../storage';
import { tryRecordAcquisitionEvent, recordAcquisitionEvent, describeError } from './audit';
import { AcquisitionError, type FileAssetPort, type SourceConnectionPort } from './types';

/** 25 MiB: large enough for invoice batches, small enough to stay in memory. */
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface FileUploadInput {
  organizationId: string;
  connectionId: string;
  domain: RecoveryDomain;
  channel: Channel;
  kind: FileKind;
  originalName: string;
  mimeType?: string;
  body: Buffer;
  createdBy?: string;
}

export interface FileUploadDeps {
  connections: SourceConnectionPort;
  fileAssets: FileAssetPort;
  storage: StorageAdapter;
  imports: ImportRepository;
  audit: AuditWriter;
  maxBytes?: number;
  now?: () => Date;
}

export interface FileUploadResult {
  fileAssetId: string;
  import: ImportResult;
}

export async function uploadFileAndImport(
  input: FileUploadInput,
  deps: FileUploadDeps,
): Promise<FileUploadResult> {
  const now = deps.now ?? (() => new Date());
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  if (input.body.length === 0) {
    throw new AcquisitionError('FILE_EMPTY', '上传内容为空，拒绝登记 FileAsset');
  }
  if (input.body.length > maxBytes) {
    throw new AcquisitionError(
      'FILE_TOO_LARGE',
      `上传内容 ${input.body.length} 字节超过上限 ${maxBytes} 字节`,
    );
  }
  if (input.kind !== 'CSV') {
    throw new AcquisitionError(
      'FILE_KIND_UNSUPPORTED',
      `Gate 3 第一阶段只解析 CSV；${input.kind} 需要单独的解析器评审，本次 fail closed`,
    );
  }

  const connection = await deps.connections.find(input.organizationId, input.connectionId);
  if (!connection) {
    throw new AcquisitionError(
      'CONNECTION_NOT_FOUND',
      `连接 ${input.connectionId} 不存在或不属于该租户`,
    );
  }
  if (connection.organizationId !== input.organizationId) {
    throw new AcquisitionError('CONNECTION_TENANT_MISMATCH', '连接不属于该租户');
  }
  if (connection.kind !== 'FILE_UPLOAD') {
    throw new AcquisitionError(
      'CONNECTION_KIND_MISMATCH',
      `连接 ${connection.id} 的类型为 ${connection.kind}，文件上传只能用 FILE_UPLOAD 连接`,
    );
  }

  const fileAssetId = randomUUID();
  const sha256 = sha256Hex(input.body);
  const auditBase = { connectionId: connection.id, source: 'FILE_UPLOAD' as const };

  let storedSize: number;
  try {
    const stored = await deps.storage.put({
      organizationId: input.organizationId,
      fileAssetId,
      body: input.body,
      ...(input.mimeType ? { contentType: input.mimeType } : {}),
      expectedSha256: sha256,
    });
    storedSize = stored.size;

    await deps.fileAssets.create({
      id: fileAssetId,
      organizationId: input.organizationId,
      connectionId: connection.id,
      kind: input.kind,
      storageKey: stored.storageKey,
      originalName: input.originalName,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      sizeBytes: stored.size,
      sha256: stored.sha256,
      ...(input.createdBy ? { uploadedBy: input.createdBy } : {}),
    });
  } catch (err) {
    const failure = describeError(err);
    await tryRecordAcquisitionEvent(deps.audit, {
      organizationId: input.organizationId,
      action: 'file.upload_failed',
      entityType: 'FileAsset',
      entityId: fileAssetId,
      changes: {
        ...auditBase,
        kind: input.kind,
        originalName: input.originalName,
        sizeBytes: input.body.length,
        failure,
      },
    });
    throw err;
  }

  await recordAcquisitionEvent(deps.audit, {
    organizationId: input.organizationId,
    action: 'file.uploaded',
    entityType: 'FileAsset',
    entityId: fileAssetId,
    changes: {
      ...auditBase,
      kind: input.kind,
      originalName: input.originalName,
      sizeBytes: storedSize,
      sha256,
    },
  });

  let importResult: ImportResult;
  try {
    importResult = await runImport({
      context: {
        organizationId: input.organizationId,
        domain: input.domain,
        channel: input.channel,
        connectionId: connection.id,
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      },
      csvText: input.body.toString('utf8'),
      repository: deps.imports,
      fileAssetId,
      now,
    });
  } catch (err) {
    const failure = describeError(err);
    await tryRecordAcquisitionEvent(deps.audit, {
      organizationId: input.organizationId,
      action: 'import.failed',
      entityType: 'ImportBatch',
      entityId: fileAssetId,
      changes: { ...auditBase, fileAssetId, failure },
    });
    await deps.connections.markError(connection.id, failure.message, now());
    throw err;
  }

  await recordAcquisitionEvent(deps.audit, {
    organizationId: input.organizationId,
    action: importResult.status === 'FAILED' ? 'import.failed' : 'import.completed',
    entityType: 'ImportBatch',
    entityId: importResult.batchId,
    changes: {
      ...auditBase,
      fileAssetId,
      status: importResult.status,
      rowsTotal: importResult.rowsTotal,
      rowsOk: importResult.rowsOk,
      rowsFailed: importResult.rowsFailed,
      duplicates: importResult.duplicates,
      issueCount: importResult.issues.length,
    },
  });

  if (importResult.status === 'FAILED') {
    await deps.connections.markError(
      connection.id,
      `import ${importResult.batchId} 失败：全部行都未通过校验`,
      now(),
    );
  } else {
    await deps.connections.markSynced(connection.id, now());
  }

  return { fileAssetId, import: importResult };
}
