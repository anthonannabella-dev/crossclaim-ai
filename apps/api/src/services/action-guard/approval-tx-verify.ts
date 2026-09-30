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

export interface ApprovalBoundaryQuery {
  organizationId: string;
  approvalId: string;
  action: string;
  caseId: string;
  /** 规范化后的提交载荷（amount/currency/basisReference/evidenceArtifactId） */
  payload: { amount: string | null; currency: string | null; basisReference: string | null; evidenceArtifactId: string | null };
  now: Date;
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

type Client = Prisma.TransactionClient | { auditLog: Prisma.TransactionClient['auditLog'] };

function boundPayloadOf(changes: unknown): Record<string, unknown> | null {
  if (!changes || typeof changes !== 'object') return null;
  const bound = (changes as { boundPayload?: unknown }).boundPayload;
  return bound && typeof bound === 'object' ? (bound as Record<string, unknown>) : null;
}

/** 锁内重验：审批存在/归属/目标/动作/载荷/有效期/撤销/消费/轮次 */
export async function verifyApprovalBoundary(client: Client, query: ApprovalBoundaryQuery): Promise<ApprovalBoundaryResult> {
  try {
    const event = await client.auditLog.findFirst({
      where: { id: query.approvalId, organizationId: query.organizationId, action: APPROVAL_EVENT_ACTION },
      select: { id: true, entityType: true, entityId: true, changes: true, createdAt: true },
    });
    if (!event) return { ok: false, reason: 'APPROVAL_NOT_FOUND' };
    if (event.entityType !== 'Case' || event.entityId !== query.caseId) return { ok: false, reason: 'APPROVAL_TARGET_MISMATCH' };

    const changes = event.changes as Record<string, unknown> | null;
    const boundAction = typeof changes?.boundAction === 'string' ? changes.boundAction : null;
    if (boundAction !== query.action) return { ok: false, reason: 'APPROVAL_ACTION_MISMATCH' };

    const bound = boundPayloadOf(event.changes);
    if (!bound) return { ok: false, reason: 'APPROVAL_PAYLOAD_MISMATCH' };
    for (const key of ['amount', 'currency', 'basisReference', 'evidenceArtifactId'] as const) {
      if ((bound[key] ?? null) !== (query.payload[key] ?? null)) return { ok: false, reason: 'APPROVAL_PAYLOAD_MISMATCH' };
    }

    const expiresRaw = typeof changes?.expiresAt === 'string' ? changes.expiresAt : null;
    const expiresAt = expiresRaw ? new Date(expiresRaw) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) return { ok: false, reason: 'SOURCE_ERROR' };
    if (query.now.getTime() >= expiresAt.getTime()) return { ok: false, reason: 'APPROVAL_EXPIRED' };

    const priorRequired = await client.auditLog.count({
      where: {
        organizationId: query.organizationId,
        entityType: 'Case',
        entityId: query.caseId,
        action: APPROVAL_REQUIRED_EVENT_ACTION,
        createdAt: { lt: event.createdAt },
      },
    });
    if (priorRequired === 0) return { ok: false, reason: 'APPROVAL_NOT_APPROVED' };

    const revocation = await client.auditLog.count({
      where: {
        organizationId: query.organizationId,
        entityType: 'Case',
        entityId: query.caseId,
        action: { in: [APPROVAL_REJECTED_EVENT_ACTION, APPROVAL_REVOKED_EVENT_ACTION] },
        createdAt: { gt: event.createdAt },
      },
    });
    if (revocation > 0) return { ok: false, reason: 'APPROVAL_REVOKED' };

    const consumed = await client.auditLog.count({
      where: {
        organizationId: query.organizationId,
        action: APPROVAL_CONSUMED_EVENT_ACTION,
        changes: { path: ['approvalId'], equals: query.approvalId } as never,
      },
    });
    return { ok: true, consumed: consumed > 0 };
  } catch {
    return { ok: false, reason: 'SOURCE_ERROR' };
  }
}
