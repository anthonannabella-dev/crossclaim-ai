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
  // 该对象：PAID 必须带 paymentReference 或 note，在传入前判定
  if (to === 'PAID' && paymentReference === '' && note === '') {
    throw new WorkflowError(
      'PAYMENT_REFERENCE_REQUIRED',
      'PAID 必须提供 paymentReference 或 note（二者之一）',
    );
  }
  if (to === '') {
    throw new WorkflowError('INVALID_INPUT', '目标状态非法');
  }

  // R7 CHANGE A：锁外读取仅作为**预检查**（存在性 / 明显非法迁移），快速失败用；
  // 它不再提供执行依据 —— 金额 / 币种 / 当前状态 / 执行时间一律取自锁后快照。
  const precheck = await prisma.billingInvoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { id: true, status: true },
  });
  if (!precheck) {
    throw new WorkflowError('NOT_FOUND', `发票 ${input.invoiceId} 不存在或不属于该租户`);
  }
  if (precheck.status === to) {
    throw new WorkflowError('ILLEGAL_TRANSITION', `发票已处于 ${to}，不可重复迁移`);
  }
  if (!canAdvanceBilling(precheck.status, to)) {
    throw new WorkflowError(
      'ILLEGAL_TRANSITION',
      `发票状态 ${precheck.status} 不能迁移到 ${to}：只接受 DRAFT → ISSUED → PAID`,
    );
  }

  // P5：操作关联标识（缺省时由审批编号直接推导）
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

  try {
    return await prisma.$transaction(async (tx) => {
      // 统一锁协议（R7 CHANGE A）：所有账单写入者都必须先持有该发票的行级咨询锁；
      // 锁内读取的事实才是本次执行的依据。
      if (typeof tx.$executeRawUnsafe === 'function') {
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          `cc-payment-invoice:${input.invoiceId}`,
        );
      }
      // R7 CHANGE A：锁后读取**完整执行快照**；迁移判断、CAS、金额写入、成功审计与消费记录全部使用它。
      const snapshot = await tx.billingInvoice.findFirst({
        where: { id: input.invoiceId, organizationId: input.organizationId },
        select: { id: true, status: true, invoiceNo: true, caseId: true, total: true, currency: true },
      });
      if (!snapshot) {
        throw new WorkflowError('NOT_FOUND', `发票 ${input.invoiceId} 不存在或不属于该租户`);
      }
      const from = snapshot.status;
      if (from === to) {
        throw new WorkflowError('ILLEGAL_TRANSITION', `发票已处于 ${to}，不可重复迁移`);
      }
      if (!canAdvanceBilling(from, to)) {
        throw new WorkflowError(
          'ILLEGAL_TRANSITION',
          `发票状态 ${from} 不能迁移到 ${to}：只接受 DRAFT → ISSUED → PAID`,
        );
      }
      // R7 CHANGE A：执行时间在锁内生成，统一用于 issuedAt / paidAt、消费记录与最终成功审计。
      const executionAt = now();
      const lockedAmount = money(snapshot.total);

      if (approvalId) {
        // 受保护收费动作只能用于 PAID 确认；签发（DRAFT → ISSUED）保留独立授权边界，不得复用本审批。
        if (to !== 'PAID') {
          throw new WorkflowError(
            'ILLEGAL_TRANSITION',
            '受保护收费动作只接受 PAID 确认；签发等迁移需独立授权边界',
          );
        }
        // 批准事实必须等于**锁内**账单事实（金额/币种）；不允许凭"锁内比较通过"再写入另一份旧快照。
        if (boundPayload?.amount !== lockedAmount || boundPayload?.currency !== snapshot.currency) {
          throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', snapshot.id);
        }
        const boundary = await verifyApprovalBoundary(tx, {
          organizationId: input.organizationId,
          approvalId,
          action: PAYMENT_CAPTURE_ACTION,
          caseId: snapshot.id,
          actorUserId: input.actorUserId,
          payload: {
            amount: boundPayload?.amount ?? null,
            currency: boundPayload?.currency ?? null,
            basisReference: boundPayload?.basisReference ?? null,
            evidenceArtifactId: boundPayload?.evidenceArtifactId ?? null,
          },
          // 真实账单操作指纹：目标 + 精确迁移（取自锁内快照）
          extra: { invoiceId: snapshot.id, from, to },
          now: executionAt,
          approvalEventAction: PAYMENT_APPROVAL_EVENT_ACTION,
          requiredEventAction: PAYMENT_REQUIRED_EVENT_ACTION,
          revocationEventActions: [PAYMENT_REJECTED_EVENT_ACTION],
          consumedEventAction: PAYMENT_CONSUMED_EVENT_ACTION,
          targetEntityType: 'BillingInvoice',
        });
        if (!boundary.ok) throw new ApprovalBoundaryError(boundary.reason, snapshot.id);
        if (boundary.consumed) throw new ApprovalBoundaryError('APPROVAL_ALREADY_CONSUMED', snapshot.id);
      }
      // CAS：状态 + 事实（金额/币种）双重比较。咨询锁之外的写入者若改变事实，这里必须拒绝，
      // 而不是把锁外旧快照写进账单。
      const updated = await tx.billingInvoice.updateMany({
        where: {
          id: snapshot.id,
          organizationId: input.organizationId,
          status: from as never,
          total: snapshot.total,
          currency: snapshot.currency,
        },
        data: {
          status: to as never,
          ...(to === 'ISSUED' ? { issuedAt: executionAt } : {}),
          ...(to === 'PAID'
            ? {
                paidAt: executionAt,
                paidAmount: snapshot.total,
                ...(paymentReference ? { externalRef: paymentReference } : {}),
              }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw new WorkflowError('ILLEGAL_TRANSITION', '发票状态或记账事实已被其他事务改变，请刷新后重试');
      }

      const row = prepareAuditInsert(
        {
          organizationId: input.organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action: 'billing.status_changed',
          entityType: 'BillingInvoice',
          entityId: snapshot.id,
          // 该对象只记录是否提供了支付依据 / 备注本身，绝不写入完整支付流水
          changes: {
            from,
            to,
            invoiceNo: snapshot.invoiceNo,
            caseId: snapshot.caseId,
            currency: snapshot.currency,
            amount: lockedAmount,
            paymentReferenceProvided: paymentReference !== '',
            ...(note ? { note } : {}),
            // R6 CHANGE D：本次执行的账单操作关联（审批/操作）；entityId = BillingInvoice
            ...(approvalId ? { approvalId, operationId } : {}),
            result: 'TRANSITIONED',
            at: executionAt.toISOString(),
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
          createdAt: executionAt,
        },
      });

      if (approvalId) {
        // P5：消费事件与资金写入同事务（一次性）
        await tx.auditLog.create({
          data: {
            organizationId: input.organizationId,
            actorType: 'USER',
            actorUserId: input.actorUserId,
            action: PAYMENT_CONSUMED_EVENT_ACTION,
            entityType: 'BillingInvoice',
            entityId: snapshot.id,
            changes: {
              approvalId,
              operationId,
              invoiceId: snapshot.id,
              from,
              to,
              amount: lockedAmount,
              currency: snapshot.currency,
            } as never,
            createdAt: executionAt,
          },
        });
      }

      return { invoiceId: snapshot.id, from, to, paymentReferenceProvided: paymentReference !== '' };
    });
  } catch (error) {
    // R6 CHANGE D：支付捕获在锁内被拒绝时写最终拒绝审计（事务已回滚，故用独立连接写入；失败不覆盖原错误）
    const reason =
      error instanceof ApprovalBoundaryError
        ? error.reason
        : error instanceof WorkflowError
          ? error.code
          : null;
    if (reason !== null) {
      await writePaymentRejectionAudit(prisma, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        invoiceId: input.invoiceId,
        approvalId: typeof input.approvalId === 'string' ? input.approvalId : null,
        operationId:
          typeof input.operationId === 'string' && input.operationId.trim() !== ''
            ? input.operationId.trim()
            : typeof input.approvalId === 'string' && input.approvalId.trim() !== ''
              ? `approval:${input.approvalId}`
              : null,
        stage: 'LOCKED_RECHECK',
        reason,
        at: now(),
      }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * R6 CHANGE D：支付捕获最终拒绝审计（锁内重验拒绝）。
 * 记录执行主体、审批、操作、目标与结果；主体记入 changes（可能已失效），保持 SYSTEM actor 形状约束。
 */
async function writePaymentRejectionAudit(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    invoiceId: string;
    approvalId: string | null;
    operationId: string | null;
    stage: 'LOCKED_RECHECK';
    reason: string;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: 'payment-capture-guard',
      action: 'payment.capture_rejected',
      entityType: 'BillingInvoice',
      entityId: input.invoiceId,
      changes: {
        invoiceId: input.invoiceId,
        actorUserId: input.actorUserId,
        approvalId: input.approvalId,
        operationId: input.operationId,
        stage: input.stage,
        reason: input.reason,
        result: 'REJECTED',
      },
    },
    { maxStringLength: 512, now: () => input.at },
  );
  await prisma.auditLog.create({
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
