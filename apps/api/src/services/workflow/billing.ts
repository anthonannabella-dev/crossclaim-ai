/**
 * C-0008-B2-3b — billing display and the approved billing state machine.
 * ---------------------------------------------------------------
 * Approved rulings (MSG-20260928-53 / -56 / -58):
 *   · states   : DRAFT → ISSUED → PAID. A direct DRAFT → PAID is NOT allowed,
 *                even with a note (an invoice must be issued before it is paid).
 *   · roles    : OWNER / ADMIN / FINANCE may advance (advanceBilling);
 *                OPS may only read; VIEWER has no access.
 *   · CAS      : every transition is a compare-and-swap on the current status
 *                (updateMany + count === 1), never read-then-update-by-id.
 *   · PAID     : requires paymentReference or note; the audit records
 *                `paymentReferenceProvided` and never the full payment record.
 *   · boundary : BillingInvoice is what WE charge the client. It is deliberately
 *                a different object from Settlement (what a third party paid the
 *                client) and the two are never presented as the same fact.
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { PAYMENT_CAPTURE_ACTION } from '../action-guard/approval-verifier';
import {
  ApprovalBoundaryError,
  PAYMENT_APPROVAL_EVENT_ACTION,
  PAYMENT_CONSUMED_EVENT_ACTION,
  PAYMENT_REJECTED_EVENT_ACTION,
  PAYMENT_REQUIRED_EVENT_ACTION,
  verifyApprovalBoundary,
} from '../action-guard/approval-tx-verify';
import { normalizeBoundPayload } from './recovery-review';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

const NOTE_MAX = 500;
const REFERENCE_MAX = 256;

/** 已批准的 Billing 状态机：DRAFT → ISSUED → PAID（其余一律非法）。 */
export const BILLING_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ['ISSUED'],
  ISSUED: ['PAID'],
  PAID: [],
  PARTIALLY_PAID: ['PAID'],
  VOID: [],
  WRITTEN_OFF: [],
};

export function canAdvanceBilling(from: string, to: string): boolean {
  return (BILLING_TRANSITIONS[from] ?? []).includes(to);
}

export interface BillingInvoiceView {
  id: string;
  invoiceNo: string;
  status: string;
  caseId: string | null;
  caseNo: string | null;
  subtotal: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  currency: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  reference: string | null;
  serviceFee: string | null;
}

const money = (value: InstanceType<typeof Prisma.Decimal>): string =>
  new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

export async function listBillingInvoices(
  prisma: PrismaClient,
  actor: { organizationId: string; role: string },
  limit = 50,
): Promise<BillingInvoiceView[]> {
  assertPermission(actor.role, 'viewBilling');
  const take = Math.min(Math.max(limit, 1), 200);

  const rows = await prisma.billingInvoice.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      invoiceNo: true,
      status: true,
      caseId: true,
      subtotal: true,
      taxAmount: true,
      total: true,
      paidAmount: true,
      currency: true,
      issuedAt: true,
      dueAt: true,
      paidAt: true,
      externalRef: true,
      case: { select: { caseNo: true } },
      fees: { select: { feeAmount: true }, take: 1 },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    invoiceNo: row.invoiceNo,
    status: row.status,
    caseId: row.caseId,
    caseNo: row.case?.caseNo ?? null,
    subtotal: money(row.subtotal),
    taxAmount: money(row.taxAmount),
    total: money(row.total),
    paidAmount: money(row.paidAmount),
    currency: row.currency,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    paidAt: row.paidAt,
    reference: row.externalRef,
    serviceFee: row.fees[0]?.feeAmount ? money(row.fees[0].feeAmount) : null,
  }));
}

export interface AdvanceBillingInput {
  /** P5（② 第二批）：操作级审批（payment.capture）。提供时在资金事务内完整重验并写消费事件。 */
  approvalId?: string;
  operationId?: string;
  approvalPayload?: {
    amount?: unknown;
    currency?: unknown;
    basisReference?: unknown;
    evidenceArtifactId?: unknown;
  };
  organizationId: string;
  actorUserId: string;
  role: string;
  invoiceId: string;
  to: unknown;
  paymentReference?: unknown;
  note?: unknown;
}

export interface AdvanceBillingResult {
  invoiceId: string;
  from: string;
  to: string;
  paymentReferenceProvided: boolean;
}

export async function advanceBillingInvoice(
  prisma: PrismaClient,
  input: AdvanceBillingInput,
  now: () => Date = () => new Date(),
): Promise<AdvanceBillingResult> {
  assertPermission(input.role, 'advanceBilling');

  const to = typeof input.to === 'string' ? input.to.trim().toUpperCase() : '';
  const paymentReference =
    typeof input.paymentReference === 'string' ? input.paymentReference.trim() : '';
  const note = typeof input.note === 'string' ? input.note.trim() : '';

  if (paymentReference.length > REFERENCE_MAX) {
    throw new WorkflowError('INVALID_INPUT', `paymentReference 不得超过 ${REFERENCE_MAX} 个字符`);
  }
  if (note.length > NOTE_MAX) {
    throw new WorkflowError('INVALID_INPUT', `note 不得超过 ${NOTE_MAX} 个字符`);
  }
  // 裁定：PAID 必须带 paymentReference 或 note（在触库前判定）
  if (to === 'PAID' && paymentReference === '' && note === '') {
    throw new WorkflowError(
      'PAYMENT_REFERENCE_REQUIRED',
      'PAID 必须提供 paymentReference 或 note（至少一个）',
    );
  }
  if (to === '') {
    throw new WorkflowError('INVALID_INPUT', '目标状态非法');
  }

  const invoice = await prisma.billingInvoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { id: true, status: true, invoiceNo: true, caseId: true, total: true, currency: true },
  });
  if (!invoice) {
    throw new WorkflowError('NOT_FOUND', `发票 ${input.invoiceId} 不存在或不属于该租户`);
  }
  if (invoice.status === to) {
    throw new WorkflowError('ILLEGAL_TRANSITION', `发票已处于 ${to}，无需重复迁移`);
  }
  if (!canAdvanceBilling(invoice.status, to)) {
    throw new WorkflowError(
      'ILLEGAL_TRANSITION',
      `发票状态 ${invoice.status} 不能迁移到 ${to}（只允许 DRAFT → ISSUED → PAID）`,
    );
  }

  const from = invoice.status;
  const at = now();
  // P5：审批与操作身份（缺省时保持既有直接调用语义）
  const approvalId = typeof input.approvalId === 'string' && input.approvalId.trim() !== '' ? input.approvalId.trim() : null;
  const operationId =
    typeof input.operationId === 'string' && input.operationId.trim() !== ''
      ? input.operationId.trim()
      : approvalId
        ? `approval:${approvalId}`
        : null;
  const boundPayload = normalizeBoundPayload(
    input.approvalPayload
      ? {
          recoveredAmount: input.approvalPayload.amount,
          currency: input.approvalPayload.currency,
          basisReference: input.approvalPayload.basisReference,
          evidenceArtifactId: input.approvalPayload.evidenceArtifactId,
        }
      : undefined,
  );

  return prisma.$transaction(async (tx) => {
    // P5：目标级串行化（发票粒度）→ 锁内完整重验 → CAS → 审计/消费
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-invoice:${invoice.id}`);
    }
    if (approvalId) {
      // R6 CHANGE A：锁内重读发票事实，与批准快照逐项核对（不得用事务外读取的 invoice.total）
      const fresh = await tx.billingInvoice.findFirst({
        where: { id: invoice.id, organizationId: input.organizationId },
        select: { status: true, total: true, currency: true },
      });
      if (!fresh) throw new WorkflowError('NOT_FOUND', `发票 ${invoice.id} 不存在或不属于该租户`);
      if (to !== 'PAID') {
        throw new WorkflowError('ILLEGAL_TRANSITION', '受保护收费入口只允许 PAID 确认（签发等迁移需独立授权）');
      }
      const freshAmount = money(fresh.total);
      if (boundPayload?.amount !== freshAmount || boundPayload?.currency !== fresh.currency) {
        throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', invoice.id);
      }
      const boundary = await verifyApprovalBoundary(tx, {
        organizationId: input.organizationId,
        approvalId,
        action: PAYMENT_CAPTURE_ACTION,
        caseId: invoice.id,
        actorUserId: input.actorUserId,
        payload: {
          amount: boundPayload?.amount ?? null,
          currency: boundPayload?.currency ?? null,
          basisReference: boundPayload?.basisReference ?? null,
          evidenceArtifactId: boundPayload?.evidenceArtifactId ?? null,
        },
        // 真实账单操作指纹：目标 + 迁移
        extra: { invoiceId: invoice.id, from: fresh.status, to },
        now: now(),
        approvalEventAction: PAYMENT_APPROVAL_EVENT_ACTION,
        requiredEventAction: PAYMENT_REQUIRED_EVENT_ACTION,
        revocationEventActions: [PAYMENT_REJECTED_EVENT_ACTION],
        consumedEventAction: PAYMENT_CONSUMED_EVENT_ACTION,
        targetEntityType: 'BillingInvoice',
      });
      if (!boundary.ok) throw new ApprovalBoundaryError(boundary.reason, invoice.id);
      if (boundary.consumed) throw new ApprovalBoundaryError('APPROVAL_ALREADY_CONSUMED', invoice.id);
    }
    // CAS：并发推进只有一个能命中当前状态
    const updated = await tx.billingInvoice.updateMany({
      where: { id: invoice.id, organizationId: input.organizationId, status: from as never },
      data: {
        status: to as never,
        ...(to === 'ISSUED' ? { issuedAt: at } : {}),
        ...(to === 'PAID'
          ? {
              paidAt: at,
              paidAmount: invoice.total,
              ...(paymentReference ? { externalRef: paymentReference } : {}),
            }
          : {}),
      },
    });
    if (updated.count !== 1) {
      throw new WorkflowError('ILLEGAL_TRANSITION', '发票状态已被其他操作改变，请刷新后重试');
    }

    const row = prepareAuditInsert(
      {
        organizationId: input.organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'billing.status_changed',
        entityType: 'BillingInvoice',
        entityId: invoice.id,
        // 裁定：只记录「是否提供了支付引用 / 备注」，绝不写入完整支付流水
        changes: {
          from,
          to,
          invoiceNo: invoice.invoiceNo,
          caseId: invoice.caseId,
          currency: invoice.currency,
          amount: money(invoice.total),
          paymentReferenceProvided: paymentReference !== '',
          ...(note ? { note } : {}),
          // R6 CHANGE D：最终执行审计必须能与审批/操作关联（entityId = BillingInvoice）
          ...(approvalId ? { approvalId, operationId } : {}),
          result: from !== to ? 'TRANSITIONED' : 'NOOP',
          at: at.toISOString(),
        },
      },
      { maxStringLength: NOTE_MAX },
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

    if (approvalId) {
      // P5：消费事件与资金写入同事务（审批一次性）
      await tx.auditLog.create({
        data: {
          organizationId: input.organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action: PAYMENT_CONSUMED_EVENT_ACTION,
          entityType: 'BillingInvoice',
          entityId: invoice.id,
          changes: {
            approvalId,
            operationId,
            invoiceId: invoice.id,
            from,
            to,
            amount: money(invoice.total),
            currency: invoice.currency,
          } as never,
          createdAt: at,
        },
      });
    }

    return { invoiceId: invoice.id, from, to, paymentReferenceProvided: paymentReference !== '' };
  });
}
