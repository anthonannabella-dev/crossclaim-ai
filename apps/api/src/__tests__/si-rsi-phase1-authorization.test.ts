/**
 * PHASE 1 / C4 —— 租户 / 账户 / 授权重解析与撤销拦截（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 对应 `MSG-20261008-16` CHANGE 4：
 *   · 执行前从**可信持久化事实**重新解析 organizationId 与 Standing Authorization；
 *   · 授权撤销 / 过期后不得继续执行受控动作；
 *   · 不可信容器（伪造 incident kind）与不可解析租户必须 BLOCK；
 *   · 拒绝必须是**持久化**的（任务落 BLOCKED + 原因码），而不是悄悄跳过。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CLAIM_AUTHORIZATION_DENY,
  createAutonomyTaskSource,
} from '../runtime/rsi-durable-task-source';
import { createPrismaTaskQueuePort } from '../services/agent-goal/prisma-task-queue-port';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-08T12:00:00.000Z');
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

const draft = (
  dedupeKey: string,
  requiresStanding = true,
): GoalTaskDraft => ({
  domain: 'LOGISTICS',
  dedupeKey,
  candidateActions: [],
  autoExecutableActions: [],
  blockedActions: [],
  executionMode: 'AUTO_WHEN_AUTHORIZED',
  requiresStandingAuthorizationForAutoExecution: requiresStanding,
});

const admit = (key: string, requiresStanding = true): Promise<unknown> =>
  createPrismaTaskQueuePort({ prisma, now: () => T0 }).admit({
    organizationId: 'org-A',
    tasks: [draft(key, requiresStanding)],
  });

async function seedOrganization(organizationId: string): Promise<void> {
  await prisma.organization.upsert({
    where: { id: organizationId },
    create: { id: organizationId, name: organizationId, slug: organizationId },
    update: {},
  });
}

async function seedStandingAuth(
  organizationId: string,
  options: { revocationState?: string; expiresAt?: Date; effectiveAt?: Date; version?: number } = {},
): Promise<void> {
  await seedOrganization(organizationId);
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
      effectiveAt: options.effectiveAt ?? new Date('2026-10-08T00:00:00.000Z'),
      expiresAt: options.expiresAt ?? new Date('2026-11-08T00:00:00.000Z'),
      authorizationVersion: options.version ?? 1,
      termsPolicyVersion: 'v1',
      consentEvidenceRef: 'evidence://test-seed',
      scopeDigest: 'a'.repeat(64),
      revocationState: options.revocationState ?? 'ACTIVE',
      // DB 约束 StandingAuthorization_revocation_chk：非 ACTIVE 必须带完整撤销凭证
      ...(options.revocationState === undefined || options.revocationState === 'ACTIVE'
        ? {}
        : { revokedAt: T0, revokedBy: 'owner@example.test', revocationReason: 'TEST_REVOKE' }),
      createdAt: T0,
    },
  });
}

async function truncateAutonomy(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AutonomyMetricResult", "AutonomyRollbackRecord", "AutonomyPromotionDecision", "AutonomyEvaluationRun", "AutonomyCandidate", "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE',
  );
}

const source = (ownerRef = 'worker-A') => createAutonomyTaskSource({ prisma, ownerRef, now: () => T0 });

beforeEach(async () => {
  await truncateAutonomy();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: 'org-A' } });
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: 'org-ghost' } });
});

afterAll(async () => {
  await truncateAutonomy();
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: { in: ['org-A', 'org-ghost'] } } });
  await prisma.$disconnect();
});

describe('PHASE 1 / C4 · 执行前授权重解析与撤销拦截', () => {
  it('C4-1 受控任务 + 有效 Standing Authorization ⇒ 允许领取', async () => {
    await seedStandingAuth('org-A');
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    const claimed = await source().claim(5);
    expect(claimed.map((t) => t.dedupeKey)).toEqual([key]);
    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
    expect(task.status).toBe('IN_PROGRESS');
  });

  it('C4-2 授权已撤销 ⇒ 拒绝领取，且任务被持久化 BLOCKED + 原因码', async () => {
    await seedStandingAuth('org-A', { revocationState: 'REVOKED' });
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    expect(await source().claim(5)).toEqual([]);
    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
    expect(task.status).toBe('BLOCKED');
    expect(task.lastErrorCode).toBe(CLAIM_AUTHORIZATION_DENY.STANDING_AUTHORIZATION_REVOKED);
    // 无租约残留
    expect(await prisma.autonomyLease.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('C4-3 授权已过期 ⇒ 拒绝领取并 BLOCK（撤销/过期的统一 fail-closed）', async () => {
    await seedStandingAuth('org-A', { expiresAt: new Date('2026-10-08T11:00:00.000Z') });
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key);
    expect(await source().claim(5)).toEqual([]);
    const task = await prisma.autonomyTask.findFirstOrThrow({ where: { dedupeKey: key } });
    expect(task.status).toBe('BLOCKED');
    expect(task.lastErrorCode).toBe(CLAIM_AUTHORIZATION_DENY.STANDING_AUTHORIZATION_REVOKED);
  });

  it('C4-4 不可信容器（非 CUSTOMER_GOAL_QUEUE 的 incident）⇒ 拒绝领取并 BLOCK', async () => {
    await seedStandingAuth('org-A');
    // 直接构造一个「非客户队列」容器下的 recovery 任务（模拟伪造 / 错误归属）
    const incident = await prisma.autonomyIncident.create({
      data: {
        kind: 'CI_RED',
        dedupeKey: 'INC:' + suffix(),
        status: 'OPEN',
        riskClass: 'LOW',
        sourceRefs: [{ organizationId: 'org-A' }],
        detectedAt: T0,
      },
    });
    const key = 'task:recovery:scan:v1:' + suffix();
    const task = await prisma.autonomyTask.create({
      data: { incidentId: incident.id, status: 'READY', riskClass: 'LOW', ownerGateRequired: true, dedupeKey: key },
    });
    expect(await source().claim(5)).toEqual([]);
    const after = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('BLOCKED');
    expect(after.lastErrorCode).toBe(CLAIM_AUTHORIZATION_DENY.UNTRUSTED_INCIDENT_KIND);
  });

  it('C4-5 租户不可解析 / 不存在 ⇒ 拒绝领取并 BLOCK（不信任自报 sourceRefs）', async () => {
    const incident = await prisma.autonomyIncident.create({
      data: {
        kind: 'CUSTOMER_GOAL_QUEUE',
        dedupeKey: 'customer-goal-queue:org-ghost',
        status: 'OPEN',
        riskClass: 'LOW',
        sourceRefs: [{ organizationId: 'org-ghost' }], // 库中不存在该 Organization
        detectedAt: T0,
      },
    });
    const key = 'task:recovery:scan:v1:' + suffix();
    const task = await prisma.autonomyTask.create({
      data: { incidentId: incident.id, status: 'READY', riskClass: 'LOW', ownerGateRequired: true, dedupeKey: key },
    });
    expect(await source().claim(5)).toEqual([]);
    const after = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('BLOCKED');
    expect(after.lastErrorCode).toBe(CLAIM_AUTHORIZATION_DENY.ORGANIZATION_NOT_FOUND);
  });

  it('C4-6 非受控任务（无需自动执行授权）⇒ 只要求租户真实存在，无需 Standing Authorization', async () => {
    await seedOrganization('org-A');
    const key = 'task:recovery:scan:v1:' + suffix();
    await admit(key, false);
    const claimed = await source().claim(5);
    expect(claimed.map((t) => t.dedupeKey)).toEqual([key]);
  });
});
