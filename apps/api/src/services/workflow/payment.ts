/**
 * C-0010-A — Payment domain (customer pays our service fee).
 * ---------------------------------------------------------------
 * Approved plan (MSG-20260928-80):
 *   · only the webhook may推进 `BillingInvoice(ISSUED → PAID)`, via CAS;
 *   · amount + currency must equal the invoice exactly, otherwise
 *     `payment.reconciliation_failed` and no state change;
 *   · high-value invoices require a **Payment HITL** approval first
 *     (`payment.review_*` — a separate audit domain from `recovery.review_*`);
 *   · `Payment` rows are append-only; `Settlement` is never touched;
 *   · thresholds come from the environment (`PAYMENT_REVIEW_THRESHOLD`).
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

export const DEFAULT_PAYMENT_REVIEW_THRESHOLD = '1000.0000';
export const PAYMENT_REVIEW_ACTIONS = {
  required: 'payment.review_required',
  approved: 'payment.review_approved',
  rejected: 'payment.review_rejected',
} as const;

export type PaymentReviewState = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

const money = (value: string | InstanceType<typeof Prisma.Decimal>): string =>
  new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

export function resolvePaymentReviewThreshold(env: Record<string, string | undefined> = process.env): string {
  const raw = env.PAYMENT_REVIEW_THRESHOLD;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PAYMENT_REVIEW_THRESHOLD;
  try {
    const value = new Prisma.Decimal(raw.trim());
    if (!value.gte(0)) return DEFAULT_PAYMENT_REVIEW_THRESHOLD;
    return money(value);
  } catch {
    return DEFAULT_PAYMENT_REVIEW_THRESHOLD;
  }
}

export function paymentsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PAYMENTS_ENABLED === 'true' || env.PAYMENTS_ENABLED === '1';
}

/** USD 超过阈值才需要复核；非 USD 一律人工（与追回侧口径一致）。 */
export function requiresPaymentReview(input: {
  amount: string | InstanceType<typeof Prisma.Decimal>;
  currency: string;
  threshold: string;
}): boolean {
  if (input.currency !== 'USD') return true;
  return new Prisma.Decimal(input.amount).gt(new Prisma.Decimal(input.threshold));
}

export function resolvePaymentReviewState(
  events: Array<{ action: string; createdAt: Date }>,
): PaymentReviewState {
  const relevant = events
    .filter((event) =>
      [PAYMENT_REVIEW_ACTIONS.required, PAYMENT_REVIEW_ACTIONS.approved, PAYMENT_REVIEW_ACTIONS.rejected].includes(
        event.action as never,
      ),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (relevant.length === 0) return 'NOT_REQUIRED';
  const last = relevant[relevant.length - 1];
  if (last.action === PAYMENT_REVIEW_ACTIONS.approved) return 'APPROVED';
  if (last.action === PAYMENT_REVIEW_ACTIONS.rejected) return 'REJECTED';
  return 'PENDING';
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    /** USER actor（人工动作）或 EXTERNAL actor（webhook 驱动）。 */
    actor:
      | { type: 'USER'; userId: string }
      | { type: 'EXTERNAL'; ref: string };
    action: string;
    entityType: string;
    entityId: string;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      ...(input.actor.type === 'USER'
        ? { actorType: 'USER' as const, actorUserId: input.actor.userId }
        : { actorType: 'EXTERNAL' as const, actorRef: input.actor.ref }),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
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

export interface ApplyPaymentSucceededInput {
  organizationId: string;
  /** webhook 无用户上下文：使用 EXTERNAL actor（actorRef=provider）。 */
  provider: string;
  externalPaymentId: string;
  invoiceId: string;
  amount: string;
  currency: string;
  idempotencyKey?: string;
  /**
   * C-0010-B2 REVISE-1：**显式**处理模式，禁止隐式开关。
   *   FIRST_PROCESSING（默认）：首处理；同一笔付款重复投递 → ILLEGAL_TRANSITION，不推进状态。
   *   RECOVERY：恢复收口（replay / retry-due）；Payment 已记账时继续走 HITL + CAS 把账单推到终态，
   *             账单已是 PAID 则直接返回、不写无意义的失败审计。
   */
  mode?: PaymentSucceededMode;
}

export type PaymentSucceededMode = 'FIRST_PROCESSING' | 'RECOVERY';

export interface ApplyPaymentSucceededResult {
  paymentId: string;
  invoiceId: string;
  status: 'PAID' | 'PENDING_REVIEW' | 'AMOUNT_MISMATCH' | 'ILLEGAL_TRANSITION';
}

export async function applyPaymentSucceeded(
  prisma: PrismaClient,
  input: ApplyPaymentSucceededInput,
  deps: {
    now?: () => Date;
    env?: Record<string, string | undefined>;
    /**
     * C-0010-B2：Payment 行被记入的**同一个事务**里回调，用于把执行尝试链接到 Payment
     * 并写 `payment.processing_payment_linked` 审计（链接与资金事实同生共死）。
     */
    onPaymentRecorded?: (tx: Prisma.TransactionClient, paymentId: string) => Promise<void>;
  } = {},
): Promise<ApplyPaymentSucceededResult> {
  const at = (deps.now ?? (() => new Date()))();
  const mode: PaymentSucceededMode = input.mode ?? 'FIRST_PROCESSING';

  const invoice = await prisma.billingInvoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { id: true, status: true, total: true, currency: true, invoiceNo: true },
  });
  if (!invoice) {
    throw new WorkflowError('NOT_FOUND', `发票 ${input.invoiceId} 不存在或不属于该租户`);
  }

  const amountMatches = money(invoice.total) === money(input.amount);
  const currencyMatches = invoice.currency === input.currency;

  return prisma.$transaction(async (tx) => {
    // 幂等：同 (organizationId, provider, externalPaymentId) 只记录一次
    const existing = await tx.payment.findFirst({
      where: {
        organizationId: input.organizationId,
        provider: input.provider,
        externalPaymentId: input.externalPaymentId,
      },
      select: { id: true },
    });
    const payment =
      existing ??
      (await tx.payment.create({
        data: {
          organizationId: input.organizationId,
          invoiceId: invoice.id,
          provider: input.provider,
          externalPaymentId: input.externalPaymentId,
          amount: new Prisma.Decimal(input.amount),
          currency: input.currency,
          status: amountMatches && currencyMatches ? 'SUCCEEDED' : 'FAILED',
          idempotencyKey: input.idempotencyKey ?? `${input.provider}:${input.externalPaymentId}`,
        },
        select: { id: true },
      }));

    if (deps.onPaymentRecorded) await deps.onPaymentRecorded(tx, payment.id);

    if (existing) {
      // 首处理：同一笔付款重复投递 → 不推进任何状态
      if (mode === 'FIRST_PROCESSING') {
        return { paymentId: payment.id, invoiceId: invoice.id, status: 'ILLEGAL_TRANSITION' as const };
      }
      // 恢复收口：账单已经终态 → 同样无事可做，且不写无意义的失败审计
      if (invoice.status === 'PAID') {
        return { paymentId: payment.id, invoiceId: invoice.id, status: 'ILLEGAL_TRANSITION' as const };
      }
    }

    if (!amountMatches || !currencyMatches) {
      // 金额/币种不符：绝不推进 PAID，只留异常审计
      await writeAudit(tx, {
        organizationId: input.organizationId,
        actor: { type: 'EXTERNAL', ref: input.provider },
        action: 'payment.reconciliation_failed',
        entityType: 'BillingInvoice',
        entityId: invoice.id,
        changes: {
          reason: amountMatches ? 'currency mismatch' : 'amount mismatch',
          expected: money(invoice.total),
          received: money(input.amount),
          expectedCurrency: invoice.currency,
          receivedCurrency: input.currency,
          externalPaymentId: input.externalPaymentId,
        },
        at,
      });
      return { paymentId: payment.id, invoiceId: invoice.id, status: 'AMOUNT_MISMATCH' as const };
    }

    // Payment HITL（独立域）：高额或非 USD 需要 payment.review_approved
    const threshold = resolvePaymentReviewThreshold(deps.env);
    const needsReview = requiresPaymentReview({
      amount: invoice.total,
      currency: invoice.currency,
      threshold,
    });
    if (needsReview) {
      const events = await tx.auditLog.findMany({
        where: {
          organizationId: input.organizationId,
          entityType: 'BillingInvoice',
          entityId: invoice.id,
          action: {
            in: [
              PAYMENT_REVIEW_ACTIONS.required,
              PAYMENT_REVIEW_ACTIONS.approved,
              PAYMENT_REVIEW_ACTIONS.rejected,
            ],
          },
        },
        orderBy: { createdAt: 'asc' },
        select: { action: true, createdAt: true },
      });
      const state = resolvePaymentReviewState(events);
      if (state !== 'APPROVED') {
        await writeAudit(tx, {
          organizationId: input.organizationId,
          actor: { type: 'EXTERNAL', ref: input.provider },
          action: PAYMENT_REVIEW_ACTIONS.required,
          entityType: 'BillingInvoice',
          entityId: invoice.id,
          changes: {
            invoiceNo: invoice.invoiceNo,
            amount: money(invoice.total),
            currency: invoice.currency,
            threshold,
            previousState: state,
          },
          at,
        });
        return { paymentId: payment.id, invoiceId: invoice.id, status: 'PENDING_REVIEW' as const };
      }
    }

    // CAS：只有 ISSUED 才能推进到 PAID（一次且仅一次）
    const updated = await tx.billingInvoice.updateMany({
      where: { id: invoice.id, organizationId: input.organizationId, status: 'ISSUED' },
      data: { status: 'PAID', paidAt: at, paidAmount: new Prisma.Decimal(input.amount) },
    });
    if (updated.count !== 1) {
      await writeAudit(tx, {
        organizationId: input.organizationId,
        actor: { type: 'EXTERNAL', ref: input.provider },
        action: 'payment.reconciliation_failed',
        entityType: 'BillingInvoice',
        entityId: invoice.id,
        changes: {
          reason: `invoice status is ${invoice.status}, ISSUED required`,
          externalPaymentId: input.externalPaymentId,
        },
        at,
      });
      return { paymentId: payment.id, invoiceId: invoice.id, status: 'ILLEGAL_TRANSITION' as const };
    }

    const row = prepareAuditInsert(
      {
        organizationId: input.organizationId,
        // webhook 驱动，无用户上下文 → EXTERNAL actor
        actorType: 'EXTERNAL',
        actorRef: input.provider,
        action: 'payment.succeeded',
        entityType: 'BillingInvoice',
        entityId: invoice.id,
        changes: {
          invoiceNo: invoice.invoiceNo,
          amount: money(invoice.total),
          currency: invoice.currency,
          externalPaymentId: input.externalPaymentId,
          status: 'PAID',
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

    return { paymentId: payment.id, invoiceId: invoice.id, status: 'PAID' as const };
  });
}

/**
 * C-0010-B2 REVISE-1：恢复收口的**具名入口**。
 * 调用点必须显式选择恢复语义（replay / retry-due），不允许靠隐式开关改变资金代码行为。
 */
export async function recoverPaymentSucceeded(
  prisma: PrismaClient,
  input: ApplyPaymentSucceededInput,
  deps: Parameters<typeof applyPaymentSucceeded>[2] = {},
): Promise<ApplyPaymentSucceededResult> {
  return applyPaymentSucceeded(prisma, { ...input, mode: 'RECOVERY' }, deps);
}

/** Payment HITL：OWNER/ADMIN 复核（与 Recovery HITL 同角色口径，但审计域独立）。 */
export async function submitPaymentReview(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    role: string;
    invoiceId: string;
    decision: 'REQUEST' | 'APPROVE' | 'REJECT';
    reason?: string;
  },
  deps: { now?: () => Date } = {},
): Promise<{ invoiceId: string; state: PaymentReviewState }> {
  assertPermission(input.role, 'setCommercialTerms');
  assertPermission(input.role, 'advanceBilling');
  if (input.decision === 'REJECT' && (!input.reason || input.reason.trim() === '')) {
    throw new WorkflowError('REASON_REQUIRED', 'REJECT 必须给出 reason');
  }

  const invoice = await prisma.billingInvoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { id: true, invoiceNo: true },
  });
  if (!invoice) throw new WorkflowError('NOT_FOUND', `发票 ${input.invoiceId} 不存在或不属于该租户`);

  const at = (deps.now ?? (() => new Date()))();
  return prisma.$transaction(async (tx) => {
    const events = await tx.auditLog.findMany({
      where: {
        organizationId: input.organizationId,
        entityType: 'BillingInvoice',
        entityId: invoice.id,
        action: {
          in: [
            PAYMENT_REVIEW_ACTIONS.required,
            PAYMENT_REVIEW_ACTIONS.approved,
            PAYMENT_REVIEW_ACTIONS.rejected,
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true },
    });
    const state = resolvePaymentReviewState(events);

    if (input.decision === 'REQUEST') {
      if (state === 'PENDING') throw new WorkflowError('ILLEGAL_TRANSITION', '该账单已处于待审批状态');
      await writeAudit(tx, {
        organizationId: input.organizationId,
        actor: { type: 'USER', userId: input.actorUserId },
        action: PAYMENT_REVIEW_ACTIONS.required,
        entityType: 'BillingInvoice',
        entityId: invoice.id,
        changes: { invoiceNo: invoice.invoiceNo, threshold: resolvePaymentReviewThreshold() },
        at,
      });
      return { invoiceId: invoice.id, state: 'PENDING' as PaymentReviewState };
    }

    if (state !== 'PENDING') {
      throw new WorkflowError('ILLEGAL_TRANSITION', `当前状态 ${state} 不允许审批（必须先有待审批请求）`);
    }
    const action =
      input.decision === 'APPROVE' ? PAYMENT_REVIEW_ACTIONS.approved : PAYMENT_REVIEW_ACTIONS.rejected;
    await writeAudit(tx, {
      organizationId: input.organizationId,
      actor: { type: 'USER', userId: input.actorUserId },
      action,
      entityType: 'BillingInvoice',
      entityId: invoice.id,
      changes: {
        invoiceNo: invoice.invoiceNo,
        ...(input.reason ? { reason: input.reason } : {}),
        charged: false,
      },
      at,
    });
    return {
      invoiceId: invoice.id,
      state: input.decision === 'APPROVE' ? ('APPROVED' as PaymentReviewState) : ('REJECTED' as PaymentReviewState),
    };
  });
}
