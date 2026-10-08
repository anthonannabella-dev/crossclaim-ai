/**
 * PHASE 1 —— 客户任务自动执行闭环（真实 PostgreSQL + 真实 ONE SI Runtime 模块链）
 * ---------------------------------------------------------------
 * 覆盖 HOST 指令 PHASE 1 的 1/2/3/4/5/6：
 *   1 运行中的 runtime 自动发现并领取（无需重启）
 *   2 durable 队列（消除 JSON 读-改-写并发丢任务）
 *   3 租户可信绑定（organizationId 由服务端固化在 durable incident 上）
 *   4 claim / lease 语义（CAS 领取 + 租约行）
 *   5 并发 worker 不重复领取
 *   6 崩溃恢复（中断在 IN_PROGRESS 的任务经既有 reconcile 回到 READY 并可被重新领取）
 * 不使用 Mock 替换被测逻辑：真实 PrismaClient、真实队列端口、真实 runtime 组合根、真实 reconcile。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaRsiReconcileStore } from '../runtime/rsi-reconcile-prisma-store';
import { runRsiRestartReconcile } from '../runtime/rsi-restart-reconcile';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';
import type { RsiTaskRunner } from '../runtime/rsi-controller-continuation';

const prisma = new PrismaClient();
const NOW = new Date('2026-10-08T12:00:00.000Z');
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

/**
 * C4：领取前会从可信库重解析 organization + Standing Authorization。
 * 因此测试必须先 seed 真实租户事实（否则正确行为是 BLOCK，而非「领取成功」）。
 */
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
      createdAt: NOW,
    },
  });
}

const probe = (): { seen: string[]; runner: RsiTaskRunner } => {
  const seen: string[] = [];
  return {
    seen,
    runner: {
      async run(task) {
        seen.push(task.dedupeKey);
        return { status: 'PASS' };
      },
    },
  };
};

async function truncateAutonomy(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AutonomyMetricResult", "AutonomyRollbackRecord", "AutonomyPromotionDecision", "AutonomyEvaluationRun", "AutonomyCandidate", "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncateAutonomy();
  await seedTenant('org-A');
  await seedTenant('org-B');
});

afterAll(async () => {
  await truncateAutonomy();
  await prisma.$disconnect();
});

describe('PHASE 1 · durable 队列端口（PostgreSQL）', () => {
  it('01 入队幂等：同一 dedupeKey 重复提交只落一行，第二次报告 alreadyPresent', async () => {
    const port = createPrismaTaskQueuePort({ prisma, now: () => NOW });
    const key = 'task:recovery:scan:v1:' + suffix();
    const first = await port.admit({ organizationId: 'org-A', tasks: [draft(key)] });
    const second = await port.admit({ organizationId: 'org-A', tasks: [draft(key)] });
    expect(first.admitted).toEqual([key]);
    expect(second.alreadyPresent).toEqual([key]);
    expect(await prisma.autonomyTask.count({ where: { dedupeKey: key } })).toBe(1);
  });

  it('02 并发入队不丢任务（取代 JSON 读-改-写）', async () => {
    const port = createPrismaTaskQueuePort({ prisma, now: () => NOW });
    const a = 'task:recovery:scan:v1:' + suffix();
    const b = 'task:recovery:scan:v1:' + suffix();
    const [ra, rb] = await Promise.all([
      port.admit({ organizationId: 'org-A', tasks: [draft(a)] }),
      port.admit({ organizationId: 'org-A', tasks: [draft(b)] }),
    ]);
    expect([...ra.admitted, ...rb.admitted].sort()).toEqual([a, b].sort());
    expect(await prisma.autonomyTask.count({ where: { dedupeKey: { in: [a, b] } } })).toBe(2);
  });

  it('03 租户可信绑定：organizationId 固化在 durable incident 上，跨租户互不可见', async () => {
    const port = createPrismaTaskQueuePort({ prisma, now: () => NOW });
    const ka = 'task:recovery:scan:v1:' + suffix();
    const kb = 'task:recovery:scan:v1:' + suffix();
    await port.admit({ organizationId: 'org-A', tasks: [draft(ka)] });
    await port.admit({ organizationId: 'org-B', tasks: [draft(kb)] });

    const incA = await prisma.autonomyIncident.findFirstOrThrow({
      where: { dedupeKey: 'customer-goal-queue:org-A' },
    });
    const incB = await prisma.autonomyIncident.findFirstOrThrow({
      where: { dedupeKey: 'customer-goal-queue:org-B' },
    });
    expect(incA.sourceRefs).toEqual([{ organizationId: 'org-A' }]);
    expect(incB.sourceRefs).toEqual([{ organizationId: 'org-B' }]);
    expect(incA.id).not.toBe(incB.id);

    const taskA = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: ka } });
    expect(taskA.incidentId).toBe(incA.id);
    expect(taskA.incidentId).not.toBe(incB.id);
  });
});

describe('PHASE 1 · claim / lease / 并发', () => {
  it('04 CAS 领取：多 worker 并发只允许一个赢家，且写入 ACTIVE 租约', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => NOW }).admit({
      organizationId: 'org-A',
      tasks: [draft(key)],
    });
    const w1 = createAutonomyTaskSource({ prisma, ownerRef: 'worker-1', now: () => NOW });
    const w2 = createAutonomyTaskSource({ prisma, ownerRef: 'worker-2', now: () => NOW });
    const [c1, c2] = await Promise.all([w1.claim(5), w2.claim(5)]);
    expect(c1.length + c2.length).toBe(1);

    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
    expect(task.status).toBe('IN_PROGRESS');
    const lease = await prisma.autonomyLease.findFirstOrThrow({ where: { taskId: task.id } });
    expect(lease.status).toBe('ACTIVE');
    expect(['worker-1', 'worker-2']).toContain(lease.ownerRef);
  });

  it('05 崩溃恢复：中断在 IN_PROGRESS 的任务经既有 reconcile 回到 READY 并可被重新领取', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => NOW }).admit({
      organizationId: 'org-A',
      tasks: [draft(key)],
    });
    const crashed = createAutonomyTaskSource({ prisma, ownerRef: 'worker-crashed', now: () => NOW });
    expect((await crashed.claim(5)).map((t) => t.dedupeKey)).toEqual([key]);

    // 另一 worker 现在领不到（已被 crashed 领取）
    const other = createAutonomyTaskSource({ prisma, ownerRef: 'worker-other', now: () => NOW });
    expect(await other.claim(5)).toEqual([]);

    // 模拟重启接管：既有 reconcile 把 IN_PROGRESS 放回 READY
    await runRsiRestartReconcile({
      store: createPrismaRsiReconcileStore(prisma),
      ownerRef: 'worker-recovery',
      trigger: 'RESTART',
      now: () => new Date('2026-10-08T13:00:00.000Z').toISOString(),
    });
    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
    expect(task.status).toBe('READY');

    // 恢复后可以被重新领取（不重复产生业务副作用由 dedupeKey + CAS 保证）
    expect((await other.claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
  });
});

describe('PHASE 1 · 运行中的 ONE SI Runtime 动态消费（无需重启）', () => {
  it('06 服务启动后再入队的任务会被运行中的 runtime 自动发现并执行（对照 PHASE 0 的 A1）', async () => {
    const { seen, runner } = probe();
    const source = createAutonomyTaskSource({
      prisma,
      ownerRef: 'runtime-1',
      now: () => NOW,
      taskPrefix: 'task:demo:', // 用非 recovery 前缀以便观察真实执行（recovery 的前缀见用例 07）
    });
    const composition = await composeRsiRuntime({
      readFile: noFile,
      runner,
      intervalMs: 50,
      taskSource: source,
    });
    composition.start();
    try {
      expect(seen).toEqual([]);

      // 入队发生在 runtime **已经运行**之后
      await createPrismaTaskQueuePort({ prisma, now: () => NOW }).admit({
        organizationId: 'org-A',
        tasks: [draft('task:demo:' + suffix())],
      });
      const queued = await prisma.autonomyTask.findFirstOrThrow({ where: { status: 'READY' } });

      // 既有 60s 兜底 tick（不重启进程）
      await composition.controller.tick();
      expect(seen).toEqual([queued.dedupeKey]);
      expect(composition.controller.state().adoptedCount).toBe(1);
    } finally {
      composition.stop();
    }
  });

  it('07 生产前缀 task:recovery:*：任务被动态采纳并 claim（修复 PHASE 0-A），执行仍待 PHASE 2 装配', async () => {
    const { seen, runner } = probe();
    const source = createAutonomyTaskSource({ prisma, ownerRef: 'runtime-1', now: () => NOW });
    const composition = await composeRsiRuntime({
      readFile: noFile,
      runner,
      intervalMs: 50,
      taskSource: source,
    });
    try {
      const key = 'task:recovery:scan:v1:' + suffix();
      await createPrismaTaskQueuePort({ prisma, now: () => NOW }).admit({
        organizationId: 'org-A',
        tasks: [draft(key)],
      });
      const outcome = await composition.controller.tick();
      expect(outcome.claimed?.dedupeKey).toBe(key);
      expect(composition.controller.state().adoptedCount).toBe(1);
      // PHASE 2 之前：Recovery pack 未装配 ⇒ 不回退 caller runner（保持 fail-closed）
      expect(seen).toEqual([]);
    } finally {
      composition.stop();
    }
  });
});
