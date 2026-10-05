/**
 * SI-COST-OPTIMIZATION C3 —— Deterministic model cache **runtime wiring**
 * ---------------------------------------------------------------
 * 硬约束（HOST ADDENDUM OPT-3 / MSG-20261005-37 NEXT #1）：
 *   - 接入唯一 `rsi-model-router`（Gateway 内部），cache **不是**第二决策引擎；
 *   - identity 必须 tenant-safe：`organizationId` 为空 → fail-closed（不查、不存）；
 *   - stale / ruleVersion / schemaVersion / inputDigest / promptDigest / tenant 不匹配 → MISS（复用 C1 判定）；
 *   - 高风险场景禁止 stale fallback（由 C1 `evaluateAiCacheLookup` 保证）；
 *   - cache HIT **不得产生假 provider ledger entry**：本模块只返回判定 + savings，
 *     真实成本事实仍然只能来自 durable `AiCostLedgerEntry`（真实 provider invocation）。
 *   - savings 无可信估算器时标记 `NOT_YET_MEASURABLE`（禁止伪造节省量）。
 */

import type { PrismaClient } from '@prisma/client';

import { buildAiCacheKey, type AiCacheIdentity } from './rsi-model-cache-identity';
import { getAiModelCacheEntry, putAiModelCacheEntry } from './si-model-cache-store';

/** 与 C1 identity 七字段一致；`organizationId` 为 null 表示「未提供」→ fail-closed */
export interface AiModelCacheScope {
  taskType: string;
  promptDigest: string;
  inputDigest: string;
  ruleVersion: string;
  schemaVersion: string;
  capabilityTier: string;
  organizationId: string | null;
}

export const AI_MODEL_CACHE_RUNTIME_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export const AI_MODEL_CACHE_RUNTIME_BOUNDARY = {
  singleChokePoint: 'rsi-model-router（Gateway 内部）',
  tenantScopedIdentity: 'REQUIRED（organizationId 为空 → fail-closed）',
  staleFallback: 'FORBIDDEN',
  highRiskStaleFallback: 'FORBIDDEN',
  fakeProviderLedgerEntryOnHit: 'FORBIDDEN',
  savingsSource: 'EXPLICIT_ESTIMATOR_OR_NOT_YET_MEASURABLE',
  secondPolicyEngine: 'FORBIDDEN',
  recordsCustomerData: false,
} as const;

export type AiModelCacheSavingsSource = 'ESTIMATOR' | 'NOT_YET_MEASURABLE';

export type AiModelCacheRuntimeLookup =
  | {
      hit: true;
      reason: 'HIT';
      resultDigest: string;
      savedTokens: number | null;
      savedCostMicros: number | null;
      savingsSource: AiModelCacheSavingsSource;
    }
  | { hit: false; reason: string };

export interface AiModelCacheRuntimePort {
  lookup(input: { scope: AiModelCacheScope; highRisk?: boolean; now?: Date }): Promise<AiModelCacheRuntimeLookup>;
  storeResult(input: {
    scope: AiModelCacheScope;
    resultDigest: string;
    ttlMs?: number;
    now?: Date;
  }): Promise<{ stored: boolean; expiresAt: string | null; reason: string }>;
}

/** tenant-safe identity：organizationId 缺失 / 空白 → 抛错（fail-closed，不查不存） */
export function toAiCacheIdentity(scope: AiModelCacheScope): AiCacheIdentity {
  const organizationId = typeof scope.organizationId === 'string' ? scope.organizationId.trim() : '';
  if (organizationId === '') throw new Error('AI_MODEL_CACHE_TENANT_REQUIRED');
  const identity: AiCacheIdentity = {
    taskType: scope.taskType,
    promptDigest: scope.promptDigest,
    inputDigest: scope.inputDigest,
    ruleVersion: scope.ruleVersion,
    schemaVersion: scope.schemaVersion,
    capabilityTier: scope.capabilityTier,
    organizationId,
  };
  // buildAiCacheKey 同时充当 identity 合法性校验（字段缺失 / 非法 → 抛错）
  buildAiCacheKey(identity);
  return identity;
}

export interface AiCacheSavingsEstimatorInput {
  scope: AiModelCacheScope;
  resultDigest: string;
}

export interface AiCacheSavingsEstimate {
  savedTokens: number;
  savedCostMicros: number;
}

/**
 * 构造 cache runtime port。
 * `estimateSavings` 必须由 host 以**真实历史口径**提供（例如同 taskType 的 p50 usage）；
 * 未提供 → savings 一律 `NOT_YET_MEASURABLE`（绝不使用编造数字）。
 */
export function createAiModelCacheRuntime(
  prisma: PrismaClient,
  options: {
    defaultTtlMs?: number;
    estimateSavings?: (input: AiCacheSavingsEstimatorInput) => AiCacheSavingsEstimate | null;
  } = {},
): AiModelCacheRuntimePort {
  const defaultTtlMs = options.defaultTtlMs ?? AI_MODEL_CACHE_RUNTIME_DEFAULT_TTL_MS;

  return {
    async lookup(input) {
      const identity = toAiCacheIdentity(input.scope);
      const outcome = await getAiModelCacheEntry(prisma, {
        identity,
        now: input.now,
        highRisk: input.highRisk,
      });
      if (!outcome.hit) return { hit: false, reason: outcome.reason };
      const estimate = options.estimateSavings?.({ scope: input.scope, resultDigest: outcome.resultDigest }) ?? null;
      if (
        estimate !== null &&
        Number.isInteger(estimate.savedTokens) &&
        estimate.savedTokens >= 0 &&
        Number.isInteger(estimate.savedCostMicros) &&
        estimate.savedCostMicros >= 0
      ) {
        return {
          hit: true,
          reason: 'HIT',
          resultDigest: outcome.resultDigest,
          savedTokens: estimate.savedTokens,
          savedCostMicros: estimate.savedCostMicros,
          savingsSource: 'ESTIMATOR',
        };
      }
      return {
        hit: true,
        reason: 'HIT',
        resultDigest: outcome.resultDigest,
        savedTokens: null,
        savedCostMicros: null,
        savingsSource: 'NOT_YET_MEASURABLE',
      };
    },

    async storeResult(input) {
      const identity = toAiCacheIdentity(input.scope);
      if (typeof input.resultDigest !== 'string' || input.resultDigest.trim() === '') {
        throw new Error('AI_MODEL_CACHE_RESULT_DIGEST_REQUIRED');
      }
      const row = await putAiModelCacheEntry(prisma, {
        identity,
        resultDigest: input.resultDigest,
        ttlMs: input.ttlMs ?? defaultTtlMs,
        now: input.now,
      });
      return { stored: true, expiresAt: row.expiresAt.toISOString(), reason: 'STORED' };
    },
  };
}
