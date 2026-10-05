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
    expect(snapshot.metrics.LOW_COST_MODEL_RATE).toBe(0.5);
    expect(snapshot.metrics.STRONG_MODEL_RATE).toBe(0.5);
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
