/**
 * AUDIT-RC-1 CHANGE 3 —— RSI durable reconcile 接线契约（MSG-20261008-14）
 * ---------------------------------------------------------------
 * 覆盖三件事：
 *   ① 纯决策矩阵（无 DB）：何时接线、何时 fail-closed、ownerRef 来源；
 *   ② 静态接线证据：rsi-run 直跑入口**确实**把 store 传进 composeRsiRuntime，
 *      且没有任何内存队列冒充持久化的分支；
 *   ③ 真实 PostgreSQL：用与生产入口完全相同的 openPrismaReconcile() 打开 store，
 *      验证「过期租约 → EXPIRED + 任务回 READY」以及重复运行的幂等。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  RSI_RUN_BOOTSTRAP_BOUNDARY,
  openPrismaReconcile,
  planReconcileBootstrap,
} from '../runtime/rsi-run-bootstrap';
import { runRsiRestartReconcile } from '../runtime/rsi-restart-reconcile';

const prisma = new PrismaClient();
const NOW = '2026-10-08T09:00:00.000Z';
const DEFAULT_OWNER = 'rsi-runtime:00000000-0000-4000-8000-000000000000:4242';
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

const rsiRunSource = readFileSync(
  path.join(__dirname, '..', 'runtime', 'rsi-run.ts'),
  'utf8',
);

async function truncateAutonomy(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AutonomyMetricResult", "AutonomyRollbackRecord", "AutonomyPromotionDecision", "AutonomyEvaluationRun", "AutonomyCandidate", "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncateAutonomy();
});

afterAll(async () => {
  await truncateAutonomy();
  await prisma.$disconnect();
});

async function seedExpiredLeaseTask(): Promise<{ taskId: string }> {
  const incident = await prisma.autonomyIncident.create({
    data: {
      kind: 'CI_RED',
      dedupeKey: 'INC:' + suffix(),
      status: 'OPEN',
      riskClass: 'LOW',
      sourceRefs: [{ ref: 'ci/run/' + suffix() }],
      detectedAt: new Date('2026-10-08T07:00:00.000Z'),
    },
  });
  const task = await prisma.autonomyTask.create({
    data: {
      incidentId: incident.id,
      status: 'IN_PROGRESS',
      riskClass: 'LOW',
      ownerGateRequired: false,
      dedupeKey: 'TASK:' + suffix(),
    },
  });
  await prisma.autonomyLease.create({
    data: {
      taskId: task.id,
      ownerRef: 'runtime-A',
      acquiredAt: new Date('2026-10-08T07:00:00.000Z'),
      renewedAt: new Date('2026-10-08T07:10:00.000Z'),
      // 早于 NOW ⇒ 已过期，必须被 reconcile 收敛
      expiresAt: new Date('2026-10-08T07:30:00.000Z'),
      status: 'ACTIVE',
    },
  });
  return { taskId: task.id };
}

describe('CHANGE 3 · planReconcileBootstrap（纯决策，无 DB）', () => {
  it('01 DATABASE_URL 存在 ⇒ PRISMA，且 ownerRef 取进程默认身份', () => {
    const decision = planReconcileBootstrap(
      { DATABASE_URL: 'postgresql://user:pass@db:5432/x' },
      { defaultOwnerRef: DEFAULT_OWNER },
    );
    expect(decision.kind).toBe('PRISMA');
    expect(decision.ownerRef).toBe(DEFAULT_OWNER);
    expect(decision.trigger).toBe('BOOT');
    expect(decision.reason).toBe('DATABASE_URL_PRESENT');
  });

  it('02 显式 RSI_RUNTIME_OWNER_REF 优先于进程默认身份（trim 后使用）', () => {
    const decision = planReconcileBootstrap(
      { DATABASE_URL: 'postgresql://u:p@db:5432/x', RSI_RUNTIME_OWNER_REF: '  host-a:worker-7  ' },
      { defaultOwnerRef: DEFAULT_OWNER },
    );
    expect(decision.kind).toBe('PRISMA');
    expect(decision.ownerRef).toBe('host-a:worker-7');
  });

  it('03 缺 DATABASE_URL 且 RSI_RECONCILE_REQUIRED=true ⇒ 拒绝启动（fail-closed）', () => {
    const decision = planReconcileBootstrap(
      { RSI_RECONCILE_REQUIRED: 'true' },
      { defaultOwnerRef: DEFAULT_OWNER },
    );
    expect(decision.kind).toBe('REQUIRED_BUT_MISSING_DATABASE_URL');
    expect(decision.reason).toBe('RSI_RECONCILE_REQUIRED_WITHOUT_DATABASE_URL');
  });

  it('04 缺 DATABASE_URL 且未要求 reconcile ⇒ NOT_CONFIGURED（不伪造接线）', () => {
    for (const env of [{}, { RSI_RECONCILE_REQUIRED: 'false' }, { DATABASE_URL: '   ' }]) {
      const decision = planReconcileBootstrap(env, { defaultOwnerRef: DEFAULT_OWNER });
      expect(decision.kind).toBe('NOT_CONFIGURED');
      expect(decision.reason).toBe('NO_DATABASE_URL_AND_NOT_REQUIRED');
    }
  });

  it('05 边界常量：不新建运行时 / 不用内存队列兜底 / fail-closed', () => {
    expect(RSI_RUN_BOOTSTRAP_BOUNDARY).toMatchObject({
      createsScheduler: false,
      createsController: false,
      createsRunner: false,
      reusesExistingSiRuntime: true,
      reusesExistingReconcileStore: 'createPrismaRsiReconcileStore',
      createsSecondReconcileStore: false,
      inMemoryQueueAsFallback: false,
      failClosedWhenRequired: true,
      readsCredentials: false,
      performsNetworkCalls: false,
      externalWrite: false,
    });
  });
});

describe('CHANGE 3 · rsi-run 直跑入口的静态接线证据', () => {
  it('06 入口使用 planReconcileBootstrap 决策并把 spec 传给 composeRsiRuntime', () => {
    expect(rsiRunSource).toContain("from './rsi-run-bootstrap'");
    expect(rsiRunSource).toContain('planReconcileBootstrap(process.env');
    expect(rsiRunSource).toContain('openPrismaReconcile(reconcileDecision.ownerRef)');
    expect(rsiRunSource).toContain('{ reconcile: openedReconcile.spec }');
  });

  it('07 缺 DATABASE_URL 而要求 reconcile 时拒绝启动（不是静默降级）', () => {
    expect(rsiRunSource).toContain('REQUIRED_BUT_MISSING_DATABASE_URL');
    expect(rsiRunSource).toContain('REQUIRED_BUT_NO_DATABASE_URL');
    expect(rsiRunSource).toContain('process.exit(1)');
  });

  it('08 入口不得用内存 store 兜底（无 createRsiInMemoryReconcileStore 引用）', () => {
    expect(rsiRunSource).not.toContain('createRsiInMemoryReconcileStore');
  });

  it('09 优雅停止：停止时收敛 DB 连接', () => {
    expect(rsiRunSource).toContain('openedReconcile.disconnect()');
  });
});

describe('CHANGE 3 · 生产同源 store 的真实 PostgreSQL 收敛（openPrismaReconcile）', () => {
  it('10 过期租约 → EXPIRED + 任务回 READY；重复运行幂等（无额外写入）', async () => {
    const { taskId } = await seedExpiredLeaseTask();
    const opened = await openPrismaReconcile(DEFAULT_OWNER);
    try {
      const first = await runRsiRestartReconcile({
        store: opened.spec.store,
        ownerRef: opened.spec.ownerRef,
        trigger: opened.spec.trigger,
        now: () => NOW,
      });
      expect(first.expiredLeaseIds).toHaveLength(1);
      expect(first.recoveredTaskIds).toEqual([taskId]);
      expect(first.idempotentNoop).toBe(false);

      const lease = await prisma.autonomyLease.findFirstOrThrow({ where: { taskId } });
      expect(lease.status).toBe('EXPIRED');
      const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.status).toBe('READY');

      // 第二次（模拟重启再次收敛）必须 0 行变化
      const second = await runRsiRestartReconcile({
        store: opened.spec.store,
        ownerRef: opened.spec.ownerRef,
        trigger: 'RESTART',
        now: () => NOW,
      });
      expect(second.idempotentNoop).toBe(true);
      expect(second.expiredLeaseIds).toEqual([]);
      expect(second.recoveredTaskIds).toEqual([]);
      expect((await prisma.autonomyLease.findFirstOrThrow({ where: { taskId } })).status).toBe('EXPIRED');
      expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('READY');
    } finally {
      await opened.disconnect();
    }
  });

  it('11 未过期租约（另一实例仍在运行）→ 不动，且 idempotentNoop=true', async () => {
    const incident = await prisma.autonomyIncident.create({
      data: {
        kind: 'CI_RED',
        dedupeKey: 'INC:' + suffix(),
        status: 'OPEN',
        riskClass: 'LOW',
        sourceRefs: [{ ref: 'ci/run/' + suffix() }],
        detectedAt: new Date('2026-10-08T07:00:00.000Z'),
      },
    });
    const task = await prisma.autonomyTask.create({
      data: {
        incidentId: incident.id,
        status: 'IN_PROGRESS',
        riskClass: 'LOW',
        ownerGateRequired: false,
        dedupeKey: 'TASK:' + suffix(),
      },
    });
    await prisma.autonomyLease.create({
      data: {
        taskId: task.id,
        ownerRef: 'runtime-other',
        acquiredAt: new Date('2026-10-08T08:50:00.000Z'),
        renewedAt: new Date('2026-10-08T08:55:00.000Z'),
        expiresAt: new Date('2026-10-08T09:30:00.000Z'), // 晚于 NOW ⇒ 仍有效
        status: 'ACTIVE',
      },
    });

    const opened = await openPrismaReconcile(DEFAULT_OWNER);
    try {
      const plan = await runRsiRestartReconcile({
        store: opened.spec.store,
        ownerRef: opened.spec.ownerRef,
        now: () => NOW,
      });
      expect(plan.heldActiveLeaseIds).toHaveLength(1);
      expect(plan.idempotentNoop).toBe(true);
      expect((await prisma.autonomyLease.findFirstOrThrow({ where: { taskId: task.id } })).status).toBe('ACTIVE');
      expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('IN_PROGRESS');
    } finally {
      await opened.disconnect();
    }
  });
});
