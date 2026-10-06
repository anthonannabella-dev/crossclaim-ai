// PROVIDER FOLLOW-UP INTELLIGENCE / P7 — slice A-S8 — Recovery Case Lifecycle 投影
// ---------------------------------------------------------------------------
// 先审计（本文件底部 LIFECYCLE_FACT_SOURCES 逐条列出复用来源），再投影：
//   **不新建状态机、不新建表/枚举**，把已有事实（Case / ClaimItem / RecoveryPackage /
//   RecoveryManualSubmission(+Reference/Evidence) / Settlement / Reconciliation / 证据解析 / Follow-up 草稿包）
//   映射成一条**只读**生命周期投影。
//
// 硬边界：
//   ① 只读投影：不写库、不改状态、不产生任何事实；
//   ② 单一 SUBMITTED 不得混淆「内部准备完成」与「平台已收到」——
//      internal.internalReady 与 provider.providerReceived 来自**不同来源**，且
//      providerReceived 只承认 PROVIDER_VERIFIED / AUTHORITY_VERIFIED 级别来源；
//   ③ 未验证来源（用户自述 provider case ref 等）只能进 omittedBecauseUnverified，不升级为「平台已收到」；
//   ④ 金额/结算只做投影，不重算 money truth。

import { digestOf } from '../config-execution-durability/digests';

export const RECOVERY_CASE_LIFECYCLE_VERSION = 'recovery-case-lifecycle/v1';

/** 生命周期阶段（派生结果，不是新的持久化状态机） */
export const LIFECYCLE_STAGES = [
  'INTAKE',
  'EVIDENCE_INCOMPLETE',
  'FOLLOW_UP_DRAFTED',
  'EVIDENCE_COMPLETE',
  'PACKAGE_GENERATED',
  'PACKAGE_EXPORTED',
  'AWAITING_APPROVAL',
  'SUBMISSION_RECORDED',
  'PROVIDER_REFERENCE_RECORDED',
  'PROVIDER_ACKNOWLEDGED',
  'SETTLED',
  'RECONCILED',
  'CLOSED',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** 以下常量镜像既有 Prisma 枚举（只读投影，**不新增枚举/表**） */
export const CASE_STATUSES = [
  'OPEN',
  'COLLECTING_EVIDENCE',
  'READY_TO_CLAIM',
  'CLAIMED',
  'APPEALING',
  'WON',
  'PARTIALLY_WON',
  'LOST',
  'SETTLED',
  'CLOSED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CLAIM_ITEM_STATUSES = [
  'DISCOVERED',
  'VERIFIED',
  'REVIEW_REQUIRED',
  'READY_TO_APPEAL',
  'SUBMITTED_MANUAL',
  'RECOVERED',
  'CLOSED',
] as const;
export type ClaimItemStatus = (typeof CLAIM_ITEM_STATUSES)[number];

export const PACKAGE_STATUSES = ['GENERATED', 'EXPORTED', 'SUPERSEDED', 'WITHDRAWN'] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

export const SETTLEMENT_CONFIRMATION_STATUSES = [
  'CONFIRMED',
  'PENDING_CONFIRMATION',
  'REJECTED_BY_REVIEW',
] as const;
export type SettlementConfirmationStatus = (typeof SETTLEMENT_CONFIRMATION_STATUSES)[number];

export const SETTLEMENT_RECONCILIATION_STATUSES = [
  'NOT_STARTED',
  'PARTIAL',
  'RECONCILED',
  'DISPUTED',
  'REVERSED',
] as const;
export type SettlementReconciliationStatus = (typeof SETTLEMENT_RECONCILIATION_STATUSES)[number];

export const RECONCILIATION_PROJECTION_STATUSES = [
  'UNMATCHED',
  'AMBIGUOUS',
  'MATCHED',
  'PARTIALLY_RECONCILED',
  'FULLY_RECONCILED',
] as const;
export type ReconciliationProjectionStatus = (typeof RECONCILIATION_PROJECTION_STATUSES)[number];

export const LIFECYCLE_EVIDENCE_STATUSES = [
  'FOUND',
  'PARTIAL',
  'MISSING',
  'CONFLICT',
  'AMBIGUOUS',
  'LOW_CONFIDENCE',
] as const;
export type LifecycleEvidenceStatus = (typeof LIFECYCLE_EVIDENCE_STATUSES)[number];

export type ProviderAcknowledgementState = 'NONE' | 'UNVERIFIED' | 'VERIFIED';

/** 事实来源可信级别：只有 PROVIDER_VERIFIED / AUTHORITY_VERIFIED 可支撑「平台已收到 / 已到账」 */
export const FACT_SOURCE_LEVELS = [
  'PROVIDER_VERIFIED',
  'AUTHORITY_VERIFIED',
  'USER_RECORDED',
  'UNVERIFIED',
] as const;
export type FactSourceLevel = (typeof FACT_SOURCE_LEVELS)[number];

export const VERIFIED_FACT_SOURCES: readonly FactSourceLevel[] = ['PROVIDER_VERIFIED', 'AUTHORITY_VERIFIED'];

export function isVerifiedFactSource(source: FactSourceLevel | null | undefined): boolean {
  return source !== null && source !== undefined && VERIFIED_FACT_SOURCES.includes(source);
}

export interface EvidenceResolutionFact {
  kind: string;
  status: LifecycleEvidenceStatus;
  evidenceReferences: readonly string[];
  resultDigest: string;
}

export interface PackageFact {
  packageId: string;
  status: PackageStatus;
  packageDigest: string;
  generatedAt?: string | null;
}

export interface RecoveryCaseLifecycleSnapshot {
  organizationId: string;
  caseId: string;
  caseNo?: string | null;
  domain: string;
  caseStatus: CaseStatus;
  openedAt: string | null;
  closedAt?: string | null;
  currency?: string | null;
  claimedAmount?: number | null;
  recoveredAmount?: number | null;
  claimItemStatuses?: readonly ClaimItemStatus[];
  requiredEvidenceKinds?: readonly string[];
  evidenceResolutions?: readonly EvidenceResolutionFact[];
  followUp?: {
    status: 'DRAFT' | 'BLOCKED' | 'NOT_REQUIRED';
    approvalRequired: boolean;
    approvalRole: 'REVIEWER' | 'OWNER' | 'ADMIN' | null;
    highValue: boolean;
  } | null;
  packages?: readonly PackageFact[];
  approvals?: readonly { approvalId: string; kind: string; grantedAt: string }[];
  submission?: { submissionId: string; submittedAt: string; packageDigest: string } | null;
  providerReference?: { providerCaseRefCanonical: string; recordedAt: string; source: FactSourceLevel } | null;
  providerAcknowledgement?: {
    source: FactSourceLevel;
    acknowledgedAt: string | null;
    providerCaseId?: string | null;
  } | null;
  settlement?: {
    settlementId: string;
    confirmationStatus: SettlementConfirmationStatus;
    reconciliationStatus: SettlementReconciliationStatus;
    verifiedSource?: FactSourceLevel | null;
    amountUsd?: number | null;
    confirmedAt?: string | null;
  } | null;
  reconciliation?: { status: ReconciliationProjectionStatus; reconciledAt?: string | null } | null;
  manualReview?: { reason: string; at: string } | null;
}

export interface LifecycleStageEntry {
  stage: LifecycleStage;
  at: string | null;
  basis: string;
}

export interface RecoveryCaseLifecycleProjection {
  kind: 'RECOVERY_CASE_LIFECYCLE';
  version: string;
  derivedOnly: true;
  organizationId: string;
  caseId: string;
  caseNo: string | null;
  domain: string;
  stage: LifecycleStage;
  stageHistory: LifecycleStageEntry[];
  internal: {
    evidenceComplete: boolean;
    followUpDrafted: boolean;
    packageGenerated: boolean;
    packageExported: boolean;
    approvalRequired: boolean;
    approvalGranted: boolean;
    submissionRecorded: boolean;
    /** 「内部准备完成」——绝不等于平台已收到 */
    internalReady: boolean;
  };
  provider: {
    referenceRecorded: boolean;
    acknowledgement: ProviderAcknowledgementState;
    settlementConfirmed: boolean;
    reconciliationStatus: ReconciliationProjectionStatus | null;
    /** 「平台已收到」——只承认 VERIFIED 来源 */
    providerReceived: boolean;
  };
  separation: {
    internalReady: boolean;
    providerReceived: boolean;
    /** 恒为 false：本投影结构上不可能把两者合并 */
    conflated: false;
    basis: string[];
  };
  money: {
    currency: string | null;
    claimedAmount: number | null;
    recoveredAmount: number | null;
    /** 只做投影；null 表示来源不足，绝不是 0 */
    settledAmountUsd: number | null;
  };
  blockers: string[];
  reasons: string[];
  omittedBecauseUnverified: string[];
  observedAt: string;
  projectionDigest: string;
}

export type RecoveryCaseLifecycleErrorCode =
  | 'LIFECYCLE_TENANT_MISMATCH'
  | 'LIFECYCLE_ACK_REQUIRES_VERIFIED_SOURCE';

export class RecoveryCaseLifecycleError extends Error {
  readonly code: RecoveryCaseLifecycleErrorCode;

  constructor(code: RecoveryCaseLifecycleErrorCode, message: string) {
    super(message);
    this.name = 'RecoveryCaseLifecycleError';
    this.code = code;
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function latestPackage(packages: readonly PackageFact[] | undefined): PackageFact | null {
  if (!packages || packages.length === 0) return null;
  return packages.slice().sort((a, b) => (a.generatedAt ?? '') < (b.generatedAt ?? '') ? 1 : -1)[0];
}

/** 有效（未撤销/未取代）的最新包；WITHDRAWN / SUPERSEDED 不构成当前阶段 */
function activePackage(packages: readonly PackageFact[] | undefined): PackageFact | null {
  return latestPackage((packages ?? []).filter((p) => p.status === 'GENERATED' || p.status === 'EXPORTED'));
}

function evidenceMissingKinds(input: {
  requiredEvidenceKinds?: readonly string[];
  evidenceResolutions?: readonly EvidenceResolutionFact[];
}): string[] {
  const resolutions = input.evidenceResolutions ?? [];
  const fromResolutions = resolutions
    .filter((r) => r.status !== 'FOUND')
    .map((r) => r.kind);
  const required = input.requiredEvidenceKinds ?? [];
  const resolvedFound = new Set(resolutions.filter((r) => r.status === 'FOUND').map((r) => r.kind));
  const fromRequired = required.filter((kind) => !resolvedFound.has(kind));
  return uniqueSorted([...fromResolutions, ...fromRequired]);
}

/** 生命周期阶段派生（纯函数，可单测） */
export function deriveLifecycleStage(snapshot: RecoveryCaseLifecycleSnapshot): LifecycleStage {
  const pkg = activePackage(snapshot.packages);
  const approvalGranted = (snapshot.approvals ?? []).length > 0;
  const ackVerified = isVerifiedFactSource(snapshot.providerAcknowledgement?.source ?? null);
  const settled =
    snapshot.settlement?.confirmationStatus === 'CONFIRMED' &&
    isVerifiedFactSource(snapshot.settlement?.verifiedSource ?? null);
  const reconciled = snapshot.reconciliation?.status === 'MATCHED' ||
    snapshot.reconciliation?.status === 'FULLY_RECONCILED';

  if (reconciled) return 'RECONCILED';
  if (settled) return 'SETTLED';
  if (ackVerified) return 'PROVIDER_ACKNOWLEDGED';
  if (snapshot.caseStatus === 'CLOSED') return 'CLOSED';
  if (snapshot.providerReference) return 'PROVIDER_REFERENCE_RECORDED';
  if (snapshot.submission) return 'SUBMISSION_RECORDED';
  if (snapshot.followUp?.approvalRequired === true && !approvalGranted) return 'AWAITING_APPROVAL';
  if (pkg?.status === 'EXPORTED') return 'PACKAGE_EXPORTED';
  if (pkg) return 'PACKAGE_GENERATED';
  if (evidenceMissingKinds(snapshot).length === 0 && (snapshot.evidenceResolutions ?? []).length > 0) {
    return 'EVIDENCE_COMPLETE';
  }
  if (snapshot.followUp?.status === 'DRAFT') return 'FOLLOW_UP_DRAFTED';
  if (snapshot.caseStatus === 'OPEN') return 'INTAKE';
  return 'EVIDENCE_INCOMPLETE';
}

/**
 * 组装生命周期投影（只读）。
 * @throws LIFECYCLE_TENANT_MISMATCH 快照范围与投影范围不一致
 */
export function projectRecoveryCaseLifecycle(input: {
  scope: { organizationId: string };
  snapshot: RecoveryCaseLifecycleSnapshot;
  observedAt: Date;
}): RecoveryCaseLifecycleProjection {
  const { snapshot } = input;
  if (snapshot.organizationId !== input.scope.organizationId) {
    throw new RecoveryCaseLifecycleError(
      'LIFECYCLE_TENANT_MISMATCH',
      '快照组织与投影范围不一致，禁止跨 tenant 投影。',
    );
  }

  const pkg = latestPackage(snapshot.packages);
  const approvals = snapshot.approvals ?? [];
  const approvalGranted = approvals.length > 0;
  const activePkg = activePackage(snapshot.packages);
  const internalReady =
    activePkg?.status === 'EXPORTED' && (!snapshot.followUp?.approvalRequired || approvalGranted);
  const ackSource = snapshot.providerAcknowledgement?.source ?? null;
  const ackVerified = isVerifiedFactSource(ackSource);
  const providerReceived = ackVerified;

  const blockers: string[] = [];
  const reasons: string[] = [];
  const omitted: string[] = [];

  const conflicts = (snapshot.evidenceResolutions ?? []).filter(
    (r) => r.status === 'CONFLICT' || r.status === 'AMBIGUOUS',
  );
  if (conflicts.length > 0) {
    blockers.push('EVIDENCE_UNRESOLVED:' + uniqueSorted(conflicts.map((c) => c.kind)).join(','));
  }
  const missing = evidenceMissingKinds(snapshot);
  if (missing.length > 0) reasons.push('MISSING_EVIDENCE:' + missing.join(','));

  if (snapshot.followUp?.highValue === true) {
    reasons.push('HIGH_VALUE_CASE');
    if (!approvalGranted) blockers.push('HIGH_VALUE_APPROVAL_REQUIRED');
  }
  if (snapshot.followUp?.status === 'BLOCKED') blockers.push('FOLLOW_UP_BLOCKED');
  if (snapshot.manualReview) {
    blockers.push('AWAITING_MANUAL_REVIEW');
    reasons.push('MANUAL_REVIEW_REASON:' + snapshot.manualReview.reason);
  }
  if (pkg?.status === 'WITHDRAWN') blockers.push('PACKAGE_WITHDRAWN');
  if ((snapshot.packages ?? []).some((p) => p.status === 'SUPERSEDED')) reasons.push('PACKAGE_SUPERSEDED');
  if (snapshot.submission && pkg && snapshot.submission.packageDigest !== pkg.packageDigest) {
    blockers.push('SUBMISSION_PACKAGE_DIGEST_MISMATCH');
  }

  // provider 侧：未验证来源一律不得升级为「平台已收到」
  if (snapshot.providerAcknowledgement && !ackVerified) {
    omitted.push('PROVIDER_ACKNOWLEDGEMENT');
    blockers.push('PROVIDER_ACK_UNVERIFIED');
    reasons.push('ACK_SOURCE_NOT_PROVIDER_VERIFIED');
  }
  if (snapshot.providerReference && !isVerifiedFactSource(snapshot.providerReference.source)) {
    omitted.push('PROVIDER_CASE_REFERENCE_AS_RECEIPT');
    reasons.push('USER_RECORDED_REFERENCE_IS_NOT_PROVIDER_RECEIPT');
  }

  const settlementConfirmed =
    snapshot.settlement?.confirmationStatus === 'CONFIRMED' &&
    isVerifiedFactSource(snapshot.settlement?.verifiedSource ?? null);
  if (snapshot.settlement && !settlementConfirmed) {
    blockers.push('SETTLEMENT_NOT_CONFIRMED_BY_VERIFIED_SOURCE');
    omitted.push('SETTLED_AMOUNT');
  }
  if (
    snapshot.settlement?.reconciliationStatus === 'DISPUTED' ||
    snapshot.settlement?.reconciliationStatus === 'REVERSED'
  ) {
    blockers.push('SETTLEMENT_RECONCILIATION_' + snapshot.settlement.reconciliationStatus);
  }
  if (
    snapshot.reconciliation?.status === 'UNMATCHED' ||
    snapshot.reconciliation?.status === 'AMBIGUOUS'
  ) {
    blockers.push('RECONCILIATION_' + snapshot.reconciliation.status);
  }

  const stage = deriveLifecycleStage(snapshot);

  const stageHistory: LifecycleStageEntry[] = [];
  const push = (stageEntry: LifecycleStage, at: string | null, basis: string): void => {
    stageHistory.push({ stage: stageEntry, at, basis });
  };
  if (snapshot.openedAt) push('INTAKE', snapshot.openedAt, 'Case.openedAt');
  if (missing.length > 0) {
    push('EVIDENCE_INCOMPLETE', null, 'evidence resolutions / requiredEvidenceKinds');
  }
  if (snapshot.followUp?.status === 'DRAFT') {
    push('FOLLOW_UP_DRAFTED', null, 'FollowUpPackage(status=DRAFT)');
  }
  if (missing.length === 0 && (snapshot.evidenceResolutions ?? []).length > 0) {
    push('EVIDENCE_COMPLETE', null, 'evidence resolutions all FOUND');
  }
  for (const entry of (snapshot.packages ?? [])
    .slice()
    .sort((a, b) => ((a.generatedAt ?? '') < (b.generatedAt ?? '') ? -1 : 1))) {
    if (entry.status === 'EXPORTED') {
      push('PACKAGE_EXPORTED', entry.generatedAt ?? null, 'RecoveryPackage.status=EXPORTED');
    } else if (entry.status === 'GENERATED') {
      push('PACKAGE_GENERATED', entry.generatedAt ?? null, 'RecoveryPackage.status=GENERATED');
    }
  }
  if (snapshot.followUp?.approvalRequired === true && !approvalGranted) {
    push('AWAITING_APPROVAL', null, 'FollowUpPackage.approval.required=true 且无审批记录');
  }
  if (snapshot.submission) {
    push('SUBMISSION_RECORDED', snapshot.submission.submittedAt, 'RecoveryManualSubmission.submittedAt');
  }
  if (snapshot.providerReference) {
    push(
      'PROVIDER_REFERENCE_RECORDED',
      snapshot.providerReference.recordedAt,
      `RecoveryManualSubmissionReference(source=${snapshot.providerReference.source})`,
    );
  }
  if (ackVerified) {
    push(
      'PROVIDER_ACKNOWLEDGED',
      snapshot.providerAcknowledgement?.acknowledgedAt ?? null,
      `provider acknowledgement source=${ackSource}`,
    );
  }
  if (settlementConfirmed) {
    push('SETTLED', snapshot.settlement?.confirmedAt ?? null, 'Settlement.confirmationStatus=CONFIRMED');
  }
  if (snapshot.reconciliation?.status === 'MATCHED' || snapshot.reconciliation?.status === 'FULLY_RECONCILED') {
    push('RECONCILED', snapshot.reconciliation.reconciledAt ?? null, 'ReconciliationProjectionStatus=' + snapshot.reconciliation.status);
  }
  if (snapshot.caseStatus === 'CLOSED') {
    push('CLOSED', snapshot.closedAt ?? null, 'Case.status=CLOSED');
  }

  const ordered = [...stageHistory].sort(
    (a, b) =>
      LIFECYCLE_STAGES.indexOf(a.stage) - LIFECYCLE_STAGES.indexOf(b.stage) ||
      ((a.at ?? '') < (b.at ?? '') ? -1 : 1),
  );

  const body: Omit<
    RecoveryCaseLifecycleProjection,
    'kind' | 'derivedOnly' | 'stageHistory' | 'projectionDigest'
  > = {
    version: RECOVERY_CASE_LIFECYCLE_VERSION,
    organizationId: snapshot.organizationId,
    caseId: snapshot.caseId,
    caseNo: snapshot.caseNo ?? null,
    domain: snapshot.domain,
    stage,
    internal: {
      evidenceComplete: missing.length === 0 && (snapshot.evidenceResolutions ?? []).length > 0,
      followUpDrafted: snapshot.followUp?.status === 'DRAFT',
      packageGenerated: activePkg !== null,
      packageExported: activePkg?.status === 'EXPORTED',
      approvalRequired: snapshot.followUp?.approvalRequired === true,
      approvalGranted,
      submissionRecorded: Boolean(snapshot.submission) || Boolean(snapshot.providerReference),
      internalReady,
    },
    provider: {
      referenceRecorded: snapshot.providerReference !== null && snapshot.providerReference !== undefined,
      acknowledgement: ackVerified ? 'VERIFIED' : snapshot.providerAcknowledgement ? 'UNVERIFIED' : 'NONE',
      settlementConfirmed,
      reconciliationStatus: snapshot.reconciliation?.status ?? null,
      providerReceived,
    },
    separation: {
      internalReady,
      providerReceived,
      conflated: false as const,
      basis: [
        'internalReady ← RecoveryPackage.status=EXPORTED（+ 必要审批）',
        'providerReceived ← provider acknowledgement source ∈ {PROVIDER_VERIFIED, AUTHORITY_VERIFIED}',
      ],
    },
    money: {
      currency: snapshot.currency ?? null,
      claimedAmount: snapshot.claimedAmount ?? null,
      recoveredAmount: snapshot.recoveredAmount ?? null,
      settledAmountUsd: settlementConfirmed ? (snapshot.settlement?.amountUsd ?? null) : null,
    },
    blockers: uniqueSorted(blockers),
    reasons: uniqueSorted(reasons),
    omittedBecauseUnverified: uniqueSorted(omitted),
    observedAt: input.observedAt.toISOString(),
  };

  return {
    kind: 'RECOVERY_CASE_LIFECYCLE',
    derivedOnly: true,
    ...body,
    stageHistory: ordered,
    projectionDigest: digestOf({ ...body, stageHistory: ordered }),
  };
}

/** 边界断言：任何把「内部准备完成」当成「平台已收到」（或反之）的记录都必须被拒绝 */
export function assertLifecycleSeparation(projection: {
  internal?: { internalReady?: boolean };
  provider?: { providerReceived?: boolean; acknowledgement?: 'NONE' | 'UNVERIFIED' | 'VERIFIED' };
  separation?: { conflated?: boolean };
}): void {
  const providerReceived = projection.provider?.providerReceived === true;
  const ack = projection.provider?.acknowledgement;
  if (providerReceived && ack !== 'VERIFIED') {
    throw new RecoveryCaseLifecycleError(
      'LIFECYCLE_ACK_REQUIRES_VERIFIED_SOURCE',
      '「平台已收到」只承认 VERIFIED 来源；未验证来源不得升级。',
    );
  }
  if (projection.separation?.conflated === true) {
    throw new RecoveryCaseLifecycleError(
      'LIFECYCLE_ACK_REQUIRES_VERIFIED_SOURCE',
      '内部准备完成与平台已收到必须保持分离，禁止合并为单一 SUBMITTED。',
    );
  }
}

export const LIFECYCLE_BOUNDARY = {
  derivedOnly: true,
  newStateMachine: false,
  newTableOrEnum: false,
  mutatesFacts: false,
  recomputesMoneyTruth: false,
  internalReadyImpliesProviderReceived: false,
  providerReceiptRequiresVerifiedSource: true,
  forbidden: [
    'conflating internal readiness with provider receipt (single SUBMITTED)',
    'persisting a new lifecycle status machine',
    'treating user-recorded provider case refs as provider acknowledgement',
    'recomputing recovery amounts',
    're-enabling production writes',
  ],
} as const;

/**
 * 审计表：每个生命周期阶段只允许来自**已存在**的事实来源。
 * 本单元据此确认「无需新增重复状态机」；不存在的来源必须在投影里留空（fail-closed），不得发明。
 */
export const LIFECYCLE_FACT_SOURCES = [
  { stage: 'INTAKE', model: 'Case', field: 'status/openedAt' },
  { stage: 'EVIDENCE_INCOMPLETE', model: 'EvidenceArtifact + EvidenceResolution', field: 'status/missingKeys' },
  { stage: 'FOLLOW_UP_DRAFTED', model: 'FollowUpPackage', field: 'status=DRAFT' },
  { stage: 'EVIDENCE_COMPLETE', model: 'EvidenceResolution', field: 'status=FOUND(all required)' },
  { stage: 'PACKAGE_GENERATED', model: 'RecoveryPackage', field: 'status=GENERATED' },
  { stage: 'PACKAGE_EXPORTED', model: 'RecoveryPackage + RecoveryPackageArtifact', field: 'status=EXPORTED' },
  { stage: 'AWAITING_APPROVAL', model: 'FollowUpPackage.approval + AuditLog(recovery.review_approved)', field: 'approval.required' },
  { stage: 'SUBMISSION_RECORDED', model: 'RecoveryManualSubmission', field: 'submittedAt/approvalBasisReference' },
  { stage: 'PROVIDER_REFERENCE_RECORDED', model: 'RecoveryManualSubmissionReference', field: 'providerCaseRefCanonical' },
  { stage: 'PROVIDER_ACKNOWLEDGED', model: 'ProviderCaseFact / ProviderCaseProjection (verified source)', field: 'source∈{PROVIDER_VERIFIED,AUTHORITY_VERIFIED}' },
  { stage: 'SETTLED', model: 'Settlement + RecoveryPayout', field: 'confirmationStatus=CONFIRMED' },
  { stage: 'RECONCILED', model: 'Settlement(reconciliationStatus) / ReconciliationProjectionStatus', field: 'MATCHED/FULLY_RECONCILED' },
  { stage: 'CLOSED', model: 'Case', field: 'status=CLOSED/closedAt' },
] as const;
