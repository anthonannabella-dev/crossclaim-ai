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
  readReplaySnapshot,
  recoverPaymentSucceeded,
  replayFingerprintExtra,
  type ApplyPaymentSucceededResult,
  type PaymentReplayFingerprint,
} from './payment';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';
import { PAYMENT_REPLAY_ACTION } from '../action-guard/approval-verifier';
import {
  ApprovalBoundaryError,
  PAYMENT_APPROVAL_EVENT_ACTION,
  PAYMENT_REJECTED_EVENT_ACTION,
  PAYMENT_REPLAY_CONSUMED_EVENT_ACTION,
  PAYMENT_REQUIRED_EVENT_ACTION,
  verifyApprovalBoundary,
} from '../action-guard/approval-tx-verify';

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

/** ② 第二批 replay：事务内/外都可用的最小客户端类型 */
type AttemptClient = PrismaClient | Prisma.TransactionClient;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 重放消费审计（与执行同事务；approvalId 供验证器判定「已消费」） */
async function writeReplayConsumedAudit(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    actorUserId: string;
    approvalId: string;
    operationId: string;
    fingerprint: PaymentReplayFingerprint;
    resultStatus: string | null;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: 'payment-replay-guard',
      action: PAYMENT_REPLAY_CONSUMED_EVENT_ACTION,
      entityType: 'PaymentEvent',
      entityId: input.fingerprint.paymentEventId,
      changes: {
        approvalId: input.approvalId,
        operationId: input.operationId,
        actorUserId: input.actorUserId,
        paymentEventId: input.fingerprint.paymentEventId,
        invoiceId: input.fingerprint.invoiceId,
        provider: input.fingerprint.provider,
        providerEventId: input.fingerprint.providerEventId,
        payloadHash: input.fingerprint.payloadHash,
        amount: input.fingerprint.amount,
        currency: input.fingerprint.currency,
        recoveryAction: input.fingerprint.recoveryAction,
        processingVersion: input.fingerprint.processingVersion,
        resultStatus: input.resultStatus,
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
      createdAt: input.at,
    },
  });
}

/** replay 锁内拒绝的最终拒绝审计（事务已回滚 → 独立连接写入；失败不覆盖原错误） */
async function writeReplayRejectionAudit(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    paymentEventId: string;
    approvalId: string | null;
    stage: string;
    reason: string;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: 'payment-replay-guard',
      action: 'payment.replay_rejected',
      entityType: 'PaymentEvent',
      entityId: input.paymentEventId,
      changes: {
        paymentEventId: input.paymentEventId,
        actorUserId: input.actorUserId,
        approvalId: input.approvalId,
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
  prisma: AttemptClient,
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
  prisma: AttemptClient,
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
  /** ② 第二批 replay：操作级审批（payment.replay）。缺失即拒绝，不提供 bypass。 */
  approvalId?: string;
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
  const approvalId = str(input.approvalId);
  // ② 第二批 replay：操作级审批不可选。缺审批一律拒绝 —— 受保护资金入口不留 bypass。
  if (!approvalId || str(input.paymentEventId) === null) {
    throw new ApprovalBoundaryError('APPROVAL_NOT_FOUND', String(input.paymentEventId ?? ''));
  }

  // 锁外预检查只用于快速失败；执行依据一律取自锁内执行快照（与 R7 同口径）。
  const pre = await prisma.paymentEvent.findFirst({
    where: { id: input.paymentEventId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!pre) throw new WorkflowError('NOT_FOUND', `支付事件 ${input.paymentEventId} 不存在或不属于该租户`);

  try {
    return await prisma.$transaction(async (tx) => {
      // 统一锁协议：事件级 advisory lock（审批创建 submitPaymentReplayReview 使用同一把锁）
      if (typeof tx.$executeRawUnsafe === 'function') {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-event:${pre.id}`);
      }

      // 锁内执行快照：事件身份 + 关联 attempt + 资金事实
      const locating = await readReplaySnapshot(tx, {
        organizationId: input.organizationId,
        paymentEventId: pre.id,
      });
      // R8 修订 CHANGE A：在**必要锁全部取得之后**再做最终重验（事件锁 → 发票锁）
      if (typeof tx.$executeRawUnsafe === 'function') {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-invoice:${locating.invoiceId}`);
      }
      // R9 修订 CHANGE A：定位快照只能用于定位目标 —— 在固定锁顺序（事件锁 → 发票锁）之后
      // 为关联 **Payment 行**加行锁（FOR UPDATE），再重读最终事实作为唯一执行依据。
      // R10 修订：Payment 身份必须自洽 —— 事件 provider 与 Payment.provider 不一致即失败关闭
      if (locating.paymentProvider !== locating.provider) {
        throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', locating.paymentEventId);
      }
      // 按租户 + **关联 Payment.id** 取得行锁，并确认恰一行且 id 正确
      if (typeof tx.$queryRawUnsafe === 'function') {
        const locked = (await tx.$queryRawUnsafe(
          'SELECT id FROM "Payment" WHERE "organizationId" = $1 AND id = $2 FOR UPDATE',
          input.organizationId,
          locating.paymentId,
        )) as Array<{ id?: string }>;
        if (!Array.isArray(locked) || locked.length !== 1 || locked[0]?.id !== locating.paymentId) {
          throw new ApprovalBoundaryError('APPROVAL_TARGET_MISMATCH', locating.paymentEventId);
        }
      }
      // 最终快照：事件身份 / 关联发票 / 资金事实（金额、币种、externalPaymentId）全部锁后重读
      const snapshot = await readReplaySnapshot(tx, {
        organizationId: input.organizationId,
        paymentEventId: pre.id,
      });
      // 关键关联若在等待期间改变 → 拒绝（不得沿用定位快照继续执行）
      if (
        snapshot.paymentId !== locating.paymentId ||
        snapshot.paymentProvider !== locating.paymentProvider ||
        snapshot.invoiceId !== locating.invoiceId ||
        snapshot.externalPaymentId !== locating.externalPaymentId ||
        snapshot.payloadHash !== locating.payloadHash ||
        snapshot.providerEventId !== locating.providerEventId
      ) {
        throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', snapshot.paymentEventId);
      }
      // 重验时间在所有可能等待的必要锁（事件锁 → 发票锁 → Payment 行锁）取得之后生成
      const at = (deps.now ?? (() => new Date()))();
      // 锁内重验审批：指纹逐项比对锁内快照（过期/撤销/取代/消费均在锁内判定）
      const boundary = await verifyApprovalBoundary(tx, {
        organizationId: input.organizationId,
        approvalId,
        action: PAYMENT_REPLAY_ACTION,
        caseId: snapshot.paymentEventId,
        actorUserId: input.actorUserId,
        payload: {
          amount: snapshot.amount,
          currency: snapshot.currency,
          basisReference: snapshot.basisReference,
          evidenceArtifactId: snapshot.evidenceArtifactId,
        },
        extra: replayFingerprintExtra(snapshot),
        now: at,
        approvalEventAction: PAYMENT_APPROVAL_EVENT_ACTION,
        requiredEventAction: PAYMENT_REQUIRED_EVENT_ACTION,
        revocationEventActions: [PAYMENT_REJECTED_EVENT_ACTION],
        consumedEventAction: PAYMENT_REPLAY_CONSUMED_EVENT_ACTION,
        targetEntityType: 'PaymentEvent',
      });
      if (!boundary.ok) throw new ApprovalBoundaryError(boundary.reason, snapshot.paymentEventId);
      if (boundary.consumed) {
        throw new ApprovalBoundaryError('APPROVAL_ALREADY_CONSUMED', snapshot.paymentEventId);
      }

      const attempt = await startAttempt(
        tx,
        {
          organizationId: input.organizationId,
          paymentEventId: snapshot.paymentEventId,
          actorType: 'OPERATOR',
          actorRef: input.actorUserId,
        },
        { now: () => at },
      );

      // 重放沿用既有资金执行路径，但事实来自**锁内快照**，且与核验/消费处于同一事务
      const outcome = await recoverPaymentSucceeded(
        tx,
        {
          organizationId: input.organizationId,
          provider: snapshot.provider,
          externalPaymentId: snapshot.externalPaymentId,
          invoiceId: snapshot.invoiceId,
          amount: snapshot.amount,
          currency: snapshot.currency,
        },
        {
          now: () => at,
          client: tx,
          onPaymentRecorded: async (innerTx, paymentId) => {
            await innerTx.paymentProcessingAttempt.updateMany({
              where: { id: attempt.id, status: 'RUNNING' },
              data: { paymentId },
            });
            await writeAttemptAudit(innerTx, {
              organizationId: input.organizationId,
              actorType: 'SYSTEM',
              actorRef: input.actorUserId,
              actorUserId: input.actorUserId,
              action: ATTEMPT_AUDIT.linked,
              paymentEventId: snapshot.paymentEventId,
              changes: { attemptId: attempt.id, paymentId, paymentEventId: snapshot.paymentEventId },
              at,
            });
          },
        },
      );

      await finishAttempt(
        tx,
        { attemptId: attempt.id, status: 'SUCCEEDED', resultStatus: outcome.status },
        { now: () => at },
      );
      await writeAttemptAudit(tx, {
        organizationId: input.organizationId,
        actorType: 'SYSTEM',
        actorRef: input.actorUserId,
        actorUserId: input.actorUserId,
        action: ATTEMPT_AUDIT.replayed,
        paymentEventId: snapshot.paymentEventId,
        changes: {
          paymentEventId: snapshot.paymentEventId,
          oldAttemptNo: snapshot.previousAttemptNo,
          newAttemptNo: attempt.attemptNo,
          reason,
          ...(note ? { note } : {}),
          approvalId,
          operationId: `approval:${approvalId}`,
        },
        at,
      });
      // 恢复成功要有独立标识，财务审计能区分「webhook 正常成功」与「恢复成功」
      await writeAttemptAudit(tx, {
        organizationId: input.organizationId,
        actorType: 'SYSTEM',
        actorRef: input.actorUserId,
        actorUserId: input.actorUserId,
        action: ATTEMPT_AUDIT.recovered,
        paymentEventId: snapshot.paymentEventId,
        changes: {
          paymentEventId: snapshot.paymentEventId,
          attemptId: attempt.id,
          paymentId: outcome.paymentId,
          resultStatus: outcome.status,
          recovery: true,
        },
        at,
      });
      // 消费事件与本次执行同事务、同锁：同审批并发只有一次能走到这里
      await writeReplayConsumedAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        approvalId,
        operationId: `approval:${approvalId}`,
        fingerprint: snapshot,
        resultStatus: outcome.status,
        at,
      });

      return {
        paymentEventId: snapshot.paymentEventId,
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        status: 'SUCCEEDED' as AttemptStatus,
        resultStatus: outcome.status,
      };
    });
  } catch (error) {
    // 锁内拒绝 → 独立的最终拒绝审计（事务已回滚，故用独立连接写入；失败不覆盖原错误）
    if (error instanceof ApprovalBoundaryError || error instanceof WorkflowError) {
      const reasonCode = error instanceof ApprovalBoundaryError ? error.reason : error.code;
      await writeReplayRejectionAudit(prisma, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        paymentEventId: input.paymentEventId,
        approvalId,
        stage: 'LOCKED_RECHECK',
        reason: reasonCode,
        at: (deps.now ?? (() => new Date()))(),
      }).catch(() => undefined);
    }
    throw error;
  }
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
