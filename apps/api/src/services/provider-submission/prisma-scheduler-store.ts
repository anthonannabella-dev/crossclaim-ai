// PROVIDER FOLLOW-UP INTELLIGENCE / P1 —— durable 调度存储（Prisma + PostgreSQL）
// 原则：队列状态 / 限流窗口 / 调度证据全部落库；执行权用行锁 + CAS 裁决；租约过期可恢复；
//       UNKNOWN 响应只进 reconciliation，绝不 blind retry；transport 恒 FALSE（本模块不发起任何外部写）。

import type { Prisma, PrismaClient } from '@prisma/client';

import {
  assertProviderSubmissionPolicy,
  providerSubmissionPolicyDigest,
  type ProviderPolicyRegistryPort,
  type ProviderSubmissionOperation,
  type ProviderSubmissionPlatform,
  type ProviderSubmissionPolicy,
} from './policy';
import {
  decideProviderEnqueue,
  planProviderDispatch,
  planProviderLease,
  planProviderOutcome,
  planProviderSubmissionIdempotency,
  providerRateScopeKey,
  providerSubmissionDimensionKey,
  type ProviderEnqueueDecision,
  type ProviderOutcomeAction,
  type ProviderResponseKind,
  type ProviderSubmissionEventKind,
  type ProviderSubmissionIntentState,
  type ProviderSubmissionIntentView,
  type ProviderRateWindowView,
} from './scheduler';

type Tx = Prisma.TransactionClient;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

type IntentRow = {
  id: string;
  organizationId: string;
  platformAccountId: string;
  platform: string;
  operation: string;
  connectionRef: string;
  idempotencyKey: string;
  payloadDigest: string;
  basisDigest: string;
  state: string;
  priority: number;
  attemptCount: number;
  availableAt: Date;
  retryAfterAt: Date | null;
  cooldownUntil: Date | null;
  ownerRef: string | null;
  leaseId: string | null;
  leaseAcquiredAt: Date | null;
  leaseExpiresAt: Date | null;
};

export function toProviderIntentView(row: IntentRow): ProviderSubmissionIntentView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    platform: row.platform as ProviderSubmissionPlatform,
    platformAccountId: row.platformAccountId,
    connectionRef: row.connectionRef,
    operation: row.operation as ProviderSubmissionOperation,
    state: row.state as ProviderSubmissionIntentState,
    priority: row.priority,
    attemptCount: row.attemptCount,
    availableAt: row.availableAt,
    retryAfterAt: row.retryAfterAt,
    cooldownUntil: row.cooldownUntil,
    idempotencyKey: row.idempotencyKey,
    payloadDigest: row.payloadDigest,
    basisDigest: row.basisDigest,
    ownerRef: row.ownerRef,
    leaseId: row.leaseId,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

async function nextEventSeq(tx: Tx, intentId: string): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ next: number }[]>(
    'SELECT COALESCE(MAX("seq"), 0) + 1 AS next FROM "ProviderSubmissionEvent" WHERE "intentId" = $1',
    intentId,
  );
  return Number(rows[0]?.next ?? 1);
}

async function appendEvent(
  tx: Tx,
  intentId: string,
  organizationId: string,
  event: {
    kind: ProviderSubmissionEventKind;
    fromState?: ProviderSubmissionIntentState | null;
    toState?: ProviderSubmissionIntentState | null;
    decision?: string | null;
    reason?: string | null;
    providerResponseKind?: ProviderResponseKind | null;
    policyDigest?: string | null;
    ownerRef?: string | null;
    leaseId?: string | null;
    detail?: string | null;
  },
  occurredAt: Date,
): Promise<void> {
  const seq = await nextEventSeq(tx, intentId);
  await tx.providerSubmissionEvent.create({
    data: {
      organizationId,
      intentId,
      seq,
      kind: event.kind,
      fromState: event.fromState ?? null,
      toState: event.toState ?? null,
      decision: event.decision ?? null,
      reason: event.reason ?? null,
      providerResponseKind: event.providerResponseKind ?? null,
      policyDigest: event.policyDigest ?? null,
      ownerRef: event.ownerRef ?? null,
      leaseId: event.leaseId ?? null,
      detail: event.detail ?? null,
      occurredAt,
    },
  });
}

export interface EnqueueProviderSubmissionInput {
  organizationId: string;
  platformAccountId: string;
  platform: ProviderSubmissionPlatform;
  operation: ProviderSubmissionOperation;
  connectionRef: string;
  caseRef?: string | null;
  claimRef?: string | null;
  idempotencyKey: string;
  payload: unknown;
  basis: unknown;
  priority?: number;
  availableAt?: Date;
  now: Date;
}

/** 入队：同 org 幂等键唯一；同键同载荷复用；同键异载荷 fail-closed。 */
export async function enqueueProviderSubmission(
  prisma: PrismaClient,
  input: EnqueueProviderSubmissionInput,
): Promise<ProviderEnqueueDecision & { intentId?: string }> {
  const plan = planProviderSubmissionIdempotency({
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    basis: input.basis,
  });
  const existing = (await prisma.providerSubmissionIntent.findUnique({
    where: {
      organizationId_idempotencyKey: {
        organizationId: input.organizationId,
        idempotencyKey: plan.idempotencyKey,
      },
    },
  })) as IntentRow | null;
  const decision = decideProviderEnqueue(
    existing
      ? {
          id: existing.id,
          payloadDigest: existing.payloadDigest,
          state: existing.state as ProviderSubmissionIntentState,
        }
      : null,
    plan,
  );
  if (decision.kind === 'FAIL_CLOSED') return decision;
  if (decision.kind === 'REUSE') return { ...decision };

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.providerSubmissionIntent.create({
        data: {
          organizationId: input.organizationId,
          platformAccountId: input.platformAccountId,
          platform: input.platform,
          operation: input.operation,
          connectionRef: input.connectionRef,
          caseRef: input.caseRef ?? null,
          claimRef: input.claimRef ?? null,
          idempotencyKey: plan.idempotencyKey,
          payloadDigest: plan.payloadDigest,
          basisDigest: plan.basisDigest,
          priority: input.priority ?? 0,
          state: 'QUEUED',
          availableAt: input.availableAt ?? input.now,
          createdAt: input.now,
          updatedAt: input.now,
        },
      });
      await appendEvent(
        tx,
        row.id,
        input.organizationId,
        { kind: 'ENQUEUED', toState: 'QUEUED', detail: JSON.stringify({ basisDigest: plan.basisDigest }) },
        input.now,
      );
      return { kind: 'CREATE' as const, idempotencyKey: plan.idempotencyKey, intentId: row.id };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = (await prisma.providerSubmissionIntent.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: plan.idempotencyKey,
        },
      },
    })) as IntentRow | null;
    if (!raced) throw error;
    return decideProviderEnqueue(
      {
        id: raced.id,
        payloadDigest: raced.payloadDigest,
        state: raced.state as ProviderSubmissionIntentState,
      },
      plan,
    );
  }
}

export interface LeaseProviderSubmissionInput {
  ownerRef: string;
  now: Date;
  leaseTtlMs: number;
  maxAttempts: number;
  policyRegistry: ProviderPolicyRegistryPort;
  /** 单次调用最多处理的候选数（避免队首限流时返回空） */
  maxCandidates?: number;
  organizationId?: string;
}

export type LeaseProviderSubmissionOutcome =
  | { kind: 'LEASED'; intentId: string; leaseId: string; attemptNo: number; expiresAt: Date; policyDigest: string }
  | { kind: 'NONE_AVAILABLE'; inspected: number };

/**
 * 取得执行权（exactly-once）：SELECT ... FOR UPDATE SKIP LOCKED 逐个候选裁决。
 * 只有 READY_FOR_PROVIDER / QUEUED 且通过策略（并发 / 速率 / retry-after / cooldown）才能 LEASED；
 * 未通过者只降级为 WAITING / RATE_LIMITED / NEEDS_MANUAL 并留下证据。
 */
export async function leaseProviderSubmission(
  prisma: PrismaClient,
  input: LeaseProviderSubmissionInput,
): Promise<LeaseProviderSubmissionOutcome> {
  const maxCandidates = input.maxCandidates ?? 10;
  const now = input.now;
  return prisma.$transaction(async (tx) => {
    let inspected = 0;
    // 本次调用已裁决过的候选：避免“同一行被反复重审”导致空转（例如刚被标记 WAITING/RATE_LIMITED 的行
    // 仍是最高优先级候选）。每次查询显式排除，保证遍历向前推进。
    const processed = new Set<string>();
    for (let i = 0; i < maxCandidates; i += 1) {
      const processedLiteral = `{${[...processed].map((id) => `"${id}"`).join(',')}}`;
      const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "ProviderSubmissionIntent"
          WHERE "state" IN ('QUEUED','READY_FOR_PROVIDER','WAITING','RATE_LIMITED')
            AND "availableAt" <= $1
            AND ($2::text IS NULL OR "organizationId" = $2)
            AND NOT ("id" = ANY($3::text[]))
          ORDER BY "priority" DESC, "availableAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        now,
        input.organizationId ?? null,
        processedLiteral,
      );
      if (locked.length === 0) break;
      inspected += 1;
      processed.add(locked[0].id);
      const row = (await tx.providerSubmissionIntent.findUniqueOrThrow({
        where: { id: locked[0].id },
      })) as IntentRow;
      const view = toProviderIntentView(row);
      const policy =
        input.policyRegistry.findPolicy({ platform: view.platform, operation: view.operation }) ?? null;

      const rateWindow = policy
        ? await readRateWindowInTx(tx, view, policy, now)
        : null;
      const concurrencyKey = providerSubmissionDimensionKey({
        key: 'OPERATION',
        organizationId: view.organizationId,
        platform: view.platform,
        platformAccountId: view.platformAccountId,
        operation: view.operation,
        connectionRef: view.connectionRef,
      });
      const activeRows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM "ProviderSubmissionIntent"
          WHERE "organizationId" = $1 AND "platformAccountId" = $2 AND "operation" = $3
            AND "state" = 'LEASED' AND "leaseExpiresAt" > $4`,
        view.organizationId,
        view.platformAccountId,
        view.operation,
        now,
      );
      const activeCount = Number(activeRows[0]?.n ?? 0);

      const dispatch = planProviderDispatch({
        intent: view,
        policy,
        windows: {
          window: rateWindow,
          concurrency: { activeByDimension: { [concurrencyKey]: activeCount } },
        },
        now,
        maxAttempts: input.maxAttempts,
      });

      if (dispatch.kind === 'READY_FOR_PROVIDER') {
        const leaseDecision = planProviderLease({
          intent: view,
          ownerRef: input.ownerRef,
          leaseId: `${view.id}:${input.ownerRef}:${view.attemptCount + 1}`,
          now,
          leaseTtlMs: input.leaseTtlMs,
        });
        if (leaseDecision.kind !== 'ACQUIRE') continue;
        const policyDigest = policy ? providerSubmissionPolicyDigest(policy) : null;
        await tx.providerSubmissionIntent.update({
          where: { id: view.id },
          data: {
            state: 'LEASED',
            ownerRef: leaseDecision.lease.ownerRef,
            leaseId: leaseDecision.lease.leaseId,
            leaseAcquiredAt: leaseDecision.lease.acquiredAt,
            leaseExpiresAt: leaseDecision.lease.expiresAt,
            attemptCount: leaseDecision.lease.attemptNo,
            policyProfileId: policy?.providerProfileId ?? null,
            updatedAt: now,
          },
        });
        if (policy) {
          await consumeRateSlotInTx(tx, view, policy, now);
        }
        await appendEvent(
          tx,
          view.id,
          view.organizationId,
          {
            kind: 'LEASE_ACQUIRED',
            fromState: leaseDecision.fromState,
            toState: 'LEASED',
            decision: 'READY_FOR_PROVIDER',
            policyDigest,
            ownerRef: leaseDecision.lease.ownerRef,
            leaseId: leaseDecision.lease.leaseId,
            detail: JSON.stringify({ transportEnabled: false }),
          },
          now,
        );
        return {
          kind: 'LEASED',
          intentId: view.id,
          leaseId: leaseDecision.lease.leaseId,
          attemptNo: leaseDecision.lease.attemptNo,
          expiresAt: leaseDecision.lease.expiresAt,
          policyDigest: policyDigest ?? '',
        };
      }

      if (dispatch.kind === 'RATE_LIMITED') {
        await tx.providerSubmissionIntent.update({
          where: { id: view.id },
          data: {
            state: 'RATE_LIMITED',
            retryAfterAt: new Date(now.getTime() + dispatch.retryAfterMs),
            lastReason: dispatch.reason,
            updatedAt: now,
          },
        });
        await appendEvent(
          tx,
          view.id,
          view.organizationId,
          {
            kind: 'RATE_LIMITED',
            fromState: view.state,
            toState: 'RATE_LIMITED',
            decision: 'RATE_LIMITED',
            reason: dispatch.reason,
            detail: JSON.stringify({ retryAfterMs: dispatch.retryAfterMs }),
          },
          now,
        );
        continue;
      }

      if (dispatch.kind === 'WAITING') {
        await tx.providerSubmissionIntent.update({
          where: { id: view.id },
          data: {
            state: 'WAITING',
            retryAfterAt: new Date(now.getTime() + dispatch.waitUntilMs),
            lastReason: dispatch.reason,
            updatedAt: now,
          },
        });
        await appendEvent(
          tx,
          view.id,
          view.organizationId,
          {
            kind: 'WAITING',
            fromState: view.state,
            toState: 'WAITING',
            decision: 'WAITING',
            reason: dispatch.reason,
            detail: JSON.stringify({ waitUntilMs: dispatch.waitUntilMs }),
          },
          now,
        );
        continue;
      }

      // NEEDS_MANUAL（策略缺失 / 尝试耗尽）
      await tx.providerSubmissionIntent.update({
        where: { id: view.id },
        data: {
          state: 'NEEDS_MANUAL',
          lastReason: dispatch.reason,
          ownerRef: null,
          leaseId: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });
      await appendEvent(
        tx,
        view.id,
        view.organizationId,
        {
          kind: 'MANUAL_REVIEW',
          fromState: view.state,
          toState: 'NEEDS_MANUAL',
          decision: 'NEEDS_MANUAL',
          reason: dispatch.reason,
        },
        now,
      );
    }
    return { kind: 'NONE_AVAILABLE' as const, inspected };
  });
}

function windowStartFor(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

async function readRateWindowInTx(
  tx: Tx,
  view: ProviderSubmissionIntentView,
  policy: ProviderSubmissionPolicy,
  now: Date,
): Promise<ProviderRateWindowView | null> {
  const windowMs = 60_000;
  const scopeKey = providerRateScopeKey({
    policy,
    organizationId: view.organizationId,
    platform: view.platform,
    platformAccountId: view.platformAccountId,
    operation: view.operation,
    connectionRef: view.connectionRef,
  });
  const row = await tx.providerRateWindow.findUnique({
    where: {
      organizationId_scopeKey_windowStart: {
        organizationId: view.organizationId,
        scopeKey,
        windowStart: windowStartFor(now, windowMs),
      },
    },
  });
  if (!row) return null;
  return { scopeKey, windowStart: row.windowStart, windowMs: row.windowMs, count: row.count };
}

async function consumeRateSlotInTx(
  tx: Tx,
  view: ProviderSubmissionIntentView,
  policy: ProviderSubmissionPolicy,
  now: Date,
): Promise<void> {
  const windowMs = 60_000;
  const scopeKey = providerRateScopeKey({
    policy,
    organizationId: view.organizationId,
    platform: view.platform,
    platformAccountId: view.platformAccountId,
    operation: view.operation,
    connectionRef: view.connectionRef,
  });
  const windowStart = windowStartFor(now, windowMs);
  await tx.providerRateWindow.upsert({
    where: {
      organizationId_scopeKey_windowStart: {
        organizationId: view.organizationId,
        scopeKey,
        windowStart,
      },
    },
    create: {
      organizationId: view.organizationId,
      scopeKey,
      windowStart,
      windowMs,
      count: 1,
      updatedAt: now,
    },
    update: { count: { increment: 1 }, updatedAt: now },
  });
}

export interface RecordProviderOutcomeInput {
  intentId: string;
  leaseId: string;
  responseKind: ProviderResponseKind;
  retryAfterMs?: number | null;
  now: Date;
  maxAttempts: number;
  policyRegistry: ProviderPolicyRegistryPort;
  rng?: () => number;
}

export type RecordProviderOutcomeResult =
  | { kind: 'RECORDED'; action: ProviderOutcomeAction; state: ProviderSubmissionIntentState }
  | { kind: 'LEASE_MISMATCH' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_LEASED'; state: ProviderSubmissionIntentState };

/**
 * 记录 provider 响应并收敛状态：
 *   SUCCESS            → 模拟已交付（transport=false，不产生任何外部写）
 *   429 / 5xx / 超时 / 连接重置 → 退避后重试（retry-after 收敛在策略上限内）
 *   UNKNOWN            → **只**进入只读 reconciliation（NEEDS_MANUAL），绝不 blind retry
 */
export async function recordProviderOutcome(
  prisma: PrismaClient,
  input: RecordProviderOutcomeInput,
): Promise<RecordProviderOutcomeResult> {
  const now = input.now;
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
      'SELECT "id" FROM "ProviderSubmissionIntent" WHERE "id" = $1 FOR UPDATE',
      input.intentId,
    );
    if (locked.length === 0) return { kind: 'NOT_FOUND' as const };
    const row = (await tx.providerSubmissionIntent.findUniqueOrThrow({
      where: { id: input.intentId },
    })) as IntentRow;
    const view = toProviderIntentView(row);
    if (view.state !== 'LEASED') {
      return { kind: 'NOT_LEASED' as const, state: view.state };
    }
    if (view.leaseId !== input.leaseId) {
      return { kind: 'LEASE_MISMATCH' as const };
    }
    const policy =
      input.policyRegistry.findPolicy({ platform: view.platform, operation: view.operation }) ?? null;
    if (!policy) {
      await tx.providerSubmissionIntent.update({
        where: { id: view.id },
        data: {
          state: 'NEEDS_MANUAL',
          lastReason: 'POLICY_MISSING',
          ownerRef: null,
          leaseId: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });
      await appendEvent(
        tx,
        view.id,
        view.organizationId,
        {
          kind: 'MANUAL_REVIEW',
          fromState: 'LEASED',
          toState: 'NEEDS_MANUAL',
          decision: 'NEEDS_MANUAL',
          reason: 'POLICY_MISSING',
          providerResponseKind: input.responseKind,
        },
        now,
      );
      return { kind: 'RECORDED' as const, action: { kind: 'DEAD_LETTER' as const, reason: 'ATTEMPTS_EXHAUSTED' as const }, state: 'NEEDS_MANUAL' as const };
    }

    const action = planProviderOutcome({
      responseKind: input.responseKind,
      policy,
      attemptCount: view.attemptCount,
      maxAttempts: input.maxAttempts,
      retryAfterMs: input.retryAfterMs ?? null,
      rng: input.rng,
    });
    const policyDigest = providerSubmissionPolicyDigest(policy);

    let nextState: ProviderSubmissionIntentState;
    let eventKind: ProviderSubmissionEventKind;
    let reason: string | null = null;
    let retryAfterAt: Date | null = null;
    let toState: ProviderSubmissionIntentState;

    switch (action.kind) {
      case 'MARK_SENT_SIMULATED':
        nextState = 'WAITING';
        toState = 'WAITING';
        eventKind = 'OUTCOME_RECORDED';
        reason = 'SIMULATED_SENT_TRANSPORT_FALSE';
        break;
      case 'RETRY_LATER':
        nextState = action.reason === 'RATE_LIMITED_429' ? 'RATE_LIMITED' : 'WAITING';
        toState = nextState;
        eventKind = action.reason === 'RATE_LIMITED_429' ? 'RATE_LIMITED' : 'WAITING';
        reason = action.reason;
        retryAfterAt = new Date(now.getTime() + action.retryAfterMs);
        break;
      case 'RECONCILE_READ_ONLY':
        nextState = 'NEEDS_MANUAL';
        toState = 'NEEDS_MANUAL';
        eventKind = 'RECONCILIATION_REQUIRED';
        reason = 'UNKNOWN_RESPONSE_READ_ONLY_RECONCILIATION';
        break;
      case 'DEAD_LETTER':
        nextState = 'DEAD_LETTER';
        toState = 'DEAD_LETTER';
        eventKind = 'DEAD_LETTERED';
        reason = action.reason;
        break;
    }

    await tx.providerSubmissionIntent.update({
      where: { id: view.id },
      data: {
        state: nextState,
        lastOutcome: input.responseKind,
        lastReason: reason,
        retryAfterAt,
        ownerRef: null,
        leaseId: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        cooldownUntil:
          action.kind === 'RETRY_LATER' && policy.cooldownMs > 0
            ? new Date(now.getTime() + policy.cooldownMs)
            : view.cooldownUntil,
        updatedAt: now,
      },
    });
    await appendEvent(
      tx,
      view.id,
      view.organizationId,
      {
        kind: eventKind,
        fromState: 'LEASED',
        toState,
        decision: action.kind,
        reason,
        providerResponseKind: input.responseKind,
        policyDigest,
        ownerRef: view.ownerRef,
        leaseId: view.leaseId,
        detail: JSON.stringify({ transportEnabled: false }),
      },
      now,
    );
    return { kind: 'RECORDED' as const, action, state: nextState };
  });
}

/** 重启恢复：过期 lease 归还队列（append LEASE_RECLAIMED 证据），不视为“已发送”。 */
export async function recoverExpiredProviderLeases(
  prisma: PrismaClient,
  input: { now: Date; limit?: number },
): Promise<number> {
  const now = input.now;
  const limit = input.limit ?? 50;
  return prisma.$transaction(async (tx) => {
    let recovered = 0;
    for (let i = 0; i < limit; i += 1) {
      const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "ProviderSubmissionIntent"
          WHERE "state" = 'LEASED' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" <= $1
          ORDER BY "leaseExpiresAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        now,
      );
      if (locked.length === 0) break;
      const row = (await tx.providerSubmissionIntent.findUniqueOrThrow({
        where: { id: locked[0].id },
      })) as IntentRow;
      await tx.providerSubmissionIntent.update({
        where: { id: row.id },
        data: {
          state: 'READY_FOR_PROVIDER',
          ownerRef: null,
          leaseId: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastReason: 'LEASE_EXPIRED_RECOVERED',
          updatedAt: now,
        },
      });
      await appendEvent(
        tx,
        row.id,
        row.organizationId,
        {
          kind: 'LEASE_RECLAIMED',
          fromState: 'LEASED',
          toState: 'READY_FOR_PROVIDER',
          decision: 'RECLAIM',
          reason: 'LEASE_EXPIRED_RECOVERY',
          ownerRef: row.ownerRef,
          leaseId: row.leaseId,
        },
        now,
      );
      recovered += 1;
    }
    return recovered;
  });
}

export async function listDeadLetterProviderIntents(
  prisma: PrismaClient,
  limit = 50,
): Promise<ProviderSubmissionIntentView[]> {
  const rows = (await prisma.providerSubmissionIntent.findMany({
    where: { state: { in: ['DEAD_LETTER', 'NEEDS_MANUAL'] } },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  })) as IntentRow[];
  return rows.map(toProviderIntentView);
}

export async function readProviderRateWindow(
  prisma: PrismaClient,
  input: { organizationId: string; scopeKey: string; windowStart: Date },
): Promise<ProviderRateWindowView | null> {
  const row = await prisma.providerRateWindow.findUnique({
    where: {
      organizationId_scopeKey_windowStart: {
        organizationId: input.organizationId,
        scopeKey: input.scopeKey,
        windowStart: input.windowStart,
      },
    },
  });
  if (!row) return null;
  return { scopeKey: row.scopeKey, windowStart: row.windowStart, windowMs: row.windowMs, count: row.count };
}

/** 供测试/运维直接登记策略校验（不落库，仅 fail-closed 校验）。 */
export function assertSchedulerPolicy(policy: ProviderSubmissionPolicy): ProviderSubmissionPolicy {
  return assertProviderSubmissionPolicy(policy);
}
