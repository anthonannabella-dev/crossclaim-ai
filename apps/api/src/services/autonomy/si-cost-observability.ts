/**
 * SI-COST-OPTIMIZATION C3 —— Admin read-only observability projection
 * ---------------------------------------------------------------
 * 硬约束（HOST ADDENDUM OPT-7 / MSG-20261005-37 NEXT #5）：
 *   - 只读投影：全部数据来自 durable `AiCostLedgerEntry` / `AiBudgetPolicy` / `AiModelCacheEntry`；
 *   - **不得创建新的 usage truth table**，不得写任何行；
 *   - 不得暴露客户敏感内容（结构上只有 id / 计数 / 成本 / token / 等级）；
 *   - 真实模型流量缺失时指标一律 `NOT_YET_MEASURABLE`，禁止伪造（例如「节省 90% token」）。
 */

import type { PrismaClient } from '@prisma/client';

import {
  type EffectiveAiBudget,
  resolveEffectiveAiBudget,
  type AiBudgetScopeName,
} from './si-budget-policy-store';
import type { AiCostSafeModeVerdict } from './si-cost-safe-mode';
import { resolveAiCostSafeMode } from './si-cost-safe-mode-store';
import { AI_VALUE_METRIC_NOT_YET_MEASURABLE } from './si-ai-business-value-policy';

export interface AiCostObservabilityRefs {
  organizationId?: string | null;
  accountId?: string | null;
  incidentId?: string | null;
  taskId?: string | null;
}

export interface AiCostMetricView {
  RULE_RESOLVED_RATE: number | string;
  MODEL_INVOCATION_RATE: number | string;
  LOW_COST_MODEL_RATE: number | string;
  STRONG_MODEL_RATE: number | string;
  CACHE_HIT_RATE: number | string;
  AVG_AI_COST_PER_CASE: number | string;
  AVG_AI_COST_PER_SUCCESSFUL_RECOVERY: number | string;
}

export interface AiCostObservabilitySnapshot {
  readOnly: true;
  sensitiveDataIncluded: false;
  generatedAt: string;
  scope: { organizationId: string | null; accountId: string | null; incidentId: string | null; taskId: string | null };
  cost: {
    todayMicros: number;
    monthMicros: number;
    incidentMicros: number;
    tokensToday: number;
    strongCallsToday: number;
    lowCostCallsToday: number;
    entriesToday: number;
  };
  budget: EffectiveAiBudget;
  budgetRemaining: {
    dailyMicros: number | null;
    monthlyMicros: number | null;
    incidentMicros: number | null;
    tokenToday: number | null;
    strongCallsToday: number | null;
  };
  costByScope: { platformMicros: number; organizationMicros: number | null };
  topCostIncidences: Array<{ incidentId: string; costMicros: number }>;
  cache: { entries: number; expiredEntries: number };
  safeMode: AiCostSafeModeVerdict;
  /**
   * C3 FINAL-2 CHANGE D：指标来源 provenance —— 只有可验证的**真实 provider 流量**才允许
   * 输出生产效率指标；仅 local-sim 账本时生产指标必须 NOT_YET_MEASURABLE。
   */
  provenance: {
    modelTraffic: 'NO_TRAFFIC' | 'LOCAL_SIMULATION_ONLY' | 'REAL_PROVIDER';
    rule: string;
    realProviderNames: readonly string[];
  };
  /** dev / simulation 计数（可展示，但**不得**当作生产指标） */
  devSimulation: {
    entriesToday: number;
    todayMicros: number;
    tokensToday: number;
    lowCostCallsToday: number;
    strongCallsToday: number;
  };
  metrics: AiCostMetricView;
}

export const AI_COST_OBSERVABILITY_BOUNDARY = {
  readOnly: true,
  writesRows: false,
  secondUsageTable: 'FORBIDDEN（只投影 durable ledger / policy / cache）',
  safeModeSource: 'DURABLE_PER_POLICY_SCOPE_RESOLVER（与 C2 budget Guard 同一作用域语义）',
  metricProvenance: 'REAL_PROVIDER_ONLY；LOCAL_SIMULATION_ONLY / NO_TRAFFIC → NOT_YET_MEASURABLE',
  exposesCustomerContent: false,
  exposesPromptOrResponse: false,
  exposesCredentials: false,
  fabricatedMetrics: 'FORBIDDEN（无真实流量 → NOT_YET_MEASURABLE）',
} as const;

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const startOfUtcMonth = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const normalizeRefs = (refs: AiCostObservabilityRefs) => ({
  organizationId: refs.organizationId ?? null,
  accountId: refs.accountId ?? null,
  incidentId: refs.incidentId ?? null,
  taskId: refs.taskId ?? null,
});

const ledgerScopeWhere = (refs: AiCostObservabilityRefs) => ({
  ...(refs.organizationId ? { organizationId: refs.organizationId } : {}),
  ...(refs.accountId ? { accountId: refs.accountId } : {}),
  ...(refs.incidentId ? { incidentId: refs.incidentId } : {}),
  ...(refs.taskId ? { taskId: refs.taskId } : {}),
});

/**
 * 读取只读观测快照（不写任何行）。
 * 指标口径：
 *   - LOW_COST_MODEL_RATE / STRONG_MODEL_RATE 由 durable ledger 的 executionLevel 计数直接推导 → 真实值；
 *   - RULE_RESOLVED_RATE / MODEL_INVOCATION_RATE / CACHE_HIT_RATE / AVG_* 需要「总信号数 / 真实恢复事实」，
 *     缺可信分母 → `NOT_YET_MEASURABLE`（禁止编造）。
 */
export async function readAiCostObservability(
  prisma: PrismaClient,
  input: { refs: AiCostObservabilityRefs; now?: Date; topIncidentLimit?: number },
): Promise<AiCostObservabilitySnapshot> {
  const now = input.now ?? new Date();
  const refs = normalizeRefs(input.refs);
  const scopeWhere = ledgerScopeWhere(input.refs);
  const dayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);

  const [day, month, incident, dayRows, orgMonth, platformMonth, cacheEntries, cacheExpired, budget, providerRows] =
    await Promise.all([
    prisma.aiCostLedgerEntry.aggregate({
      where: { ...scopeWhere, createdAt: { gte: dayStart } },
      _sum: { costMicros: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
    }),
    prisma.aiCostLedgerEntry.aggregate({
      where: { ...scopeWhere, createdAt: { gte: monthStart } },
      _sum: { costMicros: true },
    }),
    prisma.aiCostLedgerEntry.aggregate({
      where: { ...(input.refs.incidentId ? { incidentId: input.refs.incidentId } : {}), ...(input.refs.organizationId ? { organizationId: input.refs.organizationId } : {}) },
      _sum: { costMicros: true },
    }),
    prisma.aiCostLedgerEntry.groupBy({
      by: ['executionLevel'],
      where: { ...scopeWhere, createdAt: { gte: dayStart } },
      _count: { _all: true },
    }),
    input.refs.organizationId
      ? prisma.aiCostLedgerEntry.aggregate({
          where: { organizationId: input.refs.organizationId, createdAt: { gte: monthStart } },
          _sum: { costMicros: true },
        })
      : Promise.resolve({ _sum: { costMicros: 0 } }),
    prisma.aiCostLedgerEntry.aggregate({
      where: { createdAt: { gte: monthStart } },
      _sum: { costMicros: true },
    }),
    prisma.aiModelCacheEntry.count({
      where: { ...(input.refs.organizationId ? { organizationId: input.refs.organizationId } : {}) },
    }),
    prisma.aiModelCacheEntry.count({
      where: { ...(input.refs.organizationId ? { organizationId: input.refs.organizationId } : {}), expiresAt: { lt: now } },
    }),
    resolveEffectiveAiBudget(prisma, input.refs),
    prisma.aiCostLedgerEntry.findMany({
      where: { ...scopeWhere, createdAt: { gte: monthStart } },
      select: { provider: true },
      distinct: ['provider'],
    }),
  ]);

  const levelCounts = new Map<string, number>();
  for (const row of dayRows) levelCounts.set(row.executionLevel, row._count._all);
  const lowCostCallsToday = levelCounts.get('LEVEL_1_LOW_COST') ?? 0;
  const strongCallsToday = levelCounts.get('LEVEL_2_STRONG') ?? 0;

  // top cost incidents：只投影 id + 成本（无客户敏感内容）
  const topIncidentLimit = input.topIncidentLimit ?? 5;
  const topGroups = input.refs.organizationId
    ? await prisma.aiCostLedgerEntry.groupBy({
        by: ['incidentId'],
        where: { organizationId: input.refs.organizationId, incidentId: { not: null }, createdAt: { gte: monthStart } },
        _sum: { costMicros: true },
        orderBy: { _sum: { costMicros: 'desc' } },
        take: topIncidentLimit,
      })
    : [];

  const todayMicros = day._sum.costMicros ?? 0;
  const monthMicros = month._sum.costMicros ?? 0;
  const tokensToday = (day._sum.inputTokens ?? 0) + (day._sum.outputTokens ?? 0);
  const incidentMicros = incident._sum.costMicros ?? 0;

  // C3 FINAL-2 CHANGE C：Safe Mode 走 durable per-policy-scope resolver（与 C2 Guard 同语义）
  const safeMode = (await resolveAiCostSafeMode(prisma, { refs: input.refs, now })).verdict;

  // C3 FINAL-2 CHANGE D：指标来源 provenance（provider 身份约定：rsi-local-sim* = 仿真）
  const providerNames = providerRows.map((row) => row.provider);
  const realProviderNames = providerNames.filter((name) => typeof name === 'string' && name.trim() !== '' && !/^rsi-local-sim/i.test(name));
  const modelTraffic: 'NO_TRAFFIC' | 'LOCAL_SIMULATION_ONLY' | 'REAL_PROVIDER' =
    providerNames.length === 0 ? 'NO_TRAFFIC' : realProviderNames.length > 0 ? 'REAL_PROVIDER' : 'LOCAL_SIMULATION_ONLY';

  const remaining = (limit: number | null, used: number): number | null =>
    typeof limit === 'number' ? Math.max(0, limit - used) : null;

  const totalLevelCalls = lowCostCallsToday + strongCallsToday;
  // 生产效率指标只在存在真实 provider 流量时输出；否则（含 local-sim）一律 NOT_YET_MEASURABLE
  const productionMeasurable = modelTraffic === 'REAL_PROVIDER';
  const metrics: AiCostMetricView = {
    RULE_RESOLVED_RATE: AI_VALUE_METRIC_NOT_YET_MEASURABLE,
    MODEL_INVOCATION_RATE: AI_VALUE_METRIC_NOT_YET_MEASURABLE,
    LOW_COST_MODEL_RATE:
      productionMeasurable && totalLevelCalls > 0
        ? Number((lowCostCallsToday / totalLevelCalls).toFixed(6))
        : AI_VALUE_METRIC_NOT_YET_MEASURABLE,
    STRONG_MODEL_RATE:
      productionMeasurable && totalLevelCalls > 0
        ? Number((strongCallsToday / totalLevelCalls).toFixed(6))
        : AI_VALUE_METRIC_NOT_YET_MEASURABLE,
    CACHE_HIT_RATE: AI_VALUE_METRIC_NOT_YET_MEASURABLE,
    AVG_AI_COST_PER_CASE: AI_VALUE_METRIC_NOT_YET_MEASURABLE,
    AVG_AI_COST_PER_SUCCESSFUL_RECOVERY: AI_VALUE_METRIC_NOT_YET_MEASURABLE,
  };

  return {
    readOnly: true,
    sensitiveDataIncluded: false,
    generatedAt: now.toISOString(),
    scope: refs,
    cost: {
      todayMicros,
      monthMicros,
      incidentMicros,
      tokensToday,
      strongCallsToday,
      lowCostCallsToday,
      entriesToday: day._count._all,
    },
    budget,
    budgetRemaining: {
      dailyMicros: remaining(budget.dailyLimitMicros, todayMicros),
      monthlyMicros: remaining(budget.monthlyLimitMicros, monthMicros),
      incidentMicros: remaining(budget.perIncidentLimitMicros, incidentMicros),
      tokenToday: remaining(budget.tokenLimit, tokensToday),
      strongCallsToday: remaining(budget.strongCallLimit, strongCallsToday),
    },
    costByScope: {
      platformMicros: platformMonth._sum.costMicros ?? 0,
      organizationMicros: input.refs.organizationId ? orgMonth._sum.costMicros ?? 0 : null,
    },
    topCostIncidences: topGroups.map((row) => ({
      incidentId: row.incidentId as string,
      costMicros: row._sum.costMicros ?? 0,
    })),
    cache: { entries: cacheEntries, expiredEntries: cacheExpired },
    safeMode,
    provenance: {
      modelTraffic,
      rule: 'provider identity：/^rsi-local-sim/i → 仿真；其余 → 真实 provider；无行 → NO_TRAFFIC',
      realProviderNames,
    },
    devSimulation: {
      entriesToday: day._count._all,
      todayMicros,
      tokensToday,
      lowCostCallsToday,
      strongCallsToday,
    },
    metrics,
  };
}

/** 供测试 / 文档使用的 scope 名清单（保证与预算层级一致） */
export const AI_COST_OBSERVABILITY_SCOPES: readonly AiBudgetScopeName[] = [
  'PLATFORM',
  'ORGANIZATION',
  'ACCOUNT',
  'INCIDENT',
  'TASK',
];
