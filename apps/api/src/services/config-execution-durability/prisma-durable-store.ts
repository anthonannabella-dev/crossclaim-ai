// P6-PROD-U1 —— durable 执行状态的真实落库实现（Prisma + PostgreSQL）
// 原则：
//   * 执行所有权 / reservation / lease / 状态 / 证据**全部落库**，不依赖进程内 memory / WeakMap / 单进程锁
//   * 竞态一律用 DB 事务 + 行锁（SELECT ... FOR UPDATE）+ UNIQUE 约束裁决，loser 不得产生第二条有效执行
//   * 终态 + 结果 + outbox 在同一事务写入（transactional outbox：关闭「状态落库但事件丢失」窗口）
//   * 非法状态跳转在应用层先 assert、再由 DB 触发器兜底 fail-closed
//   * 本模块不产生生产写入：只在 sandbox 环境与受控表内记账

import type { Prisma, PrismaClient } from '@prisma/client';

import {
  buildTerminalOutboxEvent,
  buildTerminalResult,
  decideOutboxDelivery,
  decideReservation,
  planReservation,
  type DeliveryDecision,
  type TerminalResultInput,
} from './reservation';
import { planLeaseClaim } from './lease';
import {
  expectedFromReservation,
  planStartupReconciliation,
  type ExecutionExpectation,
} from './recovery';
import {
  assertConfigExecutionTransition,
  type ConfigExecutionEventKind,
  type ConfigExecutionReservationState,
} from './state-machine';
import type {
  DurabilityEvent,
  LeaseFence,
  ObservationView,
  PlannedReservation,
  ReservationView,
  TerminalResultRecord,
} from './types';

type Tx = Prisma.TransactionClient;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

type ReservationRow = {
  id: string;
  reservationKey: string;
  immutableBasisDigest: string;
  idempotencyKey: string;
  idempotencyPayloadDigest: string;
  authorizationVerdictDigest: string;
  authorizationTicketDigest: string;
  status: string;
  baselineConfigFingerprint: string;
  preConfigVersion: string;
  target: string;
  configPath: string;
  fromValue: string;
  toValue: string;
  executionAttempt: number;
  ownerRef: string | null;
  leaseId: string | null;
  leaseAcquiredAt: Date | null;
  leaseRenewedAt: Date | null;
  leaseExpiresAt: Date | null;
  reservationExpiresAt: Date;
};

export function toReservationView(row: ReservationRow): ReservationView {
  return {
    id: row.id,
    reservationKey: row.reservationKey,
    immutableBasisDigest: row.immutableBasisDigest,
    idempotencyKey: row.idempotencyKey,
    idempotencyPayloadDigest: row.idempotencyPayloadDigest,
    authorizationVerdictDigest: row.authorizationVerdictDigest,
    authorizationTicketDigest: row.authorizationTicketDigest,
    status: row.status as ConfigExecutionReservationState,
    baselineConfigFingerprint: row.baselineConfigFingerprint,
    preConfigVersion: row.preConfigVersion,
    target: row.target,
    configPath: row.configPath,
    fromValue: row.fromValue,
    toValue: row.toValue,
    executionAttempt: row.executionAttempt,
    ownerRef: row.ownerRef,
    leaseId: row.leaseId,
    leaseAcquiredAt: row.leaseAcquiredAt,
    leaseRenewedAt: row.leaseRenewedAt,
    leaseExpiresAt: row.leaseExpiresAt,
    reservationExpiresAt: row.reservationExpiresAt,
  };
}

/** 行内 lease fence（recovery 落库前复核用）。 */
export function leaseFenceOf(row: ReservationRow): LeaseFence {
  return {
    leaseId: row.leaseId,
    executionAttempt: row.executionAttempt,
    leaseRenewedAt: row.leaseRenewedAt ? row.leaseRenewedAt.toISOString() : null,
    leaseExpiresAt: row.leaseExpiresAt ? row.leaseExpiresAt.toISOString() : null,
  };
}

export function leaseFenceMatches(row: ReservationRow, fence: LeaseFence): boolean {
  const current = leaseFenceOf(row);
  return (
    current.leaseId === fence.leaseId &&
    current.executionAttempt === fence.executionAttempt &&
    current.leaseRenewedAt === fence.leaseRenewedAt &&
    current.leaseExpiresAt === fence.leaseExpiresAt
  );
}

async function nextEventSeq(tx: Tx, reservationId: string): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ next: number }[]>(
    'SELECT COALESCE(MAX("seq"), 0) + 1 AS next FROM "ControlledConfigExecutionEvent" WHERE "reservationId" = $1',
    reservationId,
  );
  return Number(rows[0]?.next ?? 1);
}

async function appendEvent(
  tx: Tx,
  reservationId: string,
  event: DurabilityEvent,
  occurredAt: Date,
): Promise<void> {
  const seq = await nextEventSeq(tx, reservationId);
  await tx.controlledConfigExecutionEvent.create({
    data: {
      reservationId,
      seq,
      kind: event.kind,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      ownerRef: event.ownerRef,
      leaseId: event.leaseId,
      evidenceDigest: event.evidenceDigest,
      detail: event.detail,
      occurredAt,
    },
  });
}

async function lockReservation(tx: Tx, reservationId: string): Promise<ReservationRow | null> {
  const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
    'SELECT "id" FROM "ControlledConfigExecutionReservation" WHERE "id" = $1 FOR UPDATE',
    reservationId,
  );
  if (locked.length === 0) return null;
  return tx.controlledConfigExecutionReservation.findUniqueOrThrow({
    where: { id: reservationId },
  }) as Promise<ReservationRow>;
}

function eventKindForResult(
  resultCode: TerminalResultRecord['resultCode'],
): ConfigExecutionEventKind {
  switch (resultCode) {
    case 'COMMITTED':
    case 'RECOVERED_COMMITTED':
      return resultCode === 'COMMITTED' ? 'COMMITTED' : 'STARTUP_RECONCILED';
    case 'NOOP_ALREADY_APPLIED':
      return 'NOOP_TERMINALIZED';
    case 'CONFLICT':
      return 'CONFLICT';
    case 'STALE_BASELINE':
      return 'STALE_BASELINE';
    case 'NEEDS_RECONCILIATION':
      return 'NEEDS_RECONCILIATION';
    case 'FAILED_ZERO_WRITE':
      return 'FAILED_CONFIRMED';
    case 'MANUAL_REVIEW':
      return 'MANUAL_REVIEW';
    case 'SUPERSEDED':
      return 'SUPERSEDED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'STARTUP_RECONCILED';
  }
}

export type ReserveOutcome =
  | { kind: 'CREATED'; reservationId: string; reservationKey: string }
  | { kind: 'REUSED'; reservationId: string; status: ConfigExecutionReservationState }
  | { kind: 'FAIL_CLOSED'; code: string; message: string };

/**
 * durable reservation：UNIQUE(verdict/ticket/idempotencyKey/reservationKey) 是最终裁决者。
 * 冲突时读回既有记录并按幂等规则判定 —— 绝不 silent overwrite，绝不产生第二条执行。
 */
export async function reserveDurableExecution(
  prisma: PrismaClient,
  input: { plan: PlannedReservation; now: Date },
): Promise<ReserveOutcome> {
  const { plan, now } = input;
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.controlledConfigExecutionReservation.create({
        data: {
          reservationKey: plan.reservationKey,
          immutableBasisDigest: plan.immutableBasisDigest,
          authorizationVerdictDigest: plan.authorizationVerdictDigest,
          authorizationTicketDigest: plan.authorizationTicketDigest,
          planDigest: plan.planDigest,
          candidateDigest: plan.candidateDigest,
          proposalDigest: plan.proposalDigest,
          controlledAdoptionDigest: plan.controlledAdoptionDigest,
          rollbackPlanDigest: plan.rollbackPlanDigest,
          baselineSnapshotDigest: plan.baselineSnapshotDigest,
          baselineConfigFingerprint: plan.baselineConfigFingerprint,
          preConfigVersion: plan.preConfigVersion,
          environment: plan.environment,
          executionMode: plan.executionMode,
          target: plan.target,
          configPath: plan.configPath,
          fromValue: plan.fromValue,
          toValue: plan.toValue,
          idempotencyKey: plan.idempotencyKey,
          idempotencyPayloadDigest: plan.idempotencyPayloadDigest,
          status: 'RESERVED',
          executionAttempt: 0,
          reservationExpiresAt: plan.reservationExpiresAt,
          reservedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      await appendEvent(
        tx,
        created.id,
        {
          kind: 'RESERVED',
          fromStatus: null,
          toStatus: 'RESERVED',
          ownerRef: null,
          leaseId: null,
          evidenceDigest: plan.immutableBasisDigest,
          detail: JSON.stringify({ reservationKey: plan.reservationKey }),
        },
        now,
      );
      return { kind: 'CREATED', reservationId: created.id, reservationKey: plan.reservationKey };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = (await prisma.controlledConfigExecutionReservation.findFirst({
      where: {
        OR: [
          { reservationKey: plan.reservationKey },
          { authorizationVerdictDigest: plan.authorizationVerdictDigest },
          { authorizationTicketDigest: plan.authorizationTicketDigest },
          { idempotencyKey: plan.idempotencyKey },
        ],
      },
    })) as ReservationRow | null;
    if (!existing) throw error;
    const decision = decideReservation(toReservationView(existing), plan);
    if (decision.kind === 'REUSE') {
      return { kind: 'REUSED', reservationId: decision.reservationId, status: decision.status };
    }
    if (decision.kind === 'FAIL_CLOSED') {
      return { kind: 'FAIL_CLOSED', code: decision.code, message: decision.message };
    }
    throw error;
  }
}

export type ClaimOutcome =
  | { kind: 'ACQUIRED'; leaseId: string; expiresAt: Date; executionAttempt: number }
  | { kind: 'RENEWED'; leaseId: string; expiresAt: Date }
  | {
      kind: 'TAKEOVER';
      leaseId: string;
      expiresAt: Date;
      executionAttempt: number;
      reason: 'LEASE_EXPIRED' | 'LEASE_MISSING';
    }
  | { kind: 'LEASE_HELD'; ownerRef: string | null; leaseId: string | null; expiresAt: Date }
  | { kind: 'RESERVATION_EXPIRED'; expiresAt: Date }
  | { kind: 'TERMINAL_NOOP'; status: ConfigExecutionReservationState }
  | { kind: 'NOT_FOUND' };

/**
 * 取得执行权（Everything 在 one transaction + row lock 内裁决）：
 * 两个 worker 并发竞争同一 reservation 时，只有一个拿到 ACQUIRE/TAKEOVER；另一个得到 LEASE_HELD。
 */
export async function claimExecutionLease(
  prisma: PrismaClient,
  input: { reservationId: string; ownerRef: string; now: Date; leaseTtlMs?: number },
): Promise<ClaimOutcome> {
  const { reservationId, ownerRef, now, leaseTtlMs } = input;
  return prisma.$transaction(async (tx) => {
    const row = await lockReservation(tx, reservationId);
    if (!row) return { kind: 'NOT_FOUND' };
    const decision = planLeaseClaim({
      reservation: toReservationView(row),
      ownerRef,
      now,
      leaseTtlMs,
    });
    switch (decision.kind) {
      case 'ACQUIRE': {
        assertConfigExecutionTransition('RESERVED', 'EXECUTING');
        await tx.controlledConfigExecutionReservation.update({
          where: { id: reservationId },
          data: {
            status: 'EXECUTING',
            ownerRef: decision.ownerRef,
            leaseId: decision.leaseId,
            leaseAcquiredAt: decision.acquiredAt,
            leaseRenewedAt: decision.renewedAt,
            leaseExpiresAt: decision.expiresAt,
            executionAttempt: decision.executionAttempt,
            startedAt: row.leaseAcquiredAt ?? decision.acquiredAt,
            updatedAt: now,
          },
        });
        await appendEvent(
          tx,
          reservationId,
          {
            kind: 'LEASE_ACQUIRED',
            fromStatus: 'RESERVED',
            toStatus: 'EXECUTING',
            ownerRef: decision.ownerRef,
            leaseId: decision.leaseId,
            evidenceDigest: null,
            detail: JSON.stringify({ executionAttempt: decision.executionAttempt }),
          },
          now,
        );
        return {
          kind: 'ACQUIRED',
          leaseId: decision.leaseId,
          expiresAt: decision.expiresAt,
          executionAttempt: decision.executionAttempt,
        };
      }
      case 'RENEW': {
        await tx.controlledConfigExecutionReservation.update({
          where: { id: reservationId },
          data: { leaseRenewedAt: decision.renewedAt, leaseExpiresAt: decision.expiresAt, updatedAt: now },
        });
        await appendEvent(
          tx,
          reservationId,
          {
            kind: 'LEASE_RENEWED',
            fromStatus: 'EXECUTING',
            toStatus: 'EXECUTING',
            ownerRef: decision.ownerRef,
            leaseId: decision.leaseId,
            evidenceDigest: null,
            detail: null,
          },
          now,
        );
        return { kind: 'RENEWED', leaseId: decision.leaseId, expiresAt: decision.expiresAt };
      }
      case 'TAKEOVER': {
        await tx.controlledConfigExecutionReservation.update({
          where: { id: reservationId },
          data: {
            ownerRef: decision.ownerRef,
            leaseId: decision.leaseId,
            leaseAcquiredAt: decision.acquiredAt,
            leaseRenewedAt: decision.renewedAt,
            leaseExpiresAt: decision.expiresAt,
            executionAttempt: decision.executionAttempt,
            updatedAt: now,
          },
        });
        await appendEvent(
          tx,
          reservationId,
          {
            kind: 'LEASE_TAKEOVER',
            fromStatus: 'EXECUTING',
            toStatus: 'EXECUTING',
            ownerRef: decision.ownerRef,
            leaseId: decision.leaseId,
            evidenceDigest: null,
            detail: JSON.stringify({
              reason: decision.reason,
              previousOwnerRef: decision.previousOwnerRef,
              previousLeaseId: decision.previousLeaseId,
              executionAttempt: decision.executionAttempt,
            }),
          },
          now,
        );
        return {
          kind: 'TAKEOVER',
          leaseId: decision.leaseId,
          expiresAt: decision.expiresAt,
          executionAttempt: decision.executionAttempt,
          reason: decision.reason,
        };
      }
      case 'LEASE_HELD':
        return {
          kind: 'LEASE_HELD',
          ownerRef: decision.ownerRef,
          leaseId: decision.leaseId,
          expiresAt: decision.expiresAt,
        };
      case 'RESERVATION_EXPIRED':
        return { kind: 'RESERVATION_EXPIRED', expiresAt: decision.expiresAt };
      case 'TERMINAL_NOOP':
        return { kind: 'TERMINAL_NOOP', status: decision.status };
      default:
        return { kind: 'NOT_FOUND' };
    }
  });
}

export type TerminalizeOutcome =
  | { kind: 'TERMINALIZED'; result: TerminalResultRecord; outboxId: string }
  | { kind: 'ALREADY_TERMINAL'; result: TerminalResultRecord | null }
  | { kind: 'LEASE_MISMATCH'; ownerRef: string | null; leaseId: string | null }
  | { kind: 'LEASE_FENCE_CHANGED'; current: LeaseFence }
  | { kind: 'NOT_FOUND' };

/**
 * 终态收敛：状态 + append-only 结果 + outbox 在同一事务写入。
 * 重复调用幂等（已有终态/结果 → 直接返回既有结果，不再写第二条）。
 */
export async function terminalizeExecution(
  prisma: PrismaClient,
  input: {
    reservationId: string;
    expectedLeaseId: string | null;
    /** recovery / reconciliation 必须携带决策时的 lease fence；落库前在行锁内复核。 */
    expectedFence?: LeaseFence | null;
    result: TerminalResultInput;
    now: Date;
  },
): Promise<TerminalizeOutcome> {
  const { reservationId, expectedLeaseId, now } = input;
  return prisma.$transaction(async (tx) => {
    const row = await lockReservation(tx, reservationId);
    if (!row) return { kind: 'NOT_FOUND' };
    const fromStatus = row.status as ConfigExecutionReservationState;
    const nonTerminalStatuses = ['RESERVED', 'EXECUTING'];

    if (!nonTerminalStatuses.includes(fromStatus)) {
      const existing = await tx.controlledConfigExecutionResult.findUnique({
        where: { reservationId },
      });
      return { kind: 'ALREADY_TERMINAL', result: (existing as TerminalResultRecord | null) ?? null };
    }
    if (input.expectedFence && !leaseFenceMatches(row, input.expectedFence)) {
      // 决策依据（lease 身份 / attempt / 续期 / 到期）已经变化：绝不 terminalize 新的执行。
      return { kind: 'LEASE_FENCE_CHANGED', current: leaseFenceOf(row) };
    }
    if (expectedLeaseId !== null && row.leaseId !== expectedLeaseId) {
      return { kind: 'LEASE_MISMATCH', ownerRef: row.ownerRef, leaseId: row.leaseId };
    }

    const result = buildTerminalResult({ ...input.result, reservationId, recordedAt: input.result.recordedAt });
    assertConfigExecutionTransition(fromStatus, result.status);

    await tx.controlledConfigExecutionResult.create({
      data: {
        reservationId,
        executionId: result.executionId,
        status: result.status,
        resultCode: result.resultCode,
        semantics: result.semantics,
        preConfigFingerprint: result.preConfigFingerprint,
        preConfigVersion: result.preConfigVersion,
        postConfigFingerprint: result.postConfigFingerprint,
        postConfigVersion: result.postConfigVersion,
        idempotencyKey: result.idempotencyKey,
        resultDigest: result.resultDigest,
        provenanceDigest: result.provenanceDigest,
        evidenceSource: result.evidenceSource,
        reconciledBy: result.reconciledBy,
        recordedAt: result.recordedAt,
      },
    });
    const event = buildTerminalOutboxEvent({ reservationId, result });
    const outbox = await tx.controlledConfigExecutionOutbox.create({
      data: {
        reservationId,
        topic: event.topic,
        eventKey: event.eventKey,
        payloadDigest: event.payloadDigest,
        payload: event.payload,
        createdAt: event.createdAt,
      },
    });
    await tx.controlledConfigExecutionReservation.update({
      where: { id: reservationId },
      data: {
        status: result.status,
        terminalAt: result.recordedAt,
        terminalCode: result.resultCode,
        updatedAt: now,
      },
    });
    await appendEvent(
      tx,
      reservationId,
      {
        kind: eventKindForResult(result.resultCode),
        fromStatus,
        toStatus: result.status,
        ownerRef: row.ownerRef,
        leaseId: row.leaseId,
        evidenceDigest: result.resultDigest,
        detail: JSON.stringify({ resultCode: result.resultCode, evidenceSource: result.evidenceSource }),
      },
      now,
    );
    return { kind: 'TERMINALIZED', result, outboxId: outbox.id };
  });
}

export async function listNonTerminalReservations(
  prisma: PrismaClient,
  limit = 100,
): Promise<ReservationView[]> {
  const rows = (await prisma.controlledConfigExecutionReservation.findMany({
    where: { status: { in: ['RESERVED', 'EXECUTING'] } },
    orderBy: { reservedAt: 'asc' },
    take: limit,
  })) as ReservationRow[];
  return rows.map(toReservationView);
}

export interface ReconciliationSummary {
  noop: number;
  cancelled: number;
  terminalized: number;
  reclaimed: number;
  reviewed: number;
  /** 决策依据的 lease fence 已变化（被续期 / 被 takeover / attempt 前进）→ 放弃旧动作。 */
  fenceChanged: number;
  /** caller 断言与 durable recovery basis 不一致 → FAIL_CLOSED（不 terminalize / 不 reclaim）。 */
  basisMismatch: number;
}

/**
 * 启动对账：把 planStartupReconciliation 的动作落到 durable 层。
 * 每步幂等（重复执行不产生第二条终态/结果/outbox；已终态的行视为 NOOP）。
 */
export async function runStartupReconciliation(
  prisma: PrismaClient,
  input: {
    now: Date;
    observe: (reservation: ReservationView) => ObservationView | null;
    reconciledBy: string;
    limit?: number;
    /** 兼容层：只断言 caller 期望与 durable basis 一致；不一致 → RECOVERY_BASIS_MISMATCH（fail-closed）。 */
    assertExpectedFor?: (reservation: ReservationView) => ExecutionExpectation;
  },
): Promise<{ summary: ReconciliationSummary; actions: ReturnType<typeof planStartupReconciliation> }> {
  const reservations = await listNonTerminalReservations(prisma, input.limit ?? 100);
  const actions = planStartupReconciliation({
    reservations,
    now: input.now,
    observe: input.observe,
    assertExpectedFor: input.assertExpectedFor,
  });
  const summary = await runReconciliationActions(prisma, {
    actions,
    reservations,
    now: input.now,
    reconciledBy: input.reconciledBy,
  });
  return { summary, actions };
}

/**
 * 把（可能是稍早计算的）recovery 动作落库。
 * 每个动作必须携带其决策时的 lease fence：行锁内 fence 不匹配 → 放弃该动作（NOOP/REPLAN），
 * 绝不覆盖后来取得执行权的 worker。
 */
export async function runReconciliationActions(
  prisma: PrismaClient,
  input: {
    actions: ReturnType<typeof planStartupReconciliation>;
    now: Date;
    reconciledBy: string;
    /** 可显式提供快照（测试用）；缺省时按 reservationId 现读。 */
    reservations?: ReservationView[];
  },
): Promise<ReconciliationSummary> {
  const reservations =
    input.reservations ?? (await listNonTerminalReservations(prisma, 1000));
  const summary: ReconciliationSummary = {
    noop: 0,
    cancelled: 0,
    terminalized: 0,
    reclaimed: 0,
    reviewed: 0,
    fenceChanged: 0,
    basisMismatch: 0,
  };
  for (const action of input.actions) {
    const reservation = reservations.find((item) => item.id === action.reservationId);
    if (!reservation) continue;
    // recovery 依据的唯一来源是 durable reservation 自身（不信任 caller 传入值）
    const expected = expectedFromReservation(reservation);
    if (action.kind === 'NOOP') {
      summary.noop += 1;
      continue;
    }
    // 兼容层断言与 durable basis 不一致：FAIL_CLOSED，绝不落任何终态/reclaim 证据
    if (action.kind === 'REVIEW' && action.reason === 'RECOVERY_BASIS_MISMATCH') {
      summary.basisMismatch += 1;
      continue;
    }
    if (action.kind === 'RECLAIM') {
      const applied = await prisma.$transaction(async (tx) => {
        const row = await lockReservation(tx, reservation.id);
        if (!row) return false;
        // 只读决策已过期：lease 被续期 / 被接管 / attempt 前进 → 不得留下 reclaim 证据
        if (!leaseFenceMatches(row, action.fence)) return false;
        await appendEvent(
          tx,
          reservation.id,
          {
            kind: 'STARTUP_RECONCILED',
            fromStatus: 'EXECUTING',
            toStatus: 'EXECUTING',
            ownerRef: reservation.ownerRef,
            leaseId: reservation.leaseId,
            evidenceDigest: null,
            detail: JSON.stringify({ reason: action.reason, reconciledBy: input.reconciledBy }),
          },
          input.now,
        );
        return true;
      });
      if (applied) summary.reclaimed += 1;
      else summary.fenceChanged += 1;
      continue;
    }
    const resultCode =
      action.kind === 'CANCEL'
        ? 'CANCELLED'
        : action.kind === 'REVIEW'
          ? 'MANUAL_REVIEW'
          : action.resultCode;
    const evidenceSource =
      action.kind === 'TERMINALIZE' && action.resultCode === 'RECOVERED_COMMITTED'
        ? 'READBACK_RECOVERY'
        : 'STARTUP_RECONCILIATION';
    const post = action.kind === 'TERMINALIZE' ? action.post : null;
    const outcome = await terminalizeExecution(prisma, {
      reservationId: reservation.id,
      expectedLeaseId: null,
      expectedFence: action.fence,
      now: input.now,
      result: {
        reservationId: reservation.id,
        executionId: `reconcile:${reservation.id}:${action.kind}`,
        resultCode,
        preConfigFingerprint: reservation.baselineConfigFingerprint,
        preConfigVersion: expected.preConfigVersion,
        postConfigFingerprint: post ? post.fingerprint : null,
        postConfigVersion: post ? post.version : null,
        idempotencyKey: reservation.idempotencyKey,
        provenanceDigest: reservation.immutableBasisDigest,
        evidenceSource,
        reconciledBy: input.reconciledBy,
        recordedAt: input.now,
      },
    });
    if (outcome.kind === 'TERMINALIZED') summary.terminalized += 1;
    else if (outcome.kind === 'ALREADY_TERMINAL') summary.noop += 1;
    else if (outcome.kind === 'LEASE_FENCE_CHANGED') summary.fenceChanged += 1;
    if (outcome.kind === 'TERMINALIZED' && action.kind === 'CANCEL') summary.cancelled += 1;
    if (outcome.kind === 'TERMINALIZED' && action.kind === 'REVIEW') summary.reviewed += 1;
  }
  return summary;
}

export async function readUndispatchedOutbox(
  prisma: PrismaClient,
  limit = 50,
): Promise<{ id: string; reservationId: string; topic: string; payloadDigest: string }[]> {
  return prisma.controlledConfigExecutionOutbox.findMany({
    where: { dispatchedAt: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, reservationId: true, topic: true, payloadDigest: true },
  });
}

/** 投递记账（只允许 dispatchedAt / dispatchAttempts 变化；DB 触发器兜底）。 */
export async function markOutboxDispatched(
  prisma: PrismaClient,
  input: { outboxId: string; now: Date },
): Promise<void> {
  await prisma.controlledConfigExecutionOutbox.update({
    where: { id: input.outboxId },
    data: { dispatchedAt: input.now, dispatchAttempts: { increment: 1 } },
  });
}

/** 消费者幂等：同一 outbox 事件同一消费者至多一条交付记录。 */
export async function consumeOutboxEvent(
  prisma: PrismaClient,
  input: { outboxId: string; consumerRef: string; payloadDigest: string; now: Date },
): Promise<DeliveryDecision> {
  // outbox row 才是 payloadDigest 的 authority；consumer 传入的摘要只能用于比对。
  const outbox = await prisma.controlledConfigExecutionOutbox.findUnique({
    where: { id: input.outboxId },
    select: { payloadDigest: true },
  });
  if (!outbox) return { kind: 'NOT_FOUND' };
  if (outbox.payloadDigest !== input.payloadDigest) {
    return {
      kind: 'FAIL_CLOSED',
      code: 'CONFIG_EXECUTION_DELIVERY_CONFLICT',
      message: '消费者提供的 payloadDigest 与 outbox 事实不一致',
    };
  }

  const existing = await prisma.controlledConfigExecutionDelivery.findUnique({
    where: { outboxId_consumerRef: { outboxId: input.outboxId, consumerRef: input.consumerRef } },
  });
  const decision = decideOutboxDelivery(
    existing ? { id: existing.id, payloadDigest: existing.payloadDigest } : null,
    input,
  );
  if (decision.kind !== 'CONSUME') return decision;
  try {
    await prisma.controlledConfigExecutionDelivery.create({
      data: {
        outboxId: input.outboxId,
        consumerRef: input.consumerRef,
        deliveryKey: decision.deliveryKey,
        payloadDigest: decision.payloadDigest,
        consumedAt: decision.consumedAt,
      },
    });
    return decision;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.controlledConfigExecutionDelivery.findUnique({
      where: { outboxId_consumerRef: { outboxId: input.outboxId, consumerRef: input.consumerRef } },
    });
    if (!raced) throw error;
    // 并发落库后的竞态行同样要跑一遍决策：同摘要 → ALREADY_CONSUMED；异摘要 → FAIL CLOSED。
    return decideOutboxDelivery({ id: raced.id, payloadDigest: raced.payloadDigest }, input);
  }
}

export async function findByVerdictDigest(
  prisma: PrismaClient,
  authorizationVerdictDigest: string,
): Promise<ReservationView | null> {
  const row = (await prisma.controlledConfigExecutionReservation.findUnique({
    where: { authorizationVerdictDigest },
  })) as ReservationRow | null;
  return row ? toReservationView(row) : null;
}

export { planReservation };
