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
