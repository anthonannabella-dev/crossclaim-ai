// SI/RSI GAP-CLOSURE — 单元 B — RSI reboot / durable reconcile 端到端（真实 PostgreSQL）
// ---------------------------------------------------------------------------
// 目的：把 RSI-DEPLOYMENT.md 里承诺的 **Test C / Test F**（状态持久化与 reboot reconcile）真正闭环，
//   并给出「reboot 不重复 / stale lease recovery / lease fencing / exactly-one logical continuation /
//   repeated startup 幂等 / duplicate event 幂等 / crash-mid-transition 可恢复」的真实 PG 取证。
// 只读/只收敛状态：不读凭据、不发网络、不做 External Write / Payment / Transport。

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaRsiReconcileStore } from '../runtime/rsi-reconcile-prisma-store';
import {
  RSI_RESTART_RECONCILE_BOUNDARY,
  runRsiRestartReconcile,
} from '../runtime/rsi-restart-reconcile';

const prisma = new PrismaClient();
const NOW = '2026-10-06T08:00:00.000Z';

const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

async function truncateAutonomy(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AutonomyMetricResult", "AutonomyRollbackRecord", "AutonomyPromotionDecision", "AutonomyEvaluationRun", "AutonomyCandidate", "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncateAutonomy();
});

afterAll(async () => {
  await truncateAutonomy();
  await prisma.$disconnect();
});

async function seedIncidentTask(options: {
  taskStatus?: string;
  lease?: { status?: string; expiresAt: string; ownerRef?: string } | null;
  incidentDedupeKey?: string;
  taskDedupeKey?: string;
} = {}): Promise<{ incidentId: string; taskId: string; taskDedupeKey: string }> {
  const incidentDedupeKey = options.incidentDedupeKey ?? 'INC:' + suffix();
  const taskDedupeKey = options.taskDedupeKey ?? 'TASK:' + suffix();
  const incident = await prisma.autonomyIncident.create({
    data: {
      kind: 'CI_RED',
      dedupeKey: incidentDedupeKey,
      status: 'OPEN',
      riskClass: 'LOW',
      sourceRefs: [{ ref: 'ci/run/' + suffix() }],
      detectedAt: new Date('2026-10-06T07:00:00.000Z'),
    },
  });
  const task = await prisma.autonomyTask.create({
    data: {
      incidentId: incident.id,
      status: options.taskStatus ?? 'IN_PROGRESS',
      riskClass: 'LOW',
      ownerGateRequired: false,
      dedupeKey: taskDedupeKey,
    },
  });
  if (options.lease !== null) {
    const lease = options.lease ?? { expiresAt: '2026-10-06T07:30:00.000Z' };
    await prisma.autonomyLease.create({
      data: {
        taskId: task.id,
        ownerRef: lease.ownerRef ?? 'runtime-A',
        acquiredAt: new Date('2026-10-06T07:00:00.000Z'),
        renewedAt: new Date('2026-10-06T07:10:00.000Z'),
        expiresAt: new Date(lease.expiresAt),
        status: lease.status ?? 'ACTIVE',
      },
    });
  }
  return { incidentId: incident.id, taskId: task.id, taskDedupeKey };
}

function reconcile(ownerRef = 'runtime-B', trigger: 'BOOT' | 'RESTART' | 'MANUAL' = 'BOOT') {
  return runRsiRestartReconcile({
    store: createPrismaRsiReconcileStore(prisma),
    ownerRef,
    trigger,
    now: () => NOW,
  });
}

async function reject(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('B — RSI reboot durable reconcile（真实 PostgreSQL）', () => {
  it('B1 reboot 不重复：incident / task / candidate / promotion 的 dedupeKey 唯一（同因不重复建）', async () => {
    const { incidentId, taskId, taskDedupeKey } = await seedIncidentTask();
    const incident = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id: incidentId } });
    const candidateDedupeKey = 'CAND:' + suffix();
    const promotionDedupeKey = 'PROMO:' + suffix();

    const candidate = await prisma.autonomyCandidate.create({
      data: {
        taskId,
        status: 'CREATED',
        builderRef: 'builder-1',
        baselineRef: 'baseline-1',
        dedupeKey: candidateDedupeKey,
      },
    });
    await prisma.autonomyPromotionDecision.create({
      data: {
        candidateId: candidate.id,
        dedupeKey: promotionDedupeKey,
        decision: 'REJECTED',
        reason: 'insufficient evidence',
        judgeRef: 'judge-1',
        decidedAt: new Date('2026-10-06T07:20:00.000Z'),
      },
    });

    // 重启后同一因再次出现：唯一约束必须挡住重复建
    await expect(
      prisma.autonomyIncident.create({
        data: {
          kind: incident.kind,
          dedupeKey: incident.dedupeKey,
          status: 'OPEN',
          riskClass: 'LOW',
          sourceRefs: [],
          detectedAt: new Date('2026-10-06T08:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.autonomyTask.create({
        data: {
          incidentId,
          status: 'READY',
          riskClass: 'LOW',
          ownerGateRequired: false,
          dedupeKey: taskDedupeKey,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.autonomyCandidate.create({
        data: {
          taskId,
          status: 'CREATED',
          builderRef: 'builder-1',
          baselineRef: 'baseline-1',
          dedupeKey: candidateDedupeKey,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.autonomyPromotionDecision.create({
        data: {
          candidateId: candidate.id,
          dedupeKey: promotionDedupeKey,
          decision: 'REJECTED',
          reason: 'duplicate',
          judgeRef: 'judge-2',
          decidedAt: new Date('2026-10-06T08:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.autonomyIncident.count()).toBe(1);
    expect(await prisma.autonomyTask.count()).toBe(1);
    expect(await prisma.autonomyCandidate.count()).toBe(1);
    expect(await prisma.autonomyPromotionDecision.count()).toBe(1);
  });

  it('B2 stale lease recovery：过期 ACTIVE lease → EXPIRED 且任务回到 READY（crash-mid-execution 可恢复）', async () => {
    const { taskId } = await seedIncidentTask({ lease: { expiresAt: '2026-10-06T07:30:00.000Z' } });

    const plan = await reconcile('runtime-B', 'BOOT');
    expect(plan.trigger).toBe('BOOT');
    expect(plan.scannedTasks).toBe(1);
    expect(plan.scannedLeases).toBe(1);
    expect(plan.expiredLeaseIds).toHaveLength(1);
    expect(plan.recoveredTaskIds).toEqual([taskId]);
    expect(plan.idempotentNoop).toBe(false);

    const lease = await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } });
    expect(lease.status).toBe('EXPIRED');
    const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('READY');
  });

  it('B3 repeated startup 幂等：连续重启收敛后不再产生任何写（第二次 = 0 差异）', async () => {
    await seedIncidentTask({ lease: { expiresAt: '2026-10-06T07:30:00.000Z' } });
    const first = await reconcile('runtime-B', 'BOOT');
    expect(first.idempotentNoop).toBe(false);

    const countsBefore = {
      incidents: await prisma.autonomyIncident.count(),
      tasks: await prisma.autonomyTask.count(),
      leases: await prisma.autonomyLease.count(),
    };

    const second = await reconcile('runtime-C', 'RESTART');
    const third = await reconcile('runtime-D', 'RESTART');
    expect(second.idempotentNoop).toBe(true);
    expect(third.idempotentNoop).toBe(true);
    expect(second.expiredLeaseIds).toEqual([]);
    expect(second.recoveredTaskIds).toEqual([]);

    expect(await prisma.autonomyIncident.count()).toBe(countsBefore.incidents);
    expect(await prisma.autonomyTask.count()).toBe(countsBefore.tasks);
    expect(await prisma.autonomyLease.count()).toBe(countsBefore.leases);
  });

  it('B4 crash-mid-transition：IN_PROGRESS 但无 lease 行 → 收敛回 READY（claim 与 lease 之间的崩溃窗口）', async () => {
    const { taskId } = await seedIncidentTask({ taskStatus: 'IN_PROGRESS', lease: null });
    const plan = await reconcile('runtime-B', 'BOOT');
    expect(plan.recoveredTaskIds).toEqual([taskId]);
    expect(plan.expiredLeaseIds).toEqual([]);

    const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('READY');
  });

  it('B5 lease fencing：未过期的 ACTIVE lease 不被其它 runtime 抢占（held，不动任务）', async () => {
    const { taskId } = await seedIncidentTask({
      lease: { expiresAt: '2026-10-06T09:00:00.000Z', ownerRef: 'runtime-A' },
    });
    const plan = await reconcile('runtime-B', 'BOOT');
    expect(plan.heldActiveLeaseIds).toHaveLength(1);
    expect(plan.expiredLeaseIds).toEqual([]);
    expect(plan.recoveredTaskIds).toEqual([]);
    expect(plan.idempotentNoop).toBe(true);

    const lease = await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } });
    expect(lease.status).toBe('ACTIVE');
    expect(lease.ownerRef).toBe('runtime-A');
    const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('IN_PROGRESS');
  });

  it('B6 exactly-one logical continuation：多次 reconcile 后每个 dedupeKey 仍只有 1 个未终态任务', async () => {
    const { taskDedupeKey } = await seedIncidentTask({ lease: { expiresAt: '2026-10-06T07:30:00.000Z' } });
    for (let i = 0; i < 3; i += 1) await reconcile('runtime-' + i, 'RESTART');

    const tasks = await prisma.autonomyTask.findMany({ where: { dedupeKey: taskDedupeKey } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('READY');
    const plan = await reconcile('runtime-final', 'RESTART');
    expect(plan.duplicateDedupeKeys).toEqual([]);
  });

  it('B7 duplicate event 幂等：同一事件的重复投递被唯一约束挡住（不会生成第二个任务）', async () => {
    const { incidentId, taskDedupeKey } = await seedIncidentTask({ taskStatus: 'READY', lease: null });
    await expect(
      prisma.autonomyTask.create({
        data: {
          incidentId,
          status: 'READY',
          riskClass: 'LOW',
          ownerGateRequired: false,
          dedupeKey: taskDedupeKey,
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.autonomyTask.count({ where: { dedupeKey: taskDedupeKey } })).toBe(1);
  });

  it('B8 Builder / Judge 分离保持：judgeRef 不得等于 builderRef（fail-closed）', async () => {
    const { taskId } = await seedIncidentTask({ taskStatus: 'READY', lease: null });
    const candidate = await prisma.autonomyCandidate.create({
      data: {
        taskId,
        status: 'CREATED',
        builderRef: 'builder-same',
        baselineRef: 'baseline-1',
        dedupeKey: 'CAND:' + suffix(),
      },
    });
    expect(
      await reject(() =>
        prisma.autonomyPromotionDecision.create({
        data: {
          candidateId: candidate.id,
          dedupeKey: 'PROMO:' + suffix(),
          decision: 'REJECTED',
          reason: 'self review',
          judgeRef: 'builder-same',
          decidedAt: new Date('2026-10-06T07:30:00.000Z'),
        },
        }),
      ),
    ).toMatch(/RSI_BUILDER_JUDGE_SAME_ACTOR/);
  });

  it('B9 证据 append-only：MetricResult 拒绝 UPDATE / DELETE（不可篡改证据保持）', async () => {
    const { taskId } = await seedIncidentTask({ taskStatus: 'READY', lease: null });
    const candidate = await prisma.autonomyCandidate.create({
      data: {
        taskId,
        status: 'CREATED',
        builderRef: 'builder-1',
        baselineRef: 'baseline-1',
        dedupeKey: 'CAND:' + suffix(),
      },
    });
    const run = await prisma.autonomyEvaluationRun.create({
      data: {
        candidateId: candidate.id,
        kind: 'REPLAY',
        status: 'PASSED',
        startedAt: new Date('2026-10-06T07:00:00.000Z'),
        finishedAt: new Date('2026-10-06T07:01:00.000Z'),
      },
    });
    const metric = await prisma.autonomyMetricResult.create({
      data: { evaluationRunId: run.id, name: 'passRate', value: 0.9, unit: 'ratio' },
    });
    expect(
      await reject(() =>
        prisma.$executeRawUnsafe(
          'UPDATE "AutonomyMetricResult" SET "name" = ' + "'tampered'" + ' WHERE "id" = ' + "'" + metric.id + "'",
        ),
      ),
    ).toMatch(/RSI_EVIDENCE_APPEND_ONLY/);
    expect(
      await reject(() => prisma.$executeRawUnsafe('DELETE FROM "AutonomyMetricResult" WHERE "id" = ' + "'" + metric.id + "'")),
    ).toMatch(/RSI_EVIDENCE_APPEND_ONLY/);
  });

  it('B10 边界：reconcile 只做状态收敛，不触及外部系统 / 凭据 / 资金', async () => {
    expect(RSI_RESTART_RECONCILE_BOUNDARY).toMatchObject({
      createsTasks: false,
      deletesTasks: false,
      readsCredentials: false,
      performsNetworkCalls: false,
      externalWrite: false,
      payment: false,
      transport: false,
      writesCustomerData: false,
      terminalStatesUntouched: true,
      idempotentByStoreGuard: true,
    });
    const plan = await reconcile('runtime-B', 'MANUAL');
    expect(typeof plan.idempotentNoop).toBe('boolean');
  });
});
