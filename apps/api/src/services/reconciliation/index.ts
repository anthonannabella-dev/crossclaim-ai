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

// R45 S3 —— deterministic projector（MSG-20261002-48）
// 注意：projection-compute 为纯计算层（无 IO）；projector 为锁内 IO 层（整体替换 membership）。
export {
  ProjectionComputeError,
  PROJECTION_STATUSES,
  computeProjection,
  fromScaled,
  toScaled,
} from './projection-compute';
export type {
  ProjectionBasisInput,
  ProjectionComputation,
  ProjectionComputationInput,
  ProjectionFactInput,
  ProjectionOverrideInput,
  ProjectionPolicyInput,
  ProjectionStatus,
} from './projection-compute';
export {
  RECONCILIATION_POLICY_OPERATION,
  RECONCILIATION_PROJECTION_REBUILT_ACTION,
  ReconciliationProjectorError,
  SYSTEM_EXACT_POLICY_ID,
  rebuildClaimReconciliationProjection,
} from './projector';
export type { ProjectorDeps, ProjectionRebuildInput, ProjectionRebuildResult } from './projector';

// R45 S4 —— 对账期受保护动作（第一批：basis set / supersede）
export {
  RECONCILIATION_BASIS_SET_RECORDED_ACTION,
  RECONCILIATION_BASIS_SUPERSEDED_ACTION,
  setReconciliationBasis,
  supersedeReconciliationBasis,
} from './basis-actions';
export type { BasisActionDeps, ReconBasisKind, ReconciliationBasisInput, ReconciliationBasisResult } from './basis-actions';

// R45 S4 —— 对账期受保护动作（第二批：人工 override / 人工 provider outcome 录入）
export {
  RECONCILIATION_OVERRIDE_RECORDED_ACTION,
  RECONCILIATION_PROVIDER_OUTCOME_RECORDED_ACTION,
  recordManualProviderOutcomeFact,
  recordReconciliationOverride,
} from './manual-actions';
export type {
  ManualActionDeps,
  RecordManualOutcomeResult,
  RecordManualProviderOutcomeInput,
  RecordOverrideResult,
  RecordReconciliationOverrideInput,
} from './manual-actions';
