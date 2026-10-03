/**
 * R46 S5-A —— BillingInvoice issue 受保护写路径（MSG-20261002-63）
 * ------------------------------------------------------------------
 * 只做：eligible immutable FeeCalculation → 独立 invoice 授权 → BillingInvoice ISSUED 边界。
 * 冻结：
 *   - 独立 protected action `billing.invoice_issue`（INTERNAL_WRITE + humanApproval，targetRef = invoiceBasisDigest）
 *   - **fee approval ≠ invoice approval**：不得继承 Settlement / reversal / FeeCalculation 的审批
 *   - 锁后重建 canonical invoice basis 并比较；任何 trusted basis drift → APPROVAL_REQUIRED（零写入）
 *   - exact replay → REUSED（同一 invoice identity；VOID 不释放 basis identity）
 *   - 原子：approval consumption + linkage + ISSUED + success audit 同事务，任一失败全部 rollback
 *   - 禁止：Payment / autopay / RecoveryLedger / R13 / 平台外写
 */

import type { PrismaClient } from '@prisma/client';

import {
  verifyApprovalOrThrow,
  type ActionGuardApprovalVerifier,
} from '../action-guard/approval-verifier';
import { assertNoClientInvoiceFields, computeInvoiceBasis } from './invoice-basis';

export const INVOICE_ISSUE_ACTION = 'billing.invoice_issue';
export const INVOICE_ISSUED_ACTION = 'billing.invoice_issued';

export type InvoiceIssueErrorCode =
  | 'INVALID_INPUT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_ALREADY_CONSUMED'
  | 'FEE_CALCULATION_NOT_FOUND'
  | 'CROSS_TENANT_REFERENCE'
  | 'INVOICE_DRAFT_REQUIRED'
  | 'INVOICE_BASIS_CONFLICT'
  | 'INVOICE_CURRENCY_MISMATCH';

export class InvoiceIssueError extends Error {
  constructor(
    public readonly code: InvoiceIssueErrorCode,
    message?: string,
  ) {
    super(message ? code + ': ' + message : code);
    this.name = 'InvoiceIssueError';
  }
}

export interface InvoiceIssueDeps {
  prisma: PrismaClient;
  verifyApproval: (request: {
    organizationId: string;
    action: string;
    approvalId: string;
    actorUserId: string;
    boundExtra: Record<string, string | null>;
  }) => Promise<boolean>;
  assertActiveMembership: (organizationId: string, userId: string) => Promise<void>;
}

export interface InvoiceIssueInput {
  organizationId: string;
  actorUserId: string;
  approvalId: string;
  feeCalculationId: string;
  /** 任何客户端提交的可信 invoice 字段 → CLIENT_INVOICE_FIELDS_NOT_TRUSTED */
  clientFields?: Record<string, unknown> | null;
}

export interface InvoiceIssueResult {
  status: 'ISSUED' | 'REUSED';
  invoiceId: string;
  invoiceNo: string;
  invoiceBasisDigest: string;
  currency: string;
  total: string;
}

export function createInvoiceIssueDeps(
  prisma: PrismaClient,
  approval: InvoiceIssueDeps['verifyApproval'] | ActionGuardApprovalVerifier,
): InvoiceIssueDeps {
  return {
    prisma,
    verifyApproval: async (request) => {
      if (typeof approval === 'function') return approval(request);
      try {
        const decision = await verifyApprovalOrThrow({
          verifier: approval,
          query: {
            approvalId: request.approvalId,
            organizationId: request.organizationId,
            action: request.action,
            actorUserId: request.actorUserId,
            targetRef: request.boundExtra.invoiceBasisDigest ?? undefined,
            payload: {
              currency: request.boundExtra.currency,
              basisReference: request.boundExtra.invoiceBasisDigest,
            },
          },
        });
        return decision.valid === true;
      } catch (error) {
        throw new InvoiceIssueError('APPROVAL_REQUIRED', (error as Error)?.message ?? 'approval rejected');
      }
    },
    assertActiveMembership: async (organizationId, userId) => {
      const row = await prisma.membership.findFirst({
        where: { organizationId, userId, isActive: true },
        select: { id: true },
      });
      if (!row) throw new InvoiceIssueError('APPROVAL_REQUIRED', 'no ACTIVE membership for actor');
    },
  };
}

const money = (value: unknown): string => String(value);

export async function issueInvoice(
  deps: InvoiceIssueDeps,
  input: InvoiceIssueInput,
): Promise<InvoiceIssueResult> {
  assertNoClientInvoiceFields((input.clientFields ?? {}) as Record<string, unknown>);
  const organizationId = String(input.organizationId ?? '').trim();
  if (!organizationId || !input.actorUserId || !input.approvalId || !input.feeCalculationId) {
    throw new InvoiceIssueError('INVALID_INPUT', 'organizationId / actorUserId / approvalId / feeCalculationId are required');
  }

  return deps.prisma.$transaction(async (tx) => {
    await deps.assertActiveMembership(organizationId, input.actorUserId);

    // 纵深防御锁键：organizationId + feeCalculationId（canonical basis 的稳定身份）
    await tx.$queryRaw`WITH lock AS (SELECT pg_advisory_xact_lock(hashtext(${organizationId + ':' + input.feeCalculationId})::bigint)) SELECT true AS acquired`;

    const fee = await tx.$queryRawUnsafe<
      Array<{
        id: string;
        organizationId: string;
        caseId: string | null;
        feeChainId: string | null;
        feeAmount: string;
        currency: string;
        policyRef: string | null;
        feeBasisVersion: string | null;
        membershipDigest: string | null;
        billingInvoiceId: string | null;
      }>
    >(
      'SELECT "id","organizationId","caseId","feeChainId","feeAmount"::text AS "feeAmount","currency",'
        + '"policyRef","feeBasisVersion","membershipDigest","billingInvoiceId" '
        + 'FROM "FeeCalculation" WHERE "id" = $1 FOR UPDATE',
      input.feeCalculationId,
    );
    const basisFee = fee[0];
    if (!basisFee) throw new InvoiceIssueError('FEE_CALCULATION_NOT_FOUND', 'fee calculation not found');
    if (basisFee.organizationId !== organizationId) {
      throw new InvoiceIssueError('CROSS_TENANT_REFERENCE', 'fee calculation belongs to another tenant');
    }
    if (!basisFee.caseId) {
      throw new InvoiceIssueError('INVALID_INPUT', 'fee calculation is not attached to a case');
    }

    const kase = await tx.case.findFirst({
      where: { id: basisFee.caseId },
      select: { id: true, organizationId: true, caseNo: true, currency: true },
    });
    if (!kase || kase.organizationId !== organizationId) {
      throw new InvoiceIssueError('CROSS_TENANT_REFERENCE', 'case belongs to another tenant');
    }

    // canonical invoice basis（服务端唯一 builder；客户端不得自证）
    const customerAccountIdentity = kase.caseNo;
    const basis = computeInvoiceBasis({
      organizationId,
      feeCalculationId: basisFee.id,
      feeChainId: basisFee.feeChainId,
      customerAccountIdentity,
      currency: basisFee.currency,
      feeAmount: basisFee.feeAmount,
      policyRef: basisFee.policyRef,
      feeBasisVersion: basisFee.feeBasisVersion,
      membershipDigest: basisFee.membershipDigest,
    });

    // 锁后重建 basis 后才校验 approval（invoice approval 独立于 fee approval）
    const approved = await deps.verifyApproval({
      organizationId,
      action: INVOICE_ISSUE_ACTION,
      approvalId: input.approvalId,
      actorUserId: input.actorUserId,
      boundExtra: {
        invoiceBasisDigest: basis.digest,
        invoiceBasisVersion: basis.basisVersion,
        feeCalculationId: basisFee.id,
        feeAmount: basisFee.feeAmount,
        currency: basisFee.currency,
        customerAccountIdentity,
      },
    });
    if (!approved) {
      throw new InvoiceIssueError('APPROVAL_REQUIRED', 'human approval is required for invoice issue');
    }

    // exact replay → REUSED（VOID 不释放 basis identity）
    const existing = await tx.billingInvoice.findFirst({
      where: { organizationId, invoiceBasisDigest: basis.digest },
      select: { id: true, invoiceNo: true, status: true, total: true, currency: true },
    });
    if (existing) {
      return {
        status: 'REUSED' as const,
        invoiceId: existing.id,
        invoiceNo: existing.invoiceNo,
        invoiceBasisDigest: basis.digest,
        currency: existing.currency,
        total: money(existing.total),
      };
    }

    if (!basisFee.billingInvoiceId) {
      throw new InvoiceIssueError('INVOICE_DRAFT_REQUIRED', 'no draft invoice linked to this fee calculation');
    }
    const draft = await tx.billingInvoice.findFirst({
      where: { id: basisFee.billingInvoiceId, organizationId },
      select: { id: true, invoiceNo: true, status: true, currency: true, total: true, caseId: true },
    });
    if (!draft) throw new InvoiceIssueError('INVOICE_DRAFT_REQUIRED', 'linked invoice not found in tenant');
    if (draft.status !== 'DRAFT') {
      throw new InvoiceIssueError('INVOICE_BASIS_CONFLICT', 'linked invoice is not DRAFT (different basis identity)');
    }
    if (draft.currency !== basisFee.currency) {
      throw new InvoiceIssueError('INVOICE_CURRENCY_MISMATCH', 'invoice currency differs from fee currency');
    }

    // approval consumption（deterministic identity；同事务）
    await tx.auditLog
      .create({
        data: {
          id: 'invoice-issue-approval-' + input.approvalId,
          organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action: 'billing.invoice_issue.approval_consumed',
          entityType: 'Approval',
          entityId: input.approvalId,
          changes: { invoiceBasisDigest: basis.digest, feeCalculationId: basisFee.id },
        },
        select: { id: true },
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2002') {
          throw new InvoiceIssueError('APPROVAL_ALREADY_CONSUMED', 'approval has already been consumed');
        }
        throw error;
      });

    let issued: { id: string; invoiceNo: string; total: unknown; currency: string };
    try {
      issued = await tx.billingInvoice.update({
        where: { id: draft.id },
        data: {
          status: 'ISSUED',
          issuedAt: new Date(),
          invoiceBasisDigest: basis.digest,
          invoiceBasisVersion: basis.basisVersion,
          customerAccountIdentity,
        },
        select: { id: true, invoiceNo: true, total: true, currency: true },
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const text = String(error);
      if (code === 'P2002' || text.includes('BillingInvoice_org_basis_key')) {
        // 并发竞争者已提交同一 basis → 重读为 REUSED（exactly one identity）
        const winner = await tx.billingInvoice.findFirst({
          where: { organizationId, invoiceBasisDigest: basis.digest },
          select: { id: true, invoiceNo: true, total: true, currency: true },
        });
        if (winner) {
          throw new InvoiceIssueError(
            'INVOICE_BASIS_CONFLICT',
            'concurrent invoice issue won for the same basis: ' + winner.invoiceNo,
          );
        }
      }
      if (text.includes('INVALID_INVOICE_STATUS_TRANSITION')) {
        throw new InvoiceIssueError('INVOICE_BASIS_CONFLICT', 'invalid invoice status transition');
      }
      if (text.includes('INVOICE_CONTENT_IMMUTABLE_AFTER_ISSUE')) {
        throw new InvoiceIssueError('INVOICE_BASIS_CONFLICT', 'invoice content is immutable after issue');
      }
      throw error;
    }

    await tx.auditLog.create({
      data: {
        organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: INVOICE_ISSUED_ACTION,
        entityType: 'BillingInvoice',
        entityId: issued.id,
        changes: {
          invoiceNo: issued.invoiceNo,
          invoiceBasisDigest: basis.digest,
          invoiceBasisVersion: basis.basisVersion,
          customerAccountIdentity,
          feeCalculationId: basisFee.id,
          total: money(issued.total),
          currency: issued.currency,
        },
      },
    });

    return {
      status: 'ISSUED' as const,
      invoiceId: issued.id,
      invoiceNo: issued.invoiceNo,
      invoiceBasisDigest: basis.digest,
      currency: issued.currency,
      total: money(issued.total),
    };
  });
}
