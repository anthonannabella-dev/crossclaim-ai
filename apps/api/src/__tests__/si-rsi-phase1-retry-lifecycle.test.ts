/**
 * PHASE 1 / C3 —— 完整生命周期：失败重试 / 指数退避 / 最大次数 / 死信 / fence（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 对应 `MSG-20261008-16` CHANGE 3：READY → IN_PROGRESS → COMPLETED(PROMOTED)/BLOCKED，
 * 并支持失败重试、退避、上限与死信；所有状态变化都有可信持久化证据。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
const T_LATER = new Date('2026-10-08T12:05:00.000Z');
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
  createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });

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

/** 固定退避 60s，便于断言（否则默认是指数退避 + 抖动） */
const source = (ownerRef: string, at: Date = T0) =>
  createAutonomyTaskSource({ prisma, ownerRef, now: () => at, backoffMs: () => 60_000 });

describe('PHASE 1 / C3 · 失败重试与退避', () => {
  it('C3-1 失败一次：attempts=1、错误码落库、状态回 READY 且设 nextAttemptAt；退避期内不可领取', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const a = source('worker-A');
    expect((await a.claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });

    const failed = await a.fail({ taskId: task.id, ownerRef: 'worker-A', errorCode: 'PROVIDER_TIMEOUT' });
    expect(failed.applied).toBe(true);
    expect(failed.attempts).toBe(1);
    expect(failed.deadLettered).toBe(false);

    const after = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('READY');
    expect(after.attempts).toBe(1);
    expect(after.lastErrorCode).toBe('PROVIDER_TIMEOUT');
    expect(after.nextAttemptAt?.toISOString()).toBe('2026-10-08T12:01:00.000Z');

    // 退避期内（T0）不可领取
    expect(await source('worker-B', T0).claim(5)).toEqual([]);
    // 退避到期后（T_LATER）可再次领取
    expect((await source('worker-B', T_LATER).claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
  });

  it('C3-2 达到 maxAttempts（默认 3）⇒ 死信：DEAD_LETTER + deadLetteredAt，且永不再被领取', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;

    // 每一轮都必须**越过上一轮的退避窗口**才能重新领取（这正是 C3 的退避语义）
    for (const attempt of [1, 2, 3]) {
      const at = new Date(T0.getTime() + attempt * 120_000);
      const worker = source('worker-' + attempt, at);
      expect((await worker.claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
      const res = await worker.fail({ taskId, ownerRef: 'worker-' + attempt, errorCode: 'RATE_LIMITED' });
      expect(res.applied).toBe(true);
      expect(res.attempts).toBe(attempt);
      if (attempt < 3) {
        expect(res.deadLettered).toBe(false);
        expect(res.nextAttemptAt).not.toBeNull();
      } else {
        expect(res.deadLettered).toBe(true);
        expect(res.nextAttemptAt).toBeNull();
      }
    }

    const row = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe('DEAD_LETTER');
    expect(row.deadLetteredAt).not.toBeNull();
    expect(row.attempts).toBe(3);
    // 死信后任何时刻都不再可领取
    expect(await source('worker-late', new Date('2026-10-09T00:00:00.000Z')).claim(5)).toEqual([]);
  });

  it('C3-3 旧 worker 迟到 fail 被 fence 拒绝，不会改动 attempts 或状态', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const a = source('worker-A');
    await a.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;

    // 租约过期后由 B 接管
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

    const stale = await a.fail({ taskId, ownerRef: 'worker-A', errorCode: 'LATE_FAILURE' });
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('FENCED_OWNER_MISMATCH');
    const row = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.attempts).toBe(0);
    expect(row.lastErrorCode).toBeNull();
    expect(row.status).toBe('IN_PROGRESS');
  });

  it('C3-4 成功终态不受影响：settle(COMPLETED) ⇒ PROMOTED 且租约 RELEASED', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const a = source('worker-A');
    await a.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
    const ok = await a.settle({ taskId, ownerRef: 'worker-A', outcome: 'COMPLETED', businessOutcome: 'SETTLEMENT_RECEIVED' });
    expect(ok.applied).toBe(true);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('PROMOTED');
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).status).toBe('RELEASED');
  });

  it('C3-5 DB 层不变量：maxAttempts/attempts 与死信时间戳由约束强制', async () => {
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;

    // attempts 超过 maxAttempts ⇒ 违反 AutonomyTask_attempts_chk
    await expect(
      prisma.autonomyTask.update({ where: { id: taskId }, data: { attempts: 9, maxAttempts: 3 } }),
    ).rejects.toThrow(/AutonomyTask_attempts_chk|check constraint/i);

    // 死信状态必须带 deadLetteredAt ⇒ 违反 AutonomyTask_dead_letter_chk
    await expect(
      prisma.autonomyTask.update({ where: { id: taskId }, data: { status: 'DEAD_LETTER' } }),
    ).rejects.toThrow(/AutonomyTask_dead_letter_chk|check constraint/i);
  });
});
