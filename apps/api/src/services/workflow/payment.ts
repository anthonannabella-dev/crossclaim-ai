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
import { PAYMENT_CAPTURE_ACTION, PAYMENT_REPLAY_ACTION } from '../action-guard/approval-verifier';
import { nextLifecycleAt, normalizeApprovalTtl, normalizeBoundPayload } from './recovery-review';
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
): Promise<string> {
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
  });
  return created.id;
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

/** 资金执行可运行在独立事务（webhook/首处理）或调用方**已有的锁内事务**（replay）中 */
export type PaymentExecClient = PrismaClient | Prisma.TransactionClient;

export async function applyPaymentSucceeded(
  prisma: PaymentExecClient,
  input: ApplyPaymentSucceededInput,
  deps: {
    now?: () => Date;
    env?: Record<string, string | undefined>;
    /** ② 第二批 replay：由调用方提供**已有的锁内事务**，使核验/执行/消费同事务（不新开事务） */
    client?: Prisma.TransactionClient;
    /**
     * C-0010-B2：Payment 行被记入的**同一个事务**里回调，用于把执行尝试链接到 Payment
     * 并写 `payment.processing_payment_linked` 审计（链接与资金事实同生共死）。
     */
    onPaymentRecorded?: (tx: Prisma.TransactionClient, paymentId: string) => Promise<void>;
  } = {},
): Promise<ApplyPaymentSucceededResult> {
  const at = (deps.now ?? (() => new Date()))();
  const mode: PaymentSucceededMode = input.mode ?? 'FIRST_PROCESSING';

  // R8 修订 CHANGE A：锁外仅做存在性预检查（快速失败）；执行依据一律取锁内快照
  const client = deps.client ?? prisma;
  const preInvoice = await client.billingInvoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
    select: { id: true, status: true },
  });
  if (!preInvoice) {
    throw new WorkflowError('NOT_FOUND', `发票 ${input.invoiceId} 不存在或不属于该租户`);
  }

  // ② 第二批 replay：允许在调用方已有的**锁内事务**中执行（统一锁协议 + 统一执行快照）
  const exec = deps.client
    ? (fn: (tx: Prisma.TransactionClient) => Promise<ApplyPaymentSucceededResult>) =>
        fn(deps.client as Prisma.TransactionClient)
    : (fn: (tx: Prisma.TransactionClient) => Promise<ApplyPaymentSucceededResult>) =>
        (prisma as PrismaClient).$transaction(fn);
  return exec(async (tx) => {
    // R8 修订 CHANGE A：统一锁协议 —— 资金执行必须先取得该发票的行级咨询锁
    // （与 R7 账单状态写入同一把锁；锁顺序固定为：事件锁 → 发票锁，避免反向获取）
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-invoice:${input.invoiceId}`);
    }
    // 锁后重读**最终发票事实**：判定、CAS 与写入全部使用这份快照
    const invoice = await tx.billingInvoice.findFirst({
      where: { id: input.invoiceId, organizationId: input.organizationId },
      select: { id: true, status: true, total: true, currency: true, invoiceNo: true },
    });
    if (!invoice) {
      throw new WorkflowError('NOT_FOUND', `发票 ${input.invoiceId} 不存在或不属于该租户`);
    }
    const amountMatches = money(invoice.total) === money(input.amount);
    const currencyMatches = invoice.currency === input.currency;
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
    // R8 修订 CHANGE A：状态 + 记账事实（total/currency）双重 CAS；
    // 即使存在不遵守发票锁协议的写入者，也只会 CAS 未命中而拒绝，不会写入旧快照金额。
    const updated = await tx.billingInvoice.updateMany({
      where: {
        id: invoice.id,
        organizationId: input.organizationId,
        status: 'ISSUED',
        total: invoice.total,
        currency: invoice.currency,
      },
      data: { status: 'PAID', paidAt: at, paidAmount: invoice.total },
    });
    if (updated.count !== 1) {
      await writeAudit(tx, {
        organizationId: input.organizationId,
        actor: { type: 'EXTERNAL', ref: input.provider },
        action: 'payment.reconciliation_failed',
        entityType: 'BillingInvoice',
        entityId: invoice.id,
        changes: {
          reason: 'invoice facts changed before update (status/amount/currency CAS miss)',
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
  prisma: PaymentExecClient,
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
    /**
     * P1（② 第二批）：APPROVE 必须绑定本次操作的规范化载荷。
     * 形状与 recovery 一致（amount/currency/basisReference/evidenceArtifactId），便于复用验证器。
     */
    boundPayload?: {
      amount?: unknown;
      currency?: unknown;
      basisReference?: unknown;
      evidenceArtifactId?: unknown;
      /** R6 CHANGE A：绑定准确的状态迁移（收费确认必须 to=PAID） */
      from?: unknown;
      to?: unknown;
    };
    /** 服务端固定动作；缺省 = payment.capture */
    boundAction?: string;
    approvalTtlMs?: number;
  },
  deps: { now?: () => Date } = {},
): Promise<{ invoiceId: string; state: PaymentReviewState; approvalId: string | null }> {
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

  const now = deps.now ?? (() => new Date());
  return prisma.$transaction(async (tx) => {
    // P1：目标级串行化（发票粒度），与 recovery 的案件锁同一模式
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-invoice:${invoice.id}`);
    }
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
    // P1：生命周期事件时间在锁内生成，且同发票严格递增（与 recovery nextLifecycleAt 同规则）
    const at = nextLifecycleAt(events, now);

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
      return { invoiceId: invoice.id, state: 'PENDING' as PaymentReviewState, approvalId: null };
    }

    if (state !== 'PENDING') {
      throw new WorkflowError('ILLEGAL_TRANSITION', `当前状态 ${state} 不允许审批（必须先有待审批请求）`);
    }
    const action =
      input.decision === 'APPROVE' ? PAYMENT_REVIEW_ACTIONS.approved : PAYMENT_REVIEW_ACTIONS.rejected;
    // P1：APPROVE 必须绑定本次操作的规范化载荷（金额/币种/依据），未知指纹版本拒绝
    const bound = input.decision === 'APPROVE'
      ? normalizeBoundPayload({
          recoveredAmount: input.boundPayload?.amount,
          currency: input.boundPayload?.currency,
          basisReference: input.boundPayload?.basisReference,
          evidenceArtifactId: input.boundPayload?.evidenceArtifactId,
        })
      : null;
    const fromStatus = typeof input.boundPayload?.from === 'string' ? input.boundPayload.from.trim().toUpperCase() : '';
    const toStatus = typeof input.boundPayload?.to === 'string' ? input.boundPayload.to.trim().toUpperCase() : '';
    if (input.decision === 'APPROVE') {
      if (!bound || bound.amount === null || bound.currency === null || bound.basisReference === null) {
        throw new WorkflowError('INVALID_INPUT', '审批必须绑定完整操作载荷（金额/币种/依据）');
      }
      if (bound.fingerprintVersion !== 'v1') {
        throw new WorkflowError('INVALID_INPUT', '未知的审批载荷指纹版本');
      }
      if (fromStatus === '' || toStatus === '') {
        throw new WorkflowError('INVALID_INPUT', '审批必须绑定准确的状态迁移（from/to）');
      }
      if (toStatus !== 'PAID') {
        throw new WorkflowError('INVALID_INPUT', 'payment.capture 审批只能用于 PAID 收费确认（签发等迁移需独立授权）');
      }
    }
    const expiresAt =
      input.decision === 'APPROVE' ? new Date(at.getTime() + normalizeApprovalTtl(input.approvalTtlMs)) : null;
    const approvalId = await writeAudit(tx, {
      organizationId: input.organizationId,
      actor: { type: 'USER', userId: input.actorUserId },
      action,
      entityType: 'BillingInvoice',
      entityId: invoice.id,
      changes: {
        invoiceNo: invoice.invoiceNo,
        ...(input.reason ? { reason: input.reason } : {}),
        charged: false,
        ...(bound && input.decision === 'APPROVE'
          ? {
              // R6 CHANGE A：真实账单操作指纹（目标 + 迁移 + 金额/币种/依据）
              boundPayload: { ...bound, invoiceId: invoice.id, from: fromStatus, to: toStatus },
              boundAction: input.boundAction && input.boundAction.trim() !== '' ? input.boundAction.trim() : PAYMENT_CAPTURE_ACTION,
              expiresAt: expiresAt ? expiresAt.toISOString() : null,
            }
          : {}),
      },
      at,
    });
    return {
      invoiceId: invoice.id,
      state: input.decision === 'APPROVE' ? ('APPROVED' as PaymentReviewState) : ('REJECTED' as PaymentReviewState),
      approvalId: input.decision === 'APPROVE' ? approvalId : null,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * ② 第二批 replay（MSG-20260930-22 §6(1) / MSG-20260930-24 §7）
 * 审批目标 = 具体 `PaymentEvent`；指纹由**服务端**组装（客户端不可替换原始 JSON）。
 * 与 payment.capture 是两条独立授权：互不通用、互不消费。
 * ──────────────────────────────────────────────────────────────────────────── */

export const REPLAY_RECOVERY_ACTION = 'recoverPaymentSucceeded';
export const REPLAY_PROCESSING_VERSION = 'v1';

export interface PaymentReplayFingerprint {
  paymentEventId: string;
  /** 关联 Payment 的行身份（R10 修订：行锁按它取得并核对） */
  paymentId: string;
  /** 关联 Payment.provider（R10 修订：必须与事件 provider 一致） */
  paymentProvider: string;
  invoiceId: string;
  provider: string;
  providerEventId: string;
  payloadHash: string;
  externalPaymentId: string;
  amount: string;
  currency: string;
  /** 事件身份（规范化）：provider:providerEventId */
  basisReference: string;
  /** 载荷摘要（绝不绑定用户可替换的原始 JSON） */
  evidenceArtifactId: string;
  recoveryAction: string;
  processingVersion: string;
  /** 仅用于审计上下文（不是审批指纹的一部分） */
  previousAttemptNo: number;
}

type ReplayReadClient = PrismaClient | Prisma.TransactionClient;

/**
 * 读取（或**锁内重读**）本次 replay 的执行快照：事件身份 + 关联 attempt + 资金事实。
 * 无可用 paymentId → `PAYMENT_CONTEXT_REQUIRED`（不猜、不人工补金额）。
 */
export async function readReplaySnapshot(
  client: ReplayReadClient,
  input: { organizationId: string; paymentEventId: string },
): Promise<PaymentReplayFingerprint> {
  const event = await client.paymentEvent.findFirst({
    where: { id: input.paymentEventId, organizationId: input.organizationId },
    select: { id: true, provider: true, providerEventId: true, payloadHash: true },
  });
  if (!event) {
    throw new WorkflowError('NOT_FOUND', `支付事件 ${input.paymentEventId} 不存在或不属于该租户`);
  }
  const linked = await client.paymentProcessingAttempt.findFirst({
    where: { organizationId: input.organizationId, paymentEventId: event.id, paymentId: { not: null } },
    orderBy: { attemptNo: 'desc' },
    select: { attemptNo: true, paymentId: true },
  });
  if (!linked?.paymentId) {
    throw new WorkflowError(
      'PAYMENT_CONTEXT_REQUIRED',
      'PAYMENT_CONTEXT_REQUIRED：该事件没有可用的 paymentId，无法安全重放（请走财务人工对账）',
    );
  }
  const payment = await client.payment.findFirst({
    where: { id: linked.paymentId, organizationId: input.organizationId },
    select: { id: true, invoiceId: true, externalPaymentId: true, amount: true, currency: true, provider: true },
  });
  if (!payment) throw new WorkflowError('NOT_FOUND', `Payment ${linked.paymentId} 不存在或不属于该租户`);
  if (!linked.paymentId) throw new WorkflowError('NOT_FOUND', 'Payment 关联缺失');

  return {
    paymentEventId: event.id,
    paymentId: payment.id,
    paymentProvider: payment.provider,
    invoiceId: payment.invoiceId,
    provider: event.provider,
    providerEventId: event.providerEventId,
    payloadHash: event.payloadHash,
    externalPaymentId: payment.externalPaymentId,
    amount: money(payment.amount),
    currency: payment.currency,
    basisReference: `${event.provider}:${event.providerEventId}`,
    evidenceArtifactId: event.payloadHash,
    recoveryAction: REPLAY_RECOVERY_ACTION,
    processingVersion: REPLAY_PROCESSING_VERSION,
    previousAttemptNo: linked.attemptNo ?? 0,
  };
}

/** 审批指纹的「额外键」：执行侧锁内快照必须与其逐项一致（verifyApprovalBoundary 的 extra）。 */
export function replayFingerprintExtra(fp: PaymentReplayFingerprint): Record<string, string> {
  return {
    paymentEventId: fp.paymentEventId,
    paymentId: fp.paymentId,
    paymentProvider: fp.paymentProvider,
    invoiceId: fp.invoiceId,
    provider: fp.provider,
    providerEventId: fp.providerEventId,
    payloadHash: fp.payloadHash,
    externalPaymentId: fp.externalPaymentId,
    recoveryAction: fp.recoveryAction,
    processingVersion: fp.processingVersion,
  };
}

export interface PaymentReplayReviewResult {
  paymentEventId: string;
  state: PaymentReviewState;
  approvalId: string | null;
  fingerprint?: PaymentReplayFingerprint;
}

/**
 * replay 的 HITL 复核（REQUEST / APPROVE / REJECT），目标为具体 `PaymentEvent`。
 * APPROVE 由**服务端**组装绑定载荷（金额/币种/事件身份/载荷摘要/恢复动作/处理版本），
 * 客户端不能替换指纹内容。
 */
export async function submitPaymentReplayReview(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    role: string;
    paymentEventId: string;
    decision: 'REQUEST' | 'APPROVE' | 'REJECT';
    reason?: string;
    approvalTtlMs?: number;
  },
  deps: { now?: () => Date } = {},
): Promise<PaymentReplayReviewResult> {
  assertPermission(input.role, 'setCommercialTerms');
  assertPermission(input.role, 'advanceBilling');
  if (input.decision === 'REJECT' && (!input.reason || input.reason.trim() === '')) {
    throw new WorkflowError('REASON_REQUIRED', 'REJECT 必须给出 reason');
  }

  const event = await prisma.paymentEvent.findFirst({
    where: { id: input.paymentEventId, organizationId: input.organizationId },
    select: { id: true, providerEventId: true },
  });
  if (!event) throw new WorkflowError('NOT_FOUND', `支付事件 ${input.paymentEventId} 不存在或不属于该租户`);

  const now = deps.now ?? (() => new Date());
  return prisma.$transaction(async (tx) => {
    // 与执行侧同一把锁：审批生命周期写入与 replay 执行遵循一致的串行化协议
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-event:${event.id}`);
    }
    const events = await tx.auditLog.findMany({
      where: {
        organizationId: input.organizationId,
        entityType: 'PaymentEvent',
        entityId: event.id,
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
    // 生命周期事件时间在锁内生成且同目标严格递增（与账单域同规则）
    const at = nextLifecycleAt(events, now);

    if (input.decision === 'REQUEST') {
      if (state === 'PENDING') throw new WorkflowError('ILLEGAL_TRANSITION', '该支付事件已处于待审批状态');
      await writeAudit(tx, {
        organizationId: input.organizationId,
        actor: { type: 'USER', userId: input.actorUserId },
        action: PAYMENT_REVIEW_ACTIONS.required,
        entityType: 'PaymentEvent',
        entityId: event.id,
        changes: { providerEventId: event.providerEventId, action: PAYMENT_REPLAY_ACTION, version: REPLAY_PROCESSING_VERSION },
        at,
      });
      return { paymentEventId: event.id, state: 'PENDING' as PaymentReviewState, approvalId: null };
    }

    if (state !== 'PENDING') {
      throw new WorkflowError('ILLEGAL_TRANSITION', `当前状态 ${state} 不允许审批（必须先有待审批请求）`);
    }

    if (input.decision === 'REJECT') {
      await writeAudit(tx, {
        organizationId: input.organizationId,
        actor: { type: 'USER', userId: input.actorUserId },
        action: PAYMENT_REVIEW_ACTIONS.rejected,
        entityType: 'PaymentEvent',
        entityId: event.id,
        changes: { providerEventId: event.providerEventId, reason: input.reason?.trim() ?? '' },
        at,
      });
      return { paymentEventId: event.id, state: 'REJECTED' as PaymentReviewState, approvalId: null };
    }

    // APPROVE：锁内读取执行快照并以此为指纹（服务端组装，客户端不可替换）
    const fingerprint = await readReplaySnapshot(tx, {
      organizationId: input.organizationId,
      paymentEventId: event.id,
    });
    const expiresAt = new Date(at.getTime() + normalizeApprovalTtl(input.approvalTtlMs));
    const approvalId = await writeAudit(tx, {
      organizationId: input.organizationId,
      actor: { type: 'USER', userId: input.actorUserId },
      action: PAYMENT_REVIEW_ACTIONS.approved,
      entityType: 'PaymentEvent',
      entityId: event.id,
      changes: {
        providerEventId: event.providerEventId,
        charged: false,
        boundPayload: {
          amount: fingerprint.amount,
          currency: fingerprint.currency,
          basisReference: fingerprint.basisReference,
          evidenceArtifactId: fingerprint.evidenceArtifactId,
          fingerprintVersion: 'v1',
          ...replayFingerprintExtra(fingerprint),
        },
        boundAction: PAYMENT_REPLAY_ACTION,
        expiresAt: expiresAt.toISOString(),
      },
      at,
    });
    return {
      paymentEventId: event.id,
      state: 'APPROVED' as PaymentReviewState,
      approvalId,
      fingerprint,
    };
  });
}
