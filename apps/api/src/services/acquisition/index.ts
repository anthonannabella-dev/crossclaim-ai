/**
 * Dual-mode acquisition entry point (C-0005 / Gate 3).
 */

export { AcquisitionError, type AcquisitionErrorCode, type ConnectionSnapshot, type FileAssetDraft, type FileAssetPort, type SourceConnectionPort } from './types';
export {
  ACQUISITION_ACTOR_REF,
  describeError,
  recordAcquisitionEvent,
  tryRecordAcquisitionEvent,
  type AcquisitionAction,
  type AcquisitionAuditEvent,
} from './audit';
export {
  DEFAULT_MAX_UPLOAD_BYTES,
  uploadFileAndImport,
  type FileUploadDeps,
  type FileUploadInput,
  type FileUploadResult,
} from './file-upload-service';
export {
  runApiAcquisition,
  type ApiPullDeps,
  type ApiPullInput,
  type ApiPullResult,
} from './api-pull-service';
export { createPrismaFileAssetPort, createPrismaSourceConnectionPort } from './prisma-ports';

export {
  CONNECTION_TRANSITIONS,
  assertTransition,
  canTransition,
  createConnection,
  initialStatusFor,
  markConnectionError,
  rotateCredentialRef,
  transitionConnection,
  type ConnectionLifecycleDeps,
  type ConnectionLifecyclePort,
  type ConnectionRecord,
  type ConnectionStatus,
} from './connection-lifecycle';
export { createPrismaConnectionLifecyclePort } from './connection-lifecycle-prisma';

export {
  DEFAULT_SCAN_MAX_BYTES,
  scanUploadContent,
  type ContentScanInput,
  type ContentScanResult,
  type ScanReason,
  type ScanStatus,
} from './content-scan';
export {
  createPrismaFileAssetLookup,
  uploadWithScan,
  type FileAssetLookupPort,
  type ScannedUploadDeps,
  type ScannedUploadResult,
} from './upload-runtime';
