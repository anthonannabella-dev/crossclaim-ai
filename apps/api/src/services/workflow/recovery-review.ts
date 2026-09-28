/**
 * C-0009.2 Step 2 — high-value recovery human gate (audit-derived, no schema).
 * ---------------------------------------------------------------
 * Approved design (MSG-20260928-70):
 *   · gate      : before `confirmRecoveryOutcome` books money; amount above the
 *                 threshold requires an APPROVED review, otherwise the call fails
 *                 with 409 REVIEW_REQUIRED and **zero** money writes.
 *   · threshold : USD 1000.00 default, env-overridable. **Non-USD amounts are
 *                 always gated** (no FX in the money chain — architect ruling Q2).
 *   · roles     : request = OWNER/ADMIN/FINANCE; approve/reject = **OWNER/ADMIN**
 *                 (FINANCE is read-only here — architect ruling Q3).
 *   · state     : derived from AuditLog only — no RecoveryReview table, no new
 *                 fields. `approved` only counts when it is LATER than the most
 *                 recent `required` (explicit ordering invariant, Q6).
 *   · audit     : recovery.review_required / recovery.review_approved /
 *                 recovery.review_rejected (USER actor + actorUserId).
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

export const DEFAULT_HIGH_VALUE_THRESHOLD = '1000.0000';
export const REVIEW_ACTIONS = {
  required: 'recovery.review_required',
  approved: 'recovery.review_approved',
  rejected: 'recovery.review_rejected',
} as const;

export type HighValueReviewState = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReviewEvent {
  action: string;
  createdAt: Date;
  actorUserId?: string | null;
  changes?: unknown;
}

const money = (value: string | InstanceType<typeof Prisma.Decimal>): string =>
  new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

export function resolveHighValueThreshold(env: Record<string, string | undefined> = process.env): string {
  const raw = env.HITL_RECOVERY_THRESHOLD;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_HIGH_VALUE_THRESHOLD;
  try {
    const value = new Prisma.Decimal(raw.trim());
    if (!value.gte(0)) return DEFAULT_HIGH_VALUE_THRESHOLD;
    return money(value);
  } catch {
    return DEFAULT_HIGH_VALUE_THRESHOLD;
  }
}

/** USD 超过阈值才需要卡口；非 USD 一律人工处理（不做汇率换算）。 */
export function requiresHighValueReview(input: {
  recoveredAmount: string | InstanceType<typeof Prisma.Decimal>;
  currency: string;
  threshold: string;
}): boolean {
  if (input.currency !== 'USD') return true;
  return new Prisma.Decimal(input.recoveredAmount).gt(new Prisma.Decimal(input.threshold));
}

/**
 * 状态完全由审计事件推导，并带有顺序不变量：
 * 「已通过」只在 approved 的时间**晚于**最近一次 required 时成立。
 */
export function resolveHighValueReviewState(events: ReviewEvent[]): HighValueReviewState {
  const relevant = events
    .filter(
      (event) =>
        event.action === REVIEW_ACTIONS.required ||
        event.action === REVIEW_ACTIONS.approved ||
        event.action === REVIEW_ACTIONS.rejected,
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (relevant.length === 0) return 'NOT_REQUIRED';

  const last = relevant[relevant.length - 1];
  if (last.action === REVIEW_ACTIONS.approved) return 'APPROVED';
  if (last.action === REVIEW_ACTIONS.rejected) return 'REJECTED';
  return 'PENDING';
}

export interface RecoveryReviewStatus {
  caseId: string;
  state: HighValueReviewState;
  threshold: string;
  lastEventAt: Date | null;
  lastActorUserId: string | null;
}

async function loadEvents(
  prisma: PrismaClient,
  organizationId: string,
  caseId: string,
): Promise<ReviewEvent[]> {
  const rows = await prisma.auditLog.findMany({
    where: {
      organizationId,
      entityType: 'Case',
      entityId: caseId,
      action: { in: [REVIEW_ACTIONS.required, REVIEW_ACTIONS.approved, REVIEW_ACTIONS.rejected] },
    },
    orderBy: { createdAt: 'asc' },
    select: { action: true, createdAt: true, actorUserId: true, changes: true },
  });
  return rows;
}

export async function getRecoveryReviewStatus(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  caseId: string,
): Promise<RecoveryReviewStatus> {
  assertPermission(actor.role, 'viewClaimAmounts');

  const kase = await prisma.case.findFirst({
    where: { id: caseId, organizationId: actor.organizationId },
    select: { id: true },
  });
  if (!kase) {
    throw new WorkflowError('NOT_FOUND', `案件 ${caseId} 不存在或不属于该租户`);
  }

  const events = await loadEvents(prisma, actor.organizationId, caseId);
  const last = events.length > 0 ? events[events.length - 1] : null;
  return {
    caseId: kase.id,
    state: resolveHighValueReviewState(events),
    threshold: resolveHighValueThreshold(),
    lastEventAt: last?.createdAt ?? null,
    lastActorUserId: last?.actorUserId ?? null,
  };
}

export interface SubmitRecoveryReviewInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  caseId: string;
  decision: unknown;
  reason?: unknown;
  recoveredAmount?: unknown;
  currency?: unknown;
}

export interface SubmitRecoveryReviewResult extends RecoveryReviewStatus {
  decision: 'REQUEST' | 'APPROVE' | 'REJECT';
}

async function writeReviewAudit(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    actorUserId: string;
    caseId: string;
    action: string;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'Case',
      entityId: input.caseId,
      changes: input.changes,
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
      createdAt: input.at,
    },
  });
}

export async function submitRecoveryReview(
  prisma: PrismaClient,
  input: SubmitRecoveryReviewInput,
  now: () => Date = () => new Date(),
): Promise<SubmitRecoveryReviewResult> {
  const decision =
    typeof input.decision === 'string' ? input.decision.trim().toUpperCase() : '';
  if (decision !== 'REQUEST' && decision !== 'APPROVE' && decision !== 'REJECT') {
    throw new WorkflowError('INVALID_INPUT', 'decision 必须是 REQUEST / APPROVE / REJECT');
  }

  // Q3：发起可由 OWNER/ADMIN/FINANCE；审批只允许 OWNER/ADMIN（FINANCE 只读）
  if (decision === 'REQUEST') {
    assertPermission(input.role, 'advanceBilling');
  } else {
    assertPermission(input.role, 'setCommercialTerms');
    assertPermission(input.role, 'advanceBilling');
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (decision === 'REJECT' && reason === '') {
    throw new WorkflowError('REASON_REQUIRED', 'REJECT 必须给出 reason');
  }

  const kase = await prisma.case.findFirst({
    where: { id: input.caseId, organizationId: input.organizationId },
    select: { id: true, caseNo: true },
  });
  if (!kase) {
    throw new WorkflowError('NOT_FOUND', `案件 ${input.caseId} 不存在或不属于该租户`);
  }

  const threshold = resolveHighValueThreshold();
  const at = now();

  return prisma.$transaction(async (tx) => {
    const events = await tx.auditLog.findMany({
      where: {
        organizationId: input.organizationId,
        entityType: 'Case',
        entityId: kase.id,
        action: { in: [REVIEW_ACTIONS.required, REVIEW_ACTIONS.approved, REVIEW_ACTIONS.rejected] },
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true, actorUserId: true, changes: true },
    });
    const state = resolveHighValueReviewState(events);

    if (decision === 'REQUEST') {
      if (state === 'PENDING') {
        throw new WorkflowError('ILLEGAL_TRANSITION', '该案件已处于待审批状态');
      }
      await writeReviewAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        caseId: kase.id,
        action: REVIEW_ACTIONS.required,
        changes: {
          caseNo: kase.caseNo,
          threshold,
          ...(typeof input.recoveredAmount === 'string'
            ? { recoveredAmount: money(input.recoveredAmount) }
            : {}),
          ...(typeof input.currency === 'string' ? { currency: input.currency } : {}),
        },
        at,
      });
      return {
        caseId: kase.id,
        state: 'PENDING' as HighValueReviewState,
        threshold,
        lastEventAt: at,
        lastActorUserId: input.actorUserId,
        decision: 'REQUEST' as const,
      };
    }

    // APPROVE / REJECT 必须建立在"当前有待审批请求"之上（顺序不变量）
    if (state !== 'PENDING') {
      throw new WorkflowError(
        'ILLEGAL_TRANSITION',
        `当前状态 ${state} 不允许审批（必须先有待审批请求）`,
      );
    }

    const action = decision === 'APPROVE' ? REVIEW_ACTIONS.approved : REVIEW_ACTIONS.rejected;
    await writeReviewAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      caseId: kase.id,
      action,
      changes: {
        caseNo: kase.caseNo,
        threshold,
        ...(reason ? { reason } : {}),
      },
      at,
    });

    return {
      caseId: kase.id,
      state: decision === 'APPROVE' ? ('APPROVED' as HighValueReviewState) : ('REJECTED' as HighValueReviewState),
      threshold,
      lastEventAt: at,
      lastActorUserId: input.actorUserId,
      decision: decision as 'APPROVE' | 'REJECT',
    };
  });
}

/**
 * confirmRecoveryOutcome 使用的闸门：超阈值且未通过审批时，
 * 写一条 review_required 审计并抛 409 REVIEW_REQUIRED（不写任何资金记录）。
 */
export async function assertHighValueReviewCleared(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    caseId: string;
    caseNo: string;
    recoveredAmount: InstanceType<typeof Prisma.Decimal>;
    currency: string;
  },
  now: () => Date = () => new Date(),
): Promise<void> {
  const threshold = resolveHighValueThreshold();
  const needsReview = requiresHighValueReview({
    recoveredAmount: input.recoveredAmount,
    currency: input.currency,
    threshold,
  });
  if (!needsReview) return;

  const events = await loadEvents(prisma, input.organizationId, input.caseId);
  const state = resolveHighValueReviewState(events);
  if (state === 'APPROVED') return;

  // 记录一次"需要复核"，供审批者处理（同一状态重复触发也各留一条，便于审计）
  const at = now();
  await prisma.$transaction(async (tx) => {
    await writeReviewAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      caseId: input.caseId,
      action: REVIEW_ACTIONS.required,
      changes: {
        caseNo: input.caseNo,
        recoveredAmount: money(input.recoveredAmount),
        currency: input.currency,
        threshold,
        previousState: state,
      },
      at,
    });
  });

  throw new WorkflowError(
    'REVIEW_REQUIRED',
    `金额 ${money(input.recoveredAmount)} ${input.currency} 超过高额阈值 ${threshold}，需要 OWNER/ADMIN 复核通过后才能确认回收`,
  );
}
