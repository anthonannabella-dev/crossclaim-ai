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
