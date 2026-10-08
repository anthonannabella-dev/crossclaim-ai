/**
 * PHASE 2 / P0-B1（审计 MSG-20261008-20）—— 生产同构业务链 E2E（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 审计对 P0-B1 的判据（逐条对应本文件的 E1–E6）：
 *   ① 有效授权任务从 `rsi-run` 同构组装入口进入业务步骤；
 *   ② **真实** Recovery domain step 确实执行（而非只写 dispatch 日志）；
 *   ③ 本地机会识别/索赔准备产生**可审计的 durable 记录**；
 *   ④ 未授权 / 跨租户 / 授权中途撤销时业务步骤**不执行**；
 *   ⑤ 全程无外部写入、不依赖真实 Provider 凭据、不新增第二 runtime。
 *
 * 实验边界：真实 PostgreSQL + 真实 Recovery pack（`createProductionRecoveryPackDeps`）
 * + 真实 controller/event loop 组装 + **既有业务 read ports**（Prisma 只读适配器）。
 * 未接真实 Provider：`REAL_PROVIDER_WRITE` / 支付 / 报关 = HOLD，本文件不做任何外部写。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  RECOVERY_DOMAIN_OUTCOME_RECORDER_BOUNDARY,
  RECOVERY_DOMAIN_STEP_ACTION,
  createRecoveryDomainOutcomeRecorder,
} from '../runtime/recovery-domain-outcome-recorder';
import { createProductionRecoveryPackDeps } from '../runtime/recovery-si-production-composition';
import { composeRsiRuntime } from '../runtime/rsi-run';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

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

/**
 * 播种**真实业务事实**：一张可追回的机会（含可追回金额）。
 * 这是 ② 的关键：只有真实读到该行，domain step 才可能 PASS；
 * 不播种时读取会失败 ⇒ BLOCK（E2 反证）。
 */
async function seedOpportunity(organizationId: string, opportunityId: string): Promise<void> {
  await prisma.recoveryOpportunity.create({
    data: {
      id: opportunityId,
      organizationId,
      domain: 'LOGISTICS',
      channel: 'FEDEX',
      status: 'DETECTED',
      opportunityType: 'RATE_DISCREPANCY',
      title: 'E2E 机会 ' + opportunityId,
      amountExpected: '120.0000',
      amountActual: '168.0000',
      recoverableAmount: '48.0000',
      currency: 'USD',
      detectedAt: T0,
      createdAt: T0,
    },
  });
}

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AutonomyMetricResult", "AutonomyRollbackRecord", "AutonomyPromotionDecision", "AutonomyEvaluationRun", "AutonomyCandidate", "AutonomyLease", "AutonomyTask", "AutonomyIncident", "AuditLog", "RecoveryOpportunity" RESTART IDENTITY CASCADE',
  );
}

/** 与生产 `rsi-run` 同构的组装：durable 任务源 + 生产 Recovery pack + 结果记录器 */
async function composeWithRecorder(ownerRef: string, prismaClient: PrismaClient = prisma) {
  const recorder = createRecoveryDomainOutcomeRecorder({ prisma: prismaClient, now: () => T0 });
  return composeRsiRuntime({
    readFile: noFile,
    intervalMs: 50,
    taskSource: createAutonomyTaskSource({ prisma: prismaClient, ownerRef, now: () => T0 }),
    productRecoveryPack: createProductionRecoveryPackDeps({ prisma: prismaClient }),
    onDomainPackEvidence: (record) => recorder.record(record).then(() => undefined),
  });
}

const auditRows = () =>
  prisma.auditLog.findMany({ where: { action: RECOVERY_DOMAIN_STEP_ACTION }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await truncateAll();
  await seedTenant('org-A');
});

afterAll(async () => {
  await truncateAll();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: { in: ['org-A', 'org-B'] } } });
  await prisma.$disconnect();
});

describe('PHASE 2 / P0-B1 · 生产同构业务链 E2E', () => {
  it('E1 有效授权任务从 rsi-run 同构入口进入业务步骤，并落一条 durable 审计事实', async () => {
    const opportunityRef = suffix();
    await seedOpportunity('org-A', opportunityRef);
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });

    const composition = await composeWithRecorder('runtime-e2e-1');
    try {
      const outcome = await composition.controller.tick();
      expect(outcome.claimed?.dedupeKey).toBe(key);
      // ① 进入真实业务步骤（domain dispatch 为 recovery-si）
      const dispatch = composition.domainDispatchLog();
      expect(dispatch.some((row) => row.packId === 'recovery-si')).toBe(true);
      expect(dispatch[0]!.taskId).toBe(outcome.claimed!.id);
    } finally {
      composition.stop();
    }

    // ③ durable 可审计记录（读回数据库，而不是内存日志）
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.organizationId).toBe('org-A');
    expect(row.actorType).toBe('SYSTEM');
    expect(row.entityType).toBe('AutonomyTask');
    const changes = row.changes as Record<string, unknown>;
    expect(changes.packId).toBe('recovery-si');
    expect(changes.status).toBe('PASS');
    expect(changes.dedupeKey).toBe(key);
    expect(changes.opportunityRef).toBe(opportunityRef);
    expect(changes.domain).toBe('CARRIER');
    expect(changes.businessOutcome).toBe('OPPORTUNITY_IDENTIFIED'); // 机会识别 ≠ 追回完成
    expect(changes.externalWritePerformed).toBe(false);
    expect(String(changes.evidenceRef)).toMatch(/^recovery-si:CARRIER:[0-9a-f]{12}$/);
    // 任务仍停在等待裁决（PASS 提案 ≠ 终局成功）
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
    expect(row.entityId).toBe(taskId);
  });

  it('E2 反证：真实 domain step 确实读取业务事实（无机会行 ⇒ BLOCK，且留痕 BLOCKED）', async () => {
    const opportunityRef = suffix(); // 故意不播种 RecoveryOpportunity
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });

    const composition = await composeWithRecorder('runtime-e2e-2');
    try {
      await composition.controller.tick();
      const dispatch = composition.domainDispatchLog();
      expect(dispatch[0]!.status).toBe('BLOCK');
    } finally {
      composition.stop();
    }

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const changes = rows[0]!.changes as Record<string, unknown>;
    expect(changes.status).toBe('BLOCK');
    expect(changes.businessOutcome).toBe('BLOCKED');
    // 读到「机会不存在」才会 BLOCK ⇒ 证明只读端口真在被调用（不是空跑 success）
    expect(String(changes.evidenceRef)).toContain('RECOVERY_READ_TOOL_FAILED');
    // registry 把 adapter 抛出的 WorkflowError(NOT_FOUND) 归一化为 TOOL_THREW（detail 保留原因）
    expect(changes.reasonCodes).toEqual(['RECOVERY_READ_TOOL_FAILED', 'recovery.opportunity.read', 'TOOL_THREW']);
  });

  it('E3 未授权（Standing Authorization 已撤销）⇒ 不进入业务步骤、无审计记录', async () => {
    const opportunityRef = suffix();
    await seedOpportunity('org-A', opportunityRef);
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });
    await prisma.standingAuthorization.updateMany({
      where: { organizationId: 'org-A' },
      data: { revocationState: 'REVOKED', revokedAt: T0, revokedBy: 'owner@example.test', revocationReason: 'E2E' },
    });

    const composition = await composeWithRecorder('runtime-e2e-3');
    try {
      const outcome = await composition.controller.tick();
      expect(outcome.claimed).toBeNull();
      expect(composition.domainDispatchLog()).toEqual([]);
    } finally {
      composition.stop();
    }
    expect(await auditRows()).toEqual([]); // 业务步骤未执行 ⇒ 无 durable 记录
  });

  it('E4 授权中途撤销（领取后、派发前）⇒ 业务步骤不执行（fail-closed 且无留痕）', async () => {
    const opportunityRef = suffix();
    await seedOpportunity('org-A', opportunityRef);
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });

    // 先领取（此时授权有效），随后撤销 ⇒ 派发前的 executionPreflight 必须拒绝
    const source = createAutonomyTaskSource({ prisma, ownerRef: 'runtime-e2e-4', now: () => T0 });
    expect((await source.claim(5)).map((t) => t.dedupeKey)).toEqual([key]);
    await prisma.standingAuthorization.updateMany({
      where: { organizationId: 'org-A' },
      data: { revocationState: 'REVOKED', revokedAt: T0, revokedBy: 'owner@example.test', revocationReason: 'E2E-MID' },
    });
    // 直接驱动 domain runner（与 rsi-run 中 executionPreflight 的调用点一致）
    const packDeps = createProductionRecoveryPackDeps({ prisma });
    const preflight = await packDeps.executionPreflight({
      id: 'x',
      dedupeKey: key,
      organizationId: 'org-A',
    });
    expect(preflight.allowed).toBe(false);
    expect(preflight.reason).toBe('EXEC_PREFLIGHT_AUTHORIZATION_REVOKED');
    expect(await auditRows()).toEqual([]);
  });

  it('E5 跨租户：org-B 的机会不会被 org-A 的任务读到（业务步骤 fail-closed）', async () => {
    const opportunityRef = suffix();
    await seedTenant('org-B');
    await seedOpportunity('org-B', opportunityRef); // 机会属于 org-B
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });

    const composition = await composeWithRecorder('runtime-e2e-5');
    try {
      await composition.controller.tick();
      expect(composition.domainDispatchLog()[0]!.status).toBe('BLOCK');
    } finally {
      composition.stop();
      await prisma.standingAuthorization.deleteMany({ where: { organizationId: 'org-B' } });
    }
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organizationId).toBe('org-A'); // 留痕归属执行租户
    expect((rows[0]!.changes as Record<string, unknown>).status).toBe('BLOCK');
  });

  it('E6 边界：无外部写 / 无凭据 / 无第二 runtime；审计记录幂等且不产生终局完成', async () => {
    expect(RECOVERY_DOMAIN_OUTCOME_RECORDER_BOUNDARY.writesDatabase).toBe(true);
    expect(RECOVERY_DOMAIN_OUTCOME_RECORDER_BOUNDARY.externalWrite).toBe(false);
    expect(RECOVERY_DOMAIN_OUTCOME_RECORDER_BOUNDARY.readsCredentials).toBe(false);
    expect(RECOVERY_DOMAIN_OUTCOME_RECORDER_BOUNDARY.updatesTaskState).toBe(false);
    expect(RECOVERY_DOMAIN_OUTCOME_RECORDER_BOUNDARY.producesTerminalCompletion).toBe(false);

    const opportunityRef = suffix();
    await seedOpportunity('org-A', opportunityRef);
    const key = 'task:recovery:LOGISTICS:' + opportunityRef;
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });

    const composition = await composeWithRecorder('runtime-e2e-6');
    try {
      await composition.controller.tick();
      expect(composition.runtimeMembers().secondRuntime).toBe(0);
      expect(composition.runtimeMembers().domainPacks).toEqual(['recovery-si']);
    } finally {
      composition.stop();
    }

    // 幂等：同一 (taskId, evidenceRef) 重复记录不产生第二行
    const recorder = createRecoveryDomainOutcomeRecorder({ prisma, now: () => T0 });
    const first = await auditRows();
    expect(first).toHaveLength(1);
    const changes = first[0]!.changes as Record<string, unknown>;
    const again = await recorder.record({
      taskId: first[0]!.entityId!,
      dedupeKey: key,
      packId: 'recovery-si',
      status: 'PASS',
      evidenceRef: String(changes.evidenceRef),
      organizationId: 'org-A',
    });
    expect(again.recorded).toBe(false);
    expect(again.reason).toBe('ALREADY_RECORDED');
    expect(await auditRows()).toHaveLength(1);

    // 无可信租户 ⇒ 拒绝写入（不猜租户）
    const denied = await recorder.record({
      taskId: 'no-tenant-task',
      dedupeKey: 'task:recovery:LOGISTICS:no-tenant',
      packId: 'recovery-si',
      status: 'PASS',
      evidenceRef: 'recovery-si:CARRIER:deadbeef0000',
    });
    expect(denied.recorded).toBe(false);
    expect(denied.reason).toBe('DOMAIN_OUTCOME_NO_TRUSTED_TENANT');
    expect(await auditRows()).toHaveLength(1);
  });
});
