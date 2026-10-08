/**
 * PHASE 3 之后 · 独立 `FAILURE_RECOVERY` 门禁（审计 MSG-20261009-05 第五节指定）
 * ---------------------------------------------------------------
 * 审计要求（原文要点）：优先完成独立的 FAILURE_RECOVERY 门禁，重点验证
 *   · 真实在飞任务中断；· 租约过期接管；· 进程恢复；· 数据库断连；· 重复外部副作用防护。
 * 约束（原文）：**必须使用真实运行时路径**，**不得以人工直接修改任务终态替代恢复流程**；
 *   可以在隔离 PostgreSQL 环境执行（本文件用真实 PG；DB 断连项用**派生不可达 URL** 注入）。
 *
 * 与 R9 的区别（审计方明确）：R9 的 soak 用的是**空闲 worker 重启**，**不能**替代真实在飞任务 kill / 断连 / 断电恢复 ——
 * 本文件补上这个缺口：进程在**持有在飞任务**时停止（不 settle、不投裁决），随后由**既有恢复路径**接管。
 *
 * 测试参数说明：为在测试内观察到租约自然到期，本文件使用**较短的租约 TTL（3 秒）**；
 * 这是审计在 MSG-20261009-03 中为 hook-level 测试建议的参数区间（5–10s 同量级），
 * **不是**用缩短 TTL 掩盖预租缺陷（那条约束针对的是把预租真空期藏起来）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createRecoveryDomainOutcomeRecorder } from '../runtime/recovery-domain-outcome-recorder';
import { createProductionRecoveryPackDeps } from '../runtime/recovery-si-production-composition';
import { composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createRecoveryVerdictSettlement } from '../runtime/recovery-verdict-settlement';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

import { testDatabaseMarker, unreachableDatabaseUrl } from './si-rsi-test-db.helper';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
const ORG = 'fr-org';
const LEASE_MS = 3_000; // 仅测试场景（审计建议区间）
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const draft = (dedupeKey: string): GoalTaskDraft => ({
  domain: 'LOGISTICS',
  dedupeKey,
  candidateActions: [],
  autoExecutableActions: [],
  blockedActions: [],
  executionMode: 'AUTO_WHEN_AUTHORIZED',
  requiresStandingAuthorizationForAutoExecution: true,
});

async function seedTenant(): Promise<void> {
  await prisma.organization.upsert({ where: { id: ORG }, create: { id: ORG, name: ORG, slug: ORG }, update: {} });
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.standingAuthorization.create({
    data: {
      organizationId: ORG,
      platformAccountId: 'acct-fr',
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
      consentEvidenceRef: 'evidence://fr-seed',
      scopeDigest: 'a'.repeat(64),
      revocationState: 'ACTIVE',
      createdAt: T0,
    },
  });
}

async function seedOpportunity(opportunityRef: string): Promise<void> {
  await prisma.recoveryOpportunity.create({
    data: {
      id: opportunityRef,
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'FEDEX',
      status: 'DETECTED',
      opportunityType: 'RATE_DISCREPANCY',
      title: 'fr ' + opportunityRef,
      amountExpected: '100.0000',
      amountActual: '150.0000',
      recoverableAmount: '50.0000',
      currency: 'USD',
      detectedAt: T0,
      createdAt: T0,
    },
  });
}

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AutonomyLease", "AutonomyTask", "AutonomyIncident", "AuditLog", "RecoveryOpportunity" CASCADE;',
  );
}

async function admitTask(): Promise<{ key: string; opportunityRef: string }> {
  const opportunityRef = suffix();
  await seedOpportunity(opportunityRef);
  const key = 'task:recovery:LOGISTICS:' + opportunityRef;
  await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });
  return { key, opportunityRef };
}

/** 真实运行时路径组装（与生产同构；owner 可切换，用于"新进程接管"） */
async function composeRuntime(ownerRef: string, readCounts: Map<string, number>) {
  let verdictSeq = 0;
  const packDeps = createProductionRecoveryPackDeps({ prisma });
  const readPorts = {
    ...packDeps.readPorts,
    async opportunityRead(portInput: { organizationId: string; opportunityRef: string }) {
      readCounts.set(portInput.opportunityRef, (readCounts.get(portInput.opportunityRef) ?? 0) + 1);
      return packDeps.readPorts.opportunityRead(portInput);
    },
  };
  const taskSource = createAutonomyTaskSource({ prisma, ownerRef, leaseMs: LEASE_MS });
  const settlement = createRecoveryVerdictSettlement({ prisma, taskSource, ownerRef });
  const composition = await composeRsiRuntime({
    readFile: async (path: string) => {
      if (path !== 'mem://verdict') return '[]';
      verdictSeq += 1;
      return JSON.stringify({ messageId: `${ownerRef}-msg-${verdictSeq}`, verdict: 'PASS' });
    },
    verdictPath: 'mem://verdict',
    verdictWatch: { intervalMs: 10_000 },
    intervalMs: 50,
    runtimeOwnerRef: ownerRef,
    taskSource,
    productRecoveryPack: { ...packDeps, readPorts },
    recoveryVerdictSettlement: settlement,
    onDomainPackEvidence: (record) =>
      createRecoveryDomainOutcomeRecorder({ prisma }).record(record).then(() => undefined),
  });
  return { composition, taskSource, settlement };
}

const appliedCount = (taskId: string) =>
  prisma.auditLog.count({ where: { organizationId: ORG, action: 'RECOVERY_SETTLEMENT_APPLIED', entityId: taskId } });

const externalWriteRows = async (): Promise<number> => {
  const counts = await Promise.all([
    prisma.claim.count({ where: { organizationId: ORG } }),
    prisma.payment.count({ where: { organizationId: ORG } }),
    prisma.settlement.count({ where: { organizationId: ORG } }),
    prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } }),
    prisma.billingInvoice.count({ where: { organizationId: ORG } }),
    prisma.platformWriteAttempt.count({ where: { organizationId: ORG } }),
  ]);
  return counts.reduce((total, n) => total + n, 0);
};

beforeEach(async () => {
  await truncateAll();
  await seedTenant();
});

afterAll(async () => {
  await truncateAll();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.$disconnect();
});

describe('PHASE 3 之后 · FAILURE_RECOVERY 门禁（真实运行时路径）', () => {
  it('FR-1/2/5 真实在飞任务中断：进程持有在飞任务时"死亡"⇒ 租约过期后新进程接管并收口，且零重复外部副作用', async () => {
    const { key, opportunityRef } = await admitTask();
    const readCounts = new Map<string, number>();

    // 进程 A：认领并在飞（真实运行时路径）
    const ownerA = 'fr-owner-a';
    const runtimeA = await composeRuntime(ownerA, readCounts);
    const claimedA = await runtimeA.composition.controller.tick();
    expect(claimedA.claimed?.dedupeKey).toBe(key);
    const taskId = claimedA.claimed!.id;
    expect(readCounts.get(opportunityRef)).toBe(1); // domain step 已执行一次

    // **真实在飞中断**：直接停止进程 A（不 settle、不投裁决）—— 刻意**不**人工改任务终态
    runtimeA.composition.stop();
    const leaseAfterCrash = await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } });
    expect(leaseAfterCrash.status).toBe('ACTIVE');
    expect(leaseAfterCrash.ownerRef).toBe(ownerA);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('IN_PROGRESS');

    // 等待租约自然到期（测试参数 3s）
    await sleep(LEASE_MS + 1_000);

    // 进程 B：新 owner 接管（既有 reclaimExpired + claim + fencing 路径，无人工改终态）
    const ownerB = 'fr-owner-b';
    const runtimeB = await composeRuntime(ownerB, readCounts);
    try {
      const claimedB = await runtimeB.composition.controller.tick();
      expect(claimedB.claimed?.dedupeKey).toBe(key);
      expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).ownerRef).toBe(ownerB);
      await runtimeB.composition.verdictWatcher!.pollOnce(); // PASS → 运行时自动 fenced settle
    } finally {
      runtimeB.composition.stop();
    }

    // 收口结果：终态 + 租约 RELEASED + 恰好 1 条 APPLIED
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('BLOCKED');
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).status).toBe('RELEASED');
    expect(await appliedCount(taskId)).toBe(1);

    // 旧 owner（进程 A 复活）不得覆盖新 owner 的结果（既有 fencing）
    const staleSettle = await runtimeA.taskSource.settle({ taskId, ownerRef: ownerA, outcome: 'BLOCKED' });
    expect(staleSettle.applied).toBe(false);
    /**
     * 拒绝原因取决于它到达时租约处于哪个状态：新 owner 已完成收口 ⇒ 租约已 RELEASED（`LEASE_NOT_ACTIVE`）；
     * 若新 owner 只是接管而未收口，则会命中 `FENCED_OWNER_MISMATCH`。两种都属于"旧 owner 不得覆盖"。
     */
    expect(String(staleSettle.reason)).toMatch(/^(FENCED_|LEASE_)/);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('BLOCKED');

    // FR-5 重复外部副作用防护：全场景零外部业务事实
    expect(await externalWriteRows()).toBe(0);
    // 如实登记：domain step 在"中断+接管"下会被执行**两次**（at-least-once；本步骤为纯只读），
    // 但审计与业务副作用均为一次（APPLIED = 1、外部事实 = 0）。
    expect(readCounts.get(opportunityRef)).toBe(2);
  });

  it('FR-3 进程恢复：多任务在崩溃后由新进程全部排空（不丢任务、不重复收口）', async () => {
    const tasks = [await admitTask(), await admitTask(), await admitTask()];
    const readCounts = new Map<string, number>();

    const runtimeA = await composeRuntime('fr-restart-a', readCounts);
    await runtimeA.composition.controller.tick(); // 认领并在飞 1 条后"死亡"
    runtimeA.composition.stop();
    await sleep(LEASE_MS + 1_000);

    const runtimeB = await composeRuntime('fr-restart-b', readCounts);
    try {
      for (let round = 0; round < 8; round += 1) {
        await runtimeB.composition.controller.tick();
        await runtimeB.composition.verdictWatcher!.pollOnce();
      }
    } finally {
      runtimeB.composition.stop();
    }

    const rows = await prisma.autonomyTask.findMany({
      where: { dedupeKey: { in: tasks.map((task) => task.key) } },
      select: { id: true, status: true },
    });
    expect(rows).toHaveLength(tasks.length);
    expect(rows.every((row) => row.status === 'BLOCKED')).toBe(true);
    for (const row of rows) expect(await appliedCount(row.id)).toBe(1);
    expect(await prisma.autonomyLease.count({ where: { status: 'ACTIVE' } })).toBe(0);
    expect(await externalWriteRows()).toBe(0);
  });

  it('FR-4 数据库断连：连接不可用时 fail-closed，durable 状态零变化，恢复后仍可继续', async () => {
    const { key } = await admitTask();
    const marker = testDatabaseMarker();
    expect(marker).not.toContain('@');

    const broken = new PrismaClient({ datasources: { db: { url: unreachableDatabaseUrl() } } });
    try {
      const brokenSource = createAutonomyTaskSource({ prisma: broken, ownerRef: 'fr-broken' });
      await expect(brokenSource.claim(5)).rejects.toThrow();
    } finally {
      await broken.$disconnect();
    }

    // durable 状态零变化（任务仍 READY、无租约）
    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key }, select: { id: true, status: true } });
    expect(task.status).toBe('READY');
    expect(await prisma.autonomyLease.count({ where: { taskId: task.id } })).toBe(0);

    // 真实连接恢复后仍可正常领取并执行（既有路径）
    const readCounts = new Map<string, number>();
    const runtime = await composeRuntime('fr-after-reconnect', readCounts);
    try {
      const claimed = await runtime.composition.controller.tick();
      expect(claimed.claimed?.dedupeKey).toBe(key);
      await runtime.composition.verdictWatcher!.pollOnce();
    } finally {
      runtime.composition.stop();
    }
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('BLOCKED');
    expect(await appliedCount(task.id)).toBe(1);
    expect(await externalWriteRows()).toBe(0);
  });
});
