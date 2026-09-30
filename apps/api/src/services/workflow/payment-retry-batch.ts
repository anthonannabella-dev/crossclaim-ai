/**
 * ② 第二批 retry-due — 冻结清单批次审批（MSG-20260930-22 §6(2) / MSG-20260930-28 §7）
 * ---------------------------------------------------------------------------
 * 与 replay 的差别：这里批准的不是"单条事件"，而是**一份冻结的到期清单**。
 *   · 服务端生成 `batchId`；清单 **排序固定**、逐项固化事实指纹；
 *   · 指纹包含：attempt/event 清单及版本、关联发票、金额币种、操作类型、数量上限与有效期；
 *   · 执行时只处理**冻结清单内**的项，绝不动态纳入批准后新增的 due 项；
 *   · 每项执行前重验事实/权限/生命周期/幂等，变化项跳过并留证；
 *   · 执行身份为 SYSTEM（`actorRef = payment-retry-worker`），预先授权范围 = 冻结清单 + batchId + 有效期。
 */

import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { PAYMENT_RETRY_DUE_ACTION } from '../action-guard/approval-verifier';
import { nextLifecycleAt, normalizeApprovalTtl } from './recovery-review';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';
import { PAYMENT_REVIEW_ACTIONS, type PaymentReviewState, resolvePaymentReviewState } from './payment';

export const RETRY_BATCH_OPERATION = 'retry_due';
export const RETRY_BATCH_VERSION = 'v1';
export const RETRY_BATCH_DIGEST_VERSION = 'v1';
export const RETRY_BATCH_MAX_ITEMS = 20;
export const RETRY_BATCH_DEFAULT_TTL_MS = 15 * 60_000;
export const RETRY_BATCH_ACTOR_REF = 'payment-retry-worker';
export const RETRY_BATCH_EVENTS = {
  frozen: 'payment.retry_batch_frozen',
  skipped: 'payment.retry_due_skipped',
  executed: 'payment.retry_due_executed',
} as const;

export interface RetryBatchItemFingerprint {
  attemptId: string;
  attemptNo: number;
  paymentEventId: string;
  provider: string;
  providerEventId: string;
  payloadHash: string;
  paymentId: string;
  paymentProvider: string;
  invoiceId: string;
  externalPaymentId: string;
  amount: string;
  currency: string;
  operation: string;
  version: string;
}

export interface RetryBatchRecord {
  batchId: string;
  organizationId: string;
  digest: string;
  digestVersion: string;
  itemCount: number;
  expiresAt: string;
  items: RetryBatchItemFingerprint[];
  requestedBy: string;
  createdAt: string;
}

const money = (value: InstanceType<typeof Prisma.Decimal>): string =>
  new Prisma.Decimal(value).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);

/** 清单指纹：排序后的规范化 JSON 的 sha256（同一清单必得同一摘要）。 */
export function retryBatchDigest(items: readonly RetryBatchItemFingerprint[]): string {
  const canonical = items.map((item) => ({
    attemptId: item.attemptId,
    attemptNo: item.attemptNo,
    paymentEventId: item.paymentEventId,
    provider: item.provider,
    providerEventId: item.providerEventId,
    payloadHash: item.payloadHash,
    paymentId: item.paymentId,
    paymentProvider: item.paymentProvider,
    invoiceId: item.invoiceId,
    externalPaymentId: item.externalPaymentId,
    amount: item.amount,
    currency: item.currency,
    operation: item.operation,
    version: item.version,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface FreezeRetryBatchResult {
  batchId: string;
  digest: string;
  digestVersion: string;
  itemCount: number;
  expiresAt: string;
}

/**
 * 冻结当前到期清单（只读选取 + 固化指纹 + 落库为 PaymentRetryBatch 审计记录）。
 * 仅 `RETRYABLE_FAILED` 且已到 `nextRetryAt` 且具备 `paymentId` 的项进入清单。
 */
export async function freezeRetryBatch(
  prisma: PrismaClient,
  input: { organizationId: string; actorUserId: string; role: string; limit?: number; ttlMs?: number },
  deps: { now?: () => Date } = {},
): Promise<FreezeRetryBatchResult> {
  assertPermission(input.role, 'setCommercialTerms');
  assertPermission(input.role, 'advanceBilling');
  const now = deps.now ?? (() => new Date());
  const at = now();
  const take = Math.min(Math.max(input.limit ?? RETRY_BATCH_MAX_ITEMS, 1), RETRY_BATCH_MAX_ITEMS);
  const ttlMs = Math.max(60_000, Math.min(input.ttlMs ?? RETRY_BATCH_DEFAULT_TTL_MS, 60 * 60_000));

  const due = await prisma.paymentProcessingAttempt.findMany({
    where: {
      organizationId: input.organizationId,
      status: 'RETRYABLE_FAILED',
      nextRetryAt: { lte: at },
      paymentId: { not: null },
    },
    // 排序固定：nextRetryAt 优先，其次 id（确定性清单）
    orderBy: [{ nextRetryAt: 'asc' }, { id: 'asc' }],
    take,
    select: { id: true, attemptNo: true, paymentEventId: true, paymentId: true },
  });

  // attempt 与 Payment/PaymentEvent 无关系字段：分别取回后在内存中连接
  const paymentIds = due.map((attempt) => attempt.paymentId).filter((id): id is string => typeof id === 'string');
  const eventIds = [...new Set(due.map((attempt) => attempt.paymentEventId))];
  const payments = await prisma.payment.findMany({
    where: { organizationId: input.organizationId, id: { in: paymentIds } },
    select: { id: true, provider: true, invoiceId: true, externalPaymentId: true, amount: true, currency: true },
  });
  const events = await prisma.paymentEvent.findMany({
    where: { organizationId: input.organizationId, id: { in: eventIds } },
    select: { id: true, provider: true, providerEventId: true, payloadHash: true },
  });
  const paymentById = new Map(payments.map((row) => [row.id, row]));
  const eventById = new Map(events.map((row) => [row.id, row]));

  const items: RetryBatchItemFingerprint[] = [];
  for (const attempt of due) {
    const payment = attempt.paymentId ? paymentById.get(attempt.paymentId) : undefined;
    const event = eventById.get(attempt.paymentEventId);
    if (!payment || !event || !attempt.paymentId) continue;
    items.push({
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      paymentEventId: attempt.paymentEventId,
      provider: event.provider,
      providerEventId: event.providerEventId,
      payloadHash: event.payloadHash,
      paymentId: payment.id,
      paymentProvider: payment.provider,
      invoiceId: payment.invoiceId,
      externalPaymentId: payment.externalPaymentId,
      amount: money(payment.amount),
      currency: payment.currency,
      operation: RETRY_BATCH_OPERATION,
      version: RETRY_BATCH_VERSION,
    });
  }

  const batchId = crypto.randomUUID();
  const digest = retryBatchDigest(items);
  const expiresAt = new Date(at.getTime() + ttlMs);
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: RETRY_BATCH_EVENTS.frozen,
      entityType: 'PaymentRetryBatch',
      entityId: batchId,
      changes: {
        batchId,
        digest,
        digestVersion: RETRY_BATCH_DIGEST_VERSION,
        itemCount: items.length,
        expiresAt: expiresAt.toISOString(),
        requestedBy: input.actorUserId,
        operation: RETRY_BATCH_OPERATION,
        version: RETRY_BATCH_VERSION,
        items,
      },
    },
    { maxStringLength: 512 },
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
      createdAt: at,
    },
  });

  return { batchId, digest, digestVersion: RETRY_BATCH_DIGEST_VERSION, itemCount: items.length, expiresAt: expiresAt.toISOString() };
}

/** 读取批次记录（冻结清单）；缺失/租户不符返回 null。 */
export async function readRetryBatch(
  client: PrismaClient | Prisma.TransactionClient,
  input: { organizationId: string; batchId: string },
): Promise<RetryBatchRecord | null> {
  const row = await client.auditLog.findFirst({
    where: {
      organizationId: input.organizationId,
      entityType: 'PaymentRetryBatch',
      entityId: input.batchId,
      action: RETRY_BATCH_EVENTS.frozen,
    },
    select: { changes: true, createdAt: true },
  });
  const changes = (row?.changes ?? null) as Record<string, unknown> | null;
  if (!changes || typeof changes.digest !== 'string' || !Array.isArray(changes.items)) return null;
  return {
    batchId: input.batchId,
    organizationId: input.organizationId,
    digest: changes.digest,
    digestVersion: String(changes.digestVersion ?? ''),
    itemCount: Number(changes.itemCount ?? 0),
    expiresAt: String(changes.expiresAt ?? ''),
    items: changes.items as RetryBatchItemFingerprint[],
    requestedBy: String(changes.requestedBy ?? ''),
    createdAt: (row?.createdAt ?? new Date()).toISOString(),
  };
}

export interface RetryBatchReviewResult {
  batchId: string;
  state: PaymentReviewState;
  approvalId: string | null;
  digest?: string;
  itemCount?: number;
  expiresAt?: string;
}

/** 批次审批（REQUEST / APPROVE / REJECT）；APPROVE 绑定 batchId + 清单摘要 + 数量上限。 */
export async function submitRetryBatchReview(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    role: string;
    batchId: string;
    decision: 'REQUEST' | 'APPROVE' | 'REJECT';
    reason?: string;
    approvalTtlMs?: number;
  },
  deps: { now?: () => Date } = {},
): Promise<RetryBatchReviewResult> {
  assertPermission(input.role, 'setCommercialTerms');
  assertPermission(input.role, 'advanceBilling');
  if (input.decision === 'REJECT' && (!input.reason || input.reason.trim() === '')) {
    throw new WorkflowError('REASON_REQUIRED', 'REJECT 必须给出 reason');
  }
  const now = deps.now ?? (() => new Date());

  const batch = await readRetryBatch(prisma, { organizationId: input.organizationId, batchId: input.batchId });
  if (!batch) throw new WorkflowError('NOT_FOUND', `批次 ${input.batchId} 不存在或不属于该租户`);

  return prisma.$transaction(async (tx) => {
    // 与执行侧同一把批次锁
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-retry-batch:${batch.batchId}`);
    }
    const events = await tx.auditLog.findMany({
      where: {
        organizationId: input.organizationId,
        entityType: 'PaymentRetryBatch',
        entityId: batch.batchId,
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
    const at = nextLifecycleAt(events, now);

    const write = async (action: string, changes: Record<string, unknown>) => {
      const row = prepareAuditInsert(
        {
          organizationId: input.organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action,
          entityType: 'PaymentRetryBatch',
          entityId: batch.batchId,
          changes,
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
          createdAt: at,
        },
      });
      return created.id;
    };

    if (input.decision === 'REQUEST') {
      if (state === 'PENDING') throw new WorkflowError('ILLEGAL_TRANSITION', '该批次已处于待审批状态');
      await write(PAYMENT_REVIEW_ACTIONS.required, {
        batchId: batch.batchId,
        digest: batch.digest,
        itemCount: batch.itemCount,
        action: PAYMENT_RETRY_DUE_ACTION,
        version: RETRY_BATCH_VERSION,
      });
      return { batchId: batch.batchId, state: 'PENDING' as PaymentReviewState, approvalId: null };
    }

    if (state !== 'PENDING') {
      throw new WorkflowError('ILLEGAL_TRANSITION', `当前状态 ${state} 不允许审批（必须先有待审批请求）`);
    }

    if (input.decision === 'REJECT') {
      await write(PAYMENT_REVIEW_ACTIONS.rejected, {
        batchId: batch.batchId,
        reason: input.reason?.trim() ?? '',
      });
      return { batchId: batch.batchId, state: 'REJECTED' as PaymentReviewState, approvalId: null };
    }

    const expiresAt = new Date(at.getTime() + normalizeApprovalTtl(input.approvalTtlMs));
    const approvalId = await write(PAYMENT_REVIEW_ACTIONS.approved, {
      batchId: batch.batchId,
      charged: false,
      boundAction: PAYMENT_RETRY_DUE_ACTION,
      boundPayload: {
        amount: null,
        currency: null,
        basisReference: batch.batchId,
        evidenceArtifactId: batch.digest,
        fingerprintVersion: 'v1',
        batchId: batch.batchId,
        digest: batch.digest,
        digestVersion: batch.digestVersion,
        itemCount: batch.itemCount,
        expiresAt: expiresAt.toISOString(),
      },
      expiresAt: expiresAt.toISOString(),
    });
    return {
      batchId: batch.batchId,
      state: 'APPROVED' as PaymentReviewState,
      approvalId,
      digest: batch.digest,
      itemCount: batch.itemCount,
      expiresAt: expiresAt.toISOString(),
    };
  });
}
