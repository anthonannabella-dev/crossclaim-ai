/**
 * SI-COST-OPTIMIZATION C2 —— 确定性模型缓存 store（可丢弃派生数据；受控 TTL/GC）
 * ---------------------------------------------------------------
 * 硬约束（MSG-20261005-30 3.3=A / MSG-20261005-33）：
 *   · identity 语义完全复用 C1 的 `buildAiCacheKey` / `evaluateAiCacheLookup`（跨租户 / ruleVersion / schema /
 *     inputDigest / promptDigest / stale 一律 MISS；高风险不得 stale fallback）
 *   · **非** append-only：允许受控 TTL/GC（DELETE）；但 identity 与 resultDigest 不可原地改写（DB 触发器保证）
 *   · tenant-scoped（organizationId 非空）与 platform 级（'' 哨兵）严格隔离
 */

import type { PrismaClient } from '@prisma/client';

import {
  buildAiCacheKey,
  evaluateAiCacheLookup,
  isTenantScopedIdentity,
  type AiCacheIdentity,
} from './rsi-model-cache-identity';

export const AI_MODEL_CACHE_STORE_BOUNDARY = {
  appendOnly: false,
  controlledTtlGc: true,
  identityInPlaceRewrite: 'FORBIDDEN（DB 触发器）',
  crossTenantReuse: 'FORBIDDEN',
  staleHighRiskFallback: 'FORBIDDEN',
  platformSentinelOrganizationId: '',
} as const;

const organizationKey = (identity: AiCacheIdentity): string =>
  isTenantScopedIdentity(identity) ? identity.organizationId!.trim() : '';

const identityWhere = (identity: AiCacheIdentity) => ({
  taskType_promptDigest_inputDigest_ruleVersion_schemaVersion_capabilityTier_organizationId: {
    taskType: identity.taskType.trim(),
    promptDigest: identity.promptDigest.trim().toLowerCase(),
    inputDigest: identity.inputDigest.trim().toLowerCase(),
    ruleVersion: identity.ruleVersion.trim(),
    schemaVersion: identity.schemaVersion.trim(),
    capabilityTier: identity.capabilityTier.trim(),
    organizationId: organizationKey(identity),
  },
});

/** 写入/刷新缓存条目（TTL 受控；identity 与 resultDigest 不可改写）。 */
export async function putAiModelCacheEntry(
  prisma: PrismaClient,
  input: { identity: AiCacheIdentity; resultDigest: string; ttlMs: number; now?: Date },
): Promise<{ id: string; expiresAt: Date }> {
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error('AI_MODEL_CACHE_TTL_INVALID');
  }
  // buildAiCacheKey 同时充当 identity 合法性校验（残缺身份 → 抛错）
  buildAiCacheKey(input.identity);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const row = await prisma.aiModelCacheEntry.upsert({
    where: identityWhere(input.identity),
    create: {
      taskType: input.identity.taskType.trim(),
      promptDigest: input.identity.promptDigest.trim().toLowerCase(),
      inputDigest: input.identity.inputDigest.trim().toLowerCase(),
      ruleVersion: input.identity.ruleVersion.trim(),
      schemaVersion: input.identity.schemaVersion.trim(),
      capabilityTier: input.identity.capabilityTier.trim(),
      organizationId: organizationKey(input.identity),
      resultDigest: input.resultDigest,
      createdAt: now,
      expiresAt,
    },
    update: { expiresAt },
    select: { id: true, expiresAt: true },
  });
  return row;
}

export type AiModelCacheLookupOutcome =
  | { hit: true; reason: 'HIT'; resultDigest: string; savedTokens: 0 }
  | { hit: false; reason: string };

/**
 * 查询缓存：命中必须通过 C1 身份判定（跨租户 / 版本 / schema / 摘要 / stale 一律 MISS）。
 * 过期条目在本次查询中按 TTL 语义视为 MISS（是否物理删除由 gc 决定）。
 */
export async function getAiModelCacheEntry(
  prisma: PrismaClient,
  input: { identity: AiCacheIdentity; now?: Date; highRisk?: boolean },
): Promise<AiModelCacheLookupOutcome> {
  const now = input.now ?? new Date();
  const row = await prisma.aiModelCacheEntry.findUnique({
    where: identityWhere(input.identity),
    select: {
      taskType: true,
      promptDigest: true,
      inputDigest: true,
      ruleVersion: true,
      schemaVersion: true,
      capabilityTier: true,
      organizationId: true,
      resultDigest: true,
      createdAt: true,
      expiresAt: true,
    },
  });
  if (!row) return { hit: false, reason: 'MISS_ABSENT' };
  const verdict = evaluateAiCacheLookup({
    requested: input.identity,
    entry: {
      identity: {
        taskType: row.taskType,
        promptDigest: row.promptDigest,
        inputDigest: row.inputDigest,
        ruleVersion: row.ruleVersion,
        schemaVersion: row.schemaVersion,
        capabilityTier: row.capabilityTier,
        organizationId: row.organizationId,
      },
      createdAtMs: row.createdAt.getTime(),
      ttlMs: Math.max(0, row.expiresAt.getTime() - row.createdAt.getTime()),
      resultDigest: row.resultDigest,
    },
    nowMs: now.getTime(),
    highRisk: input.highRisk,
  });
  if (!verdict.hit) return { hit: false, reason: verdict.reason };
  return { hit: true, reason: 'HIT', resultDigest: verdict.resultDigest, savedTokens: 0 };
}

/** 受控 TTL/GC：删除已过期条目（缓存是派生数据，DELETE 允许）。 */
export async function gcAiModelCacheEntries(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const result = await prisma.aiModelCacheEntry.deleteMany({ where: { expiresAt: { lt: now } } });
  return { deleted: result.count };
}
