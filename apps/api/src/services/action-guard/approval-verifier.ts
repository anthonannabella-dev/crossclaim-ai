/**
 * ACTION GUARD — APPROVAL BINDING VERIFICATION（授权项 ② 第一批；MSG-20260930-16 §6）
 * ----------------------------------------------------------------------------------
 * 冻结要求（MSG-20260930-12 §5 / MSG-20260930-16 §6）：
 *   审批**不得仅凭非空 approvalId 放行**。服务端必须验证：
 *   租户、权限/主体、动作、目标对象或证据版本、有效期、撤销状态、消费状态。
 *
 * 本模块提供：
 *   - `ActionGuardApprovalVerifier` 端口（由业务侧注入真实实现；本模块不读 env、不写库）；
 *   - 稳定拒绝原因码；
 *   - `verifyApprovalOrThrow`：缺失/异常/无效一律 fail closed（抛类型化错误）。
 */

import { ACTION_GUARD_CATALOG } from './action-guard';

export const APPROVAL_REASON_CODES = [
  'APPROVAL_NOT_FOUND',
  'APPROVAL_NOT_APPROVED',
  'APPROVAL_REJECTED',
  'APPROVAL_TENANT_MISMATCH',
  'APPROVAL_ACTION_MISMATCH',
  'APPROVAL_ACTOR_MISMATCH',
  'APPROVAL_TARGET_MISMATCH',
  'APPROVAL_EXPIRED',
  'APPROVAL_REVOKED',
  'APPROVAL_ALREADY_CONSUMED',
] as const;
export type ApprovalReasonCode = (typeof APPROVAL_REASON_CODES)[number];

export interface ActionGuardApprovalQuery {
  approvalId: string;
  organizationId: string;
  action: string;
  actorUserId: string;
  /** 绑定的目标对象 / 证据版本等（可选；有值时服务端必须比对） */
  targetRef?: string;
  /** 判定时刻（便于测试与可复现） */
  now?: string;
}

export interface ActionGuardApprovalDecision {
  valid: boolean;
  reason?: ApprovalReasonCode;
  expiresAt?: string | null;
  consumedAt?: string | null;
  revokedAt?: string | null;
}

export interface ActionGuardApprovalVerifier {
  verify(query: ActionGuardApprovalQuery): Promise<ActionGuardApprovalDecision>;
}

export class ActionGuardApprovalVerificationError extends Error {
  readonly code: string;
  readonly approvalId: string;
  readonly action: string;
  readonly reason?: ApprovalReasonCode | 'VERIFIER_ERROR' | 'VERIFIER_MISSING';

  constructor(params: { code: string; approvalId: string; action: string; reason?: ApprovalReasonCode | 'VERIFIER_ERROR' | 'VERIFIER_MISSING' }) {
    super(`${params.code}: ${params.action}`);
    this.name = 'ActionGuardApprovalVerificationError';
    this.code = params.code;
    this.approvalId = params.approvalId;
    this.action = params.action;
    this.reason = params.reason;
  }
}

/** 该动作是否要求人工审批（由动作目录决定，不由调用方声明） */
export function actionRequiresHumanApproval(action: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(ACTION_GUARD_CATALOG, action)) return false;
  return ACTION_GUARD_CATALOG[action].requires.includes('humanApproval');
}

/**
 * 执行前校验审批绑定。约定：
 *   - 需要审批的动作：verifier 缺失 → VERIFIER_MISSING；抛异常 → VERIFIER_ERROR；valid=false → 带 reason；
 *   - 三种情况一律抛 `ActionGuardApprovalVerificationError`（fail closed，调用方不得继续执行副作用）。
 */
export async function verifyApprovalOrThrow(params: {
  verifier?: ActionGuardApprovalVerifier;
  query: ActionGuardApprovalQuery;
}): Promise<ActionGuardApprovalDecision> {
  const { verifier, query } = params;
  if (!verifier) {
    throw new ActionGuardApprovalVerificationError({
      code: 'ACTION_GUARD_APPROVAL_VERIFIER_MISSING',
      approvalId: query.approvalId,
      action: query.action,
      reason: 'VERIFIER_MISSING',
    });
  }

  let decision: ActionGuardApprovalDecision;
  try {
    decision = await verifier.verify(query);
  } catch {
    throw new ActionGuardApprovalVerificationError({
      code: 'ACTION_GUARD_APPROVAL_NOT_VERIFIED',
      approvalId: query.approvalId,
      action: query.action,
      reason: 'VERIFIER_ERROR',
    });
  }

  if (!decision || decision.valid !== true) {
    const reason = (decision?.reason ?? 'APPROVAL_NOT_FOUND') as ApprovalReasonCode;
    if (!APPROVAL_REASON_CODES.includes(reason)) {
      throw new ActionGuardApprovalVerificationError({
        code: 'ACTION_GUARD_APPROVAL_NOT_VERIFIED',
        approvalId: query.approvalId,
        action: query.action,
        reason: 'VERIFIER_ERROR',
      });
    }
    throw new ActionGuardApprovalVerificationError({
      code: 'ACTION_GUARD_APPROVAL_NOT_VERIFIED',
      approvalId: query.approvalId,
      action: query.action,
      reason,
    });
  }

  return decision;
}
