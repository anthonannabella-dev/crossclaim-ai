// AGENT EXPERIENCE LAYER / P3 —— Goal 持久化 · 真实 PostgreSQL 验收
// ---------------------------------------------------------------------------
// 覆盖：落库/读取/重启后可读 · 重复提交幂等 · 凭据类内容拒绝 · 状态机 fail-closed ·
// 租户隔离（含 Run 的 goalId 同租户校验）· 身份不可改写 · 数据库 CHECK 兜底 ·
// 以及「goal / run 不是任何业务事实 SSOT」的边界断言。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_GOAL_PERSISTENCE_BOUNDARY,
  AgentGoalStoreError,
  assertGoalRecordIsNotBusinessTruth,
  computeAgentGoalId,
  createAgentGoalRun,
  listAgentGoalRuns,
  listAgentGoals,
  loadAgentGoal,
  persistAgentGoal,
  updateAgentGoalRunStatus,
  updateAgentGoalStatus,
} from '../services/agent-goal';

const prisma = new PrismaClient();
const NOW = new Date('2026-10-07T07:00:00.000Z');
const ORG = 'org-goal-p3-1';
const OTHER_ORG = 'org-goal-p3-2';
const INTENT = '检查我过去12个月所有可以追回的钱，Amazon、物流和关税全部检查';
const NORMALIZED = {
  goalType: 'DISCOVER_AND_RECOVER',
  domains: ['PLATFORM', 'LOGISTICS', 'CUSTOMS'],
  timeRange: { kind: 'LAST_N_MONTHS', months: 12 },
  executionMode: 'AUTO_WHEN_AUTHORIZED',
};

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE "AgentGoalRun", "AgentGoal" RESTART IDENTITY CASCADE');
}

beforeEach(async () => {
  await truncate();
});

afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

async function seedGoal(organizationId = ORG): Promise<string> {
  const result = await persistAgentGoal(prisma, {
    organizationId,
    createdBy: 'user-1',
    rawUserIntent: INTENT,
    normalizedGoal: NORMALIZED,
    now: NOW,
  });
  return result.goalId;
}

describe('P3 · Goal 持久化（真实 PostgreSQL）', () => {
  it('PG-AG1 落库 → 读取（含进程重启等价的新连接）一致；goalId 由内容确定性派生', async () => {
    const goalId = await seedGoal();
    expect(goalId).toBe(computeAgentGoalId({ organizationId: ORG, rawUserIntent: INTENT, normalizedGoal: NORMALIZED }));

    const restarted = new PrismaClient();
    try {
      const loaded = await loadAgentGoal(restarted, { organizationId: ORG, goalId });
      expect(loaded?.status).toBe('PROPOSED');
      expect(loaded?.createdBy).toBe('user-1');
      expect(loaded?.rawUserIntent).toBe(INTENT);
      expect(loaded?.normalizedGoal).toEqual(NORMALIZED);
    } finally {
      await restarted.$disconnect();
    }
  });

  it('PG-AG2 重复提交同一目标幂等（REUSED，只有 1 行）', async () => {
    const first = await persistAgentGoal(prisma, {
      organizationId: ORG,
      createdBy: 'user-1',
      rawUserIntent: INTENT,
      normalizedGoal: NORMALIZED,
      now: NOW,
    });
    const second = await persistAgentGoal(prisma, {
      organizationId: ORG,
      createdBy: 'user-1',
      rawUserIntent: INTENT,
      normalizedGoal: NORMALIZED,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(first.kind).toBe('CREATED');
    expect(second).toEqual({ kind: 'REUSED', goalId: first.goalId });
    expect(await prisma.agentGoal.count()).toBe(1);
  });

  it('PG-AG3 凭据类内容 / 畸形输入 → 拒绝（不落库）', async () => {
    await expect(
      persistAgentGoal(prisma, {
        organizationId: ORG,
        createdBy: 'user-1',
        rawUserIntent: 'my password is hunter2',
        normalizedGoal: NORMALIZED,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_GOAL_STORE_FORBIDDEN_CONTENT' });

    await expect(
      persistAgentGoal(prisma, {
        organizationId: ORG,
        createdBy: 'user-1',
        rawUserIntent: '   ',
        normalizedGoal: NORMALIZED,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_GOAL_STORE_MALFORMED' });

    await expect(
      persistAgentGoal(prisma, {
        organizationId: ORG,
        createdBy: 'user-1',
        rawUserIntent: 'x'.repeat(700),
        normalizedGoal: NORMALIZED,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_GOAL_STORE_MALFORMED' });

    await expect(
      persistAgentGoal(prisma, {
        organizationId: ORG,
        createdBy: 'user-1',
        rawUserIntent: INTENT,
        normalizedGoal: ['not', 'an', 'object'],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_GOAL_STORE_MALFORMED' });

    expect(await prisma.agentGoal.count()).toBe(0);
  });

  it('PG-AG4 goal 状态迁移 fail-closed：非法迁移拒绝、终态不可再变', async () => {
    const goalId = await seedGoal();
    await expect(
      updateAgentGoalStatus(prisma, { organizationId: ORG, goalId, nextStatus: 'RUNNING', now: NOW }),
    ).rejects.toMatchObject({ code: 'AGENT_GOAL_STORE_INVALID_TRANSITION' });

    expect((await updateAgentGoalStatus(prisma, { organizationId: ORG, goalId, nextStatus: 'ADMITTED', now: NOW })).status).toBe(
      'ADMITTED',
    );
    expect((await updateAgentGoalStatus(prisma, { organizationId: ORG, goalId, nextStatus: 'RUNNING', now: NOW })).status).toBe(
      'RUNNING',
    );
    expect(
      (await updateAgentGoalStatus(prisma, { organizationId: ORG, goalId, nextStatus: 'COMPLETED', now: NOW })).status,
    ).toBe('COMPLETED');
    await expect(
      updateAgentGoalStatus(prisma, { organizationId: ORG, goalId, nextStatus: 'RUNNING', now: NOW }),
    ).rejects.toMatchObject({ code: 'AGENT_GOAL_STORE_INVALID_TRANSITION' });
  });

  it('PG-AG5 tenant 隔离：跨租户读取恒空、更新恒 NOT_FOUND', async () => {
    const goalId = await seedGoal();
    expect(await loadAgentGoal(prisma, { organizationId: OTHER_ORG, goalId })).toBeNull();
    expect(await listAgentGoals(prisma, { organizationId: OTHER_ORG })).toEqual([]);
    await expect(
      updateAgentGoalStatus(prisma, { organizationId: OTHER_ORG, goalId, nextStatus: 'ADMITTED', now: NOW }),
    ).rejects.toMatchObject({ code: 'AGENT_GOAL_STORE_NOT_FOUND' });
  });

  it('PG-AG6 Run 生命周期：QUEUED → RUNNING → COMPLETED（带摘要与 completedAt），非法迁移拒绝', async () => {
    const goalId = await seedGoal();
    const run = await createAgentGoalRun(prisma, { organizationId: ORG, goalId, now: NOW });
    expect(run.status).toBe('QUEUED');
    expect(run.completedAt).toBeNull();

    await expect(
      updateAgentGoalRunStatus(prisma, { organizationId: ORG, runId: run.runId, nextStatus: 'COMPLETED', now: NOW }),
    ).rejects.toMatchObject({ code: 'AGENT_GOAL_STORE_INVALID_TRANSITION' });

    const running = await updateAgentGoalRunStatus(prisma, {
      organizationId: ORG,
      runId: run.runId,
      nextStatus: 'RUNNING',
      now: NOW,
    });
    expect(running.status).toBe('RUNNING');

    const done = await updateAgentGoalRunStatus(prisma, {
      organizationId: ORG,
      runId: run.runId,
      nextStatus: 'COMPLETED',
      summary: { scannedAccounts: 4, references: ['opp-1', 'case-1'] },
      now: new Date(NOW.getTime() + 120_000),
    });
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).not.toBeNull();
    expect(done.summary).toEqual({ scannedAccounts: 4, references: ['opp-1', 'case-1'] });

    const runs = await listAgentGoalRuns(prisma, { organizationId: ORG, goalId });
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe(run.runId);
  });

  it('PG-AG7 数据库兜底：身份不可改写 / Run 跨租户 goalId / 非法状态 / 终态缺 completedAt 全被拒', async () => {
    const goalId = await seedGoal();

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "AgentGoal" SET "rawUserIntent" = 'tampered' WHERE "id" = '${goalId}'`),
    ).rejects.toThrow(/AGENT_GOAL_IDENTITY_IMMUTABLE/);

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "AgentGoal" SET "organizationId" = '${OTHER_ORG}' WHERE "id" = '${goalId}'`),
    ).rejects.toThrow(/AGENT_GOAL_IDENTITY_IMMUTABLE|tenant|租户/i);

    // Run 引用别租户的 goal → 租户触发器拒绝
    await expect(
      prisma.agentGoalRun.create({
        data: {
          organizationId: OTHER_ORG,
          goalId,
          status: 'QUEUED',
          startedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ).rejects.toThrow(/cross-tenant reference blocked|check_violation/i);

    // Run 身份不可改写（goalId）
    const run = await createAgentGoalRun(prisma, { organizationId: ORG, goalId, now: NOW });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "AgentGoalRun" SET "goalId" = 'other-goal' WHERE "id" = '${run.runId}'`),
    ).rejects.toThrow(/AGENT_GOAL_RUN_IDENTITY_IMMUTABLE/);

    // CHECK 兜底
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AgentGoal" ("id","organizationId","createdBy","rawUserIntent","normalizedGoal","status","createdAt","updatedAt") VALUES ('bad-1','${ORG}','u1','x','{}'::jsonb,'WEIRD',now(),now())`,
      ),
    ).rejects.toThrow(/AgentGoal_status_chk/);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AgentGoalRun" ("id","organizationId","goalId","status","startedAt","completedAt","createdAt","updatedAt") VALUES ('bad-run','${ORG}','${goalId}','COMPLETED',now(),NULL,now(),now())`,
      ),
    ).rejects.toThrow(/AgentGoalRun_terminal_chk/);
  });

  it('PG-AG8 边界：goal / run 只是客户意图与执行投影，不是任何业务事实 SSOT', async () => {
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.isCustomerIntent).toBe(true);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.isExecutionProjection).toBe(true);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.isOpportunitySsot).toBe(false);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.isCaseSsot).toBe(false);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.isClaimSsot).toBe(false);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.isEvidenceSsot).toBe(false);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.isMoneySsot).toBe(false);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.isSettlementSsot).toBe(false);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.isRecoveryStateMachine).toBe(false);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.grantsPermissions).toBe(false);
    expect(AGENT_GOAL_PERSISTENCE_BOUNDARY.performsExternalAction).toBe(false);
    expect(() => assertGoalRecordIsNotBusinessTruth({ usedAsMoneySsot: false })).not.toThrow();
    expect(() => assertGoalRecordIsNotBusinessTruth({ usedAsOpportunitySsot: true })).toThrow(AgentGoalStoreError);
  });
});
