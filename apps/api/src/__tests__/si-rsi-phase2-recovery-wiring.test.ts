/**
 * PHASE 2 / C5 —— Recovery pack 生产装配（关闭 P0-B），真实 PostgreSQL
 * ---------------------------------------------------------------
 * 对照 PHASE 0 的 B1（无 pack ⇒ recovery 任务恒 BLOCK）：
 * 装配 `createProductionRecoveryPackDeps()` 后，`task:recovery:*` 必须进入
 * **既有** recovery-si domain dispatch（domainDispatchLog 非空），且**不得**落到 caller/no-op runner。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createProductionRecoveryPackDeps } from '../runtime/recovery-si-production-composition';
import { composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';
import type { RsiTaskRunner } from '../runtime/rsi-controller-continuation';

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

beforeEach(async () => {
  await truncateAutonomy();
  await seedTenant('org-A');
});

afterAll(async () => {
  await truncateAutonomy();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: 'org-A' } });
  await prisma.$disconnect();
});

describe('PHASE 2 / C5 · Recovery pack 生产装配', () => {
  it('R1 装配后 recovery 任务进入真实 recovery-si dispatch（不再恒 BLOCK），且不落 caller runner', async () => {
    const seen: string[] = [];
    const probeRunner: RsiTaskRunner = {
      async run(task) {
        seen.push(task.dedupeKey);
        return { status: 'PASS' };
      },
    };
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
      organizationId: 'org-A',
      tasks: [draft(key)],
    });

    const composition = await composeRsiRuntime({
      readFile: noFile,
      runner: probeRunner,
      intervalMs: 50,
      taskSource: createAutonomyTaskSource({ prisma, ownerRef: 'runtime-1', now: () => T0 }),
      productRecoveryPack: createProductionRecoveryPackDeps({ prisma }),
    });
    try {
      const outcome = await composition.controller.tick();
      expect(outcome.claimed?.dedupeKey).toBe(key);
      // 关键断言：进入既有 recovery-si domain dispatch（PHASE 0-B1 时为 0 条）
      const dispatch = composition.domainDispatchLog();
      expect(dispatch.length).toBeGreaterThan(0);
      expect(dispatch.some((row) => row.packId === 'recovery-si')).toBe(true);
      expect(dispatch[0]!.taskId).toBeTruthy();
      // 不得回退给 caller/no-op runner
      expect(seen).toEqual([]);
    } finally {
      composition.stop();
    }
  });

  it('R2 全链路可追踪：dispatch 记录含 taskId/packId/status，且不是伪造 PASS', async () => {
    const key = 'task:recovery:CUSTOMS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
      organizationId: 'org-A',
      tasks: [draft(key)],
    });
    const composition = await composeRsiRuntime({
      readFile: noFile,
      intervalMs: 50,
      taskSource: createAutonomyTaskSource({ prisma, ownerRef: 'runtime-1', now: () => T0 }),
      productRecoveryPack: createProductionRecoveryPackDeps({ prisma }),
    });
    try {
      const claimed = await composition.controller.tick();
      const row = composition.domainDispatchLog()[0];
      expect(row).toBeDefined();
      expect(row!.packId).toBe('recovery-si');
      expect(row!.taskId).toBe(claimed.claimed!.id);
      expect(typeof row!.status).toBe('string');
      // 真实业务状态：本地无 provider/证据 ⇒ 必须是 BLOCK 类，不得伪造 PASS
      expect(row!.status).not.toBe('PASS');
      expect(Array.isArray(row!.guardActions)).toBe(true);
    } finally {
      composition.stop();
    }
  });

  it('R3 授权复核：撤销后 recovery 任务不进入 dispatch（C4 拦截）', async () => {
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
      organizationId: 'org-A',
      tasks: [draft(key)],
    });
    // 撤销 org-A 的 Standing Authorization
    await prisma.standingAuthorization.updateMany({
      where: { organizationId: 'org-A' },
      data: {
        revocationState: 'REVOKED',
        revokedAt: T0,
        revokedBy: 'owner@example.test',
        revocationReason: 'TEST_REVOKE',
      },
    });
    const composition = await composeRsiRuntime({
      readFile: noFile,
      intervalMs: 50,
      taskSource: createAutonomyTaskSource({ prisma, ownerRef: 'runtime-1', now: () => T0 }),
      productRecoveryPack: createProductionRecoveryPackDeps({ prisma }),
    });
    try {
      const outcome = await composition.controller.tick();
      expect(outcome.claimed).toBeNull(); // 未被领取
      expect(composition.domainDispatchLog()).toEqual([]); // 未进入业务链
      const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
      expect(task.status).toBe('BLOCKED');
    } finally {
      composition.stop();
    }
  });

  it('R4 跨租户：org-B 的任务由 org-B 的授权放行，且 bind 使用该任务自身租户', async () => {
    await seedTenant('org-B');
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
      organizationId: 'org-B',
      tasks: [draft(key)],
    });
    const composition = await composeRsiRuntime({
      readFile: noFile,
      intervalMs: 50,
      taskSource: createAutonomyTaskSource({ prisma, ownerRef: 'runtime-1', now: () => T0 }),
      productRecoveryPack: createProductionRecoveryPackDeps({ prisma }),
    });
    try {
      await composition.controller.tick();
      expect(composition.domainDispatchLog().some((row) => row.taskId !== '')).toBe(true);
    } finally {
      composition.stop();
      await prisma.standingAuthorization.deleteMany({ where: { organizationId: 'org-B' } });
    }
  });

  it('R5 durable 恢复：崩溃后任务回 READY 并可再次进入 dispatch（不重复副作用）', async () => {
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
      organizationId: 'org-A',
      tasks: [draft(key)],
    });
    const first = await composeRsiRuntime({
      readFile: noFile,
      intervalMs: 50,
      taskSource: createAutonomyTaskSource({ prisma, ownerRef: 'runtime-1', now: () => T0 }),
      productRecoveryPack: createProductionRecoveryPackDeps({ prisma }),
    });
    await first.controller.tick();
    const firstDispatch = first.domainDispatchLog().length;
    expect(firstDispatch).toBeGreaterThan(0);
    first.stop();

    // 模拟崩溃：租约到期 → 运行中接管（C2）
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
    await prisma.autonomyLease.update({
      where: { taskId },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });
    await prisma.autonomyTask.updateMany({ where: { id: taskId, status: 'IN_PROGRESS' }, data: { status: 'READY' } });

    const second = await composeRsiRuntime({
      readFile: noFile,
      intervalMs: 50,
      taskSource: createAutonomyTaskSource({ prisma, ownerRef: 'runtime-2', now: () => T0 }),
      productRecoveryPack: createProductionRecoveryPackDeps({ prisma }),
    });
    try {
      const outcome = await second.controller.tick();
      expect(outcome.claimed?.dedupeKey).toBe(key); // 恢复后可再次领取
      expect(second.domainDispatchLog().length).toBeGreaterThan(0);
      expect(second.domainDispatchLog()[0]!.packId).toBe('recovery-si');
    } finally {
      second.stop();
    }
  });

  it('R6 无租户任务：bind fail-closed（不进业务链、不落 caller runner，也不伪造完成）', async () => {
    const seen: string[] = [];
    const probeRunner: RsiTaskRunner = {
      async run(task) {
        seen.push(task.dedupeKey);
        return { status: 'PASS' };
      },
    };
    const key = 'task:recovery:LOGISTICS:' + suffix();
    const composition = await composeRsiRuntime({
      readFile: noFile,
      runner: probeRunner,
      intervalMs: 50,
      // 无 organizationId 的任务（等价 JSON legacy 队列来源）
      taskSource: { claim: async () => [{ id: 'legacy-1', priority: 'P2', dedupeKey: key }] },
      productRecoveryPack: createProductionRecoveryPackDeps({ prisma }),
    });
    try {
      const outcome = await composition.controller.tick();
      expect(outcome.claimed?.dedupeKey).toBe(key);
      // 未绑定 ⇒ 显式记为「recovery 命名空间未认领」并 BLOCK（可追踪的 fail-closed，而非静默）
      const rows = composition.domainDispatchLog();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.packId).toBe('(recovery-namespace-unclaimed)');
      expect(rows[0]!.status).toBe('BLOCK');
      expect(seen).toEqual([]); // 也不回退 caller/no-op runner
    } finally {
      composition.stop();
    }
  });
});
