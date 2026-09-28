/**
 * Dual-mode acquisition (C-0005 / Gate 3) — shared types and ports.
 * ---------------------------------------------------------------
 * FILE_UPLOAD : bytes → Storage Adapter → FileAsset → ImportBatch → SourceTransaction
 * API         : ExternalAdapter → pull → canonical ingest → ImportBatch → SourceTransaction
 *
 * Both modes share the canonical ingest core (`services/ingest`) and the Gate 1
 * audit writer. This layer only adds provenance, connection guards and events;
 * it never computes money and never decides recovery.
 */

import type {
  Channel,
  FileKind,
  RecoveryDomain,
  SourceConnectionKind,
  SourceConnectionStatus,
} from '@prisma/client';

export type AcquisitionErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_TENANT_MISMATCH'
  | 'CONNECTION_KIND_MISMATCH'
  | 'FILE_EMPTY'
  | 'FILE_TOO_LARGE'
  | 'FILE_KIND_UNSUPPORTED';

export class AcquisitionError extends Error {
  readonly code: AcquisitionErrorCode;

  constructor(code: AcquisitionErrorCode, message: string) {
    super(message);
    this.name = 'AcquisitionError';
    this.code = code;
  }
}

/** Tenant-scoped view of a SourceConnection; no credential material is ever exposed. */
export interface ConnectionSnapshot {
  id: string;
  organizationId: string;
  kind: SourceConnectionKind;
  status: SourceConnectionStatus;
  domain: RecoveryDomain;
  channel: Channel;
}

export interface SourceConnectionPort {
  /** Must be tenant-scoped: a connection of another organization resolves to null. */
  find(organizationId: string, connectionId: string): Promise<ConnectionSnapshot | null>;
  markSynced(connectionId: string, at: Date): Promise<void>;
  markError(connectionId: string, message: string, at: Date): Promise<void>;
}

export interface FileAssetDraft {
  id: string;
  organizationId: string;
  connectionId: string;
  kind: FileKind;
  storageKey: string;
  originalName: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy?: string;
  sourceRef?: string;
}

export interface FileAssetPort {
  create(draft: FileAssetDraft): Promise<{ id: string }>;
}

/** Shared shape of the acquisition audit payloads. */
export interface AcquisitionAuditContext {
  organizationId: string;
  connectionId: string;
  source: 'FILE_UPLOAD' | 'API';
}
