/**
 * 事务内审批边界重验（MSG-20260930-18 CHANGE B1）
 * -------------------------------------------------
 * 在**资金事务的锁内**用同一个事务客户端重验审批绑定与生命周期，避免"事务外核验通过后失效仍执行"。
 * 与 hitl-approval-verifier 使用相同的判定口径；区别只在于客户端（tx vs prisma）与返回形态。
 *
 * 返回：
 *   { ok: true, consumed?: boolean } —— ok=true 表示允许继续；consumed=true 表示已消费（走幂等返回）
 *   { ok: false, reason } —— 拒绝原因（与 APPROVAL_REASON_CODES 同名，另加 SOURCE_ERROR）
 */

import type { Prisma } from '@prisma/client';

export const APPROVAL_EVENT_ACTION = 'recovery.review_approved';
export const APPROVAL_REQUIRED_EVENT_ACTION = 'recovery.review_required';
export const APPROVAL_REJECTED_EVENT_ACTION = 'recovery.review_rejected';
export const APPROVAL_REVOKED_EVENT_ACTION = 'recovery.approval_revoked';
export const APPROVAL_CONSUMED_EVENT_ACTION = 'recovery.approval_consumed';

/**
 * P2（② 第二批）：支付域（payment.capture）的审批事件族。
 * 事件挂在 BillingInvoice 上；消费事件用独立名字，避免与 recovery 的消费计数混淆。
 */
export const PAYMENT_APPROVAL_EVENT_ACTION = 'payment.review_approved';
export const PAYMENT_REQUIRED_EVENT_ACTION = 'payment.review_required';
export const PAYMENT_REJECTED_EVENT_ACTION = 'payment.review_rejected';
export const PAYMENT_CONSUMED_EVENT_ACTION = 'payment.capture_consumed';

export interface ApprovalBoundaryQuery {
  organizationId: string;
  approvalId: string;
  action: string;
  caseId: string;
  /** 执行主体（R3：事务内必须核验其用户状态、成员身份与角色） */
  actorUserId: string;
  /** 规范化后的提交载荷（amount/currency/basisReference/evidenceArtifactId） */
  payload: { amount: string | null; currency: string | null; basisReference: string | null; evidenceArtifactId: string | null };
  now: Date;
  /** 审批/请求/撤销/消费事件族与目标实体（缺省 = recovery + Case，保持既有行为） */
  approvalEventAction?: string;
  requiredEventAction?: string;
  revocationEventActions?: readonly string[];
  consumedEventAction?: string;
  targetEntityType?: string;
}

export type ApprovalBoundaryResult = { ok: true; consumed: boolean } | { ok: false; reason: string };

/** 锁内审批核验失败（精确 reason 供 HTTP 映射） */
export class ApprovalBoundaryError extends Error {
  readonly code = 'APPROVAL_NOT_VERIFIED';
  readonly reason: string;
  constructor(reason: string, caseId: string) {
    super(`APPROVAL_NOT_VERIFIED: ${reason} (case=${caseId})`);
    this.name = 'ApprovalBoundaryError';
    this.reason = reason;
  }
}

type Client = Prisma.TransactionClient |
  {
    auditLog: Prisma.TransactionClient['auditLog'];
    user: Prisma.TransactionClient['user'];
    membership: Prisma.TransactionClient['membership'];
  };

function boundPayloadOf(changes: unknown): Record<string, unknown> | null {
  if (!changes || typeof changes !== 'object') return null;
  const bound = (changes as { boundPayload?: unknown }).boundPayload;
  return bound && typeof bound === 'object' ? (bound as Record<string, unknown>) : null;
}

/** 锁内重验：审批存在/归属/目标/动作/载荷/有效期/撤销/消费/轮次 */
export async function verifyApprovalBoundary(client: Client, query: ApprovalBoundaryQuery): Promise<ApprovalBoundaryResult> {
  const approvalAction = query.approvalEventAction ?? APPROVAL_EVENT_ACTION;
  const requiredAction = query.requiredEventAction ?? APPROVAL_REQUIRED_EVENT_ACTION;
  const revocationActions = query.revocationEventActions ?? [APPROVAL_REJECTED_EVENT_ACTION, APPROVAL_REVOKED_EVENT_ACTION];
  const consumedAction = query.consumedEventAction ?? APPROVAL_CONSUMED_EVENT_ACTION;
  const targetEntityType = query.targetEntityType ?? 'Case';
  try {
    const event = await client.auditLog.findFirst({
      where: { id: query.approvalId, organizationId: query.organizationId, action: approvalAction },
      select: { id: true, actorUserId: true, entityType: true, entityId: true, changes: true, createdAt: true },
    });
    if (!event) return { ok: false, reason: 'APPROVAL_NOT_FOUND' };
    if (event.entityType !== targetEntityType || event.entityId !== query.caseId) return { ok: false, reason: 'APPROVAL_TARGET_MISMATCH' };

    const changes = event.changes as Record<string, unknown> | null;
    const boundAction = typeof changes?.boundAction === 'string' ? changes.boundAction : null;
    if (boundAction !== query.action) return { ok: false, reason: 'APPROVAL_ACTION_MISMATCH' };

    // R3：审批人与执行人的有效用户状态、成员身份与角色（事务内）
    const approverUserId = typeof event.actorUserId === 'string' ? event.actorUserId : null;
    if (!approverUserId) return { ok: false, reason: 'APPROVAL_ACTOR_MISMATCH' };
    const approver = await client.user.findFirst({ where: { id: approverUserId, status: 'ACTIVE' }, select: { id: true } });
    const approverMember = await client.membership.findFirst({
      where: { organizationId: query.organizationId, userId: approverUserId, isActive: true },
      select: { role: true },
    });
    if (!approver || !approverMember || !['OWNER', 'ADMIN'].includes(approverMember.role)) {
      return { ok: false, reason: 'APPROVAL_ACTOR_MISMATCH' };
    }
    if (query.actorUserId) {
      const executor = await client.user.findFirst({ where: { id: query.actorUserId, status: 'ACTIVE' }, select: { id: true } });
      const executorMember = await client.membership.findFirst({
        where: { organizationId: query.organizationId, userId: query.actorUserId, isActive: true },
        select: { role: true },
      });
      if (!executor || !executorMember || !['OWNER', 'ADMIN', 'FINANCE'].includes(executorMember.role)) {
        return { ok: false, reason: 'APPROVAL_ACTOR_MISMATCH' };
      }
    } else {
      return { ok: false, reason: 'APPROVAL_ACTOR_MISMATCH' };
    }

    const bound = boundPayloadOf(event.changes);
    if (!bound) return { ok: false, reason: 'APPROVAL_PAYLOAD_MISMATCH' };
    // R3：读取时校验指纹版本（缺失或未知一律拒绝）
    if (bound.fingerprintVersion !== 'v1') return { ok: false, reason: 'APPROVAL_VERSION_UNSUPPORTED' };
    for (const key of ['amount', 'currency', 'basisReference', 'evidenceArtifactId'] as const) {
      if ((bound[key] ?? null) !== (query.payload[key] ?? null)) return { ok: false, reason: 'APPROVAL_PAYLOAD_MISMATCH' };
    }

    const expiresRaw = typeof changes?.expiresAt === 'string' ? changes.expiresAt : null;
    const expiresAt = expiresRaw ? new Date(expiresRaw) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) return { ok: false, reason: 'APPROVAL_SOURCE_ERROR' };
    if (query.now.getTime() >= expiresAt.getTime()) return { ok: false, reason: 'APPROVAL_EXPIRED' };

    const priorRequired = await client.auditLog.count({
      where: {
        organizationId: query.organizationId,
        entityType: targetEntityType,
        entityId: query.caseId,
        action: requiredAction,
        createdAt: { lt: event.createdAt },
      },
    });
    if (priorRequired === 0) return { ok: false, reason: 'APPROVAL_NOT_APPROVED' };

    const revocation = await client.auditLog.count({
      where: {
        organizationId: query.organizationId,
        entityType: targetEntityType,
        entityId: query.caseId,
        action: { in: [...revocationActions] },
        createdAt: { gt: event.createdAt },
      },
    });
    if (revocation > 0) return { ok: false, reason: 'APPROVAL_REVOKED' };

    // R2 CHANGE B2：审批之后若出现新的 REQUEST（新一轮），旧审批即失效
    const superseded = await client.auditLog.count({
      where: {
        organizationId: query.organizationId,
        entityType: targetEntityType,
        entityId: query.caseId,
        action: requiredAction,
        createdAt: { gt: event.createdAt },
      },
    });
    if (superseded > 0) return { ok: false, reason: 'APPROVAL_NOT_APPROVED' };

    const consumed = await client.auditLog.count({
      where: {
        organizationId: query.organizationId,
        action: consumedAction,
        changes: { path: ['approvalId'], equals: query.approvalId } as never,
      },
    });
    return { ok: true, consumed: consumed > 0 };
  } catch {
    return { ok: false, reason: 'APPROVAL_SOURCE_ERROR' };
  }
}
