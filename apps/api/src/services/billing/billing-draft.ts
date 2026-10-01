/**
 * BILLING 草稿写入 —— 受保护动作 `billing.draft`（Gate 7 / ② 下一小批次 · INTERNAL_WRITE）
 * -----------------------------------------------------------------------------------
 * 依据 MSG-20261001-10 §5（批次范围）与 MSG-20261001-11 CHANGE A/B/C（修订项）：
 *   - INTERNAL_WRITE：只需能力闸门，不引入人工审批；
 *   - 锁顺序：案件锁 → 既有账单行锁 → **费用依据行锁** → 最终主体/角色重验 → 生成执行时间 → 幂等/拒绝/写入；
 *   - CHANGE A：幂等返回必须反映**真实持久化状态**，不把已签发/已支付账单呈现为草稿；
 *     返回可靠的既有记录时间（invoiceRefAt）与本次检查时间（checkedAt），不互相冒充；
 *     费用依据按集合返回（不宣称唯一）；
 *   - CHANGE B：案件仅有 VOID / WRITTEN_OFF 历史账单时**结构化 409**（账单号固定 `BILL-<caseNo>` 且
 *     `@@unique([organizationId, invoiceNo])`），不删除/不重用旧账单，也不触发唯一约束 500；
 *     替代账单编号与费用继承策略另批设计；
 *   - CHANGE C：费用依据必须在**锁后**重读为唯一可靠执行事实：禁止把已关联其他账单的费用重新挂到新账单；
 *     校验金额 > 0 且币种为 3 位大写；无有效依据 → 409 BILLING_BASIS_REQUIRED；
 *     契约口径收窄为「符合明确条件的既有费用计算记录」（Schema 无「已确认」状态，不宣称已完成人工确认）；
 *   - 只写业务库：不推进收款 / 到账 / 扣划，不触达平台。
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

/** 既有账单可被幂等复用的状态（VOID / WRITTEN_OFF 不在此列，见 CHANGE B） */
export type BillingInvoiceStatusValue = 'DRAFT' | 'ISSUED' | 'PAID' | 'PARTIALLY_PAID';
const REUSABLE_INVOICE_STATUSES: readonly BillingInvoiceStatusValue[] = ['DRAFT', 'ISSUED', 'PAID', 'PARTIALLY_PAID'];

export interface BillingDraftInput {
  organizationId: string;
  actorUserId: string;
  /** 会话内角色；仅作事务前快速拒绝，最终裁决在全部资源锁之后按数据库当前角色执行 */
  role: string;
  caseId: string;
  note?: string;
}

export interface BillingDraftResult {
  caseId: string;
  invoiceId: string;
  invoiceNo: string;
  /** **实际持久化状态**：幂等返回时不改写成 DRAFT */
  status: BillingInvoiceStatusValue;
  subtotal: string;
  total: string;
  currency: string;
  /** 该账单当前关联的全部费用依据（按 id 升序；多依据时按集合返回，不宣称唯一） */
  basisFeeCalculationIds: string[];
  /** true = 本次新建草稿；false = 幂等返回既有账单 */
  created: boolean;
  /** 新建时为本次写入时间；幂等返回时为既有账单 createdAt（原记录时间） */
  invoiceRefAt: string;
  /** 本次调用的检查/返回时间（不冒充起草时间） */
  checkedAt: string;
  /** **本次调用**未执行收款（不代表既有账单未收款） */
  paymentCollectedByThisCall: false;
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

/** 计费契约的明确条件（CHANGE C）：金额 > 0 且币种为 3 位大写 */
function isValidBillingBasis(fee: { feeAmount: Prisma.Decimal; currency: string }): boolean {
  const amount = new Prisma.Decimal(fee.feeAmount);
  return amount.greaterThan(0) && /^[A-Z]{3}$/.test(fee.currency);
}

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
      // 1) 案件锁（与 claim.submit / claim.prepare 同协议）
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `cc-recovery-case:${input.caseId}`,
      );

      // 2) 租户隔离：案件
      const kase = await tx.case.findFirst({
        where: { id: input.caseId, organizationId: input.organizationId },
        select: { id: true, caseNo: true },
      });
      if (!kase) throw new WorkflowError('NOT_FOUND', '案件不存在或不属于该租户');

      // 3) 资源锁 A：该案件既有账单（串行化并发起草与幂等判定）
      const lockedInvoices = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        'SELECT id, status FROM "BillingInvoice" WHERE "organizationId" = $1 AND "caseId" = $2 ORDER BY "createdAt" ASC FOR UPDATE',
        input.organizationId,
        input.caseId,
      );

      // 4) 资源锁 B：该案件费用依据行（CHANGE C：锁后重读为可靠执行事实）
      const lockedFees = await tx.$queryRawUnsafe<Array<{ id: string; billingInvoiceId: string | null }>>(
        'SELECT id, "billingInvoiceId" FROM "FeeCalculation" WHERE "organizationId" = $1 AND "caseId" = $2 ORDER BY "calculatedAt" DESC FOR UPDATE',
        input.organizationId,
        input.caseId,
      );

      // 5) 全部必要资源锁取得之后：最终主体与权限重验（等待费用锁期间的角色变化在此被拦下）
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

      // 6) 幂等：已有可复用账单 → 返回**真实**状态与既有记录时间
      const reusable = lockedInvoices.find((row) =>
        (REUSABLE_INVOICE_STATUSES as readonly string[]).includes(row.status),
      );
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
            createdAt: true,
            fees: { select: { id: true }, orderBy: { id: 'asc' } },
          },
        });
        return {
          caseId: input.caseId,
          invoiceId: existing.id,
          invoiceNo: existing.invoiceNo,
          status: existing.status as BillingInvoiceStatusValue,
          subtotal: money(existing.subtotal),
          total: money(existing.total),
          currency: existing.currency,
          basisFeeCalculationIds: existing.fees.map((fee) => fee.id),
          created: false,
          invoiceRefAt: existing.createdAt.toISOString(),
          checkedAt: at.toISOString(),
          paymentCollectedByThisCall: false as const,
          platformWriteExecuted: false as const,
        };
      }

      // 7) CHANGE B：仅有 VOID / WRITTEN_OFF 历史账单 → 结构化 409（不删除、不重用、不抢移费用关联）
      if (lockedInvoices.length > 0) {
        throw new WorkflowError(
          'BILLING_REISSUE_REQUIRES_NEW_NUMBER',
          '该案件仅有已作废/已核销账单，重新起草需要新的账单编号策略（另批设计）',
        );
      }

      // 8) CHANGE C：锁后选取并重读唯一可靠费用依据（禁止抢移已关联其他账单的费用）
      const candidate = lockedFees.find((row) => row.billingInvoiceId === null);
      if (!candidate) {
        throw new WorkflowError(
          'BILLING_BASIS_REQUIRED',
          '缺少可用的费用计算记录（FeeCalculation）：不存在，或已关联其他账单',
        );
      }
      const fee = await tx.feeCalculation.findUniqueOrThrow({
        where: { id: candidate.id },
        select: {
          id: true,
          organizationId: true,
          caseId: true,
          feeAmount: true,
          currency: true,
          billingInvoiceId: true,
        },
      });
      if (
        fee.organizationId !== input.organizationId ||
        fee.caseId !== input.caseId ||
        fee.billingInvoiceId !== null ||
        !isValidBillingBasis({ feeAmount: fee.feeAmount, currency: fee.currency })
      ) {
        throw new WorkflowError('BILLING_BASIS_REQUIRED', '费用计算记录不满足账单起草条件（锁后校验失败）');
      }

      // 9) 创建 DRAFT 账单（不推进收款/到账/扣划）
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
          // CHANGE A（MSG-20261001-12）：原记录时间只保留一个持久化来源 —— 显式写入 createdAt，
          // 首次响应、数据库记录与幂等重试返回的 invoiceRefAt 因此精确一致。
          createdAt: at,
          fees: { connect: { id: fee.id } },
        },
        select: { id: true, invoiceNo: true, status: true, subtotal: true, total: true, currency: true },
      });

      // 10) 业务审计与写入同事务；金额/币种/依据与写入结果一致
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
        basisFeeCalculationIds: [fee.id],
        created: true,
        invoiceRefAt: at.toISOString(),
        checkedAt: at.toISOString(),
        paymentCollectedByThisCall: false as const,
        platformWriteExecuted: false as const,
      };
    },
    { timeout: 30_000, maxWait: 30_000 },
  );
}
