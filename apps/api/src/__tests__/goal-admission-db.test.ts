// CUSTOMER-UX FINAL2 — Goal admission（真实 PostgreSQL + 既有队列 artifact）
// 覆盖独立终审 CHANGE 2 / CHANGE 3 的最小闭环与安全边界。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admitAgentGoal,
  createJsonTaskQueuePort,
  findNonAdmissibleActions,
  recordGoalRunFromRuntime,
  requiredAuthorizationAction,
} from '../services/agent-goal/goal-admission';
import { compileAgentGoal } from '../services/agent-goal/goal-compiler';
import { resolveGoalCapabilities } from '../services/agent-goal/goal-capability-resolver';
import { defaultGoalCapabilityFacts } from '../services/agent-goal/http-request';
import { listAgentGoalRuns, loadAgentGoal, persistAgentGoal } from '../services/agent-goal/goal-store';
import { planAgentGoal, type GoalPlan } from '../services/agent-goal/goal-task-planner';
import { validateAgentGoalDraft } from '../services/agent-goal/goal-validator';
import {
  createPrismaStandingAuthorizationResolverDeps,
  persistStandingAuthorization,
  revokeStandingAuthorizationScope,
} from '../services/standing-authorization/standing-authorization-store';

const prisma = new PrismaClient();
const ORG = 'c0ffee00-0000-4000-8000-00000000000a';
const ORG_B = 'c0ffee00-0000-4000-8000-00000000000b';
const USER = 'c0ffee00-0000-4000-8000-0000000000f1';
const PROVIDER = 'AMAZON';
const INTENT = '帮我把 Amazon 上可以追回的钱找回来';
const NOW = new Date('2026-10-07T09:00:00.000Z');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-goal-admission-'));
const tasksPath = path.join(tmpDir, 'rsi-tasks.json');

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AgentGoalRun", "AgentGoal", "StandingAuthorization", "AuditLog", "Membership", "User", "PlatformAccount", "SourceConnection", "Organization" CASCADE;',
  );
  if (fs.existsSync(tasksPath)) fs.rmSync(tasksPath, { force: true });
}

async function seedOrg(organizationId: string, slug: string): Promise<void> {
  await prisma.organization.create({ data: { id: organizationId, name: slug, slug } });
}

async function seedAccount(organizationId: string, label: string): Promise<string> {
  const account = await prisma.platformAccount.create({
    data: { organizationId, platform: PROVIDER, externalAccountId: 'ext-' + label, displayName: label },
    select: { id: true },
  });
  return account.id;
}

async function seedGoal(organizationId: string): Promise<string> {
  const persisted = await persistAgentGoal(prisma, {
    organizationId,
    createdBy: USER,
    rawUserIntent: INTENT,
    normalizedGoal: { goalType: 'DISCOVER_AND_RECOVER', domains: ['PLATFORM'] },
    now: NOW,
  });
  return persisted.goalId;
}

function planFor(): GoalPlan {
  const compiled = compileAgentGoal({ text: INTENT });
  if (!compiled.ok) throw new Error('intent must compile');
  const validated = validateAgentGoalDraft({
    draft: compiled.draft,
    context: { organizationId: ORG, actorUserId: USER, now: NOW },
  });
  const capabilities = resolveGoalCapabilities({
    organizationId: ORG,
    domains: validated.domains,
    facts: defaultGoalCapabilityFacts(),
    now: NOW,
  });
  return planAgentGoal({ goal: validated, capabilities, now: NOW });
}

async function grantAuthorization(organizationId: string, platformAccountId: string, plan: GoalPlan) {
  const actions = new Set<string>();
  const required = requiredAuthorizationAction(plan);
  if (required !== null) actions.add(required);
  for (const task of plan.tasks) {
    for (const action of task.candidateActions) actions.add(action);
    for (const action of task.autoExecutableActions) actions.add(action);
  }
  return persistStandingAuthorization(prisma, {
    serverDerived: true,
    authorizationId: 'sa-' + organizationId.slice(0, 8),
    organizationId,
    platformAccountId,
    provider: PROVIDER,
    allowedActionTypes: [...actions],
    monetaryLimitUsd: 1000,
    currency: 'USD',
    domain: 'PLATFORM',
    jurisdiction: 'US',
    effectiveAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    authorizationVersion: 1,
    termsPolicyVersion: 'terms/v1',
    consentEvidenceRef: 'consent:test',
    createdAt: NOW.toISOString(),
    revocation: { state: 'ACTIVE', revokedAt: null, revokedBy: null, reason: null },
    scopeDigest: '',
  } as never);
}

function deps() {
  return {
    queue: createJsonTaskQueuePort({ tasksPath, now: () => NOW }),
    loadAuthorization: createPrismaStandingAuthorizationResolverDeps(prisma).loadAuthorization,
  };
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await truncate();
  await seedOrg(ORG, 'admission-org-a');
  await seedOrg(ORG_B, 'admission-org-b');
});

afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CUSTOMER-UX FINAL2 · Goal admission（真实 PostgreSQL）', () => {
  it('GA-1 缺 durable 授权 → REQUIRES_AUTHORIZATION；goal 仍 PROPOSED、零入队、零 run', async () => {
    const goalId = await seedGoal(ORG);
    const accountId = await seedAccount(ORG, 'ga-1');
    const result = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId, platformAccountId: accountId, provider: PROVIDER, now: NOW },
      deps(),
    );
    expect(result.kind).toBe('REQUIRES_AUTHORIZATION');
    expect(result.requiresAuthorization).toBe(true);
    expect(result.admitted).toEqual([]);
    expect(result.externalActionPerformed).toBe(false);
    expect((await loadAgentGoal(prisma, { organizationId: ORG, goalId }))?.status).toBe('PROPOSED');
    expect(await listAgentGoalRuns(prisma, { organizationId: ORG, goalId })).toEqual([]);
    expect(fs.existsSync(tasksPath)).toBe(false);
  });

  it('GA-2 有效 durable 授权 → ADMITTED：并入既有队列 artifact + PROPOSED→ADMITTED，外部写仍 false', async () => {
    const goalId = await seedGoal(ORG);
    const accountId = await seedAccount(ORG, 'ga-2');
    const plan = planFor();
    await grantAuthorization(ORG, accountId, plan);

    const result = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId, platformAccountId: accountId, provider: PROVIDER, now: NOW },
      deps(),
    );
    expect(result.kind).toBe('ADMITTED');
    expect(result.executedBy).toBe('ONE_SI_RUNTIME');
    expect(result.admissionOnly).toBe(true);
    expect(result.externalActionPerformed).toBe(false);
    expect(result.createdRuntime).toBe(false);
    expect(result.admitted.length).toBeGreaterThan(0);
    expect(result.admitted.every((key) => key.startsWith('task:recovery:'))).toBe(true);
    expect((await loadAgentGoal(prisma, { organizationId: ORG, goalId }))?.status).toBe('ADMITTED');

    const queued = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as { dedupeKey: string }[];
    expect(queued.length).toBe(result.admitted.length);
    // 准入 ≠ 执行：此时还没有执行投影
    expect(await listAgentGoalRuns(prisma, { organizationId: ORG, goalId })).toEqual([]);
  });

  it('GA-3 重复准入不产生第二次入队（dedupeKey 幂等）', async () => {
    const goalId = await seedGoal(ORG);
    const accountId = await seedAccount(ORG, 'ga-3');
    await grantAuthorization(ORG, accountId, planFor());
    const first = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId, platformAccountId: accountId, provider: PROVIDER, now: NOW },
      deps(),
    );
    const second = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId, platformAccountId: accountId, provider: PROVIDER, now: NOW },
      deps(),
    );
    expect(second.admitted).toEqual([]);
    expect(second.alreadyPresent).toEqual(first.admitted);
    const queued = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as { dedupeKey: string }[];
    expect(queued.length).toBe(first.admitted.length);
  });

  it('GA-4 既有 runtime 认领后落 run projection；重复不产生第二次执行记录', async () => {
    const goalId = await seedGoal(ORG);
    const accountId = await seedAccount(ORG, 'ga-4');
    await grantAuthorization(ORG, accountId, planFor());
    const admission = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId, platformAccountId: accountId, provider: PROVIDER, now: NOW },
      deps(),
    );

    const first = await recordGoalRunFromRuntime(prisma, {
      organizationId: ORG,
      goalId,
      outcome: { claimed: admission.admitted, completed: admission.admitted, blocked: [] },
      now: NOW,
    });
    expect(first.created).toBe(true);
    expect(first.status).toBe('COMPLETED');

    const second = await recordGoalRunFromRuntime(prisma, {
      organizationId: ORG,
      goalId,
      outcome: { claimed: admission.admitted, completed: admission.admitted, blocked: [] },
      now: NOW,
    });
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);

    const runs = await listAgentGoalRuns(prisma, { organizationId: ORG, goalId });
    expect(runs).toHaveLength(1);
    const summary = runs[0]?.summary as { externalWritePerformed?: boolean; executedBy?: string };
    expect(summary.externalWritePerformed).toBe(false);
    expect(summary.executedBy).toBe('ONE_SI_RUNTIME');

    // 已有执行投影后再次准入：不再入队
    const again = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId, platformAccountId: accountId, provider: PROVIDER, now: NOW },
      deps(),
    );
    expect(again.kind).toBe('ALREADY_ADMITTED');
  });

  it('GA-5 授权撤销后不得继续：admit 拒绝，且不再入队', async () => {
    const goalId = await seedGoal(ORG);
    const accountId = await seedAccount(ORG, 'ga-5');
    await grantAuthorization(ORG, accountId, planFor());
    await revokeStandingAuthorizationScope(prisma, {
      organizationId: ORG,
      platformAccountId: accountId,
      provider: PROVIDER,
      revokedBy: USER,
      reason: 'acceptance revoke',
      at: NOW,
    });
    const result = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId, platformAccountId: accountId, provider: PROVIDER, now: NOW },
      deps(),
    );
    expect(result.kind).toBe('DENIED');
    expect(result.admitted).toEqual([]);
    expect(fs.existsSync(tasksPath)).toBe(false);
    expect((await loadAgentGoal(prisma, { organizationId: ORG, goalId }))?.status).toBe('PROPOSED');
  });

  it('GA-6 跨租户：别租户的 goal / account 一律不可准入（goal 仍不存在语义）', async () => {
    const foreignGoal = await seedGoal(ORG_B);
    const ownAccount = await seedAccount(ORG, 'ga-6');
    const result = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId: foreignGoal, platformAccountId: ownAccount, provider: PROVIDER, now: NOW },
      deps(),
    );
    expect(result.kind).toBe('NOT_FOUND');
    expect(fs.existsSync(tasksPath)).toBe(false);
  });

  it('GA-8 同租户但账户域不匹配（Amazon Goal + UPS 账户）→ DENIED / GOAL_SCOPE_MISMATCH，零入队', async () => {
    const goalId = await seedGoal(ORG);
    const upsAccountId = await prisma.platformAccount.create({
      data: { organizationId: ORG, platform: 'UPS', externalAccountId: 'ups-ga8', displayName: 'UPS' },
      select: { id: true },
    });
    await grantAuthorization(ORG, upsAccountId.id, planFor());
    const result = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId, platformAccountId: upsAccountId.id, provider: 'UPS', now: NOW },
      deps(),
    );
    expect(result.kind).toBe('DENIED');
    expect(result.reasonCodes).toContain('GOAL_SCOPE_MISMATCH');
    expect(result.admitted).toEqual([]);
    expect(fs.existsSync(tasksPath)).toBe(false);
  });

  it('GA-9 客户端 provider 与账户事实不一致 → PROVIDER_SCOPE_MISMATCH', async () => {
    const goalId = await seedGoal(ORG);
    const accountId = await seedAccount(ORG, "ga-9");
    await grantAuthorization(ORG, accountId, planFor());
    const result = await admitAgentGoal(
      prisma,
      { organizationId: ORG, goalId, platformAccountId: accountId, provider: 'UPS', now: NOW },
      deps(),
    );
    expect(result.kind).toBe('DENIED');
    expect(result.reasonCodes).toContain('PROVIDER_SCOPE_MISMATCH');
  });

  it('GA-10 runtime claim 与 Goal 计划不符 → GOAL_RUNTIME_LINEAGE_MISMATCH，且不落投影', async () => {
    const goalId = await seedGoal(ORG);
    await expect(
      recordGoalRunFromRuntime(prisma, {
        organizationId: ORG,
        goalId,
        outcome: { claimed: ['task:recovery:PLATFORM:not-this-goals-task'], completed: [], blocked: [] },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'GOAL_RUNTIME_LINEAGE_MISMATCH' });
    expect(await listAgentGoalRuns(prisma, { organizationId: ORG, goalId })).toEqual([]);
  });
  it('GA-7 非可绕过 gate / 高风险动作不被准入放行（external write = HOLD）', () => {
    const plan = planFor();
    const withExternalWrite: GoalPlan = {
      ...plan,
      tasks: [
        ...plan.tasks,
        {
          ...plan.tasks[0],
          dedupeKey: 'task:recovery:PLATFORM:claim-submit-probe',
          candidateActions: ['claim.submit'],
          autoExecutableActions: ['claim.submit'],
        },
      ],
    };
    const blocked = findNonAdmissibleActions(withExternalWrite);
    const claimSubmit = blocked.find((entry) => entry.action === 'claim.submit');
    expect(claimSubmit).toBeDefined();
    expect(claimSubmit?.gates).toContain('productionGate');
    expect(claimSubmit?.gates).toContain('platformEnablement');
  });
});
