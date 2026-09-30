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
import {
  ApprovalBoundaryError,
  PAYMENT_APPROVAL_EVENT_ACTION,
  PAYMENT_REJECTED_EVENT_ACTION,
  PAYMENT_REQUIRED_EVENT_ACTION,
  PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION,
  verifyApprovalBoundary,
} from '../action-guard/approval-tx-verify';
import { PAYMENT_RETRY_DUE_ACTION } from '../action-guard/approval-verifier';
import { MAX_ATTEMPTS, finishAttempt, startAttempt } from './payment-attempt';
import { nextLifecycleAt, normalizeApprovalTtl } from './recovery-review';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';
import {
  PAYMENT_REVIEW_ACTIONS,
  recoverPaymentSucceeded,
  type PaymentReviewState,
  resolvePaymentReviewState,
} from './payment';

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

/**
 * CHANGE C：批次锁后集中校验冻结记录（未知版本 / 损坏清单 / 重复项 / 数量异常一律失败关闭）。
 */
export function assertRetryBatchRecord(record: RetryBatchRecord): void {
  if (record.digestVersion !== RETRY_BATCH_DIGEST_VERSION) {
    throw new ApprovalBoundaryError('APPROVAL_VERSION_UNSUPPORTED', record.batchId);
  }
  if (!Array.isArray(record.items) || record.items.length === 0 || record.items.length > RETRY_BATCH_MAX_ITEMS) {
    throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', record.batchId);
  }
  if (record.itemCount !== record.items.length) {
    throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', record.batchId);
  }
  const expiresAt = new Date(record.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new ApprovalBoundaryError('APPROVAL_SOURCE_ERROR', record.batchId);
  }
  const seenAttempts = new Set<string>();
  for (const item of record.items) {
    const strings = [
      item.attemptId,
      item.paymentEventId,
      item.provider,
      item.providerEventId,
      item.payloadHash,
      item.paymentId,
      item.paymentProvider,
      item.invoiceId,
      item.externalPaymentId,
      item.amount,
      item.currency,
    ];
    if (strings.some((value) => typeof value !== 'string' || value === '')) {
      throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', record.batchId);
    }
    if (!Number.isInteger(item.attemptNo) || item.attemptNo < 1) {
      throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', record.batchId);
    }
    if (item.operation !== RETRY_BATCH_OPERATION || item.version !== RETRY_BATCH_VERSION) {
      throw new ApprovalBoundaryError('APPROVAL_VERSION_UNSUPPORTED', record.batchId);
    }
    if (seenAttempts.has(item.attemptId)) {
      throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', record.batchId);
    }
    seenAttempts.add(item.attemptId);
  }
  if (retryBatchDigest(record.items) !== record.digest) {
    throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', record.batchId);
  }
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
    // 冻结清单需要完整保存（逐项指纹）：放宽审计序列化预算，避免清单被截断
    { maxStringLength: 20_000 },
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
    itemCount: Number(changes.itemCount ?? Number.NaN),
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
    // CHANGE C：锁后重读并集中校验冻结记录（审批不得基于锁前记录）
    const lockedBatch = await readRetryBatch(tx, {
      organizationId: input.organizationId,
      batchId: batch.batchId,
    });
    if (!lockedBatch) throw new WorkflowError('NOT_FOUND', `批次 ${batch.batchId} 不存在或不属于该租户`);
    assertRetryBatchRecord(lockedBatch);
    // CHANGE A：冻结有效期在审批时强制生效（过期冻结不得重新批准延长）
    const approvalAt = now();
    if (approvalAt.getTime() >= new Date(lockedBatch.expiresAt).getTime()) {
      throw new ApprovalBoundaryError('APPROVAL_EXPIRED', lockedBatch.batchId);
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
        batchId: lockedBatch.batchId,
        digest: lockedBatch.digest,
        itemCount: lockedBatch.itemCount,
        action: PAYMENT_RETRY_DUE_ACTION,
        version: RETRY_BATCH_VERSION,
      });
      return { batchId: lockedBatch.batchId, state: 'PENDING' as PaymentReviewState, approvalId: null };
    }

    if (state !== 'PENDING') {
      throw new WorkflowError('ILLEGAL_TRANSITION', `当前状态 ${state} 不允许审批（必须先有待审批请求）`);
    }

    if (input.decision === 'REJECT') {
      await write(PAYMENT_REVIEW_ACTIONS.rejected, {
        batchId: lockedBatch.batchId,
        reason: input.reason?.trim() ?? '',
      });
      return { batchId: lockedBatch.batchId, state: 'REJECTED' as PaymentReviewState, approvalId: null };
    }

    const expiresAt = new Date(at.getTime() + normalizeApprovalTtl(input.approvalTtlMs));
    const approvalId = await write(PAYMENT_REVIEW_ACTIONS.approved, {
      batchId: lockedBatch.batchId,
      charged: false,
      boundAction: PAYMENT_RETRY_DUE_ACTION,
      boundPayload: {
        amount: null,
        currency: null,
        basisReference: lockedBatch.batchId,
        evidenceArtifactId: lockedBatch.digest,
        fingerprintVersion: 'v1',
        batchId: lockedBatch.batchId,
        digest: lockedBatch.digest,
        digestVersion: lockedBatch.digestVersion,
        itemCount: String(lockedBatch.itemCount),
        expiresAt: expiresAt.toISOString(),
        // CHANGE C：审批绑定**冻结截止时间**（执行侧核对，避免只绑定独立审批截止）
        freezeExpiresAt: lockedBatch.expiresAt,
      },
      expiresAt: expiresAt.toISOString(),
    });
    return {
      batchId: lockedBatch.batchId,
      state: 'APPROVED' as PaymentReviewState,
      approvalId,
      digest: lockedBatch.digest,
      itemCount: lockedBatch.itemCount,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export interface RetryBatchExecutionResult {
  batchId: string;
  digest: string;
  itemCount: number;
  executed: Array<{ attemptId: string; paymentEventId: string; attemptNo: number; resultStatus: string | null }>;
  skipped: Array<{ attemptId: string; paymentEventId: string; reason: string }>;
}

function itemFactsMatch(
  item: RetryBatchItemFingerprint,
  current: { event: { provider: string; providerEventId: string; payloadHash: string } | null; payment: { id: string; provider: string; invoiceId: string; externalPaymentId: string; amount: string; currency: string } | null },
): string | null {
  if (!current.event) return 'EVENT_MISSING';
  if (!current.payment) return 'PAYMENT_MISSING';
  if (current.event.provider !== item.provider) return 'EVENT_PROVIDER_CHANGED';
  if (current.event.providerEventId !== item.providerEventId) return 'EVENT_IDENTITY_CHANGED';
  if (current.event.payloadHash !== item.payloadHash) return 'EVENT_PAYLOAD_CHANGED';
  if (current.payment.id !== item.paymentId) return 'PAYMENT_IDENTITY_CHANGED';
  if (current.payment.provider !== item.paymentProvider) return 'PAYMENT_PROVIDER_CHANGED';
  if (current.payment.provider !== current.event.provider) return 'PAYMENT_PROVIDER_MISMATCH';
  if (current.payment.invoiceId !== item.invoiceId) return 'INVOICE_RELATION_CHANGED';
  if (current.payment.externalPaymentId !== item.externalPaymentId) return 'EXTERNAL_ID_CHANGED';
  if (current.payment.amount !== item.amount) return 'AMOUNT_CHANGED';
  if (current.payment.currency !== item.currency) return 'CURRENCY_CHANGED';
  return null;
}

/**
 * 执行冻结批次（受保护动作 `payment.retry_due`）。
 *
 * 结构：**单一事务**内完成 批次锁 → 审批核验（batchId/摘要/数量上限/有效期）→ 逐项重验与执行 → 批次消费。
 *   · 只处理**冻结清单内**的项（绝不动态纳入批准后新增的 due 项）；
 *   · 每项复用 replay 已验收协议：事件锁 → 发票锁 → Payment 行锁 → 最终事实比对 → attempt → 资金写入（同一事务）；
 *   · 事实/生命周期/幂等不满足的项 → 跳过并在同一事务内留证（`payment.retry_due_skipped`）；
 *   · 执行身份 = SYSTEM（`actorRef = payment-retry-worker`），预授权范围 = 冻结清单 + batchId + 有效期。
 */
export async function executeRetryBatch(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    role: string;
    batchId: string;
    approvalId?: string;
  },
  deps: { now?: () => Date } = {},
): Promise<RetryBatchExecutionResult> {
  assertPermission(input.role, 'setCommercialTerms');
  assertPermission(input.role, 'advanceBilling');

  const approvalId = typeof input.approvalId === 'string' && input.approvalId.trim() !== '' ? input.approvalId.trim() : '';
  if (!approvalId) throw new ApprovalBoundaryError('APPROVAL_NOT_FOUND', input.batchId);

  const pre = await readRetryBatch(prisma, { organizationId: input.organizationId, batchId: input.batchId });
  if (!pre) throw new WorkflowError('NOT_FOUND', `批次 ${input.batchId} 不存在或不属于该租户`);

  const now = deps.now ?? (() => new Date());
  const approvalPayload = (batch: RetryBatchRecord) => ({
    amount: null,
    currency: null,
    basisReference: batch.batchId,
    evidenceArtifactId: batch.digest,
  });
  const approvalExtra = (batch: RetryBatchRecord) => ({
    batchId: batch.batchId,
    digest: batch.digest,
    digestVersion: batch.digestVersion,
    itemCount: String(batch.itemCount),
    freezeExpiresAt: batch.expiresAt,
  });

  return prisma.$transaction(async (tx) => {
    // 批次锁：与审批创建/其他执行者共用同一把锁（恰一次消费的串行化点）
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-retry-batch:${pre.batchId}`);
    }
    const at = now();
    const batch = await readRetryBatch(tx, { organizationId: input.organizationId, batchId: pre.batchId });
    if (!batch) throw new WorkflowError('NOT_FOUND', `批次 ${pre.batchId} 不存在或不属于该租户`);
    assertRetryBatchRecord(batch);
    const batchExpiresAt = new Date(batch.expiresAt).getTime();
    if (at.getTime() >= batchExpiresAt) {
      throw new ApprovalBoundaryError('APPROVAL_EXPIRED', batch.batchId);
    }

    const boundary = await verifyApprovalBoundary(tx, {
      organizationId: input.organizationId,
      approvalId,
      action: PAYMENT_RETRY_DUE_ACTION,
      caseId: batch.batchId,
      actorUserId: input.actorUserId,
      payload: approvalPayload(batch),
      extra: approvalExtra(batch),
      now: at,
      approvalEventAction: PAYMENT_APPROVAL_EVENT_ACTION,
      requiredEventAction: PAYMENT_REQUIRED_EVENT_ACTION,
      revocationEventActions: [PAYMENT_REJECTED_EVENT_ACTION],
      consumedEventAction: PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION,
      targetEntityType: 'PaymentRetryBatch',
    });
    if (!boundary.ok) throw new ApprovalBoundaryError(boundary.reason, batch.batchId);
    if (boundary.consumed) throw new ApprovalBoundaryError('APPROVAL_ALREADY_CONSUMED', batch.batchId);

    // ② 安全整批锁协议（MSG-20260930-30 CHANGE B）：按确定性顺序**分阶段**取锁，
    //    先全部事件锁 → 再全部发票锁 → 再 Payment / attempt 行锁，
    //    消除「已持发票锁再等待新事件锁」的循环等待（与 replay 兼容：事件→发票→Payment）。
    const orderedItems = [...batch.items].sort((left, right) =>
      `${left.paymentEventId}|${left.invoiceId}|${left.paymentId}|${left.attemptId}`.localeCompare(
        `${right.paymentEventId}|${right.invoiceId}|${right.paymentId}|${right.attemptId}`,
      ),
    );
    // CHANGE A（MSG-31）：**每个阶段的资源集合独立排序**（不得由事件顺序推断其他资源顺序）
    const sortedIds = (ids: string[]) => [...new Set(ids)].sort((left, right) => left.localeCompare(right));
    const eventIds = sortedIds(orderedItems.map((item) => item.paymentEventId));
    const invoiceIds = sortedIds(orderedItems.map((item) => item.invoiceId));
    const paymentIds = sortedIds(orderedItems.map((item) => item.paymentId));
    const attemptIds = sortedIds(orderedItems.map((item) => item.attemptId));

    if (typeof tx.$executeRawUnsafe === 'function') {
      for (const eventId of eventIds) {
        // eslint-disable-next-line no-await-in-loop
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-event:${eventId}`);
      }
      for (const invoiceId of invoiceIds) {
        // eslint-disable-next-line no-await-in-loop
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-payment-invoice:${invoiceId}`);
      }
    }

    // CHANGE B（MSG-31）：记录**实际锁定成功的行身份**；未锁定项不得执行
    const lockedPayments = new Set<string>();
    const lockedAttempts = new Set<string>();
    if (typeof tx.$queryRawUnsafe === 'function') {
      for (const paymentId of paymentIds) {
        // eslint-disable-next-line no-await-in-loop
        const lockedPayment = (await tx.$queryRawUnsafe(
          'SELECT id FROM "Payment" WHERE "organizationId" = $1 AND id = $2 FOR UPDATE',
          input.organizationId,
          paymentId,
        )) as Array<{ id?: string }>;
        if (Array.isArray(lockedPayment) && lockedPayment.length === 1 && lockedPayment[0]?.id === paymentId) {
          lockedPayments.add(paymentId);
        }
      }
      for (const attemptId of attemptIds) {
        // eslint-disable-next-line no-await-in-loop
        const lockedAttempt = (await tx.$queryRawUnsafe(
          'SELECT id FROM "PaymentProcessingAttempt" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE',
          attemptId,
          input.organizationId,
        )) as Array<{ id?: string }>;
        if (Array.isArray(lockedAttempt) && lockedAttempt.length === 1 && lockedAttempt[0]?.id === attemptId) {
          lockedAttempts.add(attemptId);
        }
      }
    } else {
      // 无原始查询能力（单元测试替身）时按已取得 advisory lock 处理
      for (const paymentId of paymentIds) lockedPayments.add(paymentId);
      for (const attemptId of attemptIds) lockedAttempts.add(attemptId);
    }

    const executed: RetryBatchExecutionResult['executed'] = [];
    const skipped: RetryBatchExecutionResult['skipped'] = [];

    const writeBatchAudit = async (
      action: string,
      changes: Record<string, unknown>,
      createdAt: Date,
      actorType: 'SYSTEM' = 'SYSTEM',
    ) => {
      const row = prepareAuditInsert(
        {
          organizationId: input.organizationId,
          actorType,
          actorRef: RETRY_BATCH_ACTOR_REF,
          action,
          entityType: 'PaymentRetryBatch',
          entityId: batch.batchId,
          changes,
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
          createdAt,
        },
      });
    };

    for (const item of orderedItems) {
      // 所有必要锁均已持有：本项统一使用**锁后判定时间**
      const itemAt = now();
      const writeSkip = async (reason: string) => {
        await writeBatchAudit(
          RETRY_BATCH_EVENTS.skipped,
          {
            batchId: batch.batchId,
            digest: batch.digest,
            attemptId: item.attemptId,
            paymentEventId: item.paymentEventId,
            reason,
            result: 'SKIPPED',
            actorUserId: input.actorUserId,
          },
          itemAt,
        );
        skipped.push({ attemptId: item.attemptId, paymentEventId: item.paymentEventId, reason });
      };

      // 事件锁后重读原 attempt（关联 / 状态 / 到期 / 代际）
      const attempt = await tx.paymentProcessingAttempt.findFirst({
        where: { id: item.attemptId, organizationId: input.organizationId },
        select: { status: true, attemptNo: true, nextRetryAt: true, paymentId: true, paymentEventId: true },
      });
      if (!attempt) {
        await writeSkip('ATTEMPT_MISSING');
        continue;
      }
      if (attempt.paymentEventId !== item.paymentEventId || attempt.paymentId !== item.paymentId) {
        await writeSkip('ATTEMPT_RELATION_CHANGED');
        continue;
      }
      if (attempt.attemptNo !== item.attemptNo) {
        await writeSkip('ATTEMPT_GENERATION_CHANGED');
        continue;
      }
      if (attempt.status !== 'RETRYABLE_FAILED') {
        await writeSkip('ATTEMPT_NOT_RETRYABLE');
        continue;
      }
      if (!attempt.nextRetryAt || attempt.nextRetryAt.getTime() > itemAt.getTime()) {
        await writeSkip('ALREADY_CLAIMED_OR_NOT_DUE');
        continue;
      }
      if (item.attemptNo >= MAX_ATTEMPTS) {
        await writeSkip('RETRY_LIMIT_REACHED');
        continue;
      }
      const superseded = await tx.paymentProcessingAttempt.count({
        where: {
          organizationId: input.organizationId,
          paymentEventId: item.paymentEventId,
          attemptNo: { gt: item.attemptNo },
        },
      });
      if (superseded > 0) {
        await writeSkip('SUPERSEDED_GENERATION');
        continue;
      }

      // 最终事实比对（事件锁已持有）
      const event = await tx.paymentEvent.findFirst({
        where: { id: item.paymentEventId, organizationId: input.organizationId },
        select: { id: true, provider: true, providerEventId: true, payloadHash: true },
      });
      const payment = await tx.payment.findFirst({
        where: { id: item.paymentId, organizationId: input.organizationId },
        select: { id: true, provider: true, invoiceId: true, externalPaymentId: true, amount: true, currency: true },
      });
      const mismatch = itemFactsMatch(item, {
        event,
        payment: payment
          ? {
              id: payment.id,
              provider: payment.provider,
              invoiceId: payment.invoiceId,
              externalPaymentId: payment.externalPaymentId,
              amount: money(payment.amount),
              currency: payment.currency,
            }
          : null,
      });
      if (mismatch) {
        await writeSkip(mismatch);
        continue;
      }

      // CHANGE B：必须确认本项的行锁身份（恰一行且 id 正确），否则跳过留证（不得因后续可读而恢复执行）
      if (!lockedPayments.has(item.paymentId)) {
        await writeSkip('PAYMENT_NOT_LOCKED');
        continue;
      }
      if (!lockedAttempts.has(item.attemptId)) {
        await writeSkip('ATTEMPT_NOT_LOCKED');
        continue;
      }

      // 授权与冻结范围最终重验（锁后；失效 → 抛错回滚整批、不消费）
      if (itemAt.getTime() >= batchExpiresAt) {
        throw new ApprovalBoundaryError('APPROVAL_EXPIRED', batch.batchId);
      }
      const itemBoundary = await verifyApprovalBoundary(tx, {
        organizationId: input.organizationId,
        approvalId,
        action: PAYMENT_RETRY_DUE_ACTION,
        caseId: batch.batchId,
        actorUserId: input.actorUserId,
        payload: approvalPayload(batch),
        extra: approvalExtra(batch),
        now: itemAt,
        approvalEventAction: PAYMENT_APPROVAL_EVENT_ACTION,
        requiredEventAction: PAYMENT_REQUIRED_EVENT_ACTION,
        revocationEventActions: [PAYMENT_REJECTED_EVENT_ACTION],
        consumedEventAction: PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION,
        targetEntityType: 'PaymentRetryBatch',
      });
      if (!itemBoundary.ok) throw new ApprovalBoundaryError(itemBoundary.reason, batch.batchId);

      // 一次性认领：置于最终事实与授权确认之后、创建新 attempt 之前
      const claim = await tx.paymentProcessingAttempt.updateMany({
        where: { id: item.attemptId, status: 'RETRYABLE_FAILED', nextRetryAt: { not: null } },
        data: { nextRetryAt: null },
      });
      if (claim.count !== 1) {
        await writeSkip('CLAIM_FAILED');
        continue;
      }

      const next = await startAttempt(
        tx,
        {
          organizationId: input.organizationId,
          paymentEventId: item.paymentEventId,
          actorType: 'SYSTEM',
          actorRef: RETRY_BATCH_ACTOR_REF,
        },
        { now: () => itemAt },
      );
      const outcome = await recoverPaymentSucceeded(
        tx,
        {
          organizationId: input.organizationId,
          provider: item.provider,
          externalPaymentId: item.externalPaymentId,
          invoiceId: item.invoiceId,
          amount: item.amount,
          currency: item.currency,
        },
        {
          now: () => itemAt,
          client: tx,
          onPaymentRecorded: async (innerTx: Prisma.TransactionClient, paymentId: string) => {
            await innerTx.paymentProcessingAttempt.updateMany({
              where: { id: next.id, status: 'RUNNING' },
              data: { paymentId },
            });
          },
        },
      );
      await finishAttempt(tx, { attemptId: next.id, status: 'SUCCEEDED', resultStatus: outcome.status }, { now: () => itemAt });
      await writeBatchAudit(
        RETRY_BATCH_EVENTS.executed,
        {
          batchId: batch.batchId,
          digest: batch.digest,
          attemptId: item.attemptId,
          newAttemptId: next.id,
          newAttemptNo: next.attemptNo,
          paymentEventId: item.paymentEventId,
          resultStatus: outcome.status,
          approvalId,
          operationId: `approval:${approvalId}`,
          actorUserId: input.actorUserId,
          authorizationScope: 'FROZEN_BATCH',
        },
        itemAt,
      );
      executed.push({
        attemptId: item.attemptId,
        paymentEventId: item.paymentEventId,
        attemptNo: next.attemptNo,
        resultStatus: outcome.status,
      });
    }

    // 批次消费：使用**实际完成阶段**生成的时间（不再沿用锁等待前的 at）
    const completedAt = now();
    await writeBatchAudit(
      PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION,
      {
        approvalId,
        operationId: `approval:${approvalId}`,
        batchId: batch.batchId,
        digest: batch.digest,
        itemCount: batch.itemCount,
        executedCount: executed.length,
        skippedCount: skipped.length,
        actorUserId: input.actorUserId,
        authorizationScope: 'FROZEN_BATCH',
      },
      completedAt,
    );

    return { batchId: batch.batchId, digest: batch.digest, itemCount: batch.itemCount, executed, skipped };
  });
}
