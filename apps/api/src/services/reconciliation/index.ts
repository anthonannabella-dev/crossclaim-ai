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
