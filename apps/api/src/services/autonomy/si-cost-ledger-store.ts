/**
 * SI-COST-OPTIMIZATION C2 —— durable append-only 成本账本 store（MSG-20261005-30/33 授权）
 * ---------------------------------------------------------------
 * 硬约束：
 *   · 只记录身份 / 计数 / 成本 / 结果；**禁止** raw prompt / raw model response / credential / 客户敏感 payload
 *     （本模块的输入类型里根本没有这些字段，从结构上不可能写入）
 *   · append-only：DB 触发器拒绝 UPDATE/DELETE；本模块只提供 insert
 *   · 幂等：callId 唯一；重复写入 → 不产生第二条事实（duplicate=true）
 *   · usage 只有唯一事实源 = 本账本聚合（不存在 AiBudgetUsage 之类第二事实源）
 */

import type { PrismaClient } from '@prisma/client';

export interface AiCostLedgerInput {
  callId: string;
  incidentId?: string | null;
  taskId?: string | null;
  organizationId?: string | null;
  accountId?: string | null;
  provider: string;
  model: string;
  executionLevel: string;
  taskType: string;
  inputTokens?: number;
  outputTokens?: number;
  /** 整数微单位（1 USD = 1_000_000 micros） */
  costMicros: number;
  latencyMs?: number;
  result: string;
  attemptNo?: number;
  createdAt?: Date;
}

export const AI_COST_LEDGER_BOUNDARY = {
  appendOnly: true,
  storesRawPrompt: false,
  storesRawModelResponse: false,
  storesCredentials: false,
  storesCustomerSensitivePayload: false,
  usageSecondSource: 'FORBIDDEN（无 AiBudgetUsage 表；用量只由本账本聚合）',
  costUnit: 'MICROS_INTEGER',
} as const;

const UNIQUE_VIOLATION = 'P2002';
const isUniqueViolation = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { code?: unknown }).code === UNIQUE_VIOLATION;

/** 追加一条成本事实（幂等：同 callId 第二次不产生新事实）。 */
export async function appendAiCostEntry(
  prisma: PrismaClient,
  entry: AiCostLedgerInput,
): Promise<{ created: boolean; duplicate: boolean; callId: string }> {
  if (!entry.callId || entry.callId.trim() === '') {
    throw new Error('AI_COST_LEDGER_CALL_ID_REQUIRED');
  }
  if (!Number.isInteger(entry.costMicros) || entry.costMicros < 0) {
    throw new Error('AI_COST_LEDGER_COST_MICROS_INVALID');
  }
  try {
    await prisma.aiCostLedgerEntry.create({
      data: {
        callId: entry.callId,
        incidentId: entry.incidentId ?? null,
        taskId: entry.taskId ?? null,
        organizationId: entry.organizationId ?? null,
        accountId: entry.accountId ?? null,
        provider: entry.provider,
        model: entry.model,
        executionLevel: entry.executionLevel,
        taskType: entry.taskType,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        costMicros: entry.costMicros,
        latencyMs: entry.latencyMs ?? 0,
        result: entry.result,
        attemptNo: entry.attemptNo ?? 1,
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
      },
    });
    return { created: true, duplicate: false, callId: entry.callId };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { created: false, duplicate: true, callId: entry.callId };
    }
    throw error;
  }
}

export interface AiCostUsageQuery {
  organizationId?: string | null;
  accountId?: string | null;
  incidentId?: string | null;
  taskId?: string | null;
  since?: Date;
}

export interface AiCostUsageAggregate {
  totalMicros: number;
  entries: number;
  strongCalls: number;
  tokens: number;
}

/** 用量聚合（usage 的唯一来源）：按作用域从账本实时聚合。 */
export async function aggregateAiCostUsage(
  prisma: PrismaClient,
  query: AiCostUsageQuery,
): Promise<AiCostUsageAggregate> {
  const where = {
    ...(query.organizationId !== undefined && query.organizationId !== null
      ? { organizationId: query.organizationId }
      : {}),
    ...(query.accountId !== undefined && query.accountId !== null ? { accountId: query.accountId } : {}),
    ...(query.incidentId !== undefined && query.incidentId !== null ? { incidentId: query.incidentId } : {}),
    ...(query.taskId !== undefined && query.taskId !== null ? { taskId: query.taskId } : {}),
    ...(query.since ? { createdAt: { gte: query.since } } : {}),
  };
  const rows = await prisma.aiCostLedgerEntry.findMany({
    where,
    select: { costMicros: true, inputTokens: true, outputTokens: true, executionLevel: true },
  });
  let totalMicros = 0;
  let tokens = 0;
  let strongCalls = 0;
  for (const row of rows) {
    totalMicros += row.costMicros;
    tokens += row.inputTokens + row.outputTokens;
    if (row.executionLevel === 'LEVEL_2_STRONG') strongCalls += 1;
  }
  return { totalMicros, entries: rows.length, strongCalls, tokens };
}
