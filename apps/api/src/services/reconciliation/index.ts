/**
 * Cross-source reconciliation entry point (C-0005 / Gate 3).
 */

export {
  SourceConflictError,
  assertNoSourceConflict,
  factKeyOf,
  modeOf,
  normalizeDecimal,
  reconcileSourceFacts,
  type CanonicalFact,
  type FactMode,
  type FactSourceTransaction,
  type ReconcileResult,
  type SourceConflict,
  type SourceConflictEntry,
  type SourceConflictReason,
} from './reconcile';
export {
  createPrismaReconciliationRepository,
  type ReconcileScope,
  type ReconciliationRepository,
} from './prisma-repository';

// R45 S2 —— Outcome / Reimbursement ingest（MSG-20261001-47 Q3）
// 说明：本目录同时承载 C-0005 的跨源事实对账（reconcile.ts / prisma-repository.ts）与
// R45 的 provider outcome / reimbursement ingest（fingerprint.ts / ingest.ts）；
// 两者语义不同（前者 = CanonicalFact 跨源对账；后者 = 外部赔付事实 ingest），不得互相替代。
export {
  PROVIDER_EVENT_FINGERPRINT_VERSION,
  ProviderEventIdentityError,
  canonicalEventKind,
  canonicalProvider,
  canonicalSourceResource,
  providerEventFingerprintV1,
} from './fingerprint';
export type {
  ProviderEventFingerprintInput,
  ProviderEventFingerprintResult,
  ProviderEventKind,
  ProviderOutcomeKind,
  ReimbursementKind,
} from './fingerprint';
export {
  AUTOMATED_SOURCE_KINDS,
  ReconciliationIngestError,
  ingestProviderOutcomeFact,
  ingestReimbursementFact,
} from './ingest';
export type {
  AutomatedSourceKind,
  IngestOutcome,
  IngestResult,
  IngestSourceKind,
  ProviderOutcomeIngestInput,
  ReimbursementIngestInput,
} from './ingest';
