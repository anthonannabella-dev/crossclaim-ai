/**
 * SI-COST-OPTIMIZATION C2 —— 真实 PostgreSQL 取证（MSG-20261005-30/33 授权）
 * 覆盖：durable ledger / 幂等 callId / append-only / 重启不归零 / tenant 隔离 / 分级预算（子级只能收紧）/
 *      usage 仅由账本聚合（无 usage 表）/ Budget race 防线 / 缓存 identity + stale + 跨租户 + GC
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AI_COST_LEDGER_BOUNDARY, aggregateAiCostUsage, appendAiCostEntry } from '../services/autonomy/si-cost-ledger-store';
import {
  AI_BUDGET_BOUNDARY,
  resolveEffectiveAiBudget,
  runGuardedAiCostWrite,
  upsertAiBudgetPolicy,
} from '../services/autonomy/si-budget-policy-store';
import {
  AI_MODEL_CACHE_STORE_BOUNDARY,
  gcAiModelCacheEntries,
  getAiModelCacheEntry,
  putAiModelCacheEntry,
} from '../services/autonomy/si-model-cache-store';

const prisma = new PrismaClient();
let orgA = '';
let orgB = '';

const costEntry = (callId: string, over: Partial<Parameters<typeof appendAiCostEntry>[1]> = {}) => ({
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
});

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  orgA = randomUUID();
  orgB = randomUUID();
  await prisma.organization.create({ data: { id: orgA, name: 'C2 A', slug: 'c2-a-' + suffix } });
  await prisma.organization.create({ data: { id: orgB, name: 'C2 B', slug: 'c2-b-' + suffix } });
  // 预算/缓存/账本按用例隔离（账本是 append-only，行级 DELETE 被拒绝；测试夹具用 TRUNCATE）
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

describe('SI-COST C2 · durable append-only 成本账本', () => {
  it('C2_DB1 幂等 callId：同 callId 第二次不产生第二条事实', async () => {
    const callId = 'c2-call-' + randomUUID();
    const first = await appendAiCostEntry(prisma, costEntry(callId));
    const second = await appendAiCostEntry(prisma, costEntry(callId, { costMicros: 9_999 }));
    expect(first.created).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(await prisma.aiCostLedgerEntry.count({ where: { organizationId: orgA } })).toBe(1);
    const usage = await aggregateAiCostUsage(prisma, { organizationId: orgA });
    expect(usage.totalMicros).toBe(1_000);
    expect(usage.entries).toBe(1);
    expect(AI_COST_LEDGER_BOUNDARY.appendOnly).toBe(true);
    expect(AI_COST_LEDGER_BOUNDARY.storesRawPrompt).toBe(false);
  });

  it('C2_DB2 append-only：UPDATE / DELETE 被 DB 触发器拒绝', async () => {
    const callId = 'c2-call-' + randomUUID();
    await appendAiCostEntry(prisma, costEntry(callId));
    const row = await prisma.aiCostLedgerEntry.findUniqueOrThrow({ where: { callId } });
    await expect(
      prisma.$executeRawUnsafe('UPDATE "AiCostLedgerEntry" SET "costMicros" = 5 WHERE "id" = $1', row.id),
    ).rejects.toThrow(/AI_COST_LEDGER_APPEND_ONLY/);
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM "AiCostLedgerEntry" WHERE "id" = $1', row.id),
    ).rejects.toThrow(/AI_COST_LEDGER_APPEND_ONLY/);
    expect(await prisma.aiCostLedgerEntry.count({ where: { callId } })).toBe(1);
  });

  it('C2_DB3 重启后成本统计不归零（新 client 读回同一事实）', async () => {
    await appendAiCostEntry(prisma, costEntry('c2-call-' + randomUUID(), { costMicros: 2_500 }));
    const fresh = new PrismaClient();
    try {
      const usage = await aggregateAiCostUsage(fresh, { organizationId: orgA });
      expect(usage.totalMicros).toBe(2_500);
      expect(usage.entries).toBe(1);
    } finally {
      await fresh.$disconnect();
    }
  });

  it('C2_DB4 tenant isolation：按租户聚合互不串扰', async () => {
    await appendAiCostEntry(prisma, costEntry('c2-call-' + randomUUID(), { organizationId: orgA, costMicros: 700 }));
    await appendAiCostEntry(prisma, costEntry('c2-call-' + randomUUID(), { organizationId: orgB, costMicros: 300 }));
    expect((await aggregateAiCostUsage(prisma, { organizationId: orgA })).totalMicros).toBe(700);
    expect((await aggregateAiCostUsage(prisma, { organizationId: orgB })).totalMicros).toBe(300);
  });
});

describe('SI-COST C2 · 分级预算（配置 durable；usage 仅由账本聚合）', () => {
  it('C2_DB5 层级只收紧：子级更大的限额不放大父级上界', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'PLATFORM', scopeRef: '*', dailyLimitMicros: 1_000 });
    await upsertAiBudgetPolicy(prisma, { scope: 'ORGANIZATION', scopeRef: orgA, organizationId: orgA, dailyLimitMicros: 5_000 });
    await upsertAiBudgetPolicy(prisma, { scope: 'INCIDENT', scopeRef: 'inc-1', organizationId: orgA, perIncidentLimitMicros: 100 });
    const effective = await resolveEffectiveAiBudget(prisma, { organizationId: orgA, incidentId: 'inc-1' });
    expect(effective.dailyLimitMicros).toBe(1_000); // 子级 5000 不得放大平台 1000
    expect(effective.perIncidentLimitMicros).toBe(100);
    expect(AI_BUDGET_BOUNDARY.childMayLoosenParent).toBe(false);
  });

  it('C2_DB6 不存在 usage 表（usage 只能由账本聚合）', async () => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('AiBudgetUsage','BudgetUsage','AiBudgetUsageRecord')",
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);
    expect(AI_BUDGET_BOUNDARY.usageTable).toContain('FORBIDDEN');
  });

  it('C2_DB7 超预算 → 拒绝写入（账本不新增事实）', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'ORGANIZATION', scopeRef: orgA, organizationId: orgA, dailyLimitMicros: 5_000 });
    const scopeKey = 'org:' + orgA;
    const ok = await runGuardedAiCostWrite({
      prisma,
      scopeKey,
      refs: { organizationId: orgA, incidentId: 'inc-1' },
      estimatedCostMicros: 3_000,
      entry: { callId: 'c2-guard-' + randomUUID(), provider: 'p', model: 'm', executionLevel: 'LEVEL_1_LOW_COST', taskType: 'SEMANTIC', result: 'SUCCESS' },
    });
    expect(ok.written).toBe(true);
    const denied = await runGuardedAiCostWrite({
      prisma,
      scopeKey,
      refs: { organizationId: orgA, incidentId: 'inc-1' },
      estimatedCostMicros: 3_000,
      entry: { callId: 'c2-guard-' + randomUUID(), provider: 'p', model: 'm', executionLevel: 'LEVEL_1_LOW_COST', taskType: 'SEMANTIC', result: 'SUCCESS' },
    });
    expect(denied.written).toBe(false);
    expect(denied.reason).toBe('AI_BUDGET_DAILY_EXCEEDED');
    expect((await aggregateAiCostUsage(prisma, { organizationId: orgA })).entries).toBe(1);
  });

  it('C2_DB8 Budget race 防线：并发 5 次、限额只允许 2 次 → 恰好写入 2 条（不无限超支）', async () => {
    await upsertAiBudgetPolicy(prisma, { scope: 'ORGANIZATION', scopeRef: orgA, organizationId: orgA, dailyLimitMicros: 2_500 });
    const scopeKey = 'org:' + orgA;
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        runGuardedAiCostWrite({
          prisma,
          scopeKey,
          refs: { organizationId: orgA, incidentId: 'inc-race' },
          estimatedCostMicros: 1_000,
          entry: { callId: 'c2-race-' + randomUUID(), provider: 'p', model: 'm', executionLevel: 'LEVEL_1_LOW_COST', taskType: 'SEMANTIC', result: 'SUCCESS' },
        }),
      ),
    );
    const written = attempts.filter((a) => a.written).length;
    expect(written).toBe(2);
    expect(attempts.filter((a) => !a.written).every((a) => a.reason === 'AI_BUDGET_DAILY_EXCEEDED')).toBe(true);
    const usage = await aggregateAiCostUsage(prisma, { organizationId: orgA });
    expect(usage.totalMicros).toBe(2_000);
    expect(usage.entries).toBe(2);
  });
});

describe('SI-COST C2 · 确定性模型缓存 store', () => {
  const identity = (over: Record<string, unknown> = {}) => ({
    taskType: 'SEMANTIC',
    promptDigest: 'a'.repeat(64),
    inputDigest: 'b'.repeat(64),
    ruleVersion: 'rule/v1',
    schemaVersion: 'schema/v1',
    capabilityTier: 'LOW_COST',
    organizationId: orgA,
    ...over,
  });

  it('C2_DB9 命中/跨租户 MISS/ruleVersion MISS/stale MISS（高风险禁 stale fallback）', async () => {
    const now = new Date('2026-10-05T04:00:00.000Z');
    await putAiModelCacheEntry(prisma, { identity: identity(), resultDigest: 'r'.repeat(64), ttlMs: 60_000, now });
    const hit = await getAiModelCacheEntry(prisma, { identity: identity(), now: new Date(now.getTime() + 1_000) });
    expect(hit.hit).toBe(true);
    const crossTenant = await getAiModelCacheEntry(prisma, { identity: identity({ organizationId: orgB }), now });
    expect(crossTenant).toMatchObject({ hit: false, reason: 'MISS_ABSENT' });
    const ruleMismatch = await getAiModelCacheEntry(prisma, { identity: identity({ ruleVersion: 'rule/v2' }), now });
    expect(ruleMismatch).toMatchObject({ hit: false, reason: 'MISS_ABSENT' });
    const stale = await getAiModelCacheEntry(prisma, { identity: identity(), now: new Date(now.getTime() + 120_000) });
    expect(stale).toMatchObject({ hit: false, reason: 'MISS_STALE' });
    expect(AI_MODEL_CACHE_STORE_BOUNDARY.crossTenantReuse).toBe('FORBIDDEN');
  });

  it('C2_DB10 identity 不可原地改写 + GC 删除过期条目（缓存非 append-only）', async () => {
    const now = new Date('2026-10-05T04:00:00.000Z');
    await putAiModelCacheEntry(prisma, { identity: identity(), resultDigest: 'r'.repeat(64), ttlMs: 1_000, now });
    const row = await prisma.aiModelCacheEntry.findFirstOrThrow({ where: { organizationId: orgA } });
    await expect(
      prisma.$executeRawUnsafe('UPDATE "AiModelCacheEntry" SET "resultDigest" = $2 WHERE "id" = $1', row.id, 'x'.repeat(64)),
    ).rejects.toThrow(/AI_MODEL_CACHE_IDENTITY_IMMUTABLE/);
    const gc = await gcAiModelCacheEntries(prisma, new Date(now.getTime() + 10_000));
    expect(gc.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.aiModelCacheEntry.count({ where: { organizationId: orgA } })).toBe(0);
    expect(AI_MODEL_CACHE_STORE_BOUNDARY.appendOnly).toBe(false);
    expect(AI_MODEL_CACHE_STORE_BOUNDARY.controlledTtlGc).toBe(true);
  });
});
