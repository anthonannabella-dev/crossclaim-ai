/**
 * RSI / CrossClaim SI —— 确定性模型缓存身份契约（C1，零 Schema）
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-30（3.3 = A 但存储层入 C2；C1 只交付 identity 契约）。
 *
 * 安全要求：
 *   · cache identity 必须绑定全部安全身份字段；
 *   · 任一身份字段不一致 → MISS（不得复用）；
 *   · tenant-scoped 必须含 `organizationId`，**禁止跨 tenant 复用**；
 *   · 过期（stale）→ MISS；高风险任务 stale fallback = FORBIDDEN；
 *   · 缓存是可丢弃派生数据（C2 允许受控 TTL/GC），但 key/内容身份不可原地改写。
 */

export const AI_CACHE_IDENTITY_FIELDS = [
  'taskType',
  'promptDigest',
  'inputDigest',
  'ruleVersion',
  'schemaVersion',
  'capabilityTier',
  'organizationId',
] as const;

export interface AiCacheIdentity {
  taskType: string;
  promptDigest: string;
  inputDigest: string;
  ruleVersion: string;
  schemaVersion: string;
  /** 能力 / 模型层级身份（例如 LOW_COST / STRONG 或模型能力档位） */
  capabilityTier: string;
  /** tenant-scoped 任务必填；platform 级任务为 null */
  organizationId?: string | null;
}

export const AI_CACHE_MISS_REASONS = [
  'MISS_ABSENT',
  'MISS_IDENTITY_INVALID',
  'MISS_TASK_TYPE',
  'MISS_PROMPT_DIGEST',
  'MISS_INPUT_DIGEST',
  'MISS_RULE_VERSION',
  'MISS_SCHEMA_VERSION',
  'MISS_CAPABILITY_TIER',
  'MISS_ORGANIZATION',
  'MISS_STALE',
  'MISS_HIGH_RISK_STALE_FORBIDDEN',
] as const;
export type AiCacheMissReason = (typeof AI_CACHE_MISS_REASONS)[number];

export const AI_CACHE_BOUNDARY = {
  schemaInC1: false,
  storageLayer: 'C2（AiModelCacheEntry）',
  crossTenantReuse: 'FORBIDDEN',
  staleHighRiskFallback: 'FORBIDDEN',
  appendOnlyRequired: false,
  controlledTtlGc: true,
  keyOrContentInPlaceRewrite: 'FORBIDDEN',
} as const;

const isDigestLike = (value: unknown): boolean =>
  typeof value === 'string' && /^[0-9a-f]{8,64}$/i.test(value.trim());
const isNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

export function validateAiCacheIdentity(identity: AiCacheIdentity | null | undefined): {
  ok: boolean;
  problems: readonly string[];
} {
  if (!identity) return { ok: false, problems: ['IDENTITY_MISSING'] };
  const problems: string[] = [];
  if (!isNonEmptyString(identity.taskType)) problems.push('TASK_TYPE_MISSING');
  if (!isDigestLike(identity.promptDigest)) problems.push('PROMPT_DIGEST_INVALID');
  if (!isDigestLike(identity.inputDigest)) problems.push('INPUT_DIGEST_INVALID');
  if (!isNonEmptyString(identity.ruleVersion)) problems.push('RULE_VERSION_MISSING');
  if (!isNonEmptyString(identity.schemaVersion)) problems.push('SCHEMA_VERSION_MISSING');
  if (!isNonEmptyString(identity.capabilityTier)) problems.push('CAPABILITY_TIER_MISSING');
  if (identity.organizationId !== undefined && identity.organizationId !== null && !isNonEmptyString(identity.organizationId)) {
    problems.push('ORGANIZATION_INVALID');
  }
  return { ok: problems.length === 0, problems };
}

/** 该身份是否 tenant-scoped（有 organizationId 即为 tenant-scoped） */
export function isTenantScopedIdentity(identity: AiCacheIdentity): boolean {
  return typeof identity.organizationId === 'string' && identity.organizationId.trim() !== '';
}

const stableStringify = (value: Record<string, unknown>): string =>
  '{' +
  Object.keys(value)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + JSON.stringify(value[key]))
    .join(',') +
  '}';

/**
 * canonical cache key：只由身份字段构成（无 prompt 正文、无模型输出、无凭据）。
 * 身份无效 → 抛错（fail-closed，禁止用残缺身份命中缓存）。
 */
export function buildAiCacheKey(identity: AiCacheIdentity): string {
  const validated = validateAiCacheIdentity(identity);
  if (!validated.ok) {
    throw new Error('AI_CACHE_IDENTITY_INVALID: ' + validated.problems.join(','));
  }
  const projection: Record<string, unknown> = {
    taskType: identity.taskType.trim(),
    promptDigest: identity.promptDigest.trim().toLowerCase(),
    inputDigest: identity.inputDigest.trim().toLowerCase(),
    ruleVersion: identity.ruleVersion.trim(),
    schemaVersion: identity.schemaVersion.trim(),
    capabilityTier: identity.capabilityTier.trim(),
    organizationId: isTenantScopedIdentity(identity) ? identity.organizationId!.trim() : null,
  };
  return 'ai-cache/v1:' + stableStringify(projection);
}

export interface AiCacheEntryRecord {
  identity: AiCacheIdentity;
  createdAtMs: number;
  ttlMs: number;
  /** 结果摘要（不落模型原文） */
  resultDigest: string;
}

export interface AiCacheLookupInput {
  requested: AiCacheIdentity;
  entry: AiCacheEntryRecord | null | undefined;
  nowMs: number;
  /** 高风险任务：过期缓存一律不得回退使用 */
  highRisk?: boolean;
}

export type AiCacheLookupResult =
  | { hit: true; reason: 'HIT'; resultDigest: string }
  | { hit: false; reason: AiCacheMissReason; problems?: readonly string[] };

/**
 * 缓存查询判定（纯函数）：
 *   身份任一字段不一致 / 过期 / 高风险 stale → MISS（绝不跨 tenant、绝不复用错版本）。
 */
export function evaluateAiCacheLookup(input: AiCacheLookupInput): AiCacheLookupResult {
  const requestedValidation = validateAiCacheIdentity(input.requested);
  if (!requestedValidation.ok) {
    return { hit: false, reason: 'MISS_IDENTITY_INVALID', problems: requestedValidation.problems };
  }
  if (!input.entry) return { hit: false, reason: 'MISS_ABSENT' };
  const entryValidation = validateAiCacheIdentity(input.entry.identity);
  if (!entryValidation.ok) {
    return { hit: false, reason: 'MISS_IDENTITY_INVALID', problems: entryValidation.problems };
  }

  const r = input.requested;
  const e = input.entry.identity;
  if (r.taskType.trim() !== e.taskType.trim()) return { hit: false, reason: 'MISS_TASK_TYPE' };
  if (r.promptDigest.trim().toLowerCase() !== e.promptDigest.trim().toLowerCase()) {
    return { hit: false, reason: 'MISS_PROMPT_DIGEST' };
  }
  if (r.inputDigest.trim().toLowerCase() !== e.inputDigest.trim().toLowerCase()) {
    return { hit: false, reason: 'MISS_INPUT_DIGEST' };
  }
  if (r.ruleVersion.trim() !== e.ruleVersion.trim()) return { hit: false, reason: 'MISS_RULE_VERSION' };
  if (r.schemaVersion.trim() !== e.schemaVersion.trim()) return { hit: false, reason: 'MISS_SCHEMA_VERSION' };
  if (r.capabilityTier.trim() !== e.capabilityTier.trim()) return { hit: false, reason: 'MISS_CAPABILITY_TIER' };

  const requestedOrg = isTenantScopedIdentity(r) ? r.organizationId!.trim() : null;
  const entryOrg = isTenantScopedIdentity(e) ? e.organizationId!.trim() : null;
  if (requestedOrg !== entryOrg) return { hit: false, reason: 'MISS_ORGANIZATION' };

  const ageMs = input.nowMs - input.entry.createdAtMs;
  const stale = !Number.isFinite(ageMs) || ageMs < 0 || ageMs > input.entry.ttlMs;
  if (stale) {
    return input.highRisk === true
      ? { hit: false, reason: 'MISS_HIGH_RISK_STALE_FORBIDDEN' }
      : { hit: false, reason: 'MISS_STALE' };
  }
  return { hit: true, reason: 'HIT', resultDigest: input.entry.resultDigest };
}
