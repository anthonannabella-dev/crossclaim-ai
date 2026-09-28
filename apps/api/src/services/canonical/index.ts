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
