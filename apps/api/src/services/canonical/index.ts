/**
 * Canonical fact layer entry point (C-0006-A).
 */

export {
  activeFacts,
  affectedFactKeys,
  conflictFacts,
  deriveFactsFromTransactions,
  toFactSourceTransaction,
  type CanonicalFactStatus,
  type DerivedFact,
  type TransactionProjection,
} from './derive';
export {
  writeCanonicalFactsForTransactions,
  type WriteCanonicalFactsInput,
  type WriteCanonicalFactsResult,
} from './writer';
export {
  buildDetectionParityReport,
  createInMemoryDetectionRepository,
  loadActiveFactTransactionIds,
  renderMigrationAuditReport,
  type BuildParityReportInput,
  type DetectionInputs,
  type InMemoryDetectionRepository,
  type InvoiceParityRow,
  type MigrationAuditReport,
} from './parity';
export {
  loadShadowInputs,
  runCanonicalShadow,
  shadowDedupeKey,
  type LoadedShadowInputs,
  type ShadowEvaluationDraft,
  type ShadowFactRef,
  type ShadowRunDeps,
  type ShadowRunSummary,
} from './shadow';
export {
  applyIdentityBackfill,
  planIdentityBackfill,
  type ApplyIdentityBackfillResult,
  type IdentityBackfillPlan,
  type IdentityBackfillUpdate,
  type IdentityUnmappedReason,
  type PlanIdentityBackfillInput,
} from './identity-backfill';
export { canonicalDedupeKeyFor } from './identity-key';
export {
  buildIdentityParityReport,
  type IdentityParityReport,
} from './identity-parity';
export {
  buildDuplicateResolutionReport,
  type DuplicateResolutionEntry,
  type DuplicateResolutionRecommendation,
  type DuplicateResolutionReport,
} from './duplicate-resolution';
