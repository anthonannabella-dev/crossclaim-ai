/**
 * SI-COST-OPTIMIZATION C3 —— 真实 PostgreSQL 取证（MSG-20261005-37：C3 IMPLEMENTATION = AUTHORIZED）
 * 覆盖：concurrencyLimit 多实例互斥（advisory-lock slots）/ Cost Safe Mode 由 durable policy+ledger 驱动 /
 *      admin 只读可观测投影（无第二事实源、无写入）/ cache runtime tenant-safe。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appendAiCostEntry } from '../services/autonomy/si-cost-ledger-store';
import { upsertAiBudgetPolicy } from '../services/autonomy/si-budget-policy-store';
import {
  AI_CONCURRENCY_BOUNDARY,
  withAiBudgetConcurrencySlots,
} from '../services/autonomy/si-budget-concurrency';
import {
  AI_COST_OBSERVABILITY_BOUNDARY,
  readAiCostObservability,
} from '../services/autonomy/si-cost-observability';
import {
  AI_COST_SAFE_MODE_BOUNDARY,
  decideAiCostSafeModeAdmission,
} from '../services/autonomy/si-cost-safe-mode';
import {
  createAiCostSafeModeStandardAiPort,
  resolveAiCostSafeMode,
} from '../services/autonomy/si-cost-safe-mode-store';
import { createRsiLocalSimModelProviderComposition } from '../services/autonomy/rsi-model-provider-composition';
import {
  AI_MODEL_CACHE_RUNTIME_BOUNDARY,
  createAiModelCacheRuntime,
} from '../services/autonomy/si-model-cache-runtime';

const prisma = new PrismaClient();
let orgA = '';
let orgB = '';

const costEntry = (callId: string, over: Record<string, unknown> = {}) => ({
  callId,
  incidentId: 'inc-1',
  taskId: 'task-1',
  organizationId: orgA,
  accountId: null,
  provider: 'rsi-local-sim-low-cost',
  model: 'lowcost-model',
  executionLevel: 'LEVEL_1_LOW_COST',
  taskType: 'SEMANTIC',
  inputTokens: 100,
  outputTokens: 20,
  costMicros: 1_000,
  latencyMs: 10,
  result: 'SUCCESS',
  ...over,
}) as Parameters<typeof appendAiCostEntry>[1];

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  orgA = randomUUID();
  orgB = randomUUID();
  await prisma.organization.create({ data: { id: orgA, name: 'C3 A', slug: 'c3-a-' + suffix } });
  await prisma.organization.create({ data: { id: orgB, name: 'C3 B', slug: 'c3-b-' + suffix } });
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AiBudgetPolicy", "AiModelCacheEntry", "AiCostLedgerEntry" CASCADE');
});

afterAll(async () => {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE ' + tables.map((r) => '"' + r.tablename + '"').join(', ') + ' CASCADE;');
  }
  await prisma.$disconnect();
});

describe('SI-COST C3 · concurrencyLimit enforcement（多实例互斥）', () => {
  it('C3_DB1 limit=1：两个并发客户端恰好一个获得槽位，另一个被拒绝', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'PLATFORM', scopeRef: '*', concurrencyLimit: 1 });
    const p1 = new PrismaClient();
    const p2 = new PrismaClient();
    try {
      let release: () => void = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => {};
      const enteredP = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const first = withAiBudgetConcurrencySlots({
        prisma: p1,
        refs: { organizationId: orgA },
        run: async () => {
          entered();
          await hold;
          return 'first';
        },
      });
      await enteredP;
      const second = await withAiBudgetConcurrencySlots({
        prisma: p2,
        refs: { organizationId: orgA },
        run: async () => 'second',
      });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe('AI_BUDGET_CONCURRENCY_EXCEEDED');
      release();
      const firstResult = await first;
      expect(firstResult.ok).toBe(true);
      // 槽位在调用结束后自动释放（事务级 advisory lock）
      const third = await withAiBudgetConcurrencySlots({
        prisma: p2,
        refs: { organizationId: orgA },
        run: async () => 'third',
      });
      expect(third.ok).toBe(true);
      expect(AI_CONCURRENCY_BOUNDARY.inProcessCounterOnly).toBe('FORBIDDEN');
      expect(AI_CONCURRENCY_BOUNDARY.newTruthTable).toContain('FORBIDDEN');
    } finally {
      await p1.$disconnect();
      await p2.$disconnect();
    }
  });

  it('C3_DB2 limit=2：两个并发占用后第三个被拒绝', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'PLATFORM', scopeRef: '*', concurrencyLimit: 2 });
    const clients = [new PrismaClient(), new PrismaClient(), new PrismaClient()];
    try {
      const releases: Array<() => void> = [];
      const entered: Array<Promise<void>> = [];
      const holders = [0, 1].map((index) => {
        let release: () => void = () => {};
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        releases.push(release);
        let mark: () => void = () => {};
        entered.push(
          new Promise<void>((resolve) => {
            mark = resolve;
          }),
        );
        return withAiBudgetConcurrencySlots({
          prisma: clients[index],
          refs: { organizationId: orgA },
          run: async () => {
            mark();
            await hold;
            return index;
          },
        });
      });
      await Promise.all(entered);
      const third = await withAiBudgetConcurrencySlots({
        prisma: clients[2],
        refs: { organizationId: orgA },
        run: async () => 'third',
      });
      expect(third.ok).toBe(false);
      releases.forEach((release) => release());
      const results = await Promise.all(holders);
      expect(results.every((r) => r.ok)).toBe(true);
    } finally {
      for (const client of clients) await client.$disconnect();
    }
  });

  it('C3_DB3 未配置 concurrencyLimit → 不开启事务，直接执行', async () => {
    const result = await withAiBudgetConcurrencySlots({
      prisma,
      refs: { organizationId: orgA },
      run: async () => 'ran',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('ran');
      expect(result.heldKeys).toHaveLength(0);
    }
  });
});

describe('SI-COST C3 · Cost Safe Mode（durable policy + durable ledger 驱动）', () => {
  it('C3_DB4 账本累计触及日预算 → COST_SAFE；LEVEL_0_RULE 仍豁免放行', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'PLATFORM', scopeRef: '*', dailyLimitMicros: 5_000 });
    await appendAiCostEntry(prisma, costEntry('c3-call-' + randomUUID(), { costMicros: 3_000 }));
    const before = await readAiCostObservability(prisma, { refs: { organizationId: orgA } });
    expect(before.safeMode.state).toBe('NORMAL');
    expect(before.budgetRemaining.dailyMicros).toBe(2_000);

    await appendAiCostEntry(prisma, costEntry('c3-call-' + randomUUID(), { costMicros: 2_000 }));
    const after = await readAiCostObservability(prisma, { refs: { organizationId: orgA } });
    expect(after.safeMode.state).toBe('COST_SAFE');
    expect(after.safeMode.exhaustedDimensions).toContain('DAILY');
    expect(decideAiCostSafeModeAdmission({ verdict: after.safeMode, channel: 'STANDARD_AI' }).allowed).toBe(false);
    expect(decideAiCostSafeModeAdmission({ verdict: after.safeMode, channel: 'LEVEL_0_RULE' }).allowed).toBe(true);
    expect(decideAiCostSafeModeAdmission({ verdict: after.safeMode, channel: 'HEALTH_CHECK' }).allowed).toBe(true);
    expect(decideAiCostSafeModeAdmission({ verdict: after.safeMode, channel: 'CRITICAL_ALERT' }).allowed).toBe(true);
    expect(AI_COST_SAFE_MODE_BOUNDARY.retryStormAllowed).toBe(false);
  });
});

describe('SI-COST C3 · Admin 只读可观测投影（无第二事实源）', () => {
  it('C3_DB5 投影只读：来自 durable ledger，无写入，敏感内容不暴露', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'PLATFORM', scopeRef: '*', dailyLimitMicros: 100_000, strongCallLimit: 3 });
    await appendAiCostEntry(prisma, costEntry('c3-call-' + randomUUID(), { costMicros: 1_000 }));
    await appendAiCostEntry(
      prisma,
      costEntry('c3-call-' + randomUUID(), { costMicros: 4_000, executionLevel: 'LEVEL_2_STRONG', model: 'strong-model' }),
    );
    const before = await prisma.aiCostLedgerEntry.count();
    const snapshot = await readAiCostObservability(prisma, { refs: { organizationId: orgA } });
    const after = await prisma.aiCostLedgerEntry.count();
    expect(after).toBe(before);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.sensitiveDataIncluded).toBe(false);
    expect(snapshot.cost.todayMicros).toBe(5_000);
    expect(snapshot.cost.lowCostCallsToday).toBe(1);
    expect(snapshot.cost.strongCallsToday).toBe(1);
    expect(snapshot.cost.tokensToday).toBe(240);
    expect(snapshot.budgetRemaining.dailyMicros).toBe(95_000);
    // C3 FINAL-2 CHANGE D：仅 local-sim 流量 → 生产指标必须 NOT_YET_MEASURABLE（dev 计数另行展示）
    expect(snapshot.provenance.modelTraffic).toBe('LOCAL_SIMULATION_ONLY');
    expect(snapshot.metrics.LOW_COST_MODEL_RATE).toBe('NOT_YET_MEASURABLE');
    expect(snapshot.metrics.STRONG_MODEL_RATE).toBe('NOT_YET_MEASURABLE');
    expect(snapshot.devSimulation.lowCostCallsToday).toBe(1);
    expect(snapshot.devSimulation.strongCallsToday).toBe(1);
    expect(snapshot.metrics.RULE_RESOLVED_RATE).toBe('NOT_YET_MEASURABLE');
    expect(snapshot.metrics.CACHE_HIT_RATE).toBe('NOT_YET_MEASURABLE');
    expect(snapshot.metrics.AVG_AI_COST_PER_SUCCESSFUL_RECOVERY).toBe('NOT_YET_MEASURABLE');
    expect(snapshot.topCostIncidences[0]?.incidentId).toBe('inc-1');
    expect(AI_COST_OBSERVABILITY_BOUNDARY.secondUsageTable).toContain('FORBIDDEN');
    expect(AI_COST_OBSERVABILITY_BOUNDARY.writesRows).toBe(false);
  });

  it('C3_DB6 tenant 隔离：投影只聚合本租户账本', async () => {
    await appendAiCostEntry(prisma, costEntry('c3-call-' + randomUUID(), { organizationId: orgA, costMicros: 700 }));
    await appendAiCostEntry(prisma, costEntry('c3-call-' + randomUUID(), { organizationId: orgB, costMicros: 300 }));
    const snapshot = await readAiCostObservability(prisma, { refs: { organizationId: orgA } });
    expect(snapshot.cost.todayMicros).toBe(700);
    expect(snapshot.costByScope.organizationMicros).toBe(700);
  });
});

describe('SI-COST C3 · cache runtime（tenant-safe identity + 受控 TTL）', () => {
  it('C3_DB7 同租户身份命中；tenant / ruleVersion 不符 = MISS；缺 tenant = fail-closed', async () => {
    const runtime = createAiModelCacheRuntime(prisma, { defaultTtlMs: 60_000 });
    const scope = {
      taskType: 'SEMANTIC',
      promptDigest: 'b'.repeat(64),
      inputDigest: 'c'.repeat(64),
      ruleVersion: 'rule/v1',
      schemaVersion: 'schema/v1',
      capabilityTier: 'LOW_COST',
      organizationId: orgA,
    };
    await runtime.storeResult({ scope, resultDigest: 'f'.repeat(64) });
    const hit = await runtime.lookup({ scope });
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      expect(hit.resultDigest).toBe('f'.repeat(64));
      expect(hit.savingsSource).toBe('NOT_YET_MEASURABLE');
    }
    const crossTenant = await runtime.lookup({ scope: { ...scope, organizationId: orgB } });
    expect(crossTenant.hit).toBe(false);
    const wrongRule = await runtime.lookup({ scope: { ...scope, ruleVersion: 'rule/v2' } });
    expect(wrongRule.hit).toBe(false);
    await expect(runtime.lookup({ scope: { ...scope, organizationId: null } })).rejects.toThrow(
      'AI_MODEL_CACHE_TENANT_REQUIRED',
    );
    expect(AI_MODEL_CACHE_RUNTIME_BOUNDARY.staleFallback).toBe('FORBIDDEN');
  });

  it('C3_DB8 显式 savings 估算器 → 登记真实口径（正数，单位 micros）', async () => {
    const runtime = createAiModelCacheRuntime(prisma, {
      defaultTtlMs: 60_000,
      estimateSavings: () => ({ savedTokens: 120, savedCostMicros: 900 }),
    });
    const scope = {
      taskType: 'SEMANTIC',
      promptDigest: 'b'.repeat(64),
      inputDigest: 'c'.repeat(64),
      ruleVersion: 'rule/v1',
      schemaVersion: 'schema/v1',
      capabilityTier: 'LOW_COST',
      organizationId: orgA,
    };
    await runtime.storeResult({ scope, resultDigest: 'f'.repeat(64) });
    const hit = await runtime.lookup({ scope });
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      expect(hit.savingsSource).toBe('ESTIMATOR');
      expect(hit.savedTokens).toBe(120);
      expect(hit.savedCostMicros).toBe(900);
    }
  });
});

describe('SI-COST C3 FINAL-2 · concurrency 0/null 语义 + scope-correct Safe Mode + 指标 provenance', () => {
  it('C3_F2_B1 concurrencyLimit = 0 → 零并发（拒绝，绝不退化为 unlimited）', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'PLATFORM', scopeRef: '*', concurrencyLimit: 0 });
    const result = await withAiBudgetConcurrencySlots({
      prisma,
      refs: { organizationId: orgA },
      run: async () => 'never',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('AI_BUDGET_CONCURRENCY_EXCEEDED');
    expect(AI_CONCURRENCY_BOUNDARY.zeroMeans).toContain('DENY_ALL');
    expect(AI_CONCURRENCY_BOUNDARY.nullMeans).toContain('NOT_CONFIGURED');
  });

  it('C3_F2_B2 concurrencyLimit = null → 未配置语义（直接执行）', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'PLATFORM', scopeRef: '*', concurrencyLimit: null });
    const result = await withAiBudgetConcurrencySlots({
      prisma,
      refs: { organizationId: orgA },
      run: async () => 'ran',
    });
    expect(result.ok).toBe(true);
  });

  it('C3_F2_C1 org 日预算被多个 incident 合计触顶 → 任一 nested incident 查询均 COST_SAFE', async () => {
    await upsertAiBudgetPolicy(prisma, {
      scope: 'ORGANIZATION',
      scopeRef: orgA,
      organizationId: orgA,
      dailyLimitMicros: 1_000,
    });
    await appendAiCostEntry(prisma, costEntry('c3f2-' + randomUUID(), { incidentId: 'inc-A', costMicros: 900 }));
    await appendAiCostEntry(prisma, costEntry('c3f2-' + randomUUID(), { incidentId: 'inc-B', costMicros: 100 }));
    const forB = await readAiCostObservability(prisma, { refs: { organizationId: orgA, incidentId: 'inc-B' } });
    // 窄 usage（inc-B）只有 100，但 org 已 1000 → 必须 COST_SAFE（不得被 narrow usage 绕过）
    expect(forB.cost.todayMicros).toBe(100);
    expect(forB.safeMode.state).toBe('COST_SAFE');
    expect(forB.safeMode.exhaustedDimensions).toContain('DAILY');
    const forA = await readAiCostObservability(prisma, { refs: { organizationId: orgA, incidentId: 'inc-A' } });
    expect(forA.safeMode.state).toBe('COST_SAFE');
  });

  it('C3_F2_C2 account 父级预算不能被 narrow task usage 绕过', async () => {
    const accountId = 'acct-' + randomUUID();
    await upsertAiBudgetPolicy(prisma, {
      scope: 'ACCOUNT',
      scopeRef: accountId,
      organizationId: orgA,
      dailyLimitMicros: 500,
    });
    await appendAiCostEntry(
      prisma,
      costEntry('c3f2-' + randomUUID(), { accountId, taskId: 'task-1', costMicros: 300 }),
    );
    await appendAiCostEntry(
      prisma,
      costEntry('c3f2-' + randomUUID(), { accountId, taskId: 'task-2', costMicros: 200 }),
    );
    const snapshot = await readAiCostObservability(prisma, {
      refs: { organizationId: orgA, accountId, taskId: 'task-2' },
    });
    expect(snapshot.cost.todayMicros).toBe(200);
    expect(snapshot.safeMode.state).toBe('COST_SAFE');
  });

  it('C3_F2_C3 perIncident 无 incidentId → NOT_APPLICABLE（不拿 scope lifetime 代替）', async () => {
    await upsertAiBudgetPolicy(prisma, {
      scope: 'ORGANIZATION',
      scopeRef: orgA,
      organizationId: orgA,
      perIncidentLimitMicros: 100,
    });
    await appendAiCostEntry(prisma, costEntry('c3f2-' + randomUUID(), { incidentId: 'inc-A', costMicros: 5_000 }));
    const resolution = await resolveAiCostSafeMode(prisma, { refs: { organizationId: orgA } });
    expect(resolution.perIncidentDimension).toBe('NOT_APPLICABLE');
    expect(resolution.verdict.state).toBe('NORMAL');
  });

  it('C3_F3_B1 仅凭 provider 名称不得令 production metrics measurable', async () => {
    await appendAiCostEntry(prisma, costEntry('c3f2-' + randomUUID(), { provider: 'rsi-local-sim-low-cost', costMicros: 100 }));
    await appendAiCostEntry(
      prisma,
      costEntry('c3f2-' + randomUUID(), { provider: 'fake-real-provider', executionLevel: 'LEVEL_2_STRONG', costMicros: 200 }),
    );
    const snapshot = await readAiCostObservability(prisma, { refs: { organizationId: orgA } });
    expect(snapshot.provenance.modelTraffic).toBe('LOCAL_SIMULATION_ONLY');
    expect(snapshot.provenance.realProviderNames).toHaveLength(0);
    expect(snapshot.metrics.STRONG_MODEL_RATE).toBe('NOT_YET_MEASURABLE');
    expect(snapshot.metrics.LOW_COST_MODEL_RATE).toBe('NOT_YET_MEASURABLE');
  });

  it('C3_F3_B2 只有 server-owned trusted registry 命中才可计 REAL_PROVIDER', async () => {
    await appendAiCostEntry(prisma, costEntry('c3f2-' + randomUUID(), { provider: 'rsi-local-sim-low-cost', costMicros: 100 }));
    await appendAiCostEntry(
      prisma,
      costEntry('c3f2-' + randomUUID(), { provider: 'amazon-ads-readonly', executionLevel: 'LEVEL_2_STRONG', costMicros: 200 }),
    );
    const snapshot = await readAiCostObservability(prisma, {
      refs: { organizationId: orgA },
      trustedRealProviders: ['amazon-ads-readonly'],
    });
    expect(snapshot.provenance.modelTraffic).toBe('REAL_PROVIDER');
    expect(snapshot.provenance.realProviderNames).toContain('amazon-ads-readonly');
    expect(snapshot.metrics.STRONG_MODEL_RATE).toBe(0.5);
    expect(snapshot.metrics.LOW_COST_MODEL_RATE).toBe(0.5);
  });
});

describe('SI-COST C3 FINAL-3 · durable Safe Mode 真正接到 Model Gateway（local-sim composition）', () => {
  const runComposition = async (refs: { organizationId?: string | null; accountId?: string | null; incidentId?: string | null; taskId?: string | null }) => {
    const composition = createRsiLocalSimModelProviderComposition({
      usage: () => ({
        spentToday: 0,
        spentThisMonth: 0,
        incidentSpent: 0,
        incidentAttempts: 0,
        incidentCandidates: 0,
        incidentLlmCalls: 0,
        incidentTokens: 0,
        incidentElapsedMinutes: 0,
        strongCallsForTask: 0,
      }),
      resolvePrompt: () => 'local-sim-prompt',
      costSafeMode: createAiCostSafeModeStandardAiPort(prisma, refs),
    });
    const outcome = await composition.router.outcomeOf({
      taskType: 'SEMANTIC',
      complexity: 'LOW',
      maxCost: 0.5,
      latencyRequirementMs: 5_000,
      requiredCapability: 'SEMANTIC_UNDERSTANDING',
      incidentId: refs.incidentId ?? 'inc-1',
      taskId: 'task-1',
      promptRef: 'prompt:task-1',
      promptDigest: 'c'.repeat(64),
      maxOutputTokens: 256,
      timeoutMs: 5_000,
      necessity: { outcome: 'AMBIGUOUS', ruleVersion: 'rule/v1', schemaVersion: 'schema/v1', inputDigest: 'a'.repeat(64) },
    });
    return { outcome, providerEntries: composition.ledgerEntries() };
  };

  it('C3_F3_A1 durable org 预算耗尽 → Router provider 调用 = 0', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'ORGANIZATION', scopeRef: orgA, organizationId: orgA, dailyLimitMicros: 500 });
    await appendAiCostEntry(prisma, costEntry('c3f3-' + randomUUID(), { costMicros: 500 }));
    const run = await runComposition({ organizationId: orgA });
    expect(run.outcome.called).toBe(false);
    expect(run.outcome.reason).toContain('AI_COST_SAFE_MODE');
    expect(run.providerEntries).toBe(0);
  });

  it('C3_F3_A2 durable account 预算耗尽 → Router provider 调用 = 0', async () => {
    const accountId = 'acct-' + randomUUID();
    await upsertAiBudgetPolicy(prisma, {
      scope: 'ACCOUNT',
      scopeRef: accountId,
      organizationId: orgA,
      dailyLimitMicros: 100,
    });
    await appendAiCostEntry(prisma, costEntry('c3f3-' + randomUUID(), { accountId, costMicros: 100 }));
    const run = await runComposition({ organizationId: orgA, accountId });
    expect(run.outcome.called).toBe(false);
    expect(run.outcome.reason).toContain('AI_COST_SAFE_MODE');
    expect(run.providerEntries).toBe(0);
  });

  it('C3_F3_A3 durable Safe Mode NORMAL → Router 正常执行', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'ORGANIZATION', scopeRef: orgA, organizationId: orgA, dailyLimitMicros: 10_000_000 });
    const run = await runComposition({ organizationId: orgA });
    expect(run.outcome.called).toBe(true);
    expect(run.providerEntries).toBe(1);
  });

  it('C3_F3_A4 durable resolver 抛错（tenant 缺失）→ fail-closed，provider = 0', async () => {
    const run = await runComposition({ organizationId: null, incidentId: 'inc-1' });
    expect(run.outcome.called).toBe(false);
    expect(run.outcome.reason).toContain('AI_COST_SAFE_MODE');
    expect(run.providerEntries).toBe(0);
  });
});
