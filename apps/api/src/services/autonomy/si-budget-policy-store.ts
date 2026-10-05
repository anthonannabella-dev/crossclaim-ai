/**
 * SI-COST-OPTIMIZATION C2 —— durable 分级预算（配置）+ 账本派生用量 + Budget race 防线
 * ---------------------------------------------------------------
 * 硬约束（MSG-20261005-30 3.2=B / MSG-20261005-33）：
 *   · `AiBudgetPolicy` = durable **配置**；**不存在 usage 表**（AiBudgetUsage = FORBIDDEN）
 *   · usage 永远由 `AiCostLedgerEntry` 聚合（唯一事实源）
 *   · 层级 PLATFORM → ORGANIZATION → ACCOUNT → INCIDENT/TASK；子级只能**收紧**（取各字段 min）
 *   · Budget race 防线：同一作用域的事实写入必须在 **advisory 事务锁** 内重新校验用量，
 *     保证并发下不会无限超支（check-then-write 在同一把锁内完成）
 */

import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export type AiBudgetScopeName = 'PLATFORM' | 'ORGANIZATION' | 'ACCOUNT' | 'INCIDENT' | 'TASK';

export interface AiBudgetPolicyInput {
  scope: AiBudgetScopeName;
  scopeRef: string;
  organizationId?: string | null;
  dailyLimitMicros?: number | null;
  monthlyLimitMicros?: number | null;
  perIncidentLimitMicros?: number | null;
  strongCallLimit?: number | null;
  tokenLimit?: number | null;
  concurrencyLimit?: number | null;
}

export interface EffectiveAiBudget {
  dailyLimitMicros: number | null;
  monthlyLimitMicros: number | null;
  perIncidentLimitMicros: number | null;
  strongCallLimit: number | null;
  tokenLimit: number | null;
  concurrencyLimit: number | null;
  sources: readonly string[];
}

export const AI_BUDGET_BOUNDARY = {
  usageTable: 'FORBIDDEN（AiBudgetUsage 不存在；usage 只由账本聚合）',
  policyDurable: true,
  hierarchy: ['PLATFORM', 'ORGANIZATION', 'ACCOUNT', 'INCIDENT', 'TASK'],
  childMayLoosenParent: false,
  raceProtection: 'PG_ADVISORY_XACT_LOCK_PER_SCOPE_KEY + 锁内重新聚合用量',
  strongModelCallLimit: 'enforced（executionLevel=LEVEL_2_STRONG 计数）',
} as const;

const minDefined = (values: readonly (number | null | undefined)[]): number | null => {
  const defined = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return defined.length === 0 ? null : Math.min(...defined);
};

/** 预算配置 upsert（durable）。 */
export async function upsertAiBudgetPolicy(
  prisma: PrismaClient,
  policy: AiBudgetPolicyInput,
): Promise<{ id: string }> {
  const row = await prisma.aiBudgetPolicy.upsert({
    where: { scope_scopeRef: { scope: policy.scope, scopeRef: policy.scopeRef } },
    create: {
      scope: policy.scope,
      scopeRef: policy.scopeRef,
      organizationId: policy.organizationId ?? null,
      dailyLimitMicros: policy.dailyLimitMicros ?? null,
      monthlyLimitMicros: policy.monthlyLimitMicros ?? null,
      perIncidentLimitMicros: policy.perIncidentLimitMicros ?? null,
      strongCallLimit: policy.strongCallLimit ?? null,
      tokenLimit: policy.tokenLimit ?? null,
      concurrencyLimit: policy.concurrencyLimit ?? null,
    },
    update: {
      organizationId: policy.organizationId ?? null,
      dailyLimitMicros: policy.dailyLimitMicros ?? null,
      monthlyLimitMicros: policy.monthlyLimitMicros ?? null,
      perIncidentLimitMicros: policy.perIncidentLimitMicros ?? null,
      strongCallLimit: policy.strongCallLimit ?? null,
      tokenLimit: policy.tokenLimit ?? null,
      concurrencyLimit: policy.concurrencyLimit ?? null,
    },
    select: { id: true },
  });
  return row;
}

/**
 * 有效预算 = 层级上各 scope 的**最紧**取值（子级只能收紧）。
 * 缺失的层级不参与（不限制），但只要父级有值就构成上界。
 */
export async function resolveEffectiveAiBudget(
  prisma: Db,
  refs: {
    organizationId?: string | null;
    accountId?: string | null;
    incidentId?: string | null;
    taskId?: string | null;
  },
): Promise<EffectiveAiBudget> {
  const keys: Array<{ scope: AiBudgetScopeName; scopeRef: string }> = [{ scope: 'PLATFORM', scopeRef: '*' }];
  if (refs.organizationId) keys.push({ scope: 'ORGANIZATION', scopeRef: refs.organizationId });
  if (refs.accountId) keys.push({ scope: 'ACCOUNT', scopeRef: refs.accountId });
  if (refs.incidentId) keys.push({ scope: 'INCIDENT', scopeRef: refs.incidentId });
  if (refs.taskId) keys.push({ scope: 'TASK', scopeRef: refs.taskId });

  const rows = await prisma.aiBudgetPolicy.findMany({
    where: { OR: keys.map((k) => ({ scope: k.scope, scopeRef: k.scopeRef })) },
  });
  const pick = (scope: AiBudgetScopeName) => rows.filter((row) => row.scope === scope);
  const sources = rows.map((row) => `${row.scope}:${row.scopeRef}`);
  return {
    dailyLimitMicros: minDefined(pick('PLATFORM').concat(pick('ORGANIZATION'), pick('ACCOUNT'), pick('INCIDENT'), pick('TASK')).map((r) => r.dailyLimitMicros)),
    monthlyLimitMicros: minDefined(pick('PLATFORM').concat(pick('ORGANIZATION'), pick('ACCOUNT'), pick('INCIDENT'), pick('TASK')).map((r) => r.monthlyLimitMicros)),
    perIncidentLimitMicros: minDefined(pick('PLATFORM').concat(pick('ORGANIZATION'), pick('ACCOUNT'), pick('INCIDENT'), pick('TASK')).map((r) => r.perIncidentLimitMicros)),
    strongCallLimit: minDefined(pick('PLATFORM').concat(pick('ORGANIZATION'), pick('ACCOUNT'), pick('INCIDENT'), pick('TASK')).map((r) => r.strongCallLimit)),
    tokenLimit: minDefined(pick('PLATFORM').concat(pick('ORGANIZATION'), pick('ACCOUNT'), pick('INCIDENT'), pick('TASK')).map((r) => r.tokenLimit)),
    concurrencyLimit: minDefined(pick('PLATFORM').concat(pick('ORGANIZATION'), pick('ACCOUNT'), pick('INCIDENT'), pick('TASK')).map((r) => r.concurrencyLimit)),
    sources,
  };
}

export interface AiBudgetGuardResult {
  written: boolean;
  duplicate: boolean;
  reason: string;
  usageMicros: number;
  limitMicros: number | null;
}

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const startOfUtcMonth = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * Budget race 防线：在**同一事务 + 同一把 advisory 锁**内完成
 *   读用量（账本聚合）→ 与有效预算比较 → 写入事实。
 * 并发调用同一 scopeKey 时被串行化，因此不会出现「都看到没超支然后一起越界」。
 */
export async function runGuardedAiCostWrite(input: {
  prisma: PrismaClient;
  /** 稳定的作用域键（用于 advisory lock，例如 org:xxx|inc:yyy） */
  scopeKey: string;
  refs: {
    organizationId?: string | null;
    accountId?: string | null;
    incidentId?: string | null;
    taskId?: string | null;
  };
  estimatedCostMicros: number;
  requestedStrongCall?: boolean;
  entry: {
    callId: string;
    provider: string;
    model: string;
    executionLevel: string;
    taskType: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    result: string;
    attemptNo?: number;
  };
  now?: Date;
}): Promise<AiBudgetGuardResult> {
  const now = input.now ?? new Date();
  return input.prisma.$transaction(async (tx) => {
    // ① 作用域级 advisory 事务锁（PG_ADVISORY_XACT_LOCK 在事务结束自动释放）
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', input.scopeKey);

    // ② 有效预算（层级取最紧）
    const effective = await resolveEffectiveAiBudget(tx as Db, input.refs);

    // ③ 用量（唯一来源 = 账本聚合）
    const scopeWhere = {
      ...(input.refs.organizationId ? { organizationId: input.refs.organizationId } : {}),
      ...(input.refs.accountId ? { accountId: input.refs.accountId } : {}),
      ...(input.refs.incidentId ? { incidentId: input.refs.incidentId } : {}),
      ...(input.refs.taskId ? { taskId: input.refs.taskId } : {}),
    };
    const dayAgg = await tx.aiCostLedgerEntry.aggregate({
      where: { ...scopeWhere, createdAt: { gte: startOfUtcDay(now) } },
      _sum: { costMicros: true },
    });
    const monthAgg = await tx.aiCostLedgerEntry.aggregate({
      where: { ...scopeWhere, createdAt: { gte: startOfUtcMonth(now) } },
      _sum: { costMicros: true },
    });
    const incidentAgg = input.refs.incidentId
      ? await tx.aiCostLedgerEntry.aggregate({ where: scopeWhere, _sum: { costMicros: true } })
      : null;
    const strongCalls =
      input.refs.taskId && input.requestedStrongCall
        ? await tx.aiCostLedgerEntry.count({
            where: { ...scopeWhere, executionLevel: 'LEVEL_2_STRONG' },
          })
        : 0;

    const nextDayMicros = (dayAgg._sum.costMicros ?? 0) + input.estimatedCostMicros;
    const nextMonthMicros = (monthAgg._sum.costMicros ?? 0) + input.estimatedCostMicros;
    const nextIncidentMicros = (incidentAgg?._sum.costMicros ?? 0) + input.estimatedCostMicros;

    const checks: Array<[number | null, number, string]> = [
      [effective.dailyLimitMicros, nextDayMicros, 'AI_BUDGET_DAILY_EXCEEDED'],
      [effective.monthlyLimitMicros, nextMonthMicros, 'AI_BUDGET_MONTHLY_EXCEEDED'],
      [effective.perIncidentLimitMicros, nextIncidentMicros, 'AI_BUDGET_INCIDENT_EXCEEDED'],
    ];
    if (input.requestedStrongCall && effective.strongCallLimit !== null && strongCalls + 1 > effective.strongCallLimit) {
      checks.push([effective.strongCallLimit, strongCalls + 1, 'AI_BUDGET_STRONG_CALL_EXCEEDED']);
    }
    for (const [limit, next, reason] of checks) {
      if (limit !== null && next > limit) {
        return {
          written: false,
          duplicate: false,
          reason,
          usageMicros: next - input.estimatedCostMicros,
          limitMicros: limit,
        };
      }
    }

    // ④ 预算允许 → 在同一事务内写入事实（幂等）
    try {
      await tx.aiCostLedgerEntry.create({
        data: {
          callId: input.entry.callId,
          incidentId: input.refs.incidentId ?? null,
          taskId: input.refs.taskId ?? null,
          organizationId: input.refs.organizationId ?? null,
          accountId: input.refs.accountId ?? null,
          provider: input.entry.provider,
          model: input.entry.model,
          executionLevel: input.entry.executionLevel,
          taskType: input.entry.taskType,
          inputTokens: input.entry.inputTokens ?? 0,
          outputTokens: input.entry.outputTokens ?? 0,
          costMicros: input.estimatedCostMicros,
          latencyMs: input.entry.latencyMs ?? 0,
          result: input.entry.result,
          attemptNo: input.entry.attemptNo ?? 1,
        },
      });
    } catch (error) {
      if (!!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002') {
        return { written: false, duplicate: true, reason: 'AI_COST_LEDGER_DUPLICATE_CALL_ID', usageMicros: nextDayMicros - input.estimatedCostMicros, limitMicros: null };
      }
      throw error;
    }
    return { written: true, duplicate: false, reason: 'WITHIN_BUDGET', usageMicros: nextDayMicros, limitMicros: effective.dailyLimitMicros };
  });
}
