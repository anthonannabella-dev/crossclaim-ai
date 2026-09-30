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

/**
 * 受保护动作名（单一来源）：回收资金确认（POST /cases/:id/recovery-outcome）。
 * 非守卫文件必须引用本常量，不得散落动作字面量（有限静态约定检查要求）。
 */
export const RECOVERY_CONFIRMATION_ACTION = 'commission.charge';

/**
 * 受保护动作名（单一来源）：支付捕获/资金确认（POST /billing/:id/status、/payments/events/:id/replay、
 * /payments/processing/retry-due）。非守卫文件必须引用本常量（② 第二批 P1）。
 */
export const PAYMENT_CAPTURE_ACTION = 'payment.capture';

/**
 * 受保护动作名（单一来源）：支付事件重放（POST /payments/events/:id/replay，② 第二批 replay）。
 * 与 PAYMENT_CAPTURE_ACTION 分开：账单确认审批不得用于 replay，反之亦然。
 */
export const PAYMENT_REPLAY_ACTION = 'payment.replay';

export const APPROVAL_REASON_CODES = [
  'APPROVAL_NOT_FOUND',
  'APPROVAL_NOT_APPROVED',
  'APPROVAL_REJECTED',
  'APPROVAL_TENANT_MISMATCH',
  'APPROVAL_ACTION_MISMATCH',
  'APPROVAL_ACTOR_MISMATCH',
  'APPROVAL_PAYLOAD_MISMATCH',
  'APPROVAL_VERSION_UNSUPPORTED',
  'APPROVAL_SOURCE_ERROR',
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
  /** 本次提交的操作载荷（服务端会规范化后与审批绑定逐项比对） */
  payload?: {
    recoveredAmount?: unknown;
    currency?: unknown;
    basisReference?: unknown;
    evidenceArtifactId?: unknown;
  };
  /** 判定时刻（便于测试与可复现） */
  now?: string;
}

export interface ActionGuardApprovalDecision {
  valid: boolean;
  /** 该审批已被消费；valid=true 表示允许进入"幂等返回既有结果"分支（不是新的执行授权） */
  consumed?: boolean;
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
  readonly reason?: ApprovalReasonCode | 'VERIFIER_ERROR' | 'VERIFIER_MISSING' | 'AUDIT_UNAVAILABLE';

  constructor(params: {
    code: string;
    approvalId: string;
    action: string;
    reason?: ApprovalReasonCode | 'VERIFIER_ERROR' | 'VERIFIER_MISSING' | 'AUDIT_UNAVAILABLE';
  }) {
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
