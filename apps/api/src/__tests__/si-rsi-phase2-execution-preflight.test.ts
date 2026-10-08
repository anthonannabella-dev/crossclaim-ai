/**
 * PHASE 2 / P2-CHANGE2 —— 可信租户来源与授权时效（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 复审 CHANGE 2 要点：
 *   · organizationId 只能由通过服务端授权门禁的 durable claim 写入；
 *   · 外部 JSON / API 输入不得伪造可信 organizationId；
 *   · **任务领取后、执行外部动作前撤销授权，必须再次被拒绝**（claim 通过 ≠ 永久授权）；
 *   · 重新领取须重新验证授权；
 *   · 所有读端口保持组织隔离。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  RECOVERY_PREFLIGHT_DENY,
  createProductionRecoveryPackDeps,
} from '../runtime/recovery-si-production-composition';
import { composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import { createPrismaRecoveryReadPorts } from '../services/intelligence/recovery-read-tool-adapters';
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

describe('PHASE 2 / P2-CHANGE2 · 可信租户与执行前授权复核', () => {
  it('C2-1 领取时授权有效 ⇒ 照常派发进 recovery-si', async () => {
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
      expect(composition.domainDispatchLog().some((row) => row.packId === 'recovery-si')).toBe(true);
    } finally {
      composition.stop();
    }
  });

  it('C2-2 **领取后、执行前撤销授权** ⇒ 执行前复核拒绝（BLOCK），不进入业务链、不落 caller runner', async () => {
    const seen: string[] = [];
    const probeRunner: RsiTaskRunner = {
      async run(task) {
        seen.push(task.dedupeKey);
        return { status: 'PASS' };
      },
    };
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });

    // ① 先领取（此刻授权有效）—— 模拟「claim 已通过」
    const claimed = await createAutonomyTaskSource({ prisma, ownerRef: 'runtime-1', now: () => T0 }).claim(5);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.organizationId).toBe('org-A'); // 可信租户随任务携带

    // ② 领取之后才撤销授权（执行尚未开始）
    await prisma.standingAuthorization.updateMany({
      where: { organizationId: 'org-A' },
      data: { revocationState: 'REVOKED', revokedAt: T0, revokedBy: 'owner@example.test', revocationReason: 'POST_CLAIM_REVOKE' },
    });

    // ③ 执行阶段：用已领取任务喂入引擎（等价于同一 worker 继续执行）
    const composition = await composeRsiRuntime({
      readFile: noFile,
      runner: probeRunner,
      intervalMs: 50,
      taskSource: { claim: async () => claimed },
      productRecoveryPack: createProductionRecoveryPackDeps({ prisma }),
    });
    try {
      const outcome = await composition.controller.tick();
      expect(outcome.claimed?.dedupeKey).toBe(key);
      // 核心断言：没有进入 recovery-si 业务链（preflight 在派发前拒绝）
      expect(composition.domainDispatchLog().some((row) => row.packId === 'recovery-si')).toBe(false);
      expect(seen).toEqual([]); // 也不回退 caller runner
    } finally {
      composition.stop();
    }
  });

  it('C2-3 执行前复核的原因码：无可信租户 / 授权已撤销', async () => {
    const deps = createProductionRecoveryPackDeps({ prisma });
    // 无可信租户（JSON legacy 来源）
    const noTenant = await deps.executionPreflight({ id: 'legacy-1', dedupeKey: 'task:recovery:LOGISTICS:x' });
    expect(noTenant.allowed).toBe(false);
    expect(noTenant.reason).toBe(RECOVERY_PREFLIGHT_DENY.NO_TRUSTED_TENANT);

    // 授权被撤销
    await prisma.standingAuthorization.updateMany({
      where: { organizationId: 'org-A' },
      data: { revocationState: 'REVOKED', revokedAt: T0, revokedBy: 'owner@example.test', revocationReason: 'X' },
    });
    const revoked = await deps.executionPreflight({ id: 't1', dedupeKey: 'task:recovery:LOGISTICS:x', organizationId: 'org-A' });
    expect(revoked.allowed).toBe(false);
    expect(revoked.reason).toBe(RECOVERY_PREFLIGHT_DENY.AUTHORIZATION_REVOKED);
  });

  it('C2-4 读端口组织隔离：跨租户输入被 adapter 拒绝（TENANT_MISMATCH）', async () => {
    const ports = createPrismaRecoveryReadPorts(prisma, { organizationId: 'org-A', role: 'OWNER' });
    await expect(
      ports.opportunityRead({ organizationId: 'org-B', opportunityRef: 'opp-x' }),
    ).rejects.toThrow(/TENANT_MISMATCH/);
    await expect(
      ports.evidenceRead({ organizationId: 'org-B', opportunityRef: 'opp-x' }),
    ).rejects.toThrow(/TENANT_MISMATCH/);
  });
});
