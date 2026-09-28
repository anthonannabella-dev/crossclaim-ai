/**
 * Evidence promotion entry point (C-0005 / Gate 3).
 */

export {
  EvidencePromotionError,
  promoteEvidence,
  type EvidenceDraft,
  type EvidencePromotionErrorCode,
  type EvidencePromotionPorts,
  type FileAssetSnapshot,
  type PromoteEvidenceInput,
  type PromoteEvidenceResult,
  type PromotionSource,
} from './promotion';
export { createPrismaEvidencePromotionPorts } from './prisma-ports';
