/**
 * PHASE 3 / `PRELEASE_FIX_B`（审计 MSG-20261009-03，P3-1/P3-2/P3-3）
 * ---------------------------------------------------------------
 * 审计方裁决（要点）：
 *   · `handleEvent('JUDGE_VERDICT_RECEIVED')` **只**做当前任务的 durable 收口，**不得预租下一条**；
 *     下一任务由**下一次正常 tick** 领取（P3-1 / P3-2）；
 *   · 强制断言（R9 前置）：worker 完成 A 后，**不必等待 A 的租约 TTL 到期**即可领取并执行 B；
 *   · 不得用缩短租约 TTL 来掩盖预租缺陷（本文件使用**默认（长）租约**）。
 *
 * 本文件覆盖：引擎级「裁决后不预租」、watchdog 正常领取下一条、以及真实 PostgreSQL 的连续推进断言。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createRsiContinuationEngine } from '../services/autonomy/rsi-continuation-engine';
import { createRecoveryDomainOutcomeRecorder } from '../runtime/recovery-domain-outcome-recorder';
import { createProductionRecoveryPackDeps } from '../runtime/recovery-si-production-composition';
import { composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createRecoveryVerdictSettlement } from '../runtime/recovery-verdict-settlement';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
const ORG = 'prelease-org';
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

async function seedTenant(): Promise<void> {
  await prisma.organization.upsert({ where: { id: ORG }, create: { id: ORG, name: ORG, slug: ORG }, update: {} });
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.standingAuthorization.create({
    data: {
      organizationId: ORG,
      platformAccountId: 'acct-prelease',
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
      consentEvidenceRef: 'evidence://prelease-seed',
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
      title: 'prelease ' + opportunityRef,
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

describe('PHASE 3 / PRELEASE_FIX_B', () => {
  it('P3-1（引擎级）：裁决事件不再预租下一条；下一任务由正常 tick 领取', () => {
    const tasks = [
      { id: 't1', priority: 'P2' as const, dedupeKey: 'task:recovery:LOGISTICS:a' },
      { id: 't2', priority: 'P2' as const, dedupeKey: 'task:recovery:LOGISTICS:b' },
    ];
    const engine = createRsiContinuationEngine({ tasks, now: () => T0.getTime() });

    const first = engine.claimNextSafeTask();
    expect(first.claimed?.id).toBe('t1'); // 正常领取
    engine.markWaitingForVerdict('PASS'); // 停在等待裁决

    const consumed = engine.handleEvent('JUDGE_VERDICT_RECEIVED');
    expect(consumed.action).toBe('CONSUME_VERDICT');
    expect(consumed.claimed).toBeNull(); // **不预租**（旧行为会返回 t2）

    const afterVerdict = engine.watchdogTick(); // 下一次正常 tick 才领取
    expect(afterVerdict.claimed?.id).toBe('t2');
  });

  it('强制断言（真实 PostgreSQL）：完成 A 后**不必等 A 的租约 TTL** 即可领取并执行 B（默认长租约）', async () => {
    const refs = [0, 1, 2].map(() => suffix());
    const keys = refs.map((ref) => 'task:recovery:LOGISTICS:' + ref);
    for (const ref of refs) await seedOpportunity(ref);
    for (const key of keys) {
      await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });
    }

    const ownerRef = 'prelease-worker-1';
    const readCounts = new Map<string, number>();
    let verdictSeq = 0;
    const packDeps = createProductionRecoveryPackDeps({ prisma });
    const readPorts = {
      ...packDeps.readPorts,
      async opportunityRead(portInput: { organizationId: string; opportunityRef: string }) {
        readCounts.set(portInput.opportunityRef, (readCounts.get(portInput.opportunityRef) ?? 0) + 1);
        return packDeps.readPorts.opportunityRead(portInput);
      },
    };
    // 关键：**使用默认（长）租约**，不缩短 TTL（审计明确禁止用缩短 TTL 掩盖预租缺陷）
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

    const rounds: string[] = [];
    try {
      for (let round = 1; round <= 4; round += 1) {
        const outcome = await composition.controller.tick();
        const polled = await composition.verdictWatcher!.pollOnce();
        const statuses = (
          await prisma.autonomyTask.findMany({ where: { dedupeKey: { in: keys } }, select: { status: true } })
        )
          .map((row) => row.status)
          .sort()
          .join(',');
        rounds.push(`round=${round} claimed=${outcome.claimed === null || outcome.claimed === undefined ? 'none' : 'yes'} delivered=${String(polled.delivered)} statuses=${statuses}`);
      }
    } finally {
      composition.stop();
    }

    // 三个任务必须在**3 轮内**全部收口（若仍等租约 TTL，3 轮内不可能完成）
    const terminal = await prisma.autonomyTask.count({
      where: { dedupeKey: { in: keys }, status: 'BLOCKED' },
    });
    expect(terminal, rounds.join(' | ')).toBe(keys.length);
    // 每任务 domain step 恰好一次（未因预租/重复调度重复执行）
    expect([...readCounts.values()]).toEqual([1, 1, 1]);
    // 租约全部释放，无残留 ACTIVE
    expect(await prisma.autonomyLease.count({ where: { status: 'ACTIVE' } })).toBe(0);
    // 每个任务恰好 1 条 INTENT + 1 条 APPLIED
    const rows = await prisma.autonomyTask.findMany({ where: { dedupeKey: { in: keys } }, select: { id: true } });
    for (const row of rows) {
      expect(
        await prisma.auditLog.count({
          where: { organizationId: ORG, action: 'RECOVERY_SETTLEMENT_INTENT', entityId: row.id },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { organizationId: ORG, action: 'RECOVERY_SETTLEMENT_APPLIED', entityId: row.id },
        }),
      ).toBe(1);
    }
  });

  it('P3-3：正常 claim 后刷新（租约仍 ACTIVE）不改变既有恢复语义（reclaimExpired 仍可接管）', async () => {
    const ref = suffix();
    await seedOpportunity(ref);
    const key = 'task:recovery:LOGISTICS:' + ref;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });

    const ownerRef = 'prelease-worker-2';
    const source = createAutonomyTaskSource({ prisma, ownerRef, now: () => T0 });
    expect((await source.claim(5)).map((task) => task.dedupeKey)).toEqual([key]);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
    // 模拟「正常 claim 后、执行前崩溃」：租约到期后由既有 reclaimExpired + fencing 接管（不被本修复影响）
    await prisma.autonomyLease.update({
      where: { taskId },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });
    const nextOwner = createAutonomyTaskSource({ prisma, ownerRef: 'prelease-worker-3', now: () => T0 });
    expect((await nextOwner.reclaimExpired(5)).length).toBe(1);
    expect((await nextOwner.claim(5)).map((task) => task.dedupeKey)).toEqual([key]);
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).ownerRef).toBe('prelease-worker-3');
  });
});
