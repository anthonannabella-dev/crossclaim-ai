// CUSTOMS / DUTY RECOVERY — slice B-S10 — Claim-Ready Package vNext + Customs high-value HITL
// ---------------------------------------------------------------------------
// 审计结论：既有 `customs-claim-ready-package.ts` 已经确定性装配 claim-ready 包，并已固化
//   filingPerformed=false / submissionPerformed=false / transportEnabled=false / estimateOnly=true / billable=false。
// 本 slice 不重写装配器，而是在其上增加 **vNext 包络**：
//   ① 重新断言内层包的非执行语义（若内层包声称已申报/可计费/非估算 → fail-closed）；
//   ② 接入 Customs high-value HITL（复用 A 部分 follow-up-package 的阈值与角色规则：
//      > USD 1000 → OWNER，≥ USD 10000 → ADMIN；**不得绕过**）；
//   ③ 输出可交给报关行的处置：BLOCKED_BY_GAPS / NEEDS_HUMAN_APPROVAL / CLAIM_READY_FOR_HANDOFF；
//   ④ 明确不伪称第三方物流（3PL）对账已完成。
// 硬边界：不申报、不提交、不外写、不计费、不算金额（金额一律由调用方提供，LLM 不参与）。

import { digestOf } from '../config-execution-durability/digests';
import {
  DEFAULT_ADMIN_APPROVAL_THRESHOLD_USD,
  DEFAULT_HIGH_VALUE_THRESHOLD_USD,
  FOLLOW_UP_APPROVAL_ROLES,
  type FollowUpApprovalRole,
} from '../provider-support/follow-up-package';
import type { CustomsClaimReadyPackage } from './customs-claim-ready-package';

export const CLAIM_READY_PACKAGE_VNEXT_VERSION = 'customs-claim-ready-package/vnext-1';

export const CLAIM_READY_VNEXT_DISPOSITIONS = [
  'BLOCKED_BY_GAPS',
  'NEEDS_HUMAN_APPROVAL',
  'CLAIM_READY_FOR_HANDOFF',
] as const;
export type ClaimReadyVNextDisposition = (typeof CLAIM_READY_VNEXT_DISPOSITIONS)[number];

export interface ClaimReadyApprovalRecord {
  approvalId: string;
  role: FollowUpApprovalRole;
  approvedAt: string;
}

export interface ClaimReadyPackageVNextInput {
  scope: { organizationId: string; platformAccountId: string };
  /** 既有确定性装配器的输出 */
  base: CustomsClaimReadyPackage;
  /** 预计可追回金额（USD）。由调用方提供；null/未提供 → 视为未知，不触发高价值分流 */
  estimatedRecoverableAmountUsd?: number | null;
  approvals?: readonly ClaimReadyApprovalRecord[];
  /** 任何试图绕过 high-value HITL 的调用（含自动化尝试）必须 fail-closed */
  requestBypassHighValueHitl?: boolean;
  /** 第三方物流（3PL）是否已完成对账 —— 不得伪称已完成 */
  thirdPartyLogisticsReconciliationPerformed?: boolean;
  highValueThresholdUsd?: number;
  adminApprovalThresholdUsd?: number;
  now: Date;
}

export interface ClaimReadyPackageVNext {
  kind: 'CUSTOMS_CLAIM_READY_PACKAGE_VNEXT';
  version: string;
  organizationId: string;
  platformAccountId: string;
  packageId: string;
  entryNumber: string;
  jurisdiction: string;
  baseReadiness: CustomsClaimReadyPackage['readiness'];
  gaps: readonly string[];
  disposition: ClaimReadyVNextDisposition;
  hitl: {
    required: boolean;
    role: 'OWNER' | 'ADMIN' | null;
    reasons: string[];
    satisfied: boolean;
    approvedBy: ClaimReadyApprovalRecord[];
    cannotBypass: true;
    thresholdUsd: number;
    adminThresholdUsd: number;
    amountUsd: number | null;
  };
  nonExecution: {
    estimateOnly: true;
    billable: false;
    filingPerformed: false;
    submissionPerformed: false;
    transportEnabled: false;
    productionCredentials: 'ABSENT';
    allowsAutoFiling: false;
  };
  thirdPartyLogistics: {
    reconciliationPerformed: false;
    mayClaimCompleted: false;
    note: string;
  };
  baseDigests: { inputDigest: string; resultDigest: string };
  reasonCodes: string[];
  evaluatedAt: string;
  vnextDigest: string;
}

export type ClaimReadyVNextErrorCode =
  | 'CLAIM_READY_VNEXT_BASE_CLAIMS_EXECUTION'
  | 'CLAIM_READY_VNEXT_CANNOT_BYPASS_HITL'
  | 'CLAIM_READY_VNEXT_CANNOT_CLAIM_3PL'
  | 'CLAIM_READY_VNEXT_NON_EXECUTION_VIOLATION';

export class ClaimReadyVNextError extends Error {
  readonly code: ClaimReadyVNextErrorCode;

  constructor(code: ClaimReadyVNextErrorCode, message: string) {
    super(message);
    this.name = 'ClaimReadyVNextError';
    this.code = code;
  }
}

/**
 * 组装 vNext 包络（确定性；不申报、不提交、不外写、不计费）。
 */
export function assembleClaimReadyPackageVNext(input: ClaimReadyPackageVNextInput): ClaimReadyPackageVNext {
  const base = input.base;

  // ① 内层包必须是「非执行、非计费、纯估算」——否则 fail-closed
  if (
    base.filingPerformed !== false ||
    base.submissionPerformed !== false ||
    base.transportEnabled !== false ||
    base.estimateOnly !== true ||
    base.billable !== false
  ) {
    throw new ClaimReadyVNextError(
      'CLAIM_READY_VNEXT_BASE_CLAIMS_EXECUTION',
      '内层 claim-ready 包声称已申报/可计费/非估算：拒绝装配 vNext。',
    );
  }

  // ② 不得伪称 3PL 已完成
  if (input.thirdPartyLogisticsReconciliationPerformed === true) {
    throw new ClaimReadyVNextError(
      'CLAIM_READY_VNEXT_CANNOT_CLAIM_3PL',
      '第三方物流（3PL）对账尚未发生，不得伪称已完成。',
    );
  }

  // ③ high-value HITL 不得绕过
  if (input.requestBypassHighValueHitl === true) {
    throw new ClaimReadyVNextError(
      'CLAIM_READY_VNEXT_CANNOT_BYPASS_HITL',
      'high-value HITL 不可绕过：自动化不得申请豁免。',
    );
  }

  const thresholdUsd = input.highValueThresholdUsd ?? DEFAULT_HIGH_VALUE_THRESHOLD_USD;
  const adminThresholdUsd = input.adminApprovalThresholdUsd ?? DEFAULT_ADMIN_APPROVAL_THRESHOLD_USD;
  const amountUsd = typeof input.estimatedRecoverableAmountUsd === 'number' ? input.estimatedRecoverableAmountUsd : null;

  const approvals = (input.approvals ?? []).filter((record) =>
    (FOLLOW_UP_APPROVAL_ROLES as readonly string[]).includes(record.role),
  );
  const isHighValue = amountUsd !== null && amountUsd > thresholdUsd;
  const requiredRole: 'OWNER' | 'ADMIN' | null = isHighValue
    ? amountUsd !== null && amountUsd >= adminThresholdUsd
      ? 'ADMIN'
      : 'OWNER'
    : null;

  const hitlReasons: string[] = [];
  if (isHighValue) {
    hitlReasons.push('HIGH_VALUE_CUSTOMS_CLAIM');
    if (requiredRole === 'ADMIN') hitlReasons.push('ABOVE_ADMIN_THRESHOLD');
  }
  if (base.readiness !== 'READY') hitlReasons.push('BASE_PACKAGE_NOT_READY');

  const approvalSatisfied =
    requiredRole === null ||
    approvals.some((record) => record.role === requiredRole || record.role === 'ADMIN');

  const reasonCodes: string[] = [];
  let disposition: ClaimReadyVNextDisposition;
  if (base.readiness !== 'READY') {
    disposition = 'BLOCKED_BY_GAPS';
    reasonCodes.push('BASE_PACKAGE_HAS_GAPS');
  } else if (!approvalSatisfied) {
    disposition = 'NEEDS_HUMAN_APPROVAL';
    reasonCodes.push('HIGH_VALUE_HITL_REQUIRED');
  } else {
    disposition = 'CLAIM_READY_FOR_HANDOFF';
    reasonCodes.push('READY_FOR_BROKER_HANDOFF');
  }
  if (isHighValue && approvalSatisfied) reasonCodes.push('HIGH_VALUE_HITL_SATISFIED');

  const body = {
    version: CLAIM_READY_PACKAGE_VNEXT_VERSION,
    organizationId: input.scope.organizationId,
    platformAccountId: input.scope.platformAccountId,
    packageId: base.packageId,
    entryNumber: base.entryNumber,
    jurisdiction: base.jurisdiction,
    baseReadiness: base.readiness,
    gaps: [...base.gaps],
    disposition,
    hitl: {
      required: isHighValue,
      role: requiredRole,
      reasons: hitlReasons,
      satisfied: approvalSatisfied,
      approvedBy: approvals.filter((record) => record.role === requiredRole || record.role === 'ADMIN'),
      cannotBypass: true as const,
      thresholdUsd,
      adminThresholdUsd,
      amountUsd,
    },
    nonExecution: {
      estimateOnly: true as const,
      billable: false as const,
      filingPerformed: false as const,
      submissionPerformed: false as const,
      transportEnabled: false as const,
      productionCredentials: 'ABSENT' as const,
      allowsAutoFiling: false as const,
    },
    thirdPartyLogistics: {
      reconciliationPerformed: false as const,
      mayClaimCompleted: false as const,
      note: '第三方物流（3PL）对账未发生；本包不得被表述为已完成 3PL 对账。',
    },
    baseDigests: { inputDigest: base.inputDigest, resultDigest: base.resultDigest },
    reasonCodes,
    evaluatedAt: input.now.toISOString(),
  };

  return {
    kind: 'CUSTOMS_CLAIM_READY_PACKAGE_VNEXT',
    ...body,
    vnextDigest: digestOf(body),
  };
}

export const CLAIM_READY_VNEXT_BOUNDARY = {
  estimateOnly: true,
  billable: false,
  filingPerformed: false,
  submissionPerformed: false,
  transportEnabled: false,
  allowsAutoFiling: false,
  productionCredentials: 'ABSENT',
  computesRecoverableAmount: false,
  highValueHitlCannotBeBypassed: true,
  thirdPartyLogisticsClaimForbidden: true,
  forbidden: [
    'filing or submitting the claim',
    'billing on an estimate',
    'bypassing high-value HITL',
    'claiming that a 3PL reconciliation was completed',
    'computing the recoverable amount inside this module',
  ],
} as const;

/** 边界断言：任何声称已执行 / 可计费 / 已绕过 HITL / 已 3PL 对账的记录都必须被拒绝 */
export function assertClaimReadyVNextIsNonExecuting(record: {
  disposition?: ClaimReadyVNextDisposition;
  nonExecution?: {
    estimateOnly?: boolean;
    billable?: boolean;
    filingPerformed?: boolean;
    submissionPerformed?: boolean;
    transportEnabled?: boolean;
    allowsAutoFiling?: boolean;
  };
  thirdPartyLogistics?: { reconciliationPerformed?: boolean; mayClaimCompleted?: boolean };
}): void {
  const nonExecution = record.nonExecution;
  if (
    (nonExecution !== undefined &&
      (nonExecution.estimateOnly !== true ||
        nonExecution.billable !== false ||
        nonExecution.filingPerformed !== false ||
        nonExecution.submissionPerformed !== false ||
        nonExecution.transportEnabled !== false ||
        nonExecution.allowsAutoFiling !== false)) ||
    record.thirdPartyLogistics?.reconciliationPerformed === true ||
    record.thirdPartyLogistics?.mayClaimCompleted === true ||
    (record.disposition !== undefined && !CLAIM_READY_VNEXT_DISPOSITIONS.includes(record.disposition))
  ) {
    throw new ClaimReadyVNextError(
      'CLAIM_READY_VNEXT_NON_EXECUTION_VIOLATION',
      'Claim-Ready Package vNext 必须保持「非执行 / 非计费 / 纯估算」，且不得伪称 3PL 对账已完成。',
    );
  }
}
