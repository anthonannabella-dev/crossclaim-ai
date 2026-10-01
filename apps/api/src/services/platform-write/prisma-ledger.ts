/**
 * platform.write 持久化账本端口与 T1/T2/T3/R1 编排（MSG-20261001-19 授权）
 * ---------------------------------------------------------------
 * T1（数据库短事务，六项同时成立，任一步失败整笔回滚）：
 *   1) 锁后重验审批（同事务内读取）
 *   2) 取得唯一 idempotency execution chain（组织内唯一幂等键）
 *   3) approval 与该 attempt 唯一绑定（组织内唯一 approvalId）
 *   4) attempt 进入允许执行的状态（CAS PENDING → IN_FLIGHT）
 *   5) 同事务写入 approval_consumed 消费事实
 * T2（事务外）执行投递；T3（独立事务）收敛结果；R1（只读）对账，绝不重发写请求。
 * 本模块不读 env、不接触凭据、不直接发起网络调用（投递端口由调用方注入）。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { decideReconciliation, type ReconcileEvidence } from './reconcile-policy';
import {
  PlatformWriteError,
  type PlatformWriteAttemptState,
  type PlatformWritePort,
  type PlatformWriteTargetKind,
} from './types';

export const PLATFORM_WRITE_LEDGER_CODES = [
  'PLATFORM_WRITE_APPROVAL_REQUIRED',
  'PLATFORM_WRITE_APPROVAL_INVALID',
  'PLATFORM_WRITE_APPROVAL_ALREADY_BOUND',
  'PLATFORM_WRITE_DUPLICATE_EXECUTION_RIGHT',
  'PLATFORM_WRITE_CAS_MISMATCH',
  'PLATFORM_WRITE_REPLAYED',
] as const;
export type PlatformWriteLedgerCode = (typeof PLATFORM_WRITE_LEDGER_CODES)[number];

export class PlatformWriteLedgerError extends Error {
  readonly code: PlatformWriteLedgerCode;

  constructor(code: PlatformWriteLedgerCode, message: string) {
    super(message);
    this.name = 'PlatformWriteLedgerError';
    this.code = code;
  }
}

/** 审批校验/消费端口：**必须**接受事务客户端，保证与 attempt 同事务 */
export interface PlatformWriteApprovalInTxPort {
  verifyInTransaction(
    tx: Prisma.TransactionClient,
    args: { organizationId: string; approvalId: string; action: string; snapshotDigest: string },
  ): Promise<{ ok: true } | { ok: false; code: PlatformWriteLedgerCode; message: string }>;
  consumeInTransaction(
    tx: Prisma.TransactionClient,
    args: {
      organizationId: string;
      approvalId: string;
      attemptId: string;
      actorUserId: string;
      consumedAt: Date;
    },
  ): Promise<void>;
}

export interface AcquireExecutionRightInput {
  organizationId: string;
  action: string;
  caseId: string;
  targetKind: PlatformWriteTargetKind;
  targetId: string;
  platform: string;
  /** 真实通道必须为 false 且必须携带 approvalId */
  simulated: boolean;
  approvalId?: string | null;
  /** 审批事件所属动作（默认 recovery.review_approved；与 attempt 自身的 action 不同） */
  approvalAction?: string;
  snapshotVersion: string;
  snapshotDigest: string;
  idempotencyKey: string;
  actorUserId: string;
  now?: () => Date;
}

export interface AcquiredExecutionRight {
  attemptId: string;
  status: PlatformWriteAttemptState;
  attemptNo: number;
  /** true = 本次调用取得执行权（可进入 T2）；false = 既有执行链（重放，不投递） */
  acquired: boolean;
}

function isUniqueViolation(error: unknown): error is { code: string; meta?: { target?: unknown } } {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

function uniqueTargetText(meta: { target?: unknown } | undefined): string {
  const target = meta?.target;
  if (Array.isArray(target)) return target.join(',');
  return typeof target === 'string' ? target : '';
}

/**
 * T1：取得执行权。返回 acquired=true 时，调用方**必须**在事务外执行投递（T2）。
 * 幂等：同一 (organizationId, idempotencyKey) 第二次调用返回 acquired=false（既有链状态）。
 */
export async function acquireExecutionRight(
  prisma: PrismaClient,
  approvals: PlatformWriteApprovalInTxPort,
  input: AcquireExecutionRightInput,
): Promise<AcquiredExecutionRight> {
  const now = (input.now ?? (() => new Date()))();

  // 幂等前置检查（同一幂等键已存在的执行链直接返回，不开新事务）
  const existingBefore = await prisma.platformWriteAttempt.findFirst({
    where: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey },
    select: { id: true, status: true, attemptNo: true },
  });
  if (existingBefore) {
    return {
      attemptId: existingBefore.id,
      status: existingBefore.status as PlatformWriteAttemptState,
      attemptNo: existingBefore.attemptNo,
      acquired: false,
    };
  }

  return prisma.$transaction(async (tx): Promise<AcquiredExecutionRight> => {
    // 1) 锁后重验审批（真实通道必须有审批）
    if (!input.simulated) {
      if (!input.approvalId) {
        throw new PlatformWriteLedgerError(
          'PLATFORM_WRITE_APPROVAL_REQUIRED',
          '真实通道（simulated=false）必须携带 approvalId',
        );
      }
      const verified = await approvals.verifyInTransaction(tx, {
        organizationId: input.organizationId,
        approvalId: input.approvalId,
        action: input.approvalAction ?? 'recovery.review_approved',
        snapshotDigest: input.snapshotDigest,
      });
      if (!verified.ok) {
        throw new PlatformWriteLedgerError(verified.code, verified.message);
      }
    } else if (input.approvalId) {
      const verified = await approvals.verifyInTransaction(tx, {
        organizationId: input.organizationId,
        approvalId: input.approvalId,
        action: input.approvalAction ?? 'recovery.review_approved',
        snapshotDigest: input.snapshotDigest,
      });
      if (!verified.ok) {
        throw new PlatformWriteLedgerError(verified.code, verified.message);
      }
    }

    let attemptId: string;
    let attemptNo = 1;

    try {
      const created = await tx.platformWriteAttempt.create({
        data: {
          organizationId: input.organizationId,
          action: input.action,
          snapshotVersion: input.snapshotVersion,
          snapshotDigest: input.snapshotDigest,
          idempotencyKey: input.idempotencyKey,
          attemptNo: 1,
          status: 'PENDING',
          targetKind: input.targetKind,
          targetId: input.targetId,
          platform: input.platform,
          simulated: input.simulated,
          approvalId: input.approvalId ?? null,
          basisReference: input.approvalId ? input.snapshotDigest : null,
        },
        select: { id: true, attemptNo: true },
      });
      attemptId = created.id;
      attemptNo = created.attemptNo;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const target = uniqueTargetText(error.meta);
      if (input.approvalId && target.includes('approvalId')) {
        throw new PlatformWriteLedgerError(
          'PLATFORM_WRITE_APPROVAL_ALREADY_BOUND',
          '该审批已绑定另一条执行链（approval 唯一绑定）',
        );
      }
      // 并发插入冲突：事务已中止，交由外层用新连接读取既有链
      throw new PlatformWriteLedgerError(
        'PLATFORM_WRITE_DUPLICATE_EXECUTION_RIGHT',
        '同一幂等键已存在执行链（并发冲突）',
      );
    }

    // 4) CAS：PENDING → IN_FLIGHT（未取得执行权不得投递）
    const cas = await tx.platformWriteAttempt.updateMany({
      where: { id: attemptId, organizationId: input.organizationId, status: 'PENDING' },
      data: { status: 'IN_FLIGHT', startedAt: now, attemptNo },
    });
    if (cas.count !== 1) {
      throw new PlatformWriteLedgerError('PLATFORM_WRITE_CAS_MISMATCH', '取得执行权 CAS 失败');
    }

    // 5) 同事务写入审批消费事实（消费 = 事务事实，不是事后补审计）
    if (input.approvalId) {
      await approvals.consumeInTransaction(tx, {
        organizationId: input.organizationId,
        approvalId: input.approvalId,
        attemptId,
        actorUserId: input.actorUserId,
        consumedAt: now,
      });
    }

    const success: AcquiredExecutionRight = {
      attemptId,
      status: 'IN_FLIGHT',
      attemptNo,
      acquired: true,
    };
    return success;
  }).catch(async (error: unknown): Promise<AcquiredExecutionRight> => {
    if (error instanceof PlatformWriteLedgerError && error.code === 'PLATFORM_WRITE_DUPLICATE_EXECUTION_RIGHT') {
      const existing = await prisma.platformWriteAttempt.findFirst({
        where: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey },
        select: { id: true, status: true, attemptNo: true },
      });
      if (existing) {
        return {
          attemptId: existing.id,
          status: existing.status as PlatformWriteAttemptState,
          attemptNo: existing.attemptNo,
          acquired: false,
        };
      }
    }
    throw error;
  });
}

export interface SettleAttemptInput {
  organizationId: string;
  attemptId: string;
  status: Extract<
    PlatformWriteAttemptState,
    'SUCCEEDED' | 'FAILED' | 'FAILED_CONFIRMED' | 'RETRYABLE' | 'DEAD_LETTER' | 'MANUAL_REVIEW'
  >;
  errorClass?: string | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  providerRef?: string | null;
  nextRetryAt?: Date | null;
  convergedBy?: string | null;
  convergedReason?: string | null;
  now?: () => Date;
}

/** T3：结果收敛（仅 IN_FLIGHT 可收敛；SUCCEEDED 后不可改绑） */
export async function settleAttempt(
  prisma: PrismaClient,
  input: SettleAttemptInput,
): Promise<PlatformWriteAttemptState> {
  const now = (input.now ?? (() => new Date()))();
  const cas = await prisma.platformWriteAttempt.updateMany({
    where: { id: input.attemptId, organizationId: input.organizationId, status: 'IN_FLIGHT' },
    data: {
      status: input.status,
      finishedAt: now,
      errorClass: input.errorClass ?? null,
      errorCode: input.errorCode ?? null,
      errorSummary: input.errorSummary ?? null,
      providerRef: input.providerRef ?? null,
      nextRetryAt: input.nextRetryAt ?? null,
      convergedBy: input.convergedBy ?? null,
      convergedReason: input.convergedReason ?? null,
    },
  });
  if (cas.count !== 1) {
    throw new PlatformWriteLedgerError('PLATFORM_WRITE_CAS_MISMATCH', '结果收敛 CAS 失败（状态已变化）');
  }
  return input.status;
}

/** T3 变体：不可判定结果（超时 / 连接中断 / 响应无法判定）→ UNKNOWN_PROVIDER_RESPONSE */
export async function markAttemptUnknown(
  prisma: PrismaClient,
  input: { organizationId: string; attemptId: string; errorCode?: string | null; now?: () => Date },
): Promise<void> {
  await settleAttempt(prisma, {
    organizationId: input.organizationId,
    attemptId: input.attemptId,
    status: 'UNKNOWN_PROVIDER_RESPONSE' as never,
    errorCode: input.errorCode ?? 'UNKNOWN_PROVIDER_RESPONSE',
    now: input.now,
  } as SettleAttemptInput);
}

/**
 * R1：一次只读对账。
 * **绝不调用 write sink**；providerProbe 只允许查询状态。两个 worker 并发时至多一个 CAS 成功。
 */
export async function reconcileOnce(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    attemptId: string;
    actor: string;
    probe: (args: { idempotencyKey: string; providerRef: string | null }) => Promise<ReconcileEvidence>;
    now?: () => Date;
  },
): Promise<{ status: PlatformWriteAttemptState; automated: boolean; reason: string }> {
  const now = (input.now ?? (() => new Date()))();
  const row = await prisma.platformWriteAttempt.findFirst({
    where: { id: input.attemptId, organizationId: input.organizationId },
  });
  if (!row) throw new PlatformWriteLedgerError('PLATFORM_WRITE_CAS_MISMATCH', '未找到执行记录');
  if (row.status !== 'UNKNOWN_PROVIDER_RESPONSE' && row.status !== 'RECONCILING') {
    throw new PlatformWriteLedgerError(
      'PLATFORM_WRITE_CAS_MISMATCH',
      '只有 UNKNOWN_PROVIDER_RESPONSE / RECONCILING 可以进入对账，当前=' + row.status,
    );
  }

  const evidence = await input.probe({ idempotencyKey: row.idempotencyKey, providerRef: row.providerRef });
  const elapsedMinutes = row.startedAt ? Math.max(0, (now.getTime() - row.startedAt.getTime()) / 60000) : 0;
  const decision = decideReconciliation({
    evidence,
    reconcileAttempts: row.reconcileAttempts,
    elapsedMinutes,
  });

  const cas = await prisma.platformWriteAttempt.updateMany({
    where: {
      id: row.id,
      organizationId: input.organizationId,
      status: row.status,
      reconcileAttempts: row.reconcileAttempts,
    },
    data: {
      status: decision.nextStatus,
      reconcileAttempts: row.reconcileAttempts + 1,
      reconcileLastActor: input.actor,
      reconciledStatus: decision.reconciledStatus,
      reconciledAt: now,
      reconcileNextAt: decision.nextDelayMinutes === null ? null : new Date(now.getTime() + decision.nextDelayMinutes * 60000),
      finishedAt: decision.nextStatus === 'RECONCILING' ? null : now,
    },
  });
  if (cas.count !== 1) {
    throw new PlatformWriteLedgerError('PLATFORM_WRITE_CAS_MISMATCH', '对账 CAS 失败（并发收敛已被阻止）');
  }

  return { status: decision.nextStatus, automated: decision.automated, reason: decision.reason };
}

/**
 * T1 → T2 → T3 编排。
 * 传输闸门：transportEnabled 为 false 时只登记内部结果（NEEDS_MANUAL），**零投递**。
 * 端口必须 simulated === true 才能被启用（真实写入通道在本阶段结构上不存在）。
 */
export async function submitPlatformWrite(
  prisma: PrismaClient,
  deps: {
    approvals: PlatformWriteApprovalInTxPort;
    sink: PlatformWritePort;
    transportEnabled: boolean;
    now?: () => Date;
  },
  input: AcquireExecutionRightInput,
): Promise<{
  status: 'NEEDS_MANUAL' | 'SUCCEEDED' | 'FAILED' | 'RETRYABLE' | 'UNKNOWN_PROVIDER_RESPONSE' | 'REPLAYED';
  attemptId: string | null;
  providerRef: string | null;
  sinkCalls: number;
}> {
  if (!deps.transportEnabled) {
    return { status: 'NEEDS_MANUAL', attemptId: null, providerRef: null, sinkCalls: 0 };
  }
  if (deps.sink.simulated !== true) {
    throw new PlatformWriteError(
      'SIMULATED_SINK_REQUIRED',
      '只有 simulated === true 的模拟通道可以被启用；真实写入通道不得接线',
    );
  }

  const acquired = await acquireExecutionRight(prisma, deps.approvals, input);
  if (!acquired.acquired) {
    const status =
      acquired.status === 'SUCCEEDED'
        ? 'REPLAYED'
        : acquired.status === 'FAILED_CONFIRMED'
          ? 'FAILED'
          : 'RETRYABLE';
    return { status, attemptId: acquired.attemptId, providerRef: null, sinkCalls: 0 };
  }

  let sinkCalls = 0;
  sinkCalls += 1;
  const outcome = await deps.sink.submit({
    organizationId: input.organizationId,
    caseId: input.caseId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    platform: input.platform,
    idempotencyKey: input.idempotencyKey,
    snapshotDigest: input.snapshotDigest,
    payload: {},
  });

  if (outcome.status === 'SUCCEEDED') {
    await settleAttempt(prisma, {
      organizationId: input.organizationId,
      attemptId: acquired.attemptId,
      status: 'SUCCEEDED',
      providerRef: outcome.externalRef,
      now: deps.now,
    });
    return { status: 'SUCCEEDED', attemptId: acquired.attemptId, providerRef: outcome.externalRef, sinkCalls };
  }
  if (outcome.status === 'REJECTED') {
    await settleAttempt(prisma, {
      organizationId: input.organizationId,
      attemptId: acquired.attemptId,
      status: 'FAILED',
      errorCode: outcome.code,
      now: deps.now,
    });
    return { status: 'FAILED', attemptId: acquired.attemptId, providerRef: null, sinkCalls };
  }

  await settleAttempt(prisma, {
    organizationId: input.organizationId,
    attemptId: acquired.attemptId,
    status: 'RETRYABLE',
    errorCode: outcome.code,
    nextRetryAt: new Date(((deps.now ?? (() => new Date()))().getTime()) + 60000),
    now: deps.now,
  });
  return { status: 'RETRYABLE', attemptId: acquired.attemptId, providerRef: null, sinkCalls };
}
