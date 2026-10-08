/**
 * PHASE 2 / CHANGE 3A（审计 MSG-20261008-20）—— 可信终局事实（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 审计要求：
 *   1. 终局结果必须在 businessOutcome 生成、持久化与 settle() 的**完整调用链**上绑定
 *      「已验证的 provider/settlement evidence + 可信来源 + case/organization lineage」；
 *   2. runner / 任务输入 / 非可信调用者**不得自行声明**终局；
 *   3. 增加「伪造终局结果」的真实 PG 拒绝测试；
 *   4. 外部 Provider HOLD 期间**不得**用模拟终局事实把任务写成业务完成。
 *
 * 诚实边界：本用例中的「启用来源」是**测试注入**（`createTestTerminalEvidenceSource`），
 * 生产注册表 `PRODUCTION_TERMINAL_EVIDENCE_SOURCES` 全部 disabled（T1 即验证这一点）。
 * 真实 Provider / 结算接入仍为 HOLD —— 本用例不产生任何外部写。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PRODUCTION_TERMINAL_EVIDENCE_SOURCES,
  RECOVERY_TERMINAL_EVIDENCE_BOUNDARY,
  TERMINAL_EVIDENCE_DECISION,
  createTestTerminalEvidenceSource,
  deriveTrustedOutcomeOf,
  evaluateRecoveryTerminalEvidence,
} from '../runtime/recovery-terminal-evidence';
import type { RecoveryTerminalEvidence } from '../runtime/recovery-terminal-evidence';
import { deriveRecoveryBusinessOutcome } from '../runtime/recovery-business-outcome';
import { createAutonomyTaskSource } from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
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

/** 已校验的终局证据（默认全部字段合法；用 overrides 制造「伪造」变体） */
const evidence = (
  taskDedupeKey: string,
  overrides: Partial<RecoveryTerminalEvidence> = {},
): RecoveryTerminalEvidence => ({
  kind: 'SETTLEMENT_LEDGER_ENTRY',
  source: 'SETTLEMENT_LEDGER',
  verified: true,
  verifiedBy: 'SETTLEMENT_EVIDENCE_VERIFIER',
  verificationRef: 'test://settlement/' + taskDedupeKey,
  providerEventId: 'evt-' + taskDedupeKey,
  observedAt: '2026-10-08T12:05:00.000Z',
  organizationId: 'org-A',
  taskDedupeKey,
  ...overrides,
});

/** 建一个已领取的任务，返回 taskId 与 dedupeKey */
async function claimedTask(
  worker: ReturnType<typeof createAutonomyTaskSource>,
  prefix: string,
): Promise<{ taskId: string; key: string }> {
  const key = prefix + suffix();
  await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });
  await worker.claim(5);
  const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;
  return { taskId, key };
}

/** 未改动状态断言：拒绝必须是零部分写入 */
async function expectUntouched(taskId: string): Promise<void> {
  expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('IN_PROGRESS');
  expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).status).toBe('ACTIVE');
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

describe('PHASE 2 / CHANGE 3A · 可信终局事实', () => {
  const enabled = () => [createTestTerminalEvidenceSource()];
  const workerWith = (sources?: readonly ReturnType<typeof createTestTerminalEvidenceSource>[]) =>
    createAutonomyTaskSource({
      prisma,
      ownerRef: 'worker-A',
      now: () => T0,
      ...(sources === undefined ? {} : { terminalEvidenceSources: sources }),
    });

  it('T1 生产默认：终局档在 HOLD 期不可达（即使证据字段齐全也被拒，任务保持 IN_PROGRESS）', async () => {
    // 生产注册表必须全部 disabled，且边界常量自证
    expect(PRODUCTION_TERMINAL_EVIDENCE_SOURCES.every((s) => s.enabled === false)).toBe(true);
    expect(RECOVERY_TERMINAL_EVIDENCE_BOUNDARY.defaultSourcesEnabled).toBe(false);
    expect(RECOVERY_TERMINAL_EVIDENCE_BOUNDARY.runnerSelfDeclarationAccepted).toBe(false);

    const worker = workerWith(); // 未注入任何启用来源 ⇒ 使用生产注册表
    const { taskId, key } = await claimedTask(worker, 'task:recovery:LOGISTICS:');
    const res = await worker.settle({
      taskId,
      ownerRef: 'worker-A',
      outcome: 'COMPLETED',
      businessOutcome: 'SETTLEMENT_RECEIVED',
      terminalEvidence: evidence(key),
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe(TERMINAL_EVIDENCE_DECISION.SOURCE_DISABLED);
    await expectUntouched(taskId); // 关键：不得用「模拟终局事实」把客户任务写成业务完成
  });

  it('T2 自报终局被拒：RUNNER / TASK_INPUT / LOCAL_SIMULATION 的 verified=true 不构成证据', async () => {
    for (const declarer of ['RUNNER', 'TASK_INPUT', 'LOCAL_SIMULATION']) {
      const worker = workerWith(enabled());
      const { taskId, key } = await claimedTask(worker, 'task:recovery:LOGISTICS:');
      const res = await worker.settle({
        taskId,
        ownerRef: 'worker-A',
        outcome: 'COMPLETED',
        businessOutcome: 'SETTLEMENT_RECEIVED',
        terminalEvidence: evidence(key, { verifiedBy: declarer }),
      });
      expect(res.applied).toBe(false);
      expect(res.reason).toBe(TERMINAL_EVIDENCE_DECISION.SELF_DECLARED);
      await expectUntouched(taskId);
    }
  });

  it('T3 跨租户终局事实被拒（租户必须等于服务端解析的权威租户）', async () => {
    const worker = workerWith(enabled());
    const { taskId, key } = await claimedTask(worker, 'task:recovery:LOGISTICS:');
    const res = await worker.settle({
      taskId,
      ownerRef: 'worker-A',
      outcome: 'COMPLETED',
      businessOutcome: 'SETTLEMENT_RECEIVED',
      terminalEvidence: evidence(key, { organizationId: 'org-B' }),
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe(TERMINAL_EVIDENCE_DECISION.TENANT_MISMATCH);
    await expectUntouched(taskId);
  });

  it('T4 错配归属被拒（证据必须绑定本任务的 dedupeKey）', async () => {
    const worker = workerWith(enabled());
    const { taskId, key } = await claimedTask(worker, 'task:recovery:LOGISTICS:');
    const res = await worker.settle({
      taskId,
      ownerRef: 'worker-A',
      outcome: 'COMPLETED',
      businessOutcome: 'SETTLEMENT_RECEIVED',
      terminalEvidence: evidence(key, { taskDedupeKey: 'task:recovery:LOGISTICS:' + suffix() }),
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe(TERMINAL_EVIDENCE_DECISION.TASK_LINEAGE_MISMATCH);
    await expectUntouched(taskId);
  });

  it('T5 类别与档位必须唯一对应（PROVIDER_CONFIRMATION 不得充当回款）', async () => {
    const worker = workerWith([
      createTestTerminalEvidenceSource({ id: 'PROVIDER_OF_RECORD', kind: 'PROVIDER_CONFIRMATION', verifierId: 'PROVIDER_EVIDENCE_VERIFIER' }),
    ]);
    const { taskId, key } = await claimedTask(worker, 'task:recovery:LOGISTICS:');
    const res = await worker.settle({
      taskId,
      ownerRef: 'worker-A',
      outcome: 'COMPLETED',
      businessOutcome: 'SETTLEMENT_RECEIVED',
      terminalEvidence: evidence(key, { kind: 'PROVIDER_CONFIRMATION', source: 'PROVIDER_OF_RECORD', verifiedBy: 'PROVIDER_EVIDENCE_VERIFIER' }),
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe(TERMINAL_EVIDENCE_DECISION.KIND_MISMATCH);
    await expectUntouched(taskId);
  });

  it('T6 非终局档不得落业务完成（dispatch / 已准备索赔均被拒）', async () => {
    const worker = workerWith(enabled());
    const { taskId, key } = await claimedTask(worker, 'task:recovery:LOGISTICS:');
    for (const outcome of ['DISPATCHED', 'CLAIM_PREPARED', 'CLAIM_SUBMITTED'] as const) {
      const res = await worker.settle({
        taskId,
        ownerRef: 'worker-A',
        outcome: 'COMPLETED',
        businessOutcome: outcome,
        terminalEvidence: evidence(key),
      });
      expect(res.applied).toBe(false);
      expect(res.reason).toBe('EXEC_SETTLE_BUSINESS_OUTCOME_NOT_TERMINAL');
    }
    await expectUntouched(taskId);
  });

  it('T7 机制可达性：显式启用来源 + 证据齐备 ⇒ 只有此时才允许 PROMOTED（测试注入，非生产）', async () => {
    const worker = workerWith(enabled());
    const { taskId, key } = await claimedTask(worker, 'task:recovery:LOGISTICS:');
    const res = await worker.settle({
      taskId,
      ownerRef: 'worker-A',
      outcome: 'COMPLETED',
      businessOutcome: 'SETTLEMENT_RECEIVED',
      terminalEvidence: evidence(key),
    });
    expect(res.applied).toBe(true);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('PROMOTED');
    expect((await prisma.autonomyLease.findUniqueOrThrow({ where: { taskId } })).status).toBe('RELEASED');
  });

  it('T8 纯函数判定表：缺失 / 未校验 / 占位引用 / 无事件号 / 时间非法 / 未知来源 均拒绝', () => {
    const context = { authoritativeOrganizationId: 'org-A', authoritativeTaskDedupeKey: 'k1', sources: enabled() };
    const base = evidence('k1');
    const decide = (e?: RecoveryTerminalEvidence) =>
      evaluateRecoveryTerminalEvidence({ outcome: 'SETTLEMENT_RECEIVED', ...(e === undefined ? {} : { evidence: e }), context }).reason;

    expect(decide()).toBe(TERMINAL_EVIDENCE_DECISION.MISSING);
    expect(decide({ ...base, verified: false })).toBe(TERMINAL_EVIDENCE_DECISION.NOT_VERIFIED);
    expect(decide({ ...base, verificationRef: 'timeout' })).toBe(TERMINAL_EVIDENCE_DECISION.NO_VERIFICATION_REF);
    expect(decide({ ...base, providerEventId: '   ' })).toBe(TERMINAL_EVIDENCE_DECISION.MISSING_EVENT_ID);
    expect(decide({ ...base, observedAt: 'not-a-date' })).toBe(TERMINAL_EVIDENCE_DECISION.OBSERVED_AT_INVALID);
    expect(decide({ ...base, source: 'UNKNOWN_SOURCE' })).toBe(TERMINAL_EVIDENCE_DECISION.SOURCE_UNKNOWN);
    expect(decide({ ...base, verifiedBy: 'SOMEONE_ELSE' })).toBe(TERMINAL_EVIDENCE_DECISION.VERIFIER_NOT_AUTHORIZED);
    expect(decide({ ...base, organizationId: '' })).toBe(TERMINAL_EVIDENCE_DECISION.TENANT_MISMATCH);
    expect(decide(base)).toBe(TERMINAL_EVIDENCE_DECISION.TRUSTED);
  });

  it('T9 生成侧：自报布尔不再能推导出终局档（只有授权对象可以）', () => {
    // 旧口径的自报字段已删除；仅凭 dispatch / 准备 / 提交 永远得不到 Provider 或回款
    expect(deriveRecoveryBusinessOutcome({ dispatched: true, claimPrepared: true, claimSubmitted: true })).toBe('CLAIM_SUBMITTED');
    expect(deriveRecoveryBusinessOutcome({ dispatched: true, opportunityIdentified: true })).toBe('OPPORTUNITY_IDENTIFIED');
    expect(deriveRecoveryBusinessOutcome({ dispatched: true })).not.toBe('PROVIDER_CONFIRMED');
    expect(deriveRecoveryBusinessOutcome({ dispatched: true })).not.toBe('SETTLEMENT_RECEIVED');
    // 授权对象（仅由 createAuthorizedTerminalOutcome 产出）才可下沉终局档
    const authorized = deriveTrustedOutcomeOf(evidence('k1'), {
      authoritativeOrganizationId: 'org-A',
      authoritativeTaskDedupeKey: 'k1',
      sources: enabled(),
    });
    expect(authorized?.outcome).toBe('SETTLEMENT_RECEIVED');
    const authorizedInput: Parameters<typeof deriveRecoveryBusinessOutcome>[0] = { dispatched: true };
    if (authorized !== null) authorizedInput.authorizedTerminalOutcome = authorized.outcome;
    expect(deriveRecoveryBusinessOutcome(authorizedInput)).toBe('SETTLEMENT_RECEIVED');
    // 同一证据在**来源未启用**时不得授权（生产口径）
    expect(
      deriveTrustedOutcomeOf(evidence('k1'), {
        authoritativeOrganizationId: 'org-A',
        authoritativeTaskDedupeKey: 'k1',
        sources: PRODUCTION_TERMINAL_EVIDENCE_SOURCES,
      }),
    ).toBeNull();
  });
});
