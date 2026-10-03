/**
 * CARRIER QUEUE #9B（MSG-20261003-118 ⑲–㊴）— MANUAL SUBMISSION RECORD + HUMAN ATTESTATION。
 * ---------------------------------------------------------------
 * 目标：当**用户自己**已经在 carrier 官方渠道人工提交之后，安全地记录「人声称完成了提交」这一事实。
 * 核心区分（⑳）：human attestation ≠ carrier-confirmed submission。
 *   · 只能形成 HUMAN_REPORTED_SUBMITTED / carrierConfirmationStatus = NOT_VERIFIED；
 *     **不得**产生 CARRIER_CONFIRMED / ACCEPTED / APPROVED / RECOVERED。
 *   · 本单元不提交任何 claim：carrierWritePerformed=false · transportEnabled=false · platformWriteEnabled=false。
 * 硬边界：
 *   · 只有 packageStatus = READY_FOR_MANUAL_SUBMISSION + packageCompleteness = COMPLETE + manualSubmissionRequired
 *     + claimSubmissionPerformed=false 才允许记录；NEEDS_REVIEW 一律拒绝。
 *   · 身份（organizationId / submittedByUserId / role·capability）必须 **server-derived**（调用方从已认证会话派生）；
 *     client 只能提交 carrierReference? / reportedCarrierSubmissionAt? / note?。
 *   · package 事实（provider / account / tracking / rule versions）必须由 **server-side package truth** 绑定。
 *   · 幂等：同 (organizationId + packageId) 最多一条 active record；重复请求返回 ALREADY_RECORDED。
 *   · 核心事实 immutable；更正走 amendment/audit event（本文件不提供覆盖写）。
 *   · 不修改 RecoveryPayout / actualRecovered / Settlement recovered cash truth；不产生 successFee。
 * 说明：本文件是**契约层**（纯服务 + 注入端口），不含 Schema / DB / HTTP 绑定；持久化与路由需另行 Schema Delta 审核。
 */

import { createHash } from 'node:crypto';

import type { CarrierProvider } from './connector-capability';
import type { CarrierClaimPackage } from './carrier-claim-package';

/** ⑲㉔ 记录人工提交所需的 capability（走既有 RBAC / Action Guard 模式）。 */
export const CARRIER_MANUAL_SUBMISSION_CAPABILITY = 'carrier.claim_package.manual_submission.record';

/** ㉗ Action Guard 动作名（已注册：INTERNAL_WRITE + workflow kill switch + enforced actions）。 */
export const CARRIER_MANUAL_SUBMISSION_ACTION = 'carrier.manual_submission.record';

/** ㉗ 审计事件名（不使用 CLAIM_SUBMITTED_CONFIRMED）。 */
export const CARRIER_MANUAL_SUBMISSION_AUDIT_EVENT = 'carrier.manual_submission_recorded';

/** ㉝ 未收到真实 carrier 响应前恒为 NOT_VERIFIED。 */
export const CARRIER_CONFIRMATION_STATUSES = ['NOT_VERIFIED'] as const;
export type CarrierConfirmationStatus = (typeof CARRIER_CONFIRMATION_STATUSES)[number];

/** ㉙ 用户提供的 reference 一律标记为未经核验。 */
export const CARRIER_REFERENCE_PROVENANCE = ['USER_PROVIDED_UNVERIFIED'] as const;
export type CarrierReferenceProvenance = (typeof CARRIER_REFERENCE_PROVENANCE)[number];

/** ㊱ client 只能提交这三个字段（不含任何身份/package 事实）。 */
export interface CarrierManualSubmissionRequest {
  carrierReference?: string | null;
  reportedCarrierSubmissionAt?: string | null;
  note?: string | null;
}

/** ㉓ server-derived 上下文（从已认证会话与租户上下文中派生，绝不来自 client body）。 */
export interface CarrierManualSubmissionContext {
  organizationId: string;
  actorUserId: string;
  actorCapabilities: readonly string[];
}

export interface CarrierManualSubmissionHumanAttestation {
  submitted: true;
  carrierReference: string | null;
  carrierReferenceProvenance: CarrierReferenceProvenance | null;
  reportedCarrierSubmissionAt: string | null;
  note: string | null;
}

export interface CarrierManualSubmissionRecord {
  submissionRecordId: string;
  packageId: string;
  bundleId: string;
  organizationId: string;
  provider: CarrierProvider;
  externalAccountId: string;
  trackingNumber: string;
  submittedByUserId: string;
  /** ㉘ server timestamp（记录事实发生时间）。 */
  submittedAt: string;
  recordedAt: string;
  submissionMode: 'MANUAL';
  channel: string;
  humanAttestation: CarrierManualSubmissionHumanAttestation;
  carrierConfirmationStatus: CarrierConfirmationStatus;
  packageSnapshotReference: string;
  eligibilityRuleSetId: string;
  eligibilityRuleSetVersion: string;
  estimateRuleSetId: string;
  estimateRuleSetVersion: string;
  humanRecorded: true;
  carrierWritePerformed: false;
  transportEnabled: false;
  platformWriteEnabled: false;
  productionCredentials: 'ABSENT';
}

/** ㉕ server-side package truth（按 tenant + packageId 读取，不接受 client snapshot）。 */
export interface CarrierClaimPackageSource {
  load(organizationId: string, packageId: string): Promise<CarrierClaimPackage | null>;
}

/** ㉚㊲ 存储端口：create 必须对 (organizationId, packageId) 原子（unique / CAS）。 */
export interface CarrierManualSubmissionStore {
  /**
   * MSG-20261003-119 ㉛：若 store 在同一事务内写入 business audit（复用既有 audit primitive），
   * 则置为 true —— 此时 service 不再单独 emit，避免「row 已建但 audit 永久缺失」的窗口。
   */
  readonly handlesAuditAtomically?: boolean;
  find(organizationId: string, packageId: string): Promise<CarrierManualSubmissionRecord | null>;
  create(record: CarrierManualSubmissionRecord): Promise<{ created: boolean; record: CarrierManualSubmissionRecord }>;
}

/** ㉜ 审计端口（不记录 credential / raw claim payload）。 */
export interface CarrierManualSubmissionAuditEvent {
  event: string;
  organizationId: string;
  actorUserId: string;
  packageId: string;
  submissionRecordId: string;
  trackingNumber: string;
  recordedAt: string;
  result: string;
}

export interface CarrierManualSubmissionAuditSink {
  emit(event: CarrierManualSubmissionAuditEvent): Promise<void>;
}

export type CarrierManualSubmissionFailureCode =
  | 'INVALID_REQUEST'
  | 'CAPABILITY_REQUIRED'
  | 'PACKAGE_NOT_FOUND'
  | 'TENANT_MISMATCH'
  | 'PACKAGE_NOT_READY';

export type CarrierManualSubmissionOutcome =
  | { ok: true; status: 'RECORDED' | 'ALREADY_RECORDED'; record: CarrierManualSubmissionRecord }
  | { ok: false; reason: CarrierManualSubmissionFailureCode };

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 记录 human attestation（纯契约服务；端口由调用方注入）。
 *   · 幂等：已存在 record → ALREADY_RECORDED（不产生第二条 submitted fact，不重复审计）。
 *   · create 返回 created=false（并发竞争失败）→ ALREADY_RECORDED 并返回既有 record。
 */
export async function recordCarrierManualSubmission(
  input: {
    packageId: string;
    request: CarrierManualSubmissionRequest;
    context: CarrierManualSubmissionContext;
  },
  deps: {
    packages: CarrierClaimPackageSource;
    store: CarrierManualSubmissionStore;
    audit: CarrierManualSubmissionAuditSink;
    now: () => Date;
  },
): Promise<CarrierManualSubmissionOutcome> {
  const packageId = normalizeText(input.packageId);
  const organizationId = normalizeText(input.context.organizationId);
  const actorUserId = normalizeText(input.context.actorUserId);
  if (packageId === null || organizationId === null || actorUserId === null) {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }

  if (!input.context.actorCapabilities.includes(CARRIER_MANUAL_SUBMISSION_CAPABILITY)) {
    return { ok: false, reason: 'CAPABILITY_REQUIRED' };
  }

  // ㉕㉖ 以 server-side package truth 为准重新读取（不接受 client snapshot）。
  const pkg = await deps.packages.load(organizationId, packageId);
  if (pkg === null) return { ok: false, reason: 'PACKAGE_NOT_FOUND' };
  if (pkg.organizationId !== organizationId) return { ok: false, reason: 'TENANT_MISMATCH' };

  const ready =
    pkg.packageStatus === 'READY_FOR_MANUAL_SUBMISSION' &&
    pkg.packageCompleteness === 'COMPLETE' &&
    pkg.manualSubmissionRequired === true &&
    pkg.claimSubmissionPerformed === false;
  if (!ready) return { ok: false, reason: 'PACKAGE_NOT_READY' };

  // ㉚ 幂等：已存在 active record → 返回既有事实。
  const existing = await deps.store.find(organizationId, packageId);
  if (existing !== null) return { ok: true, status: 'ALREADY_RECORDED', record: existing };

  const now = deps.now();
  const recordedAt = now.toISOString();
  const carrierReference = normalizeText(input.request.carrierReference);
  const reportedCarrierSubmissionAt = normalizeText(input.request.reportedCarrierSubmissionAt);
  const note = normalizeText(input.request.note);

  const record: CarrierManualSubmissionRecord = {
    // 逻辑幂等 identity 仍是 (organizationId, packageId)；记录 id 用其确定性哈希
    // （短且无控制字符，可安全作为 audit entityId；相同输入 → 相同 id）。
    submissionRecordId: 'cms-' + createHash('sha256').update(organizationId + '|' + packageId).digest('hex').slice(0, 32),
    packageId: pkg.packageId,
    bundleId: pkg.bundleId,
    organizationId,
    provider: pkg.provider,
    externalAccountId: pkg.externalAccountId,
    trackingNumber: pkg.trackingNumber,
    submittedByUserId: actorUserId,
    // ㉘ submittedAt 使用 server timestamp；用户自报的过去时间单独标注。
    submittedAt: recordedAt,
    recordedAt,
    submissionMode: 'MANUAL',
    channel: pkg.submissionDestination.channel,
    humanAttestation: {
      submitted: true,
      carrierReference,
      carrierReferenceProvenance: carrierReference === null ? null : 'USER_PROVIDED_UNVERIFIED',
      reportedCarrierSubmissionAt,
      note,
    },
    carrierConfirmationStatus: 'NOT_VERIFIED',
    packageSnapshotReference: pkg.packageId,
    eligibilityRuleSetId: pkg.eligibilityReference.ruleSetId,
    eligibilityRuleSetVersion: pkg.eligibilityReference.ruleSetVersion,
    estimateRuleSetId: pkg.estimateRuleSetId,
    estimateRuleSetVersion: pkg.estimateRuleSetVersion,
    humanRecorded: true,
    carrierWritePerformed: false,
    transportEnabled: false,
    platformWriteEnabled: false,
    productionCredentials: 'ABSENT',
  };

  const created = await deps.store.create(record);
  if (!created.created) return { ok: true, status: 'ALREADY_RECORDED', record: created.record };

  // ㉜ 审计恰好一次（仅真实创建时）；store 若已同事务写入 business audit 则跳过（㉛）。
  if (deps.store.handlesAuditAtomically !== true) {
    await deps.audit.emit({
    event: CARRIER_MANUAL_SUBMISSION_AUDIT_EVENT,
    organizationId,
    actorUserId,
    packageId: pkg.packageId,
    submissionRecordId: record.submissionRecordId,
    trackingNumber: pkg.trackingNumber,
    recordedAt,
      result: 'RECORDED',
    });
  }

  return { ok: true, status: 'RECORDED', record: created.record };
}
