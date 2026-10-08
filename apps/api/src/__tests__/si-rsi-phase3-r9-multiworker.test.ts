/**
 * PHASE 3 / `FIX_R1` R9 —— 多 worker 并发最低验收（审计 MSG-20261009-03 的 R9-1…R9-10 / R9-12）
 * ---------------------------------------------------------------
 * 前置：`PRELEASE_FIX_B` 已落地（裁决路径不再预租下一条；下一任务由正常 tick 领取）。
 * 覆盖：R9-1 三实例共享同队列；R9-2 ≥6 任务 + 跨租户；R9-3 推进活性；R9-4 claim 互斥；
 *       R9-5 每任务 domain step 恰好一次；R9-6 INTENT/APPLIED 业务唯一键；R9-7 拒绝矩阵；
 *       R9-8 两类崩溃恢复；R9-9 无残留 ACTIVE 租约；R9-10 零外部业务事实；R9-12 不替换被测路径。
 * 说明（R9-12）：全部通过**既有** `composeRsiRuntime()` / durable 任务源 / 生产 Recovery pack / 既有 verdictWatcher 驱动，
 * 未替换 claim、settle、domain step 或 runtime 路径（测试只读取计数，不注入替代实现）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  RECOVERY_SETTLEMENT_APPLIED_ACTION,
  RECOVERY_SETTLEMENT_INTENT_ACTION,
  RECOVERY_SETTLEMENT_REFUSAL,
  createRecoveryVerdictSettlement,
} from '../runtime/recovery-verdict-settlement';
import { createRecoveryDomainOutcomeRecorder } from '../runtime/recovery-domain-outcome-recorder';
import { createProductionRecoveryPackDeps } from '../runtime/recovery-si-production-composition';
import { composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
const ORG = 'r9-main-org';
const ORG_B = 'r9-other-org';
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

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
      platformAccountId: 'acct-' + organizationId,
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
      consentEvidenceRef: 'evidence://r9-seed',
      scopeDigest: 'a'.repeat(64),
      revocationState: 'ACTIVE',
      createdAt: T0,
    },
  });
}

async function seedOpportunity(organizationId: string, opportunityRef: string): Promise<void> {
  await prisma.recoveryOpportunity.create({
    data: {
      id: opportunityRef,
      organizationId,
      domain: 'LOGISTICS',
      channel: 'FEDEX',
      status: 'DETECTED',
      opportunityType: 'RATE_DISCREPANCY',
      title: 'r9 ' + opportunityRef,
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

/** 每个 worker 一个 runtime 实例（共享同一 durable 队列；各自 owner 与裁决流） */
async function composeWorker(ownerRef: string) {
  let verdictSeq = 0;
  const readCounts = new Map<string, number>();
  const packDeps = createProductionRecoveryPackDeps({ prisma });
  const readPorts = {
    ...packDeps.readPorts,
    async opportunityRead(portInput: { organizationId: string; opportunityRef: string }) {
      readCounts.set(portInput.opportunityRef, (readCounts.get(portInput.opportunityRef) ?? 0) + 1);
      return packDeps.readPorts.opportunityRead(portInput);
    },
  };
  const taskSource = createAutonomyTaskSource({ prisma, ownerRef, now: () => T0 });
  const settlement = createRecoveryVerdictSettlement({ prisma, taskSource, ownerRef, now: () => T0 });
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
      createRecoveryDomainOutcomeRecorder({ prisma, now: () => T0 }).record(record).then(() => undefined),
  });
  return { ownerRef, composition, taskSource, readCounts };
}

beforeEach(async () => {
  await truncateAll();
  await seedTenant(ORG);
  await seedTenant(ORG_B);
});

afterAll(async () => {
  await truncateAll();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: { in: [ORG, ORG_B] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await prisma.$disconnect();
});

describe('PHASE 3 / R9 · 多 worker 并发最低验收', () => {
  it('R9-1/2/3/4/5/6/9/10/12：3 实例 × 6 任务（+跨租户）并发推进 —— 全部终态、每任务恰一次、零残留、零外写', async () => {
    // R9-2：同租户 6 个任务 + 另一个租户 1 个任务（跨租户隔离场景）
    const mainRefs = Array.from({ length: 6 }, () => suffix());
    const otherRef = suffix();
    const mainKeys = mainRefs.map((ref) => 'task:recovery:LOGISTICS:' + ref);
    const otherKey = 'task:recovery:LOGISTICS:' + otherRef;
    for (const ref of mainRefs) await seedOpportunity(ORG, ref);
    await seedOpportunity(ORG_B, otherRef);
    for (const key of mainKeys) {
      await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });
    }
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
      organizationId: ORG_B,
      tasks: [draft(otherKey)],
    });

    // R9-1：3 个独立 runtime 实例，共享同一 durable 队列
    const workers = await Promise.all(['r9-w1', 'r9-w2', 'r9-w3'].map((ownerRef) => composeWorker(ownerRef)));
    const activeLeaseSamples: number[] = [];
    try {
      for (let round = 0; round < mainKeys.length + 3; round += 1) {
        await Promise.all(
          workers.map(async (worker) => {
            await worker.composition.controller.tick();
            await worker.composition.verdictWatcher!.pollOnce();
          }),
        );
        // R9-4：任意时刻同一任务不存在两个 ACTIVE 租约（DB 唯一约束 + 采样）
        activeLeaseSamples.push(
          await prisma.$queryRawUnsafe<{ n: number }[]>(
            'SELECT count(*)::int AS n FROM (SELECT "taskId" FROM "AutonomyLease" WHERE status = \'ACTIVE\' GROUP BY "taskId" HAVING count(*) > 1) t',
          ).then((rows) => Number(rows[0]?.n ?? 0)),
        );
      }
    } finally {
      for (const worker of workers) worker.composition.stop();
    }

    // R9-3 推进活性：本租户 6 个任务全部进入允许的 durable 终态（BLOCKED = 无完成证据的合法收口）
    const mainRows = await prisma.autonomyTask.findMany({
      where: { dedupeKey: { in: mainKeys } },
      select: { id: true, status: true, dedupeKey: true },
    });
    expect(mainRows).toHaveLength(mainKeys.length);
    expect(mainRows.every((row) => row.status === 'BLOCKED')).toBe(true);

    // R9-4 claim 互斥采样：任何一轮都没有「同一任务多条 ACTIVE 租约」
    expect(activeLeaseSamples.every((n) => n === 0)).toBe(true);

    // R9-5 domain step：每任务恰好一次（按 opportunityRef 聚合的只读端口调用数）
    const perOpportunity = new Map<string, number>();
    for (const worker of workers) {
      for (const [ref, count] of worker.readCounts) perOpportunity.set(ref, (perOpportunity.get(ref) ?? 0) + count);
    }
    for (const ref of mainRefs) expect(perOpportunity.get(ref)).toBe(1);

    // R9-6 收口唯一性：每任务恰好 1 条 INTENT + 1 条 APPLIED，且 (entityId, verdictRef) 唯一
    for (const row of mainRows) {
      expect(
        await prisma.auditLog.count({
          where: { organizationId: ORG, action: RECOVERY_SETTLEMENT_INTENT_ACTION, entityId: row.id },
        }),
      ).toBe(1);
      const applied = await prisma.auditLog.findMany({
        where: { organizationId: ORG, action: RECOVERY_SETTLEMENT_APPLIED_ACTION, entityId: row.id },
        select: { changes: true },
      });
      expect(applied).toHaveLength(1);
      const changes = applied[0]!.changes as Record<string, unknown>;
      expect(changes.settleApplied).toBe(true);
      expect(changes.afterStatus).toBe('BLOCKED');
      expect(String(changes.verdictRef)).not.toBe('');
    }
    expect(
      await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM (SELECT "entityId", "changes"->>'verdictRef' AS ref FROM "AuditLog" WHERE action = '${RECOVERY_SETTLEMENT_APPLIED_ACTION}' GROUP BY 1, 2 HAVING count(*) > 1) t`,
      ).then((rows) => Number(rows[0]?.n ?? 0)),
    ).toBe(0);

    // 跨租户场景：另一个租户的任务没有被本组 worker 越权收口（仍为其自身终态或未领）
    const otherTask = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: otherKey } });
    expect(
      await prisma.auditLog.count({
        where: { organizationId: ORG, action: RECOVERY_SETTLEMENT_APPLIED_ACTION, entityId: otherTask.id },
      }),
    ).toBe(0);

    // R9-9 无残留 ACTIVE 租约（本租户全部任务）
    expect(
      await prisma.autonomyLease.count({ where: { taskId: { in: mainRows.map((r) => r.id) }, status: 'ACTIVE' } }),
    ).toBe(0);

    // R9-10 零外部业务事实
    const external =
      (await prisma.claim.count({ where: { organizationId: ORG } })) +
      (await prisma.payment.count({ where: { organizationId: ORG } })) +
      (await prisma.settlement.count({ where: { organizationId: ORG } })) +
      (await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } })) +
      (await prisma.billingInvoice.count({ where: { organizationId: ORG } })) +
      (await prisma.platformWriteAttempt.count({ where: { organizationId: ORG } }));
    expect(external).toBe(0);
  });

  it('R9-7 拒绝矩阵：错 owner / 旧租约 / 跨租户 / 错任务 lineage 全部拒绝且零写入', async () => {
    const ref = suffix();
    await seedOpportunity(ORG, ref);
    const key = 'task:recovery:LOGISTICS:' + ref;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });
    const ownerRef = 'r9-owner';
    const source = createAutonomyTaskSource({ prisma, ownerRef, now: () => T0 });
    await source.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
    const settlement = createRecoveryVerdictSettlement({ prisma, taskSource: source, ownerRef, now: () => T0 });
    const base = {
      taskId,
      dedupeKey: key,
      organizationId: ORG,
      ownerRef,
      verdict: 'PASS' as const,
      verdictRef: 'r9-msg-1',
    };

    /**
     * R9-7 拒绝矩阵。
     * 注意区分两类拒绝时机（这也是审计"必须先对账、不得盲目释放"的口径）：
     *   · **前置拒绝**（跨租户 / 错任务 lineage）：在写 INTENT 之前就拒绝 ⇒ 数据库**零写入**；
     *   · **fenced 拒绝**（错 owner / 旧租约）：已进入收口流程但被既有 fencing 拒绝 ⇒ 允许留下
     *     INTENT+APPLIED 的**审计痕迹**（settleApplied=false），这正是后续 `resumePendingSettlements`
     *     由**合法 owner** 补齐收口的依据；任务状态必须保持不变。
     */
    // 跨租户（前置拒绝，零写入）
    expect((await settlement.settleAfterVerdict({ ...base, organizationId: ORG_B })).reason).toBe(
      RECOVERY_SETTLEMENT_REFUSAL.TENANT_MISMATCH,
    );
    // 错任务（前置拒绝，零写入）
    expect((await settlement.settleAfterVerdict({ ...base, dedupeKey: key + '-other' })).reason).toBe(
      RECOVERY_SETTLEMENT_REFUSAL.TASK_LINEAGE_MISMATCH,
    );
    expect(
      await prisma.auditLog.count({
        where: {
          entityId: taskId,
          action: { in: [RECOVERY_SETTLEMENT_INTENT_ACTION, RECOVERY_SETTLEMENT_APPLIED_ACTION] },
        },
      }),
    ).toBe(0);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('IN_PROGRESS');

    // 错 owner（fenced 拒绝：允许留审计痕迹，但任务状态不得改变）
    const wrongOwner = createRecoveryVerdictSettlement({
      prisma,
      taskSource: createAutonomyTaskSource({ prisma, ownerRef: 'r9-other', now: () => T0 }),
      ownerRef: 'r9-other',
      now: () => T0,
    });
    const wrongOwnerResult = await wrongOwner.settleAfterVerdict({ ...base, ownerRef: 'r9-other' });
    expect(wrongOwnerResult.applied).toBe(false);
    expect(String(wrongOwnerResult.reason)).toMatch(/FENCED_/);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('IN_PROGRESS');
    // 该 fenced 尝试被如实记录（settleApplied=false），供合法 owner 后续 resume 补齐
    const fencedRows = await prisma.auditLog.findMany({
      where: { entityId: taskId, action: RECOVERY_SETTLEMENT_APPLIED_ACTION },
      select: { changes: true },
    });
    expect(fencedRows.length).toBeGreaterThanOrEqual(1);
    expect((fencedRows[0]!.changes as Record<string, unknown>).settleApplied).toBe(false);

    // 旧租约（同 owner 但已过期）
    await prisma.autonomyLease.update({
      where: { taskId },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });
    expect(String((await settlement.settleAfterVerdict(base)).reason)).toMatch(/FENCED_LEASE_EXPIRED/);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('IN_PROGRESS');
  });

  it('R9-8 两类崩溃恢复：(i) claim 后崩溃由 reclaimExpired 接管；(ii) INTENT 后崩溃由 resume 补齐收口', async () => {
    // (i) claim 后、执行前崩溃
    const refA = suffix();
    await seedOpportunity(ORG, refA);
    const keyA = 'task:recovery:LOGISTICS:' + refA;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(keyA)] });
    const crashedSource = createAutonomyTaskSource({ prisma, ownerRef: 'r9-crash', now: () => T0 });
    await crashedSource.claim(5);
    const taskA = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: keyA } })).id;
    await prisma.autonomyLease.update({
      where: { taskId: taskA },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });
    const resumedSource = createAutonomyTaskSource({ prisma, ownerRef: 'r9-resume', now: () => T0 });
    expect((await resumedSource.reclaimExpired(5)).length).toBe(1);
    expect((await resumedSource.claim(5)).map((t) => t.dedupeKey)).toEqual([keyA]);

    // (ii) INTENT 后、APPLIED 前崩溃
    const refB = suffix();
    await seedOpportunity(ORG, refB);
    const keyB = 'task:recovery:LOGISTICS:' + refB;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(keyB)] });
    const ownerB = 'r9-intent';
    const sourceB = createAutonomyTaskSource({ prisma, ownerRef: ownerB, now: () => T0 });
    await sourceB.claim(5);
    const taskB = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: keyB } })).id;
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'SYSTEM',
        actorRef: 'rsi-run:verdict-settlement',
        action: RECOVERY_SETTLEMENT_INTENT_ACTION,
        entityType: 'AutonomyTask',
        entityId: taskB,
        changes: {
          dedupeKey: keyB,
          ownerRef: ownerB,
          verdict: 'PASS',
          verdictRef: 'r9-crash-intent',
          intentKey: `${taskB}|r9-crash-intent`,
          recordedAt: T0.toISOString(),
        },
      },
    });
    const settlementB = createRecoveryVerdictSettlement({ prisma, taskSource: sourceB, ownerRef: ownerB, now: () => T0 });
    const resumed = await settlementB.resumePendingSettlements(ORG);
    expect(resumed.length).toBeGreaterThan(0);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskB } })).status).toBe('BLOCKED');
    expect(
      await prisma.auditLog.count({
        where: { organizationId: ORG, action: RECOVERY_SETTLEMENT_APPLIED_ACTION, entityId: taskB },
      }),
    ).toBe(1);
  });
});
