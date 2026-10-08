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
});
