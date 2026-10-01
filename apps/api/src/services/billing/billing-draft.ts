/**
 * BILLING 草稿写入 —— 受保护动作 `billing.draft`（Gate 7 / ② 下一小批次 · INTERNAL_WRITE）
 * -----------------------------------------------------------------------------------
 * 依据 MSG-20261001-10 §5：INTERNAL_WRITE 真实入口接入 Action Guard；缺装配/能力不足失败关闭；
 * 保持租户、当前主体权限与账单业务前置条件；等待资源锁后重新读取执行所需事实；
 * 草稿写入与业务审计同事务（失败回滚）；并发不得重复生成同一业务账单；
 * **不推进收款、到账、资金扣划或平台外写**（本服务只创建 DRAFT 账单）。
 *
 * 纪律：
 *   - 入口先经 Action Guard 能力闸门（billing 域 Kill Switch + 动作 feature + 控制面模式允许 INTERNAL_WRITE），
 *     **不引入人工审批**（不需要 approvalId）；
 *   - 案件锁 `cc-recovery-case:${caseId}`（与提交/准备服务同协议）→ 既有账单行锁 → **锁后**重读 ACTIVE 用户、
 *     有效 Membership 与当前角色并重新裁决 `advanceBilling` 权限（锁前检查仅作快速拒绝）；
 *   - 幂等：同一案件已有非 VOID/WRITTEN_OFF 账单 → 返回既有账单（created=false），不重复生成、不重复审计；
 *   - 业务前置条件：必须存在已确认的 `FeeCalculation`（费用依据）；缺失 → 409 BILLING_BASIS_REQUIRED；
 *   - 只写业务库；不触碰 Payment / Settlement / 平台适配器。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { ApprovalBoundaryError } from '../action-guard/approval-tx-verify';
import { billingInvoiceNoFor } from '../recovery';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';

export const BILLING_DRAFT_ACTION = 'billing.draft';
export const BILLING_DRAFTED_ACTION = 'billing.drafted';

const MONEY_SCALE = 4;

export interface BillingDraftInput {
  organizationId: string;
  actorUserId: string;
  /** 会话内角色；仅作事务前快速拒绝，最终裁决在锁后按数据库当前角色执行 */
  role: string;
  caseId: string;
  note?: string;
}

export interface BillingDraftResult {
  caseId: string;
  invoiceId: string;
  invoiceNo: string;
  status: 'DRAFT';
  subtotal: string;
  total: string;
  currency: string;
  basisFeeCalculationId: string;
  /** true = 本次新建草稿；false = 已存在既有账单（幂等返回） */
  created: boolean;
  draftedAt: string;
  /** 本批次边界：草稿不推进收款 / 到账 / 扣划 */
  paymentCollected: false;
  platformWriteExecuted: false;
}

export interface BillingDraftDeps {
  prisma: PrismaClient;
  now?: () => Date;
}

type TxClient = Prisma.TransactionClient;

async function insertTxAudit(
  tx: TxClient,
  input: {
    organizationId: string;
    actorUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<string> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: input.changes,
    },
    { maxStringLength: 512, now: () => input.at },
  );
  const created = await tx.auditLog.create({
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
    select: { id: true },
  });
  return created.id;
}

const money = (value: Prisma.Decimal): string =>
  new Prisma.Decimal(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);

/** 允许作为「已有账单」被幂等返回的状态（VOID / WRITTEN_OFF 视为已作废，可重新起草） */
const REUSABLE_INVOICE_STATUSES = new Set(['DRAFT', 'ISSUED', 'PAID', 'PARTIALLY_PAID']);

/**
 * 受保护的账单草稿写入（唯一执行入口）。
 * 前置：调用方已完成 Action Guard 能力闸门（`billing.draft`，INTERNAL_WRITE，无人工审批）。
 */
export async function createBillingDraft(
  input: BillingDraftInput,
  deps: BillingDraftDeps,
): Promise<BillingDraftResult> {
  // 快速拒绝（不能替代锁后重验）
  assertPermission(input.role, 'advanceBilling');
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim().slice(0, 500) : undefined;
  const now = deps.now ?? (() => new Date());

  return deps.prisma.$transaction(
    async (tx) => {
      // 1) 案件锁：与 claim.submit / claim.prepare 共用同一协议，串行化同案件的账单起草
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `cc-recovery-case:${input.caseId}`,
      );

      // 2) 租户隔离：案件必须属于调用方租户
      const kase = await tx.case.findFirst({
        where: { id: input.caseId, organizationId: input.organizationId },
        select: { id: true, caseNo: true },
      });
      if (!kase) throw new WorkflowError('NOT_FOUND', '案件不存在或不属于该租户');

      // 3) 资源行锁：该案件既有账单（并发起草时串行化）
      const lockedInvoices = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        'SELECT id, status FROM "BillingInvoice" WHERE "organizationId" = $1 AND "caseId" = $2 ORDER BY "createdAt" ASC FOR UPDATE',
        input.organizationId,
        input.caseId,
      );

      // 4) 锁后**最终**主体与权限重验（等待行锁期间发生的角色降权/成员停用/用户停用在此被拦下）
      const actor = await tx.user.findFirst({
        where: { id: input.actorUserId, status: 'ACTIVE' },
        select: { id: true },
      });
      const membership = await tx.membership.findFirst({
        where: { organizationId: input.organizationId, userId: input.actorUserId, isActive: true },
        select: { role: true },
      });
      if (!actor || !membership) throw new ApprovalBoundaryError('APPROVAL_ACTOR_MISMATCH', input.caseId);
      assertPermission(membership.role, 'advanceBilling');

      const at = now();

      // 5) 幂等：已有可复用账单 → 直接返回既有事实，不新建、不重复审计
      const reusable = lockedInvoices.find((row) => REUSABLE_INVOICE_STATUSES.has(row.status));
      if (reusable) {
        const existing = await tx.billingInvoice.findUniqueOrThrow({
          where: { id: reusable.id },
          select: {
            id: true,
            invoiceNo: true,
            status: true,
            subtotal: true,
            total: true,
            currency: true,
            fees: { select: { id: true }, take: 1 },
          },
        });
        return {
          caseId: input.caseId,
          invoiceId: existing.id,
          invoiceNo: existing.invoiceNo,
          status: 'DRAFT' as const,
          subtotal: money(existing.subtotal),
          total: money(existing.total),
          currency: existing.currency,
          basisFeeCalculationId: existing.fees[0]?.id ?? '',
          created: false,
          draftedAt: at.toISOString(),
          paymentCollected: false as const,
          platformWriteExecuted: false as const,
        };
      }

      // 6) 业务前置条件：必须存在已确认的费用依据（FeeCalculation）
      const fee = await tx.feeCalculation.findFirst({
        where: { organizationId: input.organizationId, caseId: input.caseId },
        orderBy: { calculatedAt: 'desc' },
        select: { id: true, feeAmount: true, currency: true },
      });
      if (!fee) {
        throw new WorkflowError('BILLING_BASIS_REQUIRED', '缺少已确认的费用计算（FeeCalculation），不能生成账单草稿');
      }

      // 7) 创建 DRAFT 账单（不推进收款/到账/扣划）
      const subtotal = new Prisma.Decimal(fee.feeAmount).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
      const invoice = await tx.billingInvoice.create({
        data: {
          organizationId: input.organizationId,
          caseId: input.caseId,
          invoiceNo: billingInvoiceNoFor(kase.caseNo),
          status: 'DRAFT',
          subtotal,
          taxAmount: new Prisma.Decimal(0),
          total: subtotal,
          currency: fee.currency,
          fees: { connect: { id: fee.id } },
        },
        select: { id: true, invoiceNo: true, status: true, subtotal: true, total: true, currency: true },
      });

      // 8) 业务审计与写入同事务（审计失败整笔回滚）
      await insertTxAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: BILLING_DRAFTED_ACTION,
        entityType: 'BillingInvoice',
        entityId: invoice.id,
        changes: {
          caseId: input.caseId,
          caseNo: kase.caseNo,
          invoiceId: invoice.id,
          invoiceNo: invoice.invoiceNo,
          basisFeeCalculationId: fee.id,
          subtotal: subtotal.toFixed(MONEY_SCALE),
          total: subtotal.toFixed(MONEY_SCALE),
          currency: fee.currency,
          created: true,
          ...(note ? { note } : {}),
        },
        at,
      });

      return {
        caseId: input.caseId,
        invoiceId: invoice.id,
        invoiceNo: invoice.invoiceNo,
        status: 'DRAFT' as const,
        subtotal: money(invoice.subtotal),
        total: money(invoice.total),
        currency: invoice.currency,
        basisFeeCalculationId: fee.id,
        created: true,
        draftedAt: at.toISOString(),
        paymentCollected: false as const,
        platformWriteExecuted: false as const,
      };
    },
    { timeout: 30_000, maxWait: 30_000 },
  );
}
