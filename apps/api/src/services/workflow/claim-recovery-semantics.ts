/**
 * TRACK A / PC-04 REVISE —— Claim 状态语义的**单一来源**（MSG-20261003-85 ④）。
 * ---------------------------------------------------------------
 * PC-03（claim package readiness）与 PC-04（claim recovery code）此前各自复制了一份
 * 「claim item status/closedReason → 客户可见含义」的判定，存在语义漂移风险。
 *
 * 本模块是唯一允许定义这份语义的位置：
 *   · `deriveClaimReadiness()`     —— PC-03 的 readiness 状态（客户可见）
 *   · `CLAIM_READINESS_TO_RECOVERY_CODE` —— readiness → PC-04 recovery code 的唯一映射
 *   · `deriveClaimRecoveryCode()`  —— PC-04 的 claim recovery code（复用同一映射）
 *   · `CLAIM_RECOVERY_SUMMARY`     —— recovery code 的客户可读安全摘要（唯一来源）
 *
 * 只读语义层：不访问数据库、不修改任何状态。
 */

export type ClaimPackageReadiness =
  | 'READY_TO_SUBMIT'
  | 'NEEDS_EVIDENCE'
  | 'NEEDS_REVIEW'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPEAL_REQUIRED';

export const READINESS_LABEL: Record<ClaimPackageReadiness, string> = {
  READY_TO_SUBMIT: '可提交（材料已就绪）',
  NEEDS_EVIDENCE: '还需补充材料',
  NEEDS_REVIEW: '需要人工复核',
  SUBMITTED: '已人工提交',
  ACKNOWLEDGED: '平台已受理',
  APPROVED: '已获批',
  REJECTED: '被拒绝',
  APPEAL_REQUIRED: '需要申诉',
};

/** claim 维度实际会暴露给客户的 recovery code 子集。 */
export type ClaimRecoveryCode = 'EVIDENCE_REQUIRED' | 'MANUAL_ACTION_REQUIRED' | 'APPEAL_REQUIRED';

/**
 * readiness → recovery code 的**唯一**映射。
 * `null` 表示该 readiness 不需要在恢复列表中提示（已提交 / 已获批 / 可提交）。
 */
export const CLAIM_READINESS_TO_RECOVERY_CODE: Record<ClaimPackageReadiness, ClaimRecoveryCode | null> = {
  READY_TO_SUBMIT: null,
  NEEDS_EVIDENCE: 'EVIDENCE_REQUIRED',
  NEEDS_REVIEW: 'MANUAL_ACTION_REQUIRED',
  SUBMITTED: null,
  ACKNOWLEDGED: null,
  APPROVED: null,
  REJECTED: 'APPEAL_REQUIRED',
  APPEAL_REQUIRED: 'APPEAL_REQUIRED',
};

/** recovery code 的客户可读安全摘要（唯一来源；不得含内部错误文本）。 */
export const CLAIM_RECOVERY_SUMMARY: Record<ClaimRecoveryCode, string> = {
  EVIDENCE_REQUIRED: '该案件中有主张尚未完成验证，可能需要补充材料。',
  MANUAL_ACTION_REQUIRED: '该案件中有主张需要人工复核。',
  APPEAL_REQUIRED: '该案件中有主张被拒绝，可进入申诉流程。',
};

export interface ClaimSemanticsItem {
  status: string;
  closedReason: string | null;
}

export interface ClaimReadinessContext {
  hasSubmission?: boolean;
  hasActivePackage?: boolean;
  missingItemsCount?: number;
}

/**
 * 由既有 claim item 事实推导客户可见 readiness（PC-03）。
 * 判定顺序与 MSG-83 ⑤5 冻结口径一致，未新增状态机。
 */
export function deriveClaimReadiness(
  items: readonly ClaimSemanticsItem[],
  context: ClaimReadinessContext = {},
): ClaimPackageReadiness {
  const statuses = items.map((item) => item.status);
  const closedReasons = items.map((item) => item.closedReason);

  if (statuses.includes('READY_TO_APPEAL') || closedReasons.includes('REJECTED')) {
    return 'APPEAL_REQUIRED';
  }
  if (statuses.includes('RECOVERED')) return 'APPROVED';
  if (context.hasSubmission || statuses.includes('SUBMITTED_MANUAL')) return 'SUBMITTED';
  // 与 PC-04 的 claim recovery code 共用同一判断：REVIEW_REQUIRED 就是「需要人工复核」。
  if (statuses.includes('REVIEW_REQUIRED')) return 'NEEDS_REVIEW';
  if (context.hasActivePackage === false) return 'NEEDS_REVIEW';
  if ((context.missingItemsCount ?? 0) > 0) return 'NEEDS_EVIDENCE';
  return 'READY_TO_SUBMIT';
}

/**
 * 由同一份语义推导 PC-04 的 claim recovery code（唯一来源）。
 * 注意：PC-04 只看「是否需要在恢复列表提示」，因此不传 package/submission 上下文 ——
 * 只有 NEEDS_EVIDENCE / NEEDS_REVIEW / APPEAL_REQUIRED 三类会返回 code。
 */
export function deriveClaimRecoveryCode(
  items: readonly ClaimSemanticsItem[],
): ClaimRecoveryCode | null {
  const statuses = items.map((item) => item.status);
  const closedReasons = items.map((item) => item.closedReason);

  if (statuses.includes('READY_TO_APPEAL') || closedReasons.includes('REJECTED')) {
    return CLAIM_READINESS_TO_RECOVERY_CODE.APPEAL_REQUIRED;
  }
  if (statuses.includes('REVIEW_REQUIRED')) {
    return CLAIM_READINESS_TO_RECOVERY_CODE.NEEDS_REVIEW;
  }
  if (statuses.includes('DISCOVERED')) {
    return CLAIM_READINESS_TO_RECOVERY_CODE.NEEDS_EVIDENCE;
  }
  return null;
}
