/**
 * PHASE 1 FINALIZATION —— C1（原子化 claim+lease）与 C2（运行中租约接管 + fencing）
 * ---------------------------------------------------------------
 * 针对 `MSG-20261008-16` 的两项 REVISE 成因：
 *   PHASE1_MULTI_WORKER_ISOLATION / PHASE1_CRASH_RECOVERY
 * 真实 PostgreSQL；不替换被测逻辑（只在测试夹具里推进时间/制造并发）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

const draft = (dedupeKey: string): GoalTaskDraft => ({
  domain: 'LOGISTICS',
  dedupeKey,
  candidateActions: [],
  autoExecutableActions: [],
  blockedActions: [],
  executionMode: 'AUTO_WHEN_AUTHORIZED',
  requiresStandingAuthorizationForAutoExecution: true,
});

/** C4：领取前从可信库重解析 organization + Standing Authorization ⇒ 测试需先 seed 真实租户事实 */
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

const admit = (key: string): Promise<unknown> =>
  createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
    organizationId: 'org-A',
    tasks: [draft(key)],
  });

async function truncateAutonomy(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AutonomyMetricResult", "AutonomyRollbackRecord", "AutonomyPromotionDecision", "AutonomyEvaluationRun", "AutonomyCandidate", "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncateAutonomy();
  await seedTenant('org-A');
});

afterAll(async () => {
  await truncateAutonomy();
  await prisma.$disconnect();
});

describe('PHASE 1 FINALIZATION · C1 原子化 claim + lease', () => {
  it('C1-1 并发领取后不存在「IN_PROGRESS 但无有效 ACTIVE 租约」的悬挂任务', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const w1 = createAutonomyTaskSource({ prisma, ownerRef: 'worker-1', now: () => T0 });
    const w2 = createAutonomyTaskSource({ prisma, ownerRef: 'worker-2', now: () => T0 });
    const w3 = createAutonomyTaskSource({ prisma, ownerRef: 'worker-3', now: () => T0 });
    await Promise.all([w1.claim(5), w2.claim(5), w3.claim(5)]);

    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
    expect(task.status).toBe('IN_PROGRESS');
    const lease = await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId: task.id } });
    expect(lease.status).toBe('ACTIVE');
    expect(lease.ownerRef).toMatch(/^worker-[123]$/);
    // 全局不变式：处于 IN_PROGRESS 的任务必须都持有 ACTIVE 租约
    const inProgress = await prisma.autonomyTask.findMany({ where: { status: 'IN_PROGRESS' } });
    for (const row of inProgress) {
      const l = await prisma.autonomyLease.findUnique({ where: { taskId: row.id } });
      expect(l?.status, row.dedupeKey).toBe('ACTIVE');
    }
  });

  it('C1-2 未赢得 CAS 的 worker 不会留下自己的租约（无部分写入）', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const w1 = createAutonomyTaskSource({ prisma, ownerRef: 'worker-1', now: () => T0 });
    const w2 = createAutonomyTaskSource({ prisma, ownerRef: 'worker-2', now: () => T0 });
    const [c1, c2] = await Promise.all([w1.claim(5), w2.claim(5)]);
    expect(c1.length + c2.length).toBe(1);
    const lease = await prisma.autonomyLease.findFirstOrThrow();
    const winner = c1.length === 1 ? 'worker-1' : 'worker-2';
    expect(lease.ownerRef).toBe(winner);
    expect(await prisma.autonomyLease.count()).toBe(1);
  });
});

describe('PHASE 1 FINALIZATION · C2 运行中租约接管 + fencing', () => {
  it('C2-1 进程未重启也能接管：到期租约被 EXPIRED，任务回 READY 并可被新 worker 领取', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const a = createAutonomyTaskSource({ prisma, ownerRef: 'worker-A', now: () => T0 });
    expect((await a.claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });

    // 模拟租约到期（仅推进 DB 中的 expiresAt，不重启任何进程）
    await prisma.autonomyLease.update({
      where: { taskId: task.id },
      // 保持时间序一致（DB 有 AutonomyLease_time_order_chk）：acquiredAt <= renewedAt <= expiresAt
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });

    const b = createAutonomyTaskSource({ prisma, ownerRef: 'worker-B', now: () => T0 });
    const requeued = await b.reclaimExpired(5);
    expect(requeued).toEqual([task.id]);
    const afterReclaim = await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId: task.id } });
    expect(afterReclaim.status).toBe('EXPIRED');

    expect((await b.claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
    const takenOver = await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId: task.id } });
    expect(takenOver.status).toBe('ACTIVE');
    expect(takenOver.ownerRef).toBe('worker-B');
  });

  it('C2-2 接管后旧 worker 迟到提交被 fence 拒绝，且不覆盖新 owner 的结果', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const a = createAutonomyTaskSource({ prisma, ownerRef: 'worker-A', now: () => T0 });
    await a.claim(5);
    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
    await prisma.autonomyLease.update({
      where: { taskId: task.id },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });

    const b = createAutonomyTaskSource({ prisma, ownerRef: 'worker-B', now: () => T0 });
    await b.reclaimExpired(5);
    await b.claim(5);
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId: task.id } })).ownerRef).toBe('worker-B');

    // 旧 worker A 迟到提交 ⇒ 必须被拒绝（fencing）
    const stale = await a.settle({ taskId: task.id, ownerRef: 'worker-A', outcome: 'COMPLETED' });
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('FENCED_OWNER_MISMATCH');
    const stillRunning = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(stillRunning.status).toBe('IN_PROGRESS'); // 未被旧 worker 覆盖

    // 新 owner B 正常提交
    const fresh = await b.settle({ taskId: task.id, ownerRef: 'worker-B', outcome: 'COMPLETED' });
    expect(fresh.applied).toBe(true);
    // 既有 DB 词汇表无 COMPLETED：成功终态映射为 PROMOTED（已登记为已知限制）
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('PROMOTED');
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId: task.id } })).status).toBe('RELEASED');
  });

  it('C2-3 即使 owner 相同，租约已过期也不得提交（时间型 fence）', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const a = createAutonomyTaskSource({ prisma, ownerRef: 'worker-A', now: () => T0 });
    await a.claim(5);
    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
    await prisma.autonomyLease.update({
      where: { taskId: task.id },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });
    const late = await a.settle({ taskId: task.id, ownerRef: 'worker-A', outcome: 'COMPLETED' });
    expect(late.applied).toBe(false);
    expect(late.reason).toBe('FENCED_LEASE_EXPIRED');
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('IN_PROGRESS');
  });
});
