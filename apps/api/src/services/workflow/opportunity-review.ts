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
  | 'FORBIDDEN';

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
    const opportunity = await tx.recoveryOpportunity.findFirst({
      where: { id: input.opportunityId, organizationId: input.organizationId },
      select: { id: true, status: true },
    });
    if (!opportunity) {
      throw new WorkflowError('NOT_FOUND', `机会 ${input.opportunityId} 不存在或不属于该租户`);
    }
    if (opportunity.status !== REVIEWABLE_STATUS) {
      throw new WorkflowError(
        'ILLEGAL_TRANSITION',
        `机会状态 ${opportunity.status} 不允许人工复核（只有 DETECTED 可以）`,
      );
    }

    await tx.recoveryOpportunity.update({
      where: { id: opportunity.id },
      data:
        to === 'QUALIFIED'
          ? { status: to, qualifiedAt: at, rejectedReason: null }
          : { status: to, rejectedReason: reason },
    });

    // Same transaction as the state change (C-0008-B1 ruling).
    const row = prepareAuditInsert(
      {
        organizationId: input.organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'opportunity.status_changed',
        entityType: 'RecoveryOpportunity',
        entityId: opportunity.id,
        changes: {
          from: opportunity.status,
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

    return { opportunityId: opportunity.id, from: REVIEWABLE_STATUS, to, reason };
  });
}
