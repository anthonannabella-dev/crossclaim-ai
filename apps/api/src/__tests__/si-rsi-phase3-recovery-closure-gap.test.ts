/**
 * PHASE 3（审计 MSG-20261009-01 的稳定性项）—— Recovery 任务的「裁决 → durable 收口」缺口特征化
 * ---------------------------------------------------------------
 * 背景（本轮实测发现）：ONE SI Runtime 对 recovery-domain 任务**强制 park-for-judge**；
 * 引擎在收到 PASS 裁决后只是**在内存里**完成该任务，**不会**把 durable `AutonomyTask` 收口。
 * 本文件把该行为**确定性地**固定下来（特征化测试），并证明可用的收口路径，供 hour-level soak 与
 * PHASE 3 生产验证使用。
 *
 * 为什么要固定它：若没有 durable 收口，租约到期后 `reclaimExpired()` 会把同一任务放回 READY，
 * 于是**同一个任务会被再次领取并再次执行 domain step**（每次都产生新 evidenceRef 的审计行）。
 * 这在 soak/生产中意味着「已完成裁决的任务被重复执行」，必须显式可见、且必须有余量可关闭。
 *
 * 本文件不新增任何 runtime/scheduler/controller：全部通过既有 `composeRsiRuntime()` 与既有
 * `verdictWatcher`（内存裁决工件 `mem://verdict`，格式与 PHASE 10 测试一致）驱动。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createRecoveryDomainOutcomeRecorder } from '../runtime/recovery-domain-outcome-recorder';
import { createProductionRecoveryPackDeps } from '../runtime/recovery-si-production-composition';
import { composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
const ORG = 'gap-org';
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);
const AUDIT_ACTION = 'RECOVERY_DOMAIN_STEP_EXECUTED';

/** domain step 结果钩子的入参类型（直接从组合根签名推导，避免手写漂移） */
type DomainStepEvidence = Parameters<
  NonNullable<Parameters<typeof composeRsiRuntime>[0]['onDomainPackEvidence']>
>[0];

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
  await prisma.organization.upsert({
    where: { id: ORG },
    create: { id: ORG, name: ORG, slug: ORG },
    update: {},
  });
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.standingAuthorization.create({
    data: {
      organizationId: ORG,
      platformAccountId: 'acct-gap',
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
      consentEvidenceRef: 'evidence://gap-seed',
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
      title: 'gap ' + opportunityRef,
      amountExpected: '100.0000',
      amountActual: '150.0000',
      recoverableAmount: '50.0000',
      currency: 'USD',
      detectedAt: T0,
      createdAt: T0,
    },
  });
}

async function truncateGapData(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AutonomyLease", "AutonomyTask", "AutonomyIncident", "AuditLog", "RecoveryOpportunity" CASCADE;',
  );
}

/** 既有 runtime 组合根 + 内存裁决工件（格式与 PHASE 10 测试一致：{ messageId, verdict }） */
async function composeWithVerdict(input: {
  verdictArtifact: string;
  ownerRef: string;
  now?: Date;
  onEvidence?: boolean;
  /** 只读端口调用计数（用于观测「domain step 是否真的又跑了一次」） */
  onReadPort?: () => void;
}) {
  const now = input.now ?? T0;
  const packDeps = createProductionRecoveryPackDeps({ prisma });
  const readPorts = {
    ...packDeps.readPorts,
    async opportunityRead(portInput: { organizationId: string; opportunityRef: string }) {
      input.onReadPort?.();
      return packDeps.readPorts.opportunityRead(portInput);
    },
  };
  return composeRsiRuntime({
    readFile: async (path: string) => {
      if (path === 'mem://verdict') return input.verdictArtifact;
      return '[]';
    },
    verdictPath: 'mem://verdict',
    // verdictWatcher 只有在显式给出 verdictWatch 时才被组装（与既有 PHASE 10 测试一致）
    verdictWatch: { intervalMs: 10_000 },
    intervalMs: 50,
    taskSource: createAutonomyTaskSource({ prisma, ownerRef: input.ownerRef, now: () => now }),
    productRecoveryPack: { ...packDeps, readPorts },
    ...(input.onEvidence === true
      ? {
          onDomainPackEvidence: (record: DomainStepEvidence) =>
            createRecoveryDomainOutcomeRecorder({ prisma, now: () => now }).record(record).then(() => undefined),
        }
      : {}),
  });
}

const auditRows = (taskId?: string) =>
  prisma.auditLog.findMany({
    where: { organizationId: ORG, action: AUDIT_ACTION, ...(taskId === undefined ? {} : { entityId: taskId }) },
    orderBy: { createdAt: 'asc' },
    select: { id: true, entityId: true, changes: true },
  });

beforeEach(async () => {
  await truncateGapData();
  await seedTenant();
});

afterAll(async () => {
  await truncateGapData();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.$disconnect();
});

describe('PHASE 3 · Recovery 任务「裁决 → durable 收口」缺口（特征化）', () => {
  it('G1 认领即执行：domain step 在 tick 内运行并留痕，随后**强制 park-for-judge** 等待裁决', async () => {
    const opportunityRef = suffix();
    await seedOpportunity(opportunityRef);
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });

    const composition = await composeWithVerdict({
      verdictArtifact: JSON.stringify({ messageId: 'gap-msg-1', verdict: 'PASS' }),
      ownerRef: 'gap-worker-1',
      onEvidence: true,
    });
    try {
      const outcome = await composition.controller.tick();
      expect(outcome.claimed?.dedupeKey).toBe(key);
      // 实测口径：pack 在 tick 内被调用 ⇒ domain step 的结论**当场**落 durable 审计行
      expect(await auditRows()).toHaveLength(1);
      // 但引擎随即停在「等待裁决」（recovery-domain 任务强制 park-for-judge）
      expect(composition.controller.state().waitingForVerdict).toBe(true);
    } finally {
      composition.stop();
    }
  });

  it('G2 PASS 裁决被真实 verdictWatcher 收口（内存侧完成），但 durable 任务仍 IN_PROGRESS + 租约 ACTIVE', async () => {
    const opportunityRef = suffix();
    await seedOpportunity(opportunityRef);
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });

    const composition = await composeWithVerdict({
      verdictArtifact: JSON.stringify({ messageId: 'gap-msg-2', verdict: 'PASS' }),
      ownerRef: 'gap-worker-2',
      onEvidence: true,
    });
    let taskId = '';
    try {
      const outcome = await composition.controller.tick();
      taskId = outcome.claimed!.id;
      const polled = await composition.verdictWatcher!.pollOnce();
      expect(polled.delivered).toBe(true);
      expect(composition.controller.state().waitingForVerdict).toBe(false); // 内存侧已收口
    } finally {
      composition.stop();
    }

    // 缺口：引擎不认识 durable 终态 —— 任务仍 IN_PROGRESS、租约仍 ACTIVE、没有 settle
    const task = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('IN_PROGRESS');
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).status).toBe('ACTIVE');
    expect((await auditRows(taskId)).length).toBe(1); // domain step 执行过一次并留痕
  });

  it('G3 缺口后果：租约到期 → 同一任务被重新领取并**再次**执行 domain step（审计行因 evidenceRef 确定性而保持幂等）', async () => {
    const opportunityRef = suffix();
    await seedOpportunity(opportunityRef);
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });

    let readPortCalls = 0;
    const composition = await composeWithVerdict({
      verdictArtifact: JSON.stringify({ messageId: 'gap-msg-3', verdict: 'PASS' }),
      ownerRef: 'gap-worker-3',
      onEvidence: true,
      onReadPort: () => {
        readPortCalls += 1;
      },
    });
    let taskId = '';
    try {
      const first = await composition.controller.tick();
      taskId = first.claimed!.id;
      await composition.verdictWatcher!.pollOnce();
      expect((await auditRows(taskId)).length).toBe(1);
      expect(readPortCalls).toBe(1);
    } finally {
      composition.stop();
    }

    // 模拟租约到期（保持 DB 时间序约束），再走既有 reclaimExpired + 新组合的 tick
    await prisma.autonomyLease.update({
      where: { taskId },
      data: {
        acquiredAt: new Date('2026-10-08T11:50:00.000Z'),
        renewedAt: new Date('2026-10-08T11:50:00.000Z'),
        expiresAt: new Date('2026-10-08T11:59:00.000Z'),
      },
    });
    const secondComposition = await composeWithVerdict({
      verdictArtifact: JSON.stringify({ messageId: 'gap-msg-4', verdict: 'PASS' }),
      ownerRef: 'gap-worker-4',
      onEvidence: true,
      onReadPort: () => {
        readPortCalls += 1;
      },
    });
    try {
      const reclaimed = await secondComposition.controller.tick(); // tick 内部先 reclaimExpired 再 claim
      expect(reclaimed.claimed?.dedupeKey).toBe(key); // ⇒ 同一任务被**重新领取**
      await secondComposition.verdictWatcher!.pollOnce();
    } finally {
      secondComposition.stop();
    }

    // domain step 确实**又跑了一次**（只读端口被第 2 次调用）
    expect(readPortCalls).toBe(2);
    /**
     * 但审计记录**没有**重复：evidenceRef 是对 (taskId, dedupeKey, org, opportunityRef, guardAction, tools)
     * 的确定性摘要 ⇒ 同一任务同一输入得到同一 evidenceRef ⇒ 记录器按 (taskId, evidenceRef) 幂等去重。
     * 这正是缺口的两面：**执行会重复，审计不会重复**（后者是好事，前者仍需 durable 收口消除）。
     */
    expect(await auditRows(taskId)).toHaveLength(1);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('IN_PROGRESS');
  });

  it('G4 收口路径：fenced settle ⇒ 任务终态 + 租约 RELEASED，之后 reclaim/tick 不再重复执行', async () => {
    const opportunityRef = suffix();
    await seedOpportunity(opportunityRef);
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: ORG, tasks: [draft(key)] });

    const ownerRef = 'gap-worker-5';
    const composition = await composeWithVerdict({
      verdictArtifact: JSON.stringify({ messageId: 'gap-msg-5', verdict: 'PASS' }),
      ownerRef,
      onEvidence: true,
    });
    let taskId = '';
    try {
      const outcome = await composition.controller.tick();
      taskId = outcome.claimed!.id;
      await composition.verdictWatcher!.pollOnce();
    } finally {
      composition.stop();
    }

    // 缺失的那一步：把裁决结果**落地**到 durable 任务（此处以 BLOCKED 终态表达「裁决未授权进一步自动动作」）
    const settled = await createAutonomyTaskSource({ prisma, ownerRef, now: () => T0 }).settle({
      taskId,
      ownerRef,
      outcome: 'BLOCKED',
    });
    expect(settled.applied).toBe(true);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('BLOCKED');
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).status).toBe('RELEASED');

    // 收口之后：即使租约过期 / 再次 tick，也不再重复执行
    const after = await composeWithVerdict({
      verdictArtifact: JSON.stringify({ messageId: 'gap-msg-6', verdict: 'PASS' }),
      ownerRef: 'gap-worker-6',
      onEvidence: true,
    });
    try {
      const outcome = await after.controller.tick();
      expect(outcome.claimed).toBeNull();
    } finally {
      after.stop();
    }
    expect(await auditRows(taskId)).toHaveLength(1);
  });
});
