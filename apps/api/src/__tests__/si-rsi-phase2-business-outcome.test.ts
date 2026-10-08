/**
 * PHASE 2 / P2-CHANGE3 —— 业务完成状态真实性（纯词表推导 + 真实 PG 终态守卫）
 * ---------------------------------------------------------------
 * 复审 CHANGE 3：不得因为 Recovery pack 成功 dispatch 就把客户任务标记成「追回成功」；
 * BLOCK / WAITING_* 也不得被误映射为业务完成。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  RECOVERY_BUSINESS_OUTCOMES,
  RECOVERY_BUSINESS_OUTCOME_BOUNDARY,
  deriveRecoveryBusinessOutcome,
  internalTaskStatusForBusinessOutcome,
  isNonCompletionOutcome,
  isTerminalBusinessCompletion,
} from '../runtime/recovery-business-outcome';
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

beforeEach(async () => {
  await truncateAutonomy();
  await seedTenant('org-A');
});

afterAll(async () => {
  await truncateAutonomy();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: 'org-A' } });
  await prisma.$disconnect();
});

describe('PHASE 2 / P2-CHANGE3 · 业务完成状态真实性', () => {
  it('B1 词表：dispatch 不是成功；仅 PROVIDER_CONFIRMED / SETTLEMENT_RECEIVED 算真实完成', () => {
    expect(RECOVERY_BUSINESS_OUTCOMES).toContain('DISPATCHED');
    expect(isNonCompletionOutcome('DISPATCHED')).toBe(true);
    expect(isNonCompletionOutcome('BLOCKED')).toBe(true);
    expect(isNonCompletionOutcome('WAITING_ON_PROVIDER')).toBe(true);
    expect(isNonCompletionOutcome('WAITING_ON_CUSTOMER')).toBe(true);
    expect(isTerminalBusinessCompletion('DISPATCHED')).toBe(false);
    expect(isTerminalBusinessCompletion('CLAIM_PREPARED')).toBe(false); // 准备索赔 ≠ 追回成功
    expect(isTerminalBusinessCompletion('CLAIM_SUBMITTED')).toBe(false); // 提交索赔 ≠ 收到回款
    expect(isTerminalBusinessCompletion('PROVIDER_CONFIRMED')).toBe(true);
    expect(isTerminalBusinessCompletion('SETTLEMENT_RECEIVED')).toBe(true);
    expect(RECOVERY_BUSINESS_OUTCOME_BOUNDARY.dispatchImpliesBusinessSuccess).toBe(false);
  });

  it('B2 推导单调：仅 dispatch ⇒ DISPATCHED；逐级需要各自证据；HOLD 档不被臆造', () => {
    expect(deriveRecoveryBusinessOutcome({ dispatched: false })).toBe('NOT_DISPATCHED');
    expect(deriveRecoveryBusinessOutcome({ dispatched: true })).toBe('DISPATCHED');
    expect(deriveRecoveryBusinessOutcome({ dispatched: true, blockCodes: ['PROVIDER_TIMEOUT'] })).toBe('WAITING_ON_PROVIDER');
    expect(deriveRecoveryBusinessOutcome({ dispatched: true, blockCodes: ['NEEDS_EVIDENCE'] })).toBe('WAITING_ON_CUSTOMER');
    expect(deriveRecoveryBusinessOutcome({ dispatched: true, opportunityIdentified: true })).toBe('OPPORTUNITY_IDENTIFIED');
    expect(deriveRecoveryBusinessOutcome({ dispatched: true, opportunityIdentified: true, claimPrepared: true })).toBe('CLAIM_PREPARED');
    // 本地无外部写/回款证据 ⇒ 不得推断出 HOLD 档
    expect(deriveRecoveryBusinessOutcome({ dispatched: true, claimPrepared: true })).not.toBe('CLAIM_SUBMITTED');
    expect(deriveRecoveryBusinessOutcome({ dispatched: true, claimPrepared: true })).not.toBe('SETTLEMENT_RECEIVED');
  });

  it('B3 内部终态映射：只有真实完成档位才允许 PROMOTED', () => {
    expect(internalTaskStatusForBusinessOutcome('DISPATCHED')).toBe('READY');
    expect(internalTaskStatusForBusinessOutcome('BLOCKED')).toBe('BLOCKED');
    expect(internalTaskStatusForBusinessOutcome('WAITING_ON_CUSTOMER')).toBe('BLOCKED');
    expect(internalTaskStatusForBusinessOutcome('CLAIM_PREPARED')).toBe('BLOCKED'); // 关键：不得 PROMOTED
    expect(internalTaskStatusForBusinessOutcome('SETTLEMENT_RECEIVED')).toBe('PROMOTED');
  });

  it('B4 真实 PG 守卫：COMPLETED 必须携带真实终局业务结果，准备索赔不算完成', async () => {
    const key = 'task:recovery:LOGISTICS:' + suffix();
    await createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({ organizationId: 'org-A', tasks: [draft(key)] });
    const worker = createAutonomyTaskSource({ prisma, ownerRef: 'worker-A', now: () => T0 });
    await worker.claim(5);
    const taskId = (await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } })).id;

    // ① 无业务结果 ⇒ 拒绝
    expect((await worker.settle({ taskId, ownerRef: 'worker-A', outcome: 'COMPLETED' })).reason)
      .toBe('EXEC_SETTLE_BUSINESS_OUTCOME_NOT_TERMINAL');
    // ② 仅「已准备索赔」⇒ 仍拒绝（不得标成追回成功）
    expect(
      (await worker.settle({ taskId, ownerRef: 'worker-A', outcome: 'COMPLETED', businessOutcome: 'CLAIM_PREPARED' })).reason,
    ).toBe('EXEC_SETTLE_BUSINESS_OUTCOME_NOT_TERMINAL');
    // ③ 任务未被标成 PROMOTED
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('IN_PROGRESS');
    // ④ 只有真实终局业务结果才放行
    expect(
      (await worker.settle({ taskId, ownerRef: 'worker-A', outcome: 'COMPLETED', businessOutcome: 'SETTLEMENT_RECEIVED' })).applied,
    ).toBe(true);
    expect((await prisma.autonomyTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('PROMOTED');
  });
});
