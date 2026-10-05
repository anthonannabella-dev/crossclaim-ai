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
  raceProtection:
    'CANONICAL_HIERARCHICAL_ADVISORY_LOCKS（platform:* → org:<id> → account:<id> → incident:<id> → task:<id>，固定顺序防死锁）+ 锁内逐 policy 重新聚合用量',
  usageAccounting: 'PER_POLICY_SCOPE（每个 policy 用自己的作用域聚合，不用最窄 scopeWhere）',
  callerProvidedLockKey: 'FORBIDDEN（锁身份由 store 内部 canonical 派生）',
  strongModelCallLimit: 'enforced（executionLevel=LEVEL_2_STRONG 计数）',
  tokenLimit: 'enforced（按 policy scope 聚合 input+output tokens）',
  concurrencyLimit: 'NOT_YET_WIRED（配置可存；并发上限执行留待 C3）',
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
  for (const [field, value] of Object.entries({
    dailyLimitMicros: policy.dailyLimitMicros,
    monthlyLimitMicros: policy.monthlyLimitMicros,
    perIncidentLimitMicros: policy.perIncidentLimitMicros,
    strongCallLimit: policy.strongCallLimit,
    tokenLimit: policy.tokenLimit,
    concurrencyLimit: policy.concurrencyLimit,
  })) {
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('AI_BUDGET_LIMIT_INVALID:' + field);
    }
  }
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
 * Budget race 防线（C2 FINAL-2 CHANGE A/B/C）：
 *   ① 锁身份由 store 内部 canonical 派生（platform:* → org → account → incident → task，固定顺序）；
 *   ② 每个 policy 用**自己的作用域**聚合 usage（daily/monthly/incident/strong/token）；
 *   ③ 先识别已有 callId（幂等重放 → duplicate=true，零新增成本，不误报 exceeded）；
 *   ④ 逐 policy 校验通过后才写事实（同一事务）。
 */
export async function runGuardedAiCostWrite(input: {
  prisma: PrismaClient;
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
  if (!Number.isInteger(input.estimatedCostMicros) || input.estimatedCostMicros < 0) {
    throw new Error('AI_COST_LEDGER_COST_MICROS_INVALID');
  }
  const inputTokens = input.entry.inputTokens ?? 0;
  const outputTokens = input.entry.outputTokens ?? 0;
  const attemptNo = input.entry.attemptNo ?? 1;
  if (!Number.isInteger(inputTokens) || inputTokens < 0) throw new Error('AI_COST_LEDGER_INPUT_TOKENS_INVALID');
  if (!Number.isInteger(outputTokens) || outputTokens < 0) throw new Error('AI_COST_LEDGER_OUTPUT_TOKENS_INVALID');
  if (!Number.isInteger(attemptNo) || attemptNo <= 0) throw new Error('AI_COST_LEDGER_ATTEMPT_INVALID');

  const now = input.now ?? new Date();
  return input.prisma.$transaction(async (tx) => {
    // ① canonical 层级锁（固定顺序；caller 不提供锁身份）
    const lockKeys = ['platform:*'];
    if (input.refs.organizationId) lockKeys.push('org:' + input.refs.organizationId);
    if (input.refs.accountId) lockKeys.push('account:' + input.refs.accountId);
    if (input.refs.incidentId) lockKeys.push('incident:' + input.refs.incidentId);
    if (input.refs.taskId) lockKeys.push('task:' + input.refs.taskId);
    for (const key of lockKeys) {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', key);
    }

    // ③ 幂等优先：已有 callId → 校验不可变身份后返回 duplicate（零新增成本，不误报 exceeded）
    const existing = await tx.aiCostLedgerEntry.findUnique({ where: { callId: input.entry.callId } });
    if (existing) {
      const sameIdentity =
        existing.organizationId === (input.refs.organizationId ?? null) &&
        existing.incidentId === (input.refs.incidentId ?? null) &&
        existing.taskId === (input.refs.taskId ?? null) &&
        existing.accountId === (input.refs.accountId ?? null) &&
        existing.taskType === input.entry.taskType &&
        existing.executionLevel === input.entry.executionLevel;
      if (!sameIdentity) throw new Error('AI_COST_LEDGER_CALL_ID_IDENTITY_CONFLICT');
      return { written: false, duplicate: true, reason: 'AI_COST_LEDGER_DUPLICATE_CALL_ID', usageMicros: 0, limitMicros: null };
    }

    // ② 逐 policy 用**自己的作用域**聚合用量并校验
    const policies = await tx.aiBudgetPolicy.findMany({
      where: {
        OR: [
          { scope: 'PLATFORM', scopeRef: '*' },
          ...(input.refs.organizationId ? [{ scope: 'ORGANIZATION', scopeRef: input.refs.organizationId }] : []),
          ...(input.refs.accountId ? [{ scope: 'ACCOUNT', scopeRef: input.refs.accountId }] : []),
          ...(input.refs.incidentId ? [{ scope: 'INCIDENT', scopeRef: input.refs.incidentId }] : []),
          ...(input.refs.taskId ? [{ scope: 'TASK', scopeRef: input.refs.taskId }] : []),
        ] as never,
      },
    });
    let observedUsageMicros = 0;
    for (const policy of policies) {
      const scopeWhere =
        policy.scope === 'ORGANIZATION'
          ? { organizationId: policy.scopeRef }
          : policy.scope === 'ACCOUNT'
            ? { accountId: policy.scopeRef }
            : policy.scope === 'INCIDENT'
              ? { incidentId: policy.scopeRef }
              : policy.scope === 'TASK'
                ? { taskId: policy.scopeRef }
                : {};
      const day = await tx.aiCostLedgerEntry.aggregate({
        where: { ...scopeWhere, createdAt: { gte: startOfUtcDay(now) } },
        _sum: { costMicros: true, inputTokens: true, outputTokens: true },
      });
      const month = await tx.aiCostLedgerEntry.aggregate({
        where: { ...scopeWhere, createdAt: { gte: startOfUtcMonth(now) } },
        _sum: { costMicros: true },
      });
      const lifetime = await tx.aiCostLedgerEntry.aggregate({
        where: scopeWhere,
        _sum: { costMicros: true },
      });
      observedUsageMicros = Math.max(observedUsageMicros, day._sum.costMicros ?? 0);
      const nextDay = (day._sum.costMicros ?? 0) + input.estimatedCostMicros;
      const nextMonth = (month._sum.costMicros ?? 0) + input.estimatedCostMicros;
      const nextLifetime = (lifetime._sum.costMicros ?? 0) + input.estimatedCostMicros;
      const nextTokens = (day._sum.inputTokens ?? 0) + (day._sum.outputTokens ?? 0) + inputTokens + outputTokens;
      const checks: Array<[number | null, number, string]> = [
        [policy.dailyLimitMicros, nextDay, 'AI_BUDGET_DAILY_EXCEEDED'],
        [policy.monthlyLimitMicros, nextMonth, 'AI_BUDGET_MONTHLY_EXCEEDED'],
        [policy.perIncidentLimitMicros, nextLifetime, 'AI_BUDGET_INCIDENT_EXCEEDED'],
        [policy.tokenLimit, nextTokens, 'AI_BUDGET_TOKEN_EXCEEDED'],
      ];
      if (input.requestedStrongCall && policy.strongCallLimit !== null) {
        const strongCalls = await tx.aiCostLedgerEntry.count({
          where: { ...scopeWhere, executionLevel: 'LEVEL_2_STRONG', createdAt: { gte: startOfUtcDay(now) } },
        });
        checks.push([policy.strongCallLimit, strongCalls + 1, 'AI_BUDGET_STRONG_CALL_EXCEEDED']);
      }
      for (const [limit, next, reason] of checks) {
        if (limit !== null && next > limit) {
          return { written: false, duplicate: false, reason, usageMicros: observedUsageMicros, limitMicros: limit };
        }
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
          inputTokens,
          outputTokens,
          costMicros: input.estimatedCostMicros,
          latencyMs: input.entry.latencyMs ?? 0,
          result: input.entry.result,
          attemptNo,
        },
      });
    } catch (error) {
      if (!!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002') {
        return { written: false, duplicate: true, reason: 'AI_COST_LEDGER_DUPLICATE_CALL_ID', usageMicros: observedUsageMicros, limitMicros: null };
      }
      throw error;
    }
    return { written: true, duplicate: false, reason: 'WITHIN_BUDGET', usageMicros: observedUsageMicros + input.estimatedCostMicros, limitMicros: null };
  });
}
