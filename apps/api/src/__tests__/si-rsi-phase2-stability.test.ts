/**
 * PHASE 2 / P2-CHANGE4 —— 运行时稳定性与可观察性（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 复审 CHANGE 4 要求覆盖：多 worker 并发 / 租约到期与续租竞争 / 任务执行中进程退出 /
 * 重启后幂等恢复 / DB 短暂中断与恢复 / dispatch 日志与 durable 状态一致性。
 *
 * 诚实边界：本机无法制造真实 DB 断连（Docker 无响应）⇒「DB 短暂中断」用**显式故障注入**
 * （错误连接串客户端 / 单次事务失败）验证 fail-closed 与回滚，并标注为注入而非真实断电。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createProductionRecoveryPackDeps } from '../runtime/recovery-si-production-composition';
import { composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaRsiReconcileStore } from '../runtime/rsi-reconcile-prisma-store';
import { runRsiRestartReconcile } from '../runtime/rsi-restart-reconcile';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

import { testDatabaseMarker, uniqueTaskKeys, unreachableDatabaseUrl } from './si-rsi-test-db.helper';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 12);
const noFile = async (): Promise<string> => {
  throw new Error('NO_FILE_SOURCE');
};

const draft = (dedupeKey: string): GoalTaskDraft => ({
  domain: 'LOGISTICS',
  dedupeKey,
  candidateActions: [],
  autoExecutableActions: [],
  blockedActions: [],
  executionMode: 'AUTO_WHEN_AUTHORIZED',
  requiresStandingAuthorizationForAutoExecution: true,
});

async function seedTenant(organizationId: string): Promise<void> {
  await prisma.organization.upsert({
    where: { id: organizationId },
    create: { id: organizationId, name: organizationId, slug: organizationId },
    update: {},
  });
  await prisma.standingAuthorization.deleteMany({ where: { organizationId } });
  await prisma.standingAuthorization.create({
    data: {
      organizationId,
      platformAccountId: 'acct-1',
      provider: 'AMAZON',
      allowedActionTypes: ['recovery.read'],
      monetaryLimitUsd: '0',
      currency: 'USD',
      domain: 'LOGISTICS',
      jurisdiction: 'US',
      effectiveAt: new Date('2026-10-08T00:00:00.000Z'),
      expiresAt: new Date('2026-11-08T00:00:00.000Z'),
      authorizationVersion: 1,
      termsPolicyVersion: 'v1',
      consentEvidenceRef: 'evidence://test-seed',
      scopeDigest: 'a'.repeat(64),
      revocationState: 'ACTIVE',
      createdAt: T0,
    },
  });
}

async function truncateAutonomy(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AutonomyMetricResult", "AutonomyRollbackRecord", "AutonomyPromotionDecision", "AutonomyEvaluationRun", "AutonomyCandidate", "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE',
  );
}

/** 让某任务的租约立即过期（保持 DB 的 time-order 约束） */
async function expireLease(taskId: string): Promise<void> {
  await prisma.autonomyLease.update({
    where: { taskId },
    data: {
      acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
      renewedAt: new Date('2026-10-08T11:50:00.000Z'),
      expiresAt: new Date('2026-10-08T11:59:00.000Z'),
    },
  });
}

beforeEach(async () => {
  await truncateAutonomy();
  await seedTenant('org-A');
});

afterAll(async () => {
  await truncateAutonomy();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: 'org-A' } });
  await prisma.$disconnect();
});

describe('PHASE 2 / P2-CHANGE4 · 运行时稳定性与可观察性', () => {
  it('S1 多 worker 并发（2 轮 × 4 任务 × 5 worker）⇒ 无重复领取、无遗漏', async () => {
    // CHANGE 4A：每轮独立键 + try/finally 清理 —— 失败时也不把脏数据留给下一个用例
    for (let round = 0; round < 2; round += 1) {
      const keys = uniqueTaskKeys('task:recovery:LOGISTICS:', 4, `${suffix()}-r${round}`);
      try {
        await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: keys.map(draft) });
        const workers = ['w1', 'w2', 'w3', 'w4', 'w5'].map((w) =>
          createAutonomyTaskSource({ prisma, ownerRef: `${w}-r${round}`, now: () => T0 }),
        );
        const results = (await Promise.all(workers.map((w) => w.claim(5)))).flat().map((t) => t.dedupeKey);
        expect(results).toHaveLength(4);
        expect(new Set(results).size).toBe(4);
        // 赢家数量与任务数一致：每个任务恰好一个 owner 持有 ACTIVE 租约
        expect(await prisma.autonomyLease.count({ where: { status: 'ACTIVE' } })).toBe(4);
      } finally {
        // 清理本轮：把任务与租约清掉以便下一轮独立（无论断言是否失败都执行）
        await truncateAutonomy();
        await seedTenant('org-A');
      }
    }
  });

  it('S2 租约续租竞争：本 owner 可续租；被接管后旧 owner 续租被 fence 拒绝', async () => {
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });
    const a = createAutonomyTaskSource({ prisma, ownerRef: 'worker-A', now: () => T0 });
    await a.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;

    const ok = await a.renew({ taskId, ownerRef: 'worker-A', leaseMs: 120_000 });
    expect(ok.applied).toBe(true);
    expect(new Date(ok.expiresAt!).getTime()).toBe(T0.getTime() + 120_000);

    // 租约被 B 接管
    await expireLease(taskId);
    const b = createAutonomyTaskSource({ prisma, ownerRef: 'worker-B', now: () => T0 });
    await b.reclaimExpired(5);
    await b.claim(5);
    const leaseBefore = await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } });

    // 旧 owner 续租 ⇒ 必须被拒，且不改变 B 的租约
    const stale = await a.renew({ taskId, ownerRef: 'worker-A', leaseMs: 120_000 });
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('FENCED_OWNER_MISMATCH');
    const leaseAfter = await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } });
    expect(leaseAfter.ownerRef).toBe('worker-B');
    expect(leaseAfter.expiresAt.getTime()).toBe(leaseBefore.expiresAt.getTime());
  });

  it('S3 任务执行中进程退出：租约到期后由新 owner 接管并完成（无重复副作用）', async () => {
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });
    const crashed = createAutonomyTaskSource({ prisma, ownerRef: 'worker-crashed', now: () => T0 });
    await crashed.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;

    await expireLease(taskId); // 执行中退出，租约到期
    const next = createAutonomyTaskSource({ prisma, ownerRef: 'worker-next', now: () => T0 });
    await next.reclaimExpired(5);
    expect((await next.claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).ownerRef).toBe('worker-next');
    // CHANGE 4A：接管后仍只有一条租约行、且没有第二条任务行（无重复副作用 / 无键漂移）
    expect(await prisma.autonomyLease.count({ where: { taskId } })).toBe(1);
    expect(await prisma.autonomyTask.count({ where: { dedupeKey: key } })).toBe(1);
  });

  it('S4 重启后幂等恢复：既有 reconcile 重复执行 0 行变化', async () => {
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });
    await createAutonomyTaskSource({ prisma, ownerRef: 'worker-A', now: () => T0 }).claim(5);
    const store = createPrismaRsiReconcileStore(prisma);
    const first = await runRsiRestartReconcile({ store, ownerRef: 'recovery', trigger: 'RESTART', now: () => '2026-10-08T13:00:00.000Z' });
    expect(first.recoveredTaskIds).toHaveLength(1);
    const second = await runRsiRestartReconcile({ store, ownerRef: 'recovery', trigger: 'RESTART', now: () => '2026-10-08T13:00:00.000Z' });
    expect(second.idempotentNoop).toBe(true);
    expect((await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).status).toBe('READY');
  });

  it('S5 DB 不可用（注入）：拒绝连接时操作 fail-closed 且不产生部分写入', async () => {
    // CHANGE 4A：故障注入 URL 由**真实测试库 URL** 派生（只换端口/库名）——
    // 仓库内不再出现任何凭据字面量；日志只暴露无凭据的数据库标记。
    const marker = testDatabaseMarker();
    expect(marker).not.toContain('@');
    expect(marker).not.toContain('DB_MARKER_UNAVAILABLE');
    const broken = new PrismaClient({ datasources: { db: { url: unreachableDatabaseUrl() } } });
    try {
      const source = createAutonomyTaskSource({ prisma: broken, ownerRef: 'worker-x', now: () => T0 });
      await expect(source.claim(5)).rejects.toThrow();
    } finally {
      // 客户端必须释放，避免连接池残留干扰后续用例（复审要求：收拢客户端释放）
      await broken.$disconnect();
    }
    // 真实库未受影响：既无残留任务，也仍可正常领取
    expect(await prisma.autonomyTask.count()).toBe(0);
    expect(await prisma.autonomyLease.count()).toBe(0);
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });
    expect((await createAutonomyTaskSource({ prisma, ownerRef: 'worker-ok', now: () => T0 }).claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
  });

  it('S6 dispatch 日志与 durable 状态一致：记录 taskId 且状态不被误标为业务完成', async () => {
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });
    const composition = await composeRsiRuntime({
      readFile: noFile,
      intervalMs: 50,
      taskSource: createAutonomyTaskSource({ prisma, ownerRef: 'runtime-1', now: () => T0 }),
      productRecoveryPack: createProductionRecoveryPackDeps({ prisma }),
    });
    try {
      await composition.controller.tick();
      const row = composition.domainDispatchLog().find((r) => r.packId === 'recovery-si');
      expect(row).toBeDefined();
      const durable = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: row!.taskId } });
      expect(durable.dedupeKey).toBe(key);
      expect(durable.status).toBe('IN_PROGRESS'); // 派发 ≠ 完成
      expect(durable.status).not.toBe('PROMOTED');
    } finally {
      composition.stop();
    }
  });
});
