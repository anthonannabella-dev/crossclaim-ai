/**
 * PHASE 1 / C6 —— 多 worker 故障注入矩阵（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 对应 `MSG-20261008-16` CHANGE 6，逐条覆盖：
 *   并发领取 / 租约过期与重新领取 / 旧 worker 迟到提交 / 数据库事务失败 /
 *   重启恢复 / 重复任务提交 / 跨租户与账户边界 / 幂等与重复副作用控制
 * 真实 PrismaClient + 真实 durable 任务源；不替换被测逻辑（只注入故障与并发）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaRsiReconcileStore } from '../runtime/rsi-reconcile-prisma-store';
import { runRsiRestartReconcile } from '../runtime/rsi-restart-reconcile';
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

const admit = (organizationId: string, keys: string[]): Promise<{ admitted: readonly string[]; alreadyPresent: readonly string[] }> =>
  createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
    organizationId,
    tasks: keys.map(draft),
  });

async function seedTenant(organizationId: string, revocationState = 'ACTIVE'): Promise<void> {
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
      revocationState,
      createdAt: T0,
      ...(revocationState === 'ACTIVE'
        ? {}
        : { revokedAt: T0, revokedBy: 'owner@example.test', revocationReason: 'TEST_REVOKE' }),
    },
  });
}

async function truncateAutonomy(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AutonomyMetricResult", "AutonomyRollbackRecord", "AutonomyPromotionDecision", "AutonomyEvaluationRun", "AutonomyCandidate", "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE',
  );
}

const source = (ownerRef: string, leaseMs?: number, at: Date = T0) =>
  createAutonomyTaskSource({ prisma, ownerRef, now: () => at, ...(leaseMs === undefined ? {} : { leaseMs }) });

beforeEach(async () => {
  await truncateAutonomy();
  await seedTenant('org-A');
  await seedTenant('org-B');
});

afterAll(async () => {
  await truncateAutonomy();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: { in: ['org-A', 'org-B'] } } });
  await prisma.$disconnect();
});

describe('PHASE 1 / C6 · 多 worker 故障注入矩阵', () => {
  it('M1 并发领取：3 任务 × 5 worker ⇒ 每个任务恰好一个赢家，总数 = 3', async () => {
    const keys = [0, 1, 2].map(() => 'task:recovery:scan:v1:' + suffix());
    await admit('org-A', keys);
    const workers = ['w1', 'w2', 'w3', 'w4', 'w5'].map((w) => source(w));
    const results = await Promise.all(workers.map((w) => w.claim(5)));
    const all = results.flat().map((t) => t.dedupeKey);
    expect(all).toHaveLength(3);
    expect(new Set(all).size).toBe(3);
    expect(await prisma.autonomyLease.count()).toBe(3);
  });

  it('M2 租约过期：运行中接管（无需重启）后新 worker 重新领取', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit('org-A', [key]);
    const a = source('worker-A');
    await a.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
    await prisma.autonomyLease.update({
      where: { taskId },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });
    const b = source('worker-B');
    expect(await b.reclaimExpired(5)).toEqual([taskId]);
    expect((await b.claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
  });

  it('M3 旧 worker 迟到提交：settle 与 fail 均被 fence 拒绝，结果不被覆盖', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit('org-A', [key]);
    const a = source('worker-A');
    await a.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
    await prisma.autonomyLease.update({
      where: { taskId },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });
    const b = source('worker-B');
    await b.reclaimExpired(5);
    await b.claim(5);

    expect((await a.settle({ taskId, ownerRef: 'worker-A', outcome: 'COMPLETED', businessOutcome: 'SETTLEMENT_RECEIVED' })).reason).toBe('FENCED_OWNER_MISMATCH');
    expect((await a.fail({ taskId, ownerRef: 'worker-A', errorCode: 'LATE' })).reason).toBe('FENCED_OWNER_MISMATCH');
    const row = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.attempts).toBe(0);
    // 新 owner 正常提交
    expect((await b.settle({ taskId, ownerRef: 'worker-B', outcome: 'COMPLETED', businessOutcome: 'SETTLEMENT_RECEIVED' })).applied).toBe(true);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('PROMOTED');
  });

  it('M4 数据库事务失败注入：lease 写入违反约束 ⇒ claim 整体回滚，任务仍 READY 且零租约', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit('org-A', [key]);
    // leaseMs = -1000 ⇒ expiresAt < acquiredAt ⇒ 违反 AutonomyLease_time_order_chk
    const broken = source('worker-broken', -1000);
    await expect(broken.claim(5)).rejects.toThrow(/AutonomyLease_time_order_chk|check constraint/i);

    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
    expect(task.status).toBe('READY'); // CAS 已随事务回滚
    expect(await prisma.autonomyLease.count({ where: { taskId: task.id } })).toBe(0);
    // 健康 worker 仍可正常领取（故障未污染状态）
    expect((await source('worker-ok').claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
  });

  it('M5 重启恢复：中断在 IN_PROGRESS 的任务经既有 reconcile 回到 READY 并可重新领取', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit('org-A', [key]);
    await source('worker-crashed').claim(5);
    await runRsiRestartReconcile({
      store: createPrismaRsiReconcileStore(prisma),
      ownerRef: 'worker-recovery',
      trigger: 'RESTART',
      now: () => new Date('2026-10-08T13:00:00.000Z').toISOString(),
    });
    expect((await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).status).toBe('READY');
    expect((await source('worker-next', undefined, new Date('2026-10-08T13:00:01.000Z')).claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
  });

  it('M6 重复任务提交：同 dedupeKey 幂等（单行 + alreadyPresent），不产生重复执行', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    const first = await admit('org-A', [key]);
    const second = await admit('org-A', [key]);
    expect(first.admitted).toEqual([key]);
    expect(second.alreadyPresent).toEqual([key]);
    expect(await prisma.autonomyTask.count({ where: { dedupeKey: key } })).toBe(1);
    const claimed = await source('worker-A').claim(5);
    expect(claimed).toHaveLength(1);
    // 已被领取后再次领取不会被重复执行
    expect(await source('worker-B').claim(5)).toEqual([]);
  });

  it('M7 跨租户/账户边界：org-A 授权撤销只影响 org-A，org-B 任务不受影响', async () => {
    const keyA = 'task:recovery:scan:v1:' + suffix();
    const keyB = 'task:recovery:scan:v1:' + suffix();
    await admit('org-A', [keyA]);
    await admit('org-B', [keyB]);
    await seedTenant('org-A', 'REVOKED'); // 仅撤销 org-A

    const claimed = await source('worker-A').claim(5);
    expect(claimed.map((t) => t.dedupeKey)).toEqual([keyB]); // 只有 org-B 的任务可执行
    const blocked = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: keyA } });
    expect(blocked.status).toBe('BLOCKED');
    const allowed = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: keyB } });
    expect(allowed.status).toBe('IN_PROGRESS');
  });

  it('M8 幂等：同一任务重复 settle/fail 不产生第二次副作用', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit('org-A', [key]);
    const a = source('worker-A');
    await a.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;

    expect((await a.settle({ taskId, ownerRef: 'worker-A', outcome: 'COMPLETED', businessOutcome: 'SETTLEMENT_RECEIVED' })).applied).toBe(true);
    const again = await a.settle({ taskId, ownerRef: 'worker-A', outcome: 'COMPLETED', businessOutcome: 'SETTLEMENT_RECEIVED' });
    expect(again.applied).toBe(false);
    expect(again.reason).toBe('LEASE_NOT_ACTIVE');
    const lateFail = await a.fail({ taskId, ownerRef: 'worker-A', errorCode: 'AFTER_DONE' });
    expect(lateFail.applied).toBe(false);

    const row = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe('PROMOTED');
    expect(row.attempts).toBe(0); // 未被迟到的 fail 改动
  });
});
