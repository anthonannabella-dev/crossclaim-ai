// P6-PROD-U1 耐久执行底座 —— 真实 PostgreSQL 验收（非 mock）
// 覆盖 HOST AUTHORIZATION 2026-10-06 的硬要求：
//   PGU-1 并发 reserve → exactly one（UNIQUE(verdict/ticket/idempotencyKey)）
//   PGU-2 同 idempotencyKey 异载荷 → FAIL CLOSED，不产生第二条执行
//   PGU-3 并发 claim → exactly one execution authority（loser 只能读既有状态）
//   PGU-4 过期 lease 并发 takeover → 恰好一个接管，另一个 LEASE_HELD
//   PGU-5 终态 + 结果 + outbox 同事务落库；重复收敛幂等
//   PGU-6 crash recovery：read-back 证明已提交 → RECOVERED_COMMITTED（不重放 CAS）
//   PGU-7 crash recovery：观测不可用 → NEEDS_RECONCILIATION（post identity = UNKNOWN）
//   PGU-8 DB 触发器：非法跳转 / terminal 再迁移 / identity 原地改写一律拒绝
//   PGU-9 append-only + outbox identity + 消费者幂等
//   PGU-10 NO PRODUCTION ENABLEMENT（environment CHECK）+ 跨连接耐久可见性
// 说明：两条独立 PrismaClient = 两条独立数据库连接，用于真实并发（非进程内锁）。

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  claimExecutionLease,
  consumeOutboxEvent,
  findByVerdictDigest,
  listNonTerminalReservations,
  markOutboxDispatched,
  planReservation,
  readUndispatchedOutbox,
  reserveDurableExecution,
  runStartupReconciliation,
  terminalizeExecution,
  type ConfigExecutionBasis,
  type PlannedReservation,
} from '../services/config-execution-durability';

const prisma = new PrismaClient();
const workerB = new PrismaClient();

const NOW = new Date('2026-10-06T04:00:00.000Z');
// 与 NOW 同源的「稍后」时钟：TTL=1ms 的租约/授权必须相对它判定过期（不要混入真实墙上时钟）
const LATER = new Date(NOW.getTime() + 10 * 60 * 1000);

function basis(tag: string, overrides: Partial<ConfigExecutionBasis> = {}): ConfigExecutionBasis {
  const seed = (prefix: string) => (tag + '-' + prefix).padEnd(64, '0').slice(0, 64);
  return {
    authorizationVerdictDigest: seed('verdict'),
    authorizationTicketDigest: seed('ticket'),
    planDigest: seed('plan'),
    candidateDigest: seed('candidate'),
    proposalDigest: seed('proposal'),
    controlledAdoptionDigest: seed('adoption'),
    rollbackPlanDigest: seed('rollback'),
    baselineSnapshotDigest: seed('baseline'),
    baselineConfigFingerprint: seed('fingerprint'),
    environment: 'SANDBOX',
    executionMode: 'SANDBOX_WRITE_ONLY',
    target: 'sandbox-config',
    configPath: 'outcomeLearning.autoAdoptThreshold',
    fromValue: '0.80',
    toValue: '0.85',
    ...overrides,
  };
}

function planned(tag: string, overrides: Partial<ConfigExecutionBasis> = {}): PlannedReservation {
  return planReservation({
    basis: basis(tag, overrides),
    idempotencyKey: 'idem-' + tag,
    now: NOW,
  });
}

const expectationOf = (plan: PlannedReservation) => ({
  baselineConfigFingerprint: plan.baselineConfigFingerprint,
  preConfigVersion: 'cfg-1',
  fromValue: plan.fromValue,
  toValue: plan.toValue,
});

function resultInput(plan: PlannedReservation, reservationId: string, overrides: Record<string, unknown>) {
  return {
    reservationId,
    executionId: 'exec-' + reservationId,
    resultCode: 'COMMITTED' as const,
    preConfigFingerprint: plan.baselineConfigFingerprint,
    preConfigVersion: 'cfg-1',
    postConfigFingerprint: 'post'.padEnd(64, '0'),
    postConfigVersion: 'cfg-2',
    idempotencyKey: plan.idempotencyKey,
    provenanceDigest: plan.immutableBasisDigest,
    evidenceSource: 'EXECUTION' as const,
    recordedAt: NOW,
    ...overrides,
  };
}

async function truncateDurabilityTables(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ControlledConfigExecutionDelivery", "ControlledConfigExecutionOutbox", "ControlledConfigExecutionResult", "ControlledConfigExecutionEvent", "ControlledConfigExecutionReservation" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncateDurabilityTables();
});

afterAll(async () => {
  await truncateDurabilityTables();
  await prisma.$disconnect();
  await workerB.$disconnect();
});

describe('P6-PROD-U1 真实 PostgreSQL · reservation / dedupe', () => {
  it('PGU-1 并发 reserve（两条独立连接）→ exactly one，且只产生一条 RESERVED 事件', async () => {
    const plan = planned('pgu1');
    const [a, b] = await Promise.all([
      reserveDurableExecution(prisma, { plan, now: NOW }),
      reserveDurableExecution(workerB, { plan, now: NOW }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['CREATED', 'REUSED']);
    expect(await prisma.controlledConfigExecutionReservation.count()).toBe(1);
    expect(
      await prisma.controlledConfigExecutionEvent.count({ where: { kind: 'RESERVED' } }),
    ).toBe(1);
    const winner = a.kind === 'CREATED' ? a : (b as { kind: 'CREATED'; reservationId: string });
    expect(await findByVerdictDigest(prisma, plan.authorizationVerdictDigest)).toMatchObject({
      id: winner.reservationId,
      status: 'RESERVED',
    });
  });

  it('PGU-2 同 idempotencyKey 但不可变载荷不一致 → FAIL CLOSED，且不产生第二条执行', async () => {
    const first = planned('pgu2');
    expect((await reserveDurableExecution(prisma, { plan: first, now: NOW })).kind).toBe('CREATED');

    const tampered = planReservation({
      basis: { ...basis('pgu2'), toValue: '0.99' },
      idempotencyKey: first.idempotencyKey,
      now: NOW,
    });
    const outcome = await reserveDurableExecution(prisma, { plan: tampered, now: NOW });
    expect(outcome.kind).toBe('FAIL_CLOSED');
    if (outcome.kind === 'FAIL_CLOSED') {
      expect(outcome.code).toBe('CONFIG_EXECUTION_IDEMPOTENCY_KEY_CONFLICT');
    }
    expect(await prisma.controlledConfigExecutionReservation.count()).toBe(1);
    // 原记录未被 silent overwrite
    const row = await prisma.controlledConfigExecutionReservation.findFirstOrThrow();
    expect(row.toValue).toBe('0.85');
  });

  it('PGU-3 并发 claim → exactly one execution authority，loser 只能读既有状态', async () => {
    const plan = planned('pgu3');
    const reserved = await reserveDurableExecution(prisma, { plan, now: NOW });
    if (reserved.kind !== 'CREATED') throw new Error('reserve 失败');

    const [a, b] = await Promise.all([
      claimExecutionLease(prisma, { reservationId: reserved.reservationId, ownerRef: 'worker-A', now: NOW }),
      claimExecutionLease(workerB, { reservationId: reserved.reservationId, ownerRef: 'worker-B', now: NOW }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['ACQUIRED', 'LEASE_HELD']);
    expect(
      await prisma.controlledConfigExecutionEvent.count({ where: { kind: 'LEASE_ACQUIRED' } }),
    ).toBe(1);
    const row = await prisma.controlledConfigExecutionReservation.findUniqueOrThrow({
      where: { id: reserved.reservationId },
    });
    expect(row.status).toBe('EXECUTING');
    expect(row.executionAttempt).toBe(1);
    expect(['worker-A', 'worker-B']).toContain(row.ownerRef);
    const loser = (a.kind === 'LEASE_HELD' ? a : b) as {
      kind: 'LEASE_HELD';
      ownerRef: string | null;
      leaseId: string | null;
      expiresAt: Date;
    };
    expect(loser.ownerRef).toBe(row.ownerRef);
  });

  it('PGU-4 过期 lease 并发 takeover → 恰好一个接管，另一个 LEASE_HELD（attempt 递增）', async () => {
    const plan = planned('pgu4');
    const reserved = await reserveDurableExecution(prisma, { plan, now: NOW });
    if (reserved.kind !== 'CREATED') throw new Error('reserve 失败');
    const acquired = await claimExecutionLease(prisma, {
      reservationId: reserved.reservationId,
      ownerRef: 'worker-A',
      now: NOW,
      leaseTtlMs: 1,
    });
    expect(acquired.kind).toBe('ACQUIRED');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const [a, b] = await Promise.all([
      claimExecutionLease(prisma, {
        reservationId: reserved.reservationId,
        ownerRef: 'worker-B',
        now: LATER,
      }),
      claimExecutionLease(workerB, {
        reservationId: reserved.reservationId,
        ownerRef: 'worker-C',
        now: LATER,
      }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['LEASE_HELD', 'TAKEOVER']);
    const takeover = (a.kind === 'TAKEOVER' ? a : b) as { kind: 'TAKEOVER'; executionAttempt: number };
    expect(takeover.executionAttempt).toBe(2);
    expect(
      await prisma.controlledConfigExecutionEvent.count({ where: { kind: 'LEASE_TAKEOVER' } }),
    ).toBe(1);
  });
});

describe('P6-PROD-U1 真实 PostgreSQL · 终态 / outbox / 消费者幂等', () => {
  it('PGU-5 终态 + 结果 + outbox 同事务落库；重复收敛幂等', async () => {
    const plan = planned('pgu5');
    const reserved = await reserveDurableExecution(prisma, { plan, now: NOW });
    if (reserved.kind !== 'CREATED') throw new Error('reserve 失败');
    const acquired = await claimExecutionLease(prisma, {
      reservationId: reserved.reservationId,
      ownerRef: 'worker-A',
      now: NOW,
    });
    if (acquired.kind !== 'ACQUIRED') throw new Error('claim 失败');

    const first = await terminalizeExecution(prisma, {
      reservationId: reserved.reservationId,
      expectedLeaseId: acquired.leaseId,
      result: resultInput(plan, reserved.reservationId, {}),
      now: NOW,
    });
    expect(first.kind).toBe('TERMINALIZED');

    const row = await prisma.controlledConfigExecutionReservation.findUniqueOrThrow({
      where: { id: reserved.reservationId },
    });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.terminalCode).toBe('COMMITTED');
    expect(await prisma.controlledConfigExecutionResult.count()).toBe(1);
    expect(await prisma.controlledConfigExecutionOutbox.count()).toBe(1);
    expect((await readUndispatchedOutbox(prisma)).length).toBe(1);

    const replay = await terminalizeExecution(prisma, {
      reservationId: reserved.reservationId,
      expectedLeaseId: acquired.leaseId,
      result: resultInput(plan, reserved.reservationId, {}),
      now: NOW,
    });
    expect(replay.kind).toBe('ALREADY_TERMINAL');
    expect(await prisma.controlledConfigExecutionResult.count()).toBe(1);
    expect(await prisma.controlledConfigExecutionOutbox.count()).toBe(1);
  });

  it('PGU-9 outbox 投递记账 + 消费者幂等（重复消费不产生第二条交付）', async () => {
    const plan = planned('pgu9');
    const reserved = await reserveDurableExecution(prisma, { plan, now: NOW });
    if (reserved.kind !== 'CREATED') throw new Error('reserve 失败');
    const acquired = await claimExecutionLease(prisma, {
      reservationId: reserved.reservationId,
      ownerRef: 'worker-A',
      now: NOW,
    });
    if (acquired.kind !== 'ACQUIRED') throw new Error('claim 失败');
    await terminalizeExecution(prisma, {
      reservationId: reserved.reservationId,
      expectedLeaseId: acquired.leaseId,
      result: resultInput(plan, reserved.reservationId, {}),
      now: NOW,
    });
    const [event] = await readUndispatchedOutbox(prisma);
    expect(event).toBeTruthy();

    const firstConsume = await consumeOutboxEvent(prisma, {
      outboxId: event.id,
      consumerRef: 'projection-worker',
      payloadDigest: event.payloadDigest,
      now: NOW,
    });
    expect(firstConsume.kind).toBe('CONSUME');
    const secondConsume = await consumeOutboxEvent(workerB, {
      outboxId: event.id,
      consumerRef: 'projection-worker',
      payloadDigest: event.payloadDigest,
      now: NOW,
    });
    expect(secondConsume.kind).toBe('ALREADY_CONSUMED');
    expect(await prisma.controlledConfigExecutionDelivery.count()).toBe(1);

    const tampered = await consumeOutboxEvent(prisma, {
      outboxId: event.id,
      consumerRef: 'projection-worker',
      payloadDigest: 'different-payload',
      now: NOW,
    });
    expect(tampered.kind).toBe('FAIL_CLOSED');

    await markOutboxDispatched(prisma, { outboxId: event.id, now: NOW });
    expect((await readUndispatchedOutbox(prisma)).length).toBe(0);
  });
});

describe('P6-PROD-U1 真实 PostgreSQL · crash recovery / startup reconciliation', () => {
  async function strandedWithExpiredLease(tag: string) {
    const plan = planned(tag);
    const reserved = await reserveDurableExecution(prisma, { plan, now: NOW });
    if (reserved.kind !== 'CREATED') throw new Error('reserve 失败');
    const acquired = await claimExecutionLease(prisma, {
      reservationId: reserved.reservationId,
      ownerRef: 'worker-A',
      now: NOW,
      leaseTtlMs: 1,
    });
    if (acquired.kind !== 'ACQUIRED') throw new Error('claim 失败');
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { plan, reservationId: reserved.reservationId };
  }

  it('PGU-6 read-back 证明已提交 → RECOVERED_COMMITTED（不重放 CAS），再次对账幂等', async () => {
    const { plan, reservationId } = await strandedWithExpiredLease('pgu6');
    const now = LATER;
    const first = await runStartupReconciliation(prisma, {
      now,
      observe: () => ({ configFingerprint: 'post'.padEnd(64, '0'), version: 'cfg-2', pathValue: plan.toValue }),
      expectedFor: () => expectationOf(plan),
      reconciledBy: 'reconcile-worker-1',
    });
    expect(first.summary.terminalized).toBe(1);

    const row = await prisma.controlledConfigExecutionReservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    expect(row.status).toBe('SUCCEEDED');
    const result = await prisma.controlledConfigExecutionResult.findUniqueOrThrow({
      where: { reservationId },
    });
    expect(result.resultCode).toBe('RECOVERED_COMMITTED');
    expect(result.evidenceSource).toBe('READBACK_RECOVERY');
    expect(result.postConfigVersion).toBe('cfg-2');

    const second = await runStartupReconciliation(prisma, {
      now,
      observe: () => ({ configFingerprint: 'post'.padEnd(64, '0'), version: 'cfg-2', pathValue: plan.toValue }),
      expectedFor: () => expectationOf(plan),
      reconciledBy: 'reconcile-worker-2',
    });
    expect(second.summary).toMatchObject({ noop: 0, terminalized: 0, cancelled: 0, reclaimed: 0 });
    expect(await prisma.controlledConfigExecutionResult.count()).toBe(1);
    expect(await prisma.controlledConfigExecutionOutbox.count()).toBe(1);
  });

  it('PGU-7 观测不可用 → NEEDS_RECONCILIATION 且 post identity = UNKNOWN（不得回填 pre）', async () => {
    const { plan, reservationId } = await strandedWithExpiredLease('pgu7');
    const now = LATER;
    const run = await runStartupReconciliation(prisma, {
      now,
      observe: () => null,
      expectedFor: () => expectationOf(plan),
      reconciledBy: 'reconcile-worker-1',
    });
    expect(run.summary.terminalized).toBe(1);
    const row = await prisma.controlledConfigExecutionReservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    expect(row.status).toBe('NEEDS_RECONCILIATION');
    const result = await prisma.controlledConfigExecutionResult.findUniqueOrThrow({
      where: { reservationId },
    });
    expect(result.postConfigFingerprint).toBeNull();
    expect(result.postConfigVersion).toBeNull();
    expect(result.semantics).toBe('SANDBOX_CONFIG_MUTATION_NEEDS_RECONCILIATION');
  });

  it('PGU-11 安全可重试：观测仍为 pre → RECLAIM（保留 EXECUTING 供 worker 重新取 lease）', async () => {
    const { plan, reservationId } = await strandedWithExpiredLease('pgu11');
    const now = LATER;
    const run = await runStartupReconciliation(prisma, {
      now,
      observe: () => ({
        configFingerprint: plan.baselineConfigFingerprint,
        version: 'cfg-1',
        pathValue: plan.fromValue,
      }),
      expectedFor: () => expectationOf(plan),
      reconciledBy: 'reconcile-worker-1',
    });
    expect(run.summary.reclaimed).toBe(1);
    const row = await prisma.controlledConfigExecutionReservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    expect(row.status).toBe('EXECUTING');
    expect(await prisma.controlledConfigExecutionResult.count()).toBe(0);
    expect(
      await prisma.controlledConfigExecutionEvent.count({ where: { kind: 'STARTUP_RECONCILED' } }),
    ).toBe(1);
    expect(await listNonTerminalReservations(prisma)).toHaveLength(1);
  });

  it('PGU-12 RESERVED 超期 → 取消（零写终态 CANCELLED + 事件）', async () => {
    const plan = planReservation({
      basis: basis('pgu12'),
      idempotencyKey: 'idem-pgu12',
      now: NOW,
      reservationTtlMs: 1,
    });
    const reserved = await reserveDurableExecution(prisma, { plan, now: NOW });
    if (reserved.kind !== 'CREATED') throw new Error('reserve 失败');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const run = await runStartupReconciliation(prisma, {
      now: LATER,
      observe: () => null,
      expectedFor: () => expectationOf(plan),
      reconciledBy: 'reconcile-worker-1',
    });
    expect(run.summary.cancelled).toBe(1);
    const row = await prisma.controlledConfigExecutionReservation.findUniqueOrThrow({
      where: { id: reserved.reservationId },
    });
    expect(row.status).toBe('CANCELLED');
    const result = await prisma.controlledConfigExecutionResult.findUniqueOrThrow({
      where: { reservationId: reserved.reservationId },
    });
    expect(result.resultCode).toBe('CANCELLED');
    expect(result.postConfigFingerprint).toBeNull();
  });
});

describe('P6-PROD-U1 真实 PostgreSQL · DB 级 fail-closed 守卫', () => {
  it('PGU-8 非法跳转 / terminal 再迁移 / identity 原地改写都被数据库拒绝', async () => {
    const plan = planned('pgu8');
    const reserved = await reserveDurableExecution(prisma, { plan, now: NOW });
    if (reserved.kind !== 'CREATED') throw new Error('reserve 失败');

    // RESERVED → SUCCEEDED（跳过 EXECUTING）必须被拒
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ControlledConfigExecutionReservation" SET "status" = $1, "terminalAt" = $2, "terminalCode" = $3 WHERE "id" = $4',
        'SUCCEEDED',
        NOW,
        'COMMITTED',
        reserved.reservationId,
      ),
    ).rejects.toThrow(/CONFIG_EXECUTION_ILLEGAL_TRANSITION/);

    // identity / immutable basis 原地改写必须被拒
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ControlledConfigExecutionReservation" SET "toValue" = $1 WHERE "id" = $2',
        '0.99',
        reserved.reservationId,
      ),
    ).rejects.toThrow(/CONFIG_EXECUTION_IDENTITY_IMMUTABLE/);

    // 进入终态后不得再迁移
    const acquired = await claimExecutionLease(prisma, {
      reservationId: reserved.reservationId,
      ownerRef: 'worker-A',
      now: NOW,
    });
    if (acquired.kind !== 'ACQUIRED') throw new Error('claim 失败');
    await terminalizeExecution(prisma, {
      reservationId: reserved.reservationId,
      expectedLeaseId: acquired.leaseId,
      result: resultInput(plan, reserved.reservationId, { resultCode: 'CONFLICT',
        postConfigFingerprint: null, postConfigVersion: null }),
      now: NOW,
    });
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ControlledConfigExecutionReservation" SET "status" = $1 WHERE "id" = $2',
        'EXECUTING',
        reserved.reservationId,
      ),
    ).rejects.toThrow(/CONFIG_EXECUTION_TERMINAL_IMMUTABLE/);
  });

  it('PGU-13 append-only：事件 / 终态结果 / 交付账本不可 UPDATE、不可 DELETE；outbox 仅投递记账', async () => {
    const plan = planned('pgu13');
    const reserved = await reserveDurableExecution(prisma, { plan, now: NOW });
    if (reserved.kind !== 'CREATED') throw new Error('reserve 失败');
    const acquired = await claimExecutionLease(prisma, {
      reservationId: reserved.reservationId,
      ownerRef: 'worker-A',
      now: NOW,
    });
    if (acquired.kind !== 'ACQUIRED') throw new Error('claim 失败');
    await terminalizeExecution(prisma, {
      reservationId: reserved.reservationId,
      expectedLeaseId: acquired.leaseId,
      result: resultInput(plan, reserved.reservationId, {}),
      now: NOW,
    });
    const [event] = await readUndispatchedOutbox(prisma);
    await consumeOutboxEvent(prisma, {
      outboxId: event.id,
      consumerRef: 'projection-worker',
      payloadDigest: event.payloadDigest,
      now: NOW,
    });

    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ControlledConfigExecutionEvent" SET "kind" = $1 WHERE "reservationId" = $2',
        'CANCELLED',
        reserved.reservationId,
      ),
    ).rejects.toThrow(/APPEND_ONLY_TABLE/);
    await expect(
      prisma.$executeRawUnsafe(
        'DELETE FROM "ControlledConfigExecutionResult" WHERE "reservationId" = $1',
        reserved.reservationId,
      ),
    ).rejects.toThrow(/APPEND_ONLY_TABLE/);
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM "ControlledConfigExecutionDelivery" WHERE "outboxId" = $1', event.id),
    ).rejects.toThrow(/APPEND_ONLY_TABLE/);
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ControlledConfigExecutionOutbox" SET "payload" = $1 WHERE "id" = $2',
        '{"tampered":true}',
        event.id,
      ),
    ).rejects.toThrow(/OUTBOX_IDENTITY_IMMUTABLE/);

    // 投递记账允许（dispatchedAt / dispatchAttempts）
    await markOutboxDispatched(prisma, { outboxId: event.id, now: NOW });
    const outbox = await prisma.controlledConfigExecutionOutbox.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(outbox.dispatchAttempts).toBe(1);
    expect(outbox.dispatchedAt).not.toBeNull();
  });

  it('PGU-10 NO PRODUCTION ENABLEMENT：environment=PRODUCTION 被数据库 CHECK 拒绝', async () => {
    const plan = planned('pgu10');
    await expect(
      prisma.controlledConfigExecutionReservation.create({
        data: {
          reservationKey: plan.reservationKey + '-prod',
          immutableBasisDigest: plan.immutableBasisDigest,
          authorizationVerdictDigest: plan.authorizationVerdictDigest + '-prod',
          authorizationTicketDigest: plan.authorizationTicketDigest + '-prod',
          planDigest: plan.planDigest,
          candidateDigest: plan.candidateDigest,
          proposalDigest: plan.proposalDigest,
          controlledAdoptionDigest: plan.controlledAdoptionDigest,
          rollbackPlanDigest: plan.rollbackPlanDigest,
          baselineSnapshotDigest: plan.baselineSnapshotDigest,
          baselineConfigFingerprint: plan.baselineConfigFingerprint,
          environment: 'PRODUCTION',
          executionMode: plan.executionMode,
          target: plan.target,
          configPath: plan.configPath,
          fromValue: plan.fromValue,
          toValue: plan.toValue,
          idempotencyKey: plan.idempotencyKey + '-prod',
          idempotencyPayloadDigest: plan.idempotencyPayloadDigest,
          status: 'RESERVED',
          reservationExpiresAt: plan.reservationExpiresAt,
          updatedAt: NOW,
        },
      }),
    ).rejects.toThrow(/environment_chk|Environment/);
  });

  it('PGU-14 跨连接耐久可见性：进程 A 建 reservation，进程 B（另一连接）可读可 claim', async () => {
    const plan = planned('pgu14');
    const reserved = await reserveDurableExecution(prisma, { plan, now: NOW });
    if (reserved.kind !== 'CREATED') throw new Error('reserve 失败');
    const seenByB = await findByVerdictDigest(workerB, plan.authorizationVerdictDigest);
    expect(seenByB?.id).toBe(reserved.reservationId);
    const claimedByB = await claimExecutionLease(workerB, {
      reservationId: reserved.reservationId,
      ownerRef: 'worker-B',
      now: NOW,
    });
    expect(claimedByB.kind).toBe('ACQUIRED');
  });

  it('PGU-15 不同 verdict/ticket 的 reservation 互不影响（无串扰）', async () => {
    const a = planned('pgu15a');
    const b = planned('pgu15b');
    const ra = await reserveDurableExecution(prisma, { plan: a, now: NOW });
    const rb = await reserveDurableExecution(prisma, { plan: b, now: NOW });
    expect([ra.kind, rb.kind]).toEqual(['CREATED', 'CREATED']);
    const randomTag = randomUUID().slice(0, 8);
    expect(await findByVerdictDigest(prisma, `missing-${randomTag}`)).toBeNull();
    expect(await prisma.controlledConfigExecutionReservation.count()).toBe(2);
  });
});
