/**
 * C-0008-B1 — human review of detected opportunities.
 * ---------------------------------------------------------------
 * Approved state machine (unchanged from earlier gates):
 *
 *   DETECTED → QUALIFIED   (human confirmation)
 *   DETECTED → REJECTED    (human rejection, reason required)
 *
 * DETECTED → CONVERTED is impossible here: conversion only happens when a case
 * is created (C-0008-B2, reusing Recovery Closure).
 *
 * Every transition writes its AuditLog row **inside the same transaction** as the
 * UPDATE, with actorType=USER and actorUserId=the signed-in user.
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { assertPermission } from './permissions';

export const REJECT_REASONS = ['wrong_amount', 'duplicate', 'not_recoverable', 'other'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export type WorkflowErrorCode =
  | 'NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'REASON_REQUIRED'
  | 'INVALID_REASON'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'SECRET_NOT_ACCEPTED'
  | 'PLATFORM_NOT_REGISTERED'
  | 'DUPLICATE_CONNECTION'
  | 'INVALID_COMMERCIAL_TERMS'
  | 'SCOPE_NOT_SUPPORTED'
  | 'CASE_NOT_CREATED'
  | 'INVALID_FIELD'
  | 'COMMERCIAL_TERMS_PENDING'
  | 'CLAIM_NOT_APPROVED'
  | 'CURRENCY_MISMATCH'
  | 'PAYMENT_REFERENCE_REQUIRED'
  | 'REVIEW_REQUIRED';

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

export interface ReviewOpportunityInput {
  organizationId: string;
  opportunityId: string;
  actorUserId: string;
  role: string;
  decision: 'QUALIFY' | 'REJECT';
  /** Required when decision = REJECT; must be one of REJECT_REASONS. */
  reason?: string;
}

export interface ReviewOpportunityResult {
  opportunityId: string;
  from: 'DETECTED';
  to: 'QUALIFIED' | 'REJECTED';
  reason: RejectReason | null;
}

/** The reviewable status is the only entry point of this transition. */
export const REVIEWABLE_STATUS = 'DETECTED' as const;

export async function reviewOpportunity(
  prisma: PrismaClient,
  input: ReviewOpportunityInput,
  now: () => Date = () => new Date(),
): Promise<ReviewOpportunityResult> {
  assertPermission(input.role, 'reviewOpportunities');

  let reason: RejectReason | null = null;
  if (input.decision === 'REJECT') {
    const raw = input.reason?.trim() ?? '';
    if (raw === '') {
      throw new WorkflowError('REASON_REQUIRED', '拒绝机会必须给出原因');
    }
    if (!(REJECT_REASONS as readonly string[]).includes(raw)) {
      throw new WorkflowError('INVALID_REASON', `拒绝原因非法：${raw}`);
    }
    reason = raw as RejectReason;
  }

  const at = now();
  const to = input.decision === 'QUALIFY' ? 'QUALIFIED' : 'REJECTED';

  return prisma.$transaction(async (tx) => {
    // C-0008-B1 REVISE（MSG-20260928-51）：必须用数据库原子 CAS，
    // 不能「先读 DETECTED 再按 id 更新」——否则两个并发 qualify/reject
    // 会同时读到 DETECTED 并双双成功，造成 lost update 与虚假审计。
    const updated = await tx.recoveryOpportunity.updateMany({
      where: {
        id: input.opportunityId,
        organizationId: input.organizationId,
        status: REVIEWABLE_STATUS,
      },
      data:
        to === 'QUALIFIED'
          ? { status: to, qualifiedAt: at, rejectedReason: null }
          : { status: to, rejectedReason: reason },
    });

    if (updated.count === 0) {
      // 区分「不存在/跨租户」与「状态已不是 DETECTED」；此处只读，不再写。
      const current = await tx.recoveryOpportunity.findFirst({
        where: { id: input.opportunityId, organizationId: input.organizationId },
        select: { status: true },
      });
      if (!current) {
        throw new WorkflowError('NOT_FOUND', `机会 ${input.opportunityId} 不存在或不属于该租户`);
      }
      throw new WorkflowError(
        'ILLEGAL_TRANSITION',
        `机会状态 ${current.status} 不允许人工复核（只有 DETECTED 可以）`,
      );
    }

    // Same transaction as the state change (C-0008-B1 ruling).
    const row = prepareAuditInsert(
      {
        organizationId: input.organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'opportunity.status_changed',
        entityType: 'RecoveryOpportunity',
        entityId: input.opportunityId,
        changes: {
          // CAS 命中即代表迁移前状态就是 DETECTED。
          from: REVIEWABLE_STATUS,
          to,
          decision: input.decision,
          ...(reason ? { reason } : {}),
        },
      },
      { maxStringLength: 512 },
    );
    await tx.auditLog.create({
      data: {
        organizationId: row.organizationId,
        actorType: row.actorType,
        actorUserId: row.actorUserId,
        actorRef: row.actorRef,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: at,
      },
    });

    return { opportunityId: input.opportunityId, from: REVIEWABLE_STATUS, to, reason };
  });
}
