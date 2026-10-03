/**
 * C-0008-B1 — role permission matrix (approved by the architecture review).
 *
 *   role     connections(write)  opportunity review  case create  claim text  claim amounts  billing view  billing advance
 *   OWNER         yes                yes                yes          yes           yes            yes            yes
 *   ADMIN         yes                yes                yes          yes           yes            yes            yes
 *   OPS           no                 yes                yes          yes           yes            yes            no
 *   FINANCE       no                 no                 no           no            no             yes            yes
 *   VIEWER        no                 no                 no           no            no             no             no
 *
 * Unknown roles fail closed (everything false).
 *
 * C-0011 追加（MSG-20260928-118）：
 *   role     claim item summary  claim evidence  claim item manage
 *   OWNER/ADMIN    yes                yes              yes
 *   OPS            yes                yes              yes
 *   FINANCE        yes（受限字段）      no               no
 *   VIEWER         no                 no               no
 *   —— FINANCE 只看 status / recoverableAmount / settlementRef，不得绕过证据边界。
 *
 * MSG-20260929-27 F2 追加（到账事实录入）：
 *   recoveryPayoutRecord = OWNER / ADMIN / FINANCE（到账登记属财务事实录入；OPS / VIEWER 不可）
 *   —— 与 Claim Tracking 分离：Claim Tracking 登记外部事件，Recovery Confirmation 登记资金到账事实。
 */

export const APP_ROLES = ['OWNER', 'ADMIN', 'OPS', 'FINANCE', 'VIEWER'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface PermissionMatrix {
  manageConnections: boolean;
  reviewOpportunities: boolean;
  createCase: boolean;
  /** 建案时填写/修改 successFeeRate（MSG-20260928-53 裁定 1：只有 OWNER / ADMIN 可以） */
  setCommercialTerms: boolean;
  viewClaimText: boolean;
  viewClaimAmounts: boolean;
  viewBilling: boolean;
  advanceBilling: boolean;
  /** C-0011：ClaimItem 汇总（FINANCE 受限字段可见） */
  viewClaimItemSummary: boolean;
  /** C-0011：证据联结元数据（FINANCE / VIEWER 不可见） */
  viewClaimEvidence: boolean;
  /** C-0011：建单 / 状态迁移 / 证据联结 */
  manageClaimItems: boolean;
  /** MSG-20260929-25 A1：Claim Tracking 记录提交 / 判定终局（仅 OWNER/ADMIN） */
  claimTrackingApprove: boolean;
  /** MSG-20260929-25 A1：Claim Tracking 录入外部回执 / 平台案件号（OWNER/ADMIN/OPS） */
  claimTrackingReceive: boolean;
  /** MSG-20260929-27 F2：录入到账事实 RecoveryPayout（OWNER/ADMIN/FINANCE） */
  recoveryPayoutRecord: boolean;
  /**
   * CARRIER QUEUE #9B FINAL（MSG-20261003-119 ㉔㉗）：记录「用户自称已人工提交 claim package」的事实。
   * 只是 human attestation（carrierConfirmationStatus = NOT_VERIFIED），不是 carrier 外写；
   * OWNER / ADMIN / OPS 可（与 claimTrackingReceive 同档），FINANCE / VIEWER 不可。
   */
  recordCarrierManualSubmission: boolean;
}

const DENY_ALL: PermissionMatrix = {
  manageConnections: false,
  reviewOpportunities: false,
  createCase: false,
  setCommercialTerms: false,
  viewClaimText: false,
  viewClaimAmounts: false,
  viewBilling: false,
  advanceBilling: false,
  viewClaimItemSummary: false,
  viewClaimEvidence: false,
  manageClaimItems: false,
  claimTrackingApprove: false,
  claimTrackingReceive: false,
  recoveryPayoutRecord: false,
  recordCarrierManualSubmission: false,
};

export const PERMISSIONS: Record<AppRole, PermissionMatrix> = {
  OWNER: {
    manageConnections: true,
    reviewOpportunities: true,
    createCase: true,
    setCommercialTerms: true,
    viewClaimText: true,
    viewClaimAmounts: true,
    viewBilling: true,
    advanceBilling: true,
    viewClaimItemSummary: true,
    viewClaimEvidence: true,
    manageClaimItems: true,
    claimTrackingApprove: true,
    claimTrackingReceive: true,
    recoveryPayoutRecord: true,
    recordCarrierManualSubmission: true,
  },
  ADMIN: {
    manageConnections: true,
    reviewOpportunities: true,
    createCase: true,
    setCommercialTerms: true,
    viewClaimText: true,
    viewClaimAmounts: true,
    viewBilling: true,
    advanceBilling: true,
    viewClaimItemSummary: true,
    viewClaimEvidence: true,
    manageClaimItems: true,
    claimTrackingApprove: true,
    claimTrackingReceive: true,
    recoveryPayoutRecord: true,
    recordCarrierManualSubmission: true,
  },
  OPS: {
    manageConnections: false,
    reviewOpportunities: true,
    createCase: true,
    setCommercialTerms: false,
    viewClaimText: true,
    viewClaimAmounts: true,
    viewBilling: true,
    advanceBilling: false,
    viewClaimItemSummary: true,
    viewClaimEvidence: true,
    manageClaimItems: true,
    claimTrackingApprove: false,
    claimTrackingReceive: true,
    recoveryPayoutRecord: false,
    recordCarrierManualSubmission: true,
  },
  FINANCE: {
    manageConnections: false,
    reviewOpportunities: false,
    createCase: false,
    setCommercialTerms: false,
    viewClaimText: false,
    viewClaimAmounts: false,
    viewBilling: true,
    advanceBilling: true,
    viewClaimItemSummary: true,
    viewClaimEvidence: false,
    manageClaimItems: false,
    claimTrackingApprove: false,
    claimTrackingReceive: false,
    recoveryPayoutRecord: true,
    recordCarrierManualSubmission: false,
  },
  VIEWER: { ...DENY_ALL },
};

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(permission: keyof PermissionMatrix) {
    super(`当前角色没有执行该操作的权限（${permission}）`);
    this.name = 'ForbiddenError';
  }
}

export function permissionsFor(role: string | null | undefined): PermissionMatrix {
  if (role && (APP_ROLES as readonly string[]).includes(role)) {
    return PERMISSIONS[role as AppRole];
  }
  return { ...DENY_ALL };
}

export function assertPermission(
  role: string | null | undefined,
  permission: keyof PermissionMatrix,
): void {
  if (!permissionsFor(role)[permission]) throw new ForbiddenError(permission);
}
