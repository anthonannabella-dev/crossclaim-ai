/**
 * C-0010-B2 — 支付事件执行尝试（PaymentProcessingAttempt）.
 * ---------------------------------------------------------------
 * Approved rulings: MSG-20260928-86 / -88 / -90 / -92 / -94.
 *
 *   · `PaymentEvent`（入站事实，不可变）→ `PaymentProcessingAttempt`（执行历史，append-only）
 *     → `Payment`（资金事实）→ `BillingInvoice`
 *   · 副本不变量由数据库保证：同一事件同一时刻最多一个进行中的 attempt（部分唯一索引）、
 *     一个 Payment 最多一个成功执行来源（部分唯一索引）、attempt.paymentId 必须同租户（触发器）
 *   · 自动重试**只限技术失败**（DATABASE_TIMEOUT / CAS_CONFLICT / UNKNOWN_PROVIDER_RESPONSE），
 *     上限 3 次、退避 1 / 5 / 15 分钟，超限 → DEAD_LETTER；业务结论（金额不符 / 卡口 / 非法状态）不重试
 *   · replay 只能基于已记录的 `attempt.paymentId` 回到 Payment 重放；
 *     没有 paymentId → `PAYMENT_CONTEXT_REQUIRED`，**绝不接受人工补金额**
 *   · 首次把 paymentId 写到 attempt 上时写审计 `payment.processing_payment_linked`
 *   · 成功（SUCCEEDED）的 attempt 不允许再改 paymentId —— 由 CAS 状态机天然保证
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import {
  applyPaymentSucceeded,
  recoverPaymentSucceeded,
  type ApplyPaymentSucceededResult,
} from './payment';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

export const ATTEMPT_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'RETRYABLE_FAILED',
  'DEAD_LETTER',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const RETRYABLE_ERROR_CODES = [
  'DATABASE_TIMEOUT',
  'CAS_CONFLICT',
  'UNKNOWN_PROVIDER_RESPONSE',
] as const;
export type RetryableErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];

export const REPLAY_REASONS = [
  'DATABASE_TIMEOUT',
  'CAS_CONFLICT',
  'UNKNOWN_PROVIDER_RESPONSE',
  'MANUAL_RECOVERY',
  'OTHER',
] as const;
export type ReplayReason = (typeof REPLAY_REASONS)[number];

export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MINUTES = [1, 5, 15] as const;
export const SYSTEM_RETRY_ACTOR_REF = 'payment-retry-worker';
export const ERROR_SUMMARY_MAX = 160;

export const ATTEMPT_AUDIT = {
  started: 'payment.processing_started',
  failed: 'payment.processing_failed',
  linked: 'payment.processing_payment_linked',
  replayed: 'payment.processing_replayed',
  recovered: 'payment.processing_recovered',
} as const;

/** 第 N 次失败之后的下一次重试延迟；超过上限返回 null（DEAD_LETTER）。 */
export function nextRetryDelayMinutes(attemptNo: number): number | null {
  if (!Number.isInteger(attemptNo) || attemptNo < 1) return null;
  return RETRY_BACKOFF_MINUTES[attemptNo - 1] ?? null;
}

/** 错误摘要只保留白名单代码与短句：长 token 一律脱敏，并截断。 */
export function redactErrorSummary(input: unknown): string {
  const text = typeof input === 'string' ? input : String(input ?? '');
  return text
    .replace(/[A-Za-z0-9_\-]{24,}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_SUMMARY_MAX);
}

export interface AttemptErrorInfo {
  errorCode: RetryableErrorCode;
  errorSummary: string;
  /** 技术失败才允许自动重试；领域错误（WorkflowError）一律不重试。 */
  retryable: boolean;
}

/**
 * 把异常映射到白名单错误码。
 * 只有数据库瞬时故障 / 写冲突 / 未知技术异常可重试；领域错误（NOT_FOUND、REASON_REQUIRED…）
 * 是确定性结论，直接 DEAD_LETTER，不做自动重试。
 */
export function classifyAttemptError(error: unknown): AttemptErrorInfo {
  const summary = redactErrorSummary(error instanceof Error ? error.message : error);
  if (error instanceof WorkflowError) {
    return { errorCode: 'UNKNOWN_PROVIDER_RESPONSE', errorSummary: summary, retryable: false };
  }
  const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : '';
  if (code === 'P2034' || code === 'P2002') {
    return { errorCode: 'CAS_CONFLICT', errorSummary: summary, retryable: true };
  }
  if (
    code === 'P2024' ||
    code === 'P1001' ||
    code === 'P1002' ||
    code === 'P1008' ||
    code === 'P1017' ||
    code === 'P2028'
  ) {
    return { errorCode: 'DATABASE_TIMEOUT', errorSummary: summary, retryable: true };
  }
  return { errorCode: 'UNKNOWN_PROVIDER_RESPONSE', errorSummary: summary, retryable: true };
}

async function writeAttemptAudit(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    actorType: 'SYSTEM' | 'EXTERNAL';
    actorRef: string;
    actorUserId?: string;
    action: string;
    paymentEventId: string;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      ...(input.actorUserId
        ? { actorType: 'USER' as const, actorUserId: input.actorUserId }
        : { actorType: input.actorType, actorRef: input.actorRef }),
      action: input.action,
      entityType: 'PaymentProcessingAttempt',
      entityId: input.paymentEventId,
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

export interface StartAttemptInput {
  organizationId: string;
  paymentEventId: string;
  actorType: 'EXTERNAL' | 'SYSTEM' | 'OPERATOR';
  actorRef: string;
}

/**
 * 新建一次执行尝试。并发保护由数据库的部分唯一索引提供：
 * 同一事件已有一个 PENDING/RUNNING 时，第二次插入会命中唯一冲突 → ILLEGAL_TRANSITION。
 */
export async function startAttempt(
  prisma: PrismaClient,
  input: StartAttemptInput,
  deps: { now?: () => Date } = {},
): Promise<{ id: string; attemptNo: number }> {
  const at = (deps.now ?? (() => new Date()))();
  const latest = await prisma.paymentProcessingAttempt.findFirst({
    where: { organizationId: input.organizationId, paymentEventId: input.paymentEventId },
    orderBy: { attemptNo: 'desc' },
    select: { attemptNo: true },
  });
  const attemptNo = (latest?.attemptNo ?? 0) + 1;

  try {
    const created = await prisma.paymentProcessingAttempt.create({
      data: {
        organizationId: input.organizationId,
        paymentEventId: input.paymentEventId,
        attemptNo,
        status: 'RUNNING',
        actorType: input.actorType,
        actorRef: input.actorRef,
        startedAt: at,
      },
      select: { id: true, attemptNo: true },
    });
    return created;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // REVISE-3：并发冲突转成稳定业务错误码，绝不把 P2002 / unique constraint 暴露给调用方
      throw new WorkflowError('ATTEMPT_ALREADY_RUNNING', 'ATTEMPT_ALREADY_RUNNING：该事件已有进行中的执行尝试');
    }
    throw error;
  }
}

export interface FinishAttemptInput {
  attemptId: string;
  status: Exclude<AttemptStatus, 'PENDING' | 'RUNNING'>;
  resultStatus?: ApplyPaymentSucceededResult['status'];
  errorCode?: RetryableErrorCode;
  errorSummary?: string;
  nextRetryAt?: Date | null;
}

/** CAS 收口：只有 RUNNING 的 attempt 能被收口 —— SUCCEEDED 之后无法再改（含禁止改绑 paymentId）。 */
export async function finishAttempt(
  prisma: PrismaClient,
  input: FinishAttemptInput,
  deps: { now?: () => Date } = {},
): Promise<boolean> {
  const at = (deps.now ?? (() => new Date()))();
  const updated = await prisma.paymentProcessingAttempt.updateMany({
    where: { id: input.attemptId, status: 'RUNNING' },
    data: {
      status: input.status,
      resultStatus: input.resultStatus ?? null,
      errorCode: input.errorCode ?? null,
      errorSummary: input.errorSummary ?? null,
      nextRetryAt: input.nextRetryAt ?? null,
      finishedAt: at,
    },
  });
  return updated.count === 1;
}

export interface ExecuteAttemptInput {
  organizationId: string;
  paymentEventId: string;
  provider: string;
  externalPaymentId: string;
  invoiceId: string;
  amount: string;
  currency: string;
  actorType: 'EXTERNAL' | 'SYSTEM' | 'OPERATOR';
  actorRef: string;
  env?: Record<string, string | undefined>;
}

export interface ExecuteAttemptResult {
  attemptId: string;
  attemptNo: number;
  status: AttemptStatus;
  resultStatus: ApplyPaymentSucceededResult['status'] | null;
  errorCode: RetryableErrorCode | null;
  nextRetryAt: Date | null;
}

/**
 * 共享执行路径（webhook / replay / retry-due 都走这里）：
 * 建 attempt → 执行 applyPaymentSucceeded（paymentId 在**同一个事务**里回填并写链接审计）→ 收口。
 */
export async function executeAttempt(
  prisma: PrismaClient,
  input: ExecuteAttemptInput,
  deps: { now?: () => Date } = {},
): Promise<ExecuteAttemptResult> {
  const at = (deps.now ?? (() => new Date()))();
  const attempt = await startAttempt(
    prisma,
    {
      organizationId: input.organizationId,
      paymentEventId: input.paymentEventId,
      actorType: input.actorType,
      actorRef: input.actorRef,
    },
    { now: () => at },
  );

  try {
    const result = await applyPaymentSucceeded(
      prisma,
      {
        organizationId: input.organizationId,
        provider: input.provider,
        externalPaymentId: input.externalPaymentId,
        invoiceId: input.invoiceId,
        amount: input.amount,
        currency: input.currency,
      },
      {
        now: () => at,
        ...(input.env ? { env: input.env } : {}),
        onPaymentRecorded: async (tx, paymentId) => {
          await tx.paymentProcessingAttempt.updateMany({
            where: { id: attempt.id, status: 'RUNNING' },
            data: { paymentId },
          });
          await writeAttemptAudit(tx, {
            organizationId: input.organizationId,
            actorType: input.actorType === 'EXTERNAL' ? 'EXTERNAL' : 'SYSTEM',
            actorRef: input.actorRef,
            action: ATTEMPT_AUDIT.linked,
            paymentEventId: input.paymentEventId,
            changes: { attemptId: attempt.id, paymentId, paymentEventId: input.paymentEventId },
            at,
          });
        },
      },
    );
    await finishAttempt(
      prisma,
      { attemptId: attempt.id, status: 'SUCCEEDED', resultStatus: result.status },
      { now: () => at },
    );
    return {
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      status: 'SUCCEEDED',
      resultStatus: result.status,
      errorCode: null,
      nextRetryAt: null,
    };
  } catch (error) {
    const info = classifyAttemptError(error);
    const delayMinutes = info.retryable ? nextRetryDelayMinutes(attempt.attemptNo) : null;
    const status: AttemptStatus = delayMinutes === null ? 'DEAD_LETTER' : 'RETRYABLE_FAILED';
    const nextRetryAt = delayMinutes === null ? null : new Date(at.getTime() + delayMinutes * 60_000);
    await finishAttempt(
      prisma,
      {
        attemptId: attempt.id,
        status,
        errorCode: info.errorCode,
        errorSummary: info.errorSummary,
        nextRetryAt,
      },
      { now: () => at },
    );
    await prisma.$transaction(async (tx) => {
      await writeAttemptAudit(tx, {
        organizationId: input.organizationId,
        actorType: input.actorType === 'EXTERNAL' ? 'EXTERNAL' : 'SYSTEM',
        actorRef: input.actorRef,
        action: ATTEMPT_AUDIT.failed,
        paymentEventId: input.paymentEventId,
        changes: {
          attemptId: attempt.id,
          attemptNo: attempt.attemptNo,
          status,
          errorCode: info.errorCode,
          errorSummary: info.errorSummary,
        },
        at,
      });
    });
    return {
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      status,
      resultStatus: null,
      errorCode: info.errorCode,
      nextRetryAt,
    };
  }
}

export interface ReplayInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  paymentEventId: string;
  reason: unknown;
  note?: unknown;
}

export interface ReplayResult {
  paymentEventId: string;
  attemptId: string;
  attemptNo: number;
  status: AttemptStatus;
  resultStatus: ApplyPaymentSucceededResult['status'] | null;
}

/** 重放：只能沿 attempt.paymentId → Payment 回到同一条资金事实；没有上下文一律 409，绝不人工补金额。 */
export async function replayPaymentEvent(
  prisma: PrismaClient,
  input: ReplayInput,
  deps: { now?: () => Date } = {},
): Promise<ReplayResult> {
  assertPermission(input.role, 'setCommercialTerms');
  assertPermission(input.role, 'advanceBilling');

  const reason = typeof input.reason === 'string' ? input.reason.trim().toUpperCase() : '';
  if (!(REPLAY_REASONS as readonly string[]).includes(reason)) {
    throw new WorkflowError('INVALID_INPUT', 'REASON_REQUIRED：replay 必须给出白名单原因');
  }
  const note = typeof input.note === 'string' ? redactErrorSummary(input.note) : '';

  const event = await prisma.paymentEvent.findFirst({
    where: { id: input.paymentEventId, organizationId: input.organizationId },
    select: { id: true, provider: true },
  });
  if (!event) throw new WorkflowError('NOT_FOUND', `支付事件 ${input.paymentEventId} 不存在或不属于该租户`);

  const linked = await prisma.paymentProcessingAttempt.findFirst({
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

  const payment = await prisma.payment.findFirst({
    where: { id: linked.paymentId, organizationId: input.organizationId },
    select: { id: true, invoiceId: true, externalPaymentId: true, amount: true, currency: true },
  });
  if (!payment) {
    throw new WorkflowError('NOT_FOUND', `Payment ${linked.paymentId} 不存在或不属于该租户`);
  }

  const at = (deps.now ?? (() => new Date()))();
  const attempt = await startAttempt(
    prisma,
    {
      organizationId: input.organizationId,
      paymentEventId: event.id,
      actorType: 'OPERATOR',
      actorRef: input.actorUserId,
    },
    { now: () => at },
  );

  const outcome = await recoverPaymentSucceeded(
    prisma,
    {
      organizationId: input.organizationId,
      provider: event.provider,
      externalPaymentId: payment.externalPaymentId,
      invoiceId: payment.invoiceId,
      amount: payment.amount.toFixed(4),
      currency: payment.currency,
    },
    {
      now: () => at,
      onPaymentRecorded: async (tx, paymentId) => {
        await tx.paymentProcessingAttempt.updateMany({
          where: { id: attempt.id, status: 'RUNNING' },
          data: { paymentId },
        });
        await writeAttemptAudit(tx, {
          organizationId: input.organizationId,
          actorType: 'SYSTEM',
          actorRef: input.actorUserId,
          actorUserId: input.actorUserId,
          action: ATTEMPT_AUDIT.linked,
          paymentEventId: event.id,
          changes: { attemptId: attempt.id, paymentId, paymentEventId: event.id },
          at,
        });
      },
    },
  );

  await finishAttempt(
    prisma,
    { attemptId: attempt.id, status: 'SUCCEEDED', resultStatus: outcome.status },
    { now: () => at },
  );
  await prisma.$transaction(async (tx) => {
    await writeAttemptAudit(tx, {
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: input.actorUserId,
      actorUserId: input.actorUserId,
      action: ATTEMPT_AUDIT.replayed,
      paymentEventId: event.id,
      changes: {
        paymentEventId: event.id,
        oldAttemptNo: linked.attemptNo,
        newAttemptNo: attempt.attemptNo,
        reason,
        ...(note ? { note } : {}),
      },
      at,
    });
    // REVISE-2：恢复成功要有独立标识，财务审计能区分「webhook 正常成功」与「恢复成功」
    await writeAttemptAudit(tx, {
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: input.actorUserId,
      actorUserId: input.actorUserId,
      action: ATTEMPT_AUDIT.recovered,
      paymentEventId: event.id,
      changes: {
        paymentEventId: event.id,
        attemptId: attempt.id,
        paymentId: payment.id,
        resultStatus: outcome.status,
        recovery: true,
      },
      at,
    });
  });

  return {
    paymentEventId: event.id,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    status: 'SUCCEEDED',
    resultStatus: outcome.status,
  };
}

export interface RetryDueResult {
  scanned: number;
  retried: ReplayResult[];
  deadLettered: Array<{ attemptId: string; paymentEventId: string; reason: string }>;
}

/** 自动重放：只处理 RETRYABLE_FAILED 且到点的 attempt；没有 paymentId 的一律 DEAD_LETTER（不猜）。 */
export async function runDueRetries(
  prisma: PrismaClient,
  input: { organizationId: string; role: string; limit?: number },
  deps: { now?: () => Date } = {},
): Promise<RetryDueResult> {
  assertPermission(input.role, 'setCommercialTerms');
  assertPermission(input.role, 'advanceBilling');
  const at = (deps.now ?? (() => new Date()))();
  const take = Math.min(Math.max(input.limit ?? 20, 1), 100);

  const due = await prisma.paymentProcessingAttempt.findMany({
    where: {
      organizationId: input.organizationId,
      status: 'RETRYABLE_FAILED',
      nextRetryAt: { lte: at },
    },
    orderBy: { nextRetryAt: 'asc' },
    take,
    select: { id: true, paymentEventId: true, paymentId: true, attemptNo: true },
  });

  const retried: ReplayResult[] = [];
  const deadLettered: RetryDueResult['deadLettered'] = [];

  for (const attempt of due) {
    if (!attempt.paymentId) {
      await prisma.paymentProcessingAttempt.updateMany({
        where: { id: attempt.id, status: 'RETRYABLE_FAILED' },
        data: { status: 'DEAD_LETTER', nextRetryAt: null, finishedAt: at },
      });
      deadLettered.push({
        attemptId: attempt.id,
        paymentEventId: attempt.paymentEventId,
        reason: 'PAYMENT_CONTEXT_REQUIRED',
      });
      continue;
    }

    const event = await prisma.paymentEvent.findFirst({
      where: { id: attempt.paymentEventId, organizationId: input.organizationId },
      select: { id: true, provider: true },
    });
    const payment = await prisma.payment.findFirst({
      where: { id: attempt.paymentId, organizationId: input.organizationId },
      select: { id: true, invoiceId: true, externalPaymentId: true, amount: true, currency: true },
    });
    if (!event || !payment) {
      await prisma.paymentProcessingAttempt.updateMany({
        where: { id: attempt.id, status: 'RETRYABLE_FAILED' },
        data: { status: 'DEAD_LETTER', nextRetryAt: null, finishedAt: at },
      });
      deadLettered.push({
        attemptId: attempt.id,
        paymentEventId: attempt.paymentEventId,
        reason: 'PAYMENT_CONTEXT_REQUIRED',
      });
      continue;
    }

    const next = await startAttempt(
      prisma,
      {
        organizationId: input.organizationId,
        paymentEventId: event.id,
        actorType: 'SYSTEM',
        actorRef: SYSTEM_RETRY_ACTOR_REF,
      },
      { now: () => at },
    );
    try {
      const outcome = await recoverPaymentSucceeded(
        prisma,
        {
          organizationId: input.organizationId,
          provider: event.provider,
          externalPaymentId: payment.externalPaymentId,
          invoiceId: payment.invoiceId,
          amount: payment.amount.toFixed(4),
          currency: payment.currency,
        },
        {
          now: () => at,
          onPaymentRecorded: async (tx, paymentId) => {
            await tx.paymentProcessingAttempt.updateMany({
              where: { id: next.id, status: 'RUNNING' },
              data: { paymentId },
            });
            await writeAttemptAudit(tx, {
              organizationId: input.organizationId,
              actorType: 'SYSTEM',
              actorRef: SYSTEM_RETRY_ACTOR_REF,
              action: ATTEMPT_AUDIT.linked,
              paymentEventId: event.id,
              changes: { attemptId: next.id, paymentId, paymentEventId: event.id },
              at,
            });
          },
        },
      );
      await finishAttempt(
        prisma,
        { attemptId: next.id, status: 'SUCCEEDED', resultStatus: outcome.status },
        { now: () => at },
      );
      await prisma.$transaction(async (tx) => {
        await writeAttemptAudit(tx, {
          organizationId: input.organizationId,
          actorType: 'SYSTEM',
          actorRef: SYSTEM_RETRY_ACTOR_REF,
          action: ATTEMPT_AUDIT.recovered,
          paymentEventId: event.id,
          changes: {
            paymentEventId: event.id,
            attemptId: next.id,
            paymentId: payment.id,
            resultStatus: outcome.status,
            recovery: true,
          },
          at,
        });
      });
      retried.push({
        paymentEventId: event.id,
        attemptId: next.id,
        attemptNo: next.attemptNo,
        status: 'SUCCEEDED',
        resultStatus: outcome.status,
      });
    } catch (error) {
      const info = classifyAttemptError(error);
      const delay = info.retryable ? nextRetryDelayMinutes(next.attemptNo) : null;
      await finishAttempt(
        prisma,
        {
          attemptId: next.id,
          status: delay === null ? 'DEAD_LETTER' : 'RETRYABLE_FAILED',
          errorCode: info.errorCode,
          errorSummary: info.errorSummary,
          nextRetryAt: delay === null ? null : new Date(at.getTime() + delay * 60_000),
        },
        { now: () => at },
      );
      await prisma.$transaction(async (tx) => {
        await writeAttemptAudit(tx, {
          organizationId: input.organizationId,
          actorType: 'SYSTEM',
          actorRef: SYSTEM_RETRY_ACTOR_REF,
          action: ATTEMPT_AUDIT.failed,
          paymentEventId: event.id,
          changes: {
            attemptId: next.id,
            attemptNo: next.attemptNo,
            errorCode: info.errorCode,
            errorSummary: info.errorSummary,
          },
          at,
        });
      });
      deadLettered.push({
        attemptId: next.id,
        paymentEventId: event.id,
        reason: info.errorCode,
      });
    }
  }

  return { scanned: due.length, retried, deadLettered };
}
