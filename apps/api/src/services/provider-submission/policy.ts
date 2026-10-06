// PROVIDER FOLLOW-UP INTELLIGENCE / P1 —— Provider Submission Scheduler：provider-aware 策略（纯决策层）
// ---------------------------------------------------------------------------
// 设计约束（HOST 2026-10-06 P1）：
//   · 限流维度：organizationId / platform / platformAccountId / operation / credential(connection) lineage
//   · 禁止硬编码「每天 3-5 条」「每 1-2 小时一条」「模拟人类行为」这类伪装成策略的常量
//   · 策略必须是 provider-aware 的：rate / burst / retryAfter / backoff / jitter / concurrency / cooldown
//   · transport 仍为 FALSE：本模块只决定 READY_FOR_PROVIDER / RATE_LIMITED / WAITING / NEEDS_MANUAL，不发起任何外部写

import { digestOf } from '../config-execution-durability/digests';

export const PROVIDER_SUBMISSION_POLICY_VERSION = 'provider-submission-policy/v1';

export const PROVIDER_SUBMISSION_OPERATIONS = [
  'CLAIM_SUBMIT',
  'APPEAL_SUBMIT',
  'CASE_REPLY',
  'EVIDENCE_UPLOAD',
  'RFI_RESPOND',
  'STATUS_READ',
] as const;
export type ProviderSubmissionOperation = (typeof PROVIDER_SUBMISSION_OPERATIONS)[number];

export const PROVIDER_SUBMISSION_PLATFORMS = ['AMAZON', 'TIKTOK', 'WALMART', 'CUSTOMS_BROKER'] as const;
export type ProviderSubmissionPlatform = (typeof PROVIDER_SUBMISSION_PLATFORMS)[number];

/** provider-aware 策略：全部数值由 provider profile 提供，代码里不得内嵌“业界惯例”常量。 */
export interface ProviderSubmissionPolicy {
  /** 策略身份（provider profile 版本化身份） */
  providerProfileId: string;
  version: string;
  platform: ProviderSubmissionPlatform;
  /** 稳态速率（每 60s 允许的请求数）；由 provider profile 给出 */
  ratePerMinute: number;
  /** 允许的瞬时突发（burst capacity） */
  burst: number;
  /** provider 明确给出 retry-after 时的上限（防止无限等待） */
  maxRetryAfterMs: number;
  /** 指数退避基数与上限 */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** 抖动比例（0..1）——确定性实现由注入的 rng 决定，不做“人类行为模拟” */
  jitterRatio: number;
  /** 同一 (platformAccountId, operation) 允许的并发执行权数量 */
  maxConcurrency: number;
  /** 连续失败后的冷却期（冷却期内不再派发该 dim key） */
  cooldownMs: number;
  /** 策略生效范围（dimension key 模板） */
  dimensionKeys: readonly ProviderSubmissionDimensionKey[];
}

export const PROVIDER_SUBMISSION_DIMENSION_KEYS = [
  'ORGANIZATION',
  'PLATFORM',
  'PLATFORM_ACCOUNT',
  'OPERATION',
  'CONNECTION',
] as const;
export type ProviderSubmissionDimensionKey = (typeof PROVIDER_SUBMISSION_DIMENSION_KEYS)[number];

export const PROVIDER_SUBMISSION_POLICY_BOUNDARY = {
  transportEnabled: false,
  forbidden: [
    'hardcoded daily/hourly submission quotas',
    'human-behaviour simulation as a rate strategy',
    'real platform write',
    'blind retry after unknown provider response',
  ],
  allowedOutcomes: ['READY_FOR_PROVIDER', 'RATE_LIMITED', 'WAITING', 'NEEDS_MANUAL', 'SIMULATED_ONLY'],
} as const;

export type ProviderPolicyCode =
  | 'POLICY_INVALID_RATE'
  | 'POLICY_INVALID_BURST'
  | 'POLICY_INVALID_BACKOFF'
  | 'POLICY_INVALID_JITTER'
  | 'POLICY_INVALID_CONCURRENCY'
  | 'POLICY_INVALID_COOLDOWN'
  | 'POLICY_INVALID_PLATFORM'
  | 'POLICY_INVALID_DIMENSIONS';

export class ProviderSubmissionPolicyError extends Error {
  readonly code: ProviderPolicyCode;

  constructor(code: ProviderPolicyCode, message: string) {
    super(message);
    this.name = 'ProviderSubmissionPolicyError';
    this.code = code;
  }
}

/** 策略校验：任何缺失/不合法都 fail-closed（绝不 fallback 到“默认惯例”）。 */
export function assertProviderSubmissionPolicy(policy: ProviderSubmissionPolicy): ProviderSubmissionPolicy {
  const fail = (code: ProviderPolicyCode, message: string): never => {
    throw new ProviderSubmissionPolicyError(code, message);
  };
  if (!(PROVIDER_SUBMISSION_PLATFORMS as readonly string[]).includes(policy.platform)) {
    fail('POLICY_INVALID_PLATFORM', `未知 platform：${String(policy.platform)}`);
  }
  if (!(policy.ratePerMinute > 0) || !Number.isFinite(policy.ratePerMinute)) {
    fail('POLICY_INVALID_RATE', 'ratePerMinute 必须为正数且由 provider profile 显式给出');
  }
  // burst = 0 表示“不允许突发”，是合法的 provider 策略（容量 = rate + burst）
  if (!(policy.burst >= 0) || !Number.isInteger(policy.burst)) {
    fail('POLICY_INVALID_BURST', 'burst 必须是 >= 0 的整数（0 = 不允许突发）');
  }
  if (!(policy.backoffBaseMs > 0) || !(policy.backoffMaxMs >= policy.backoffBaseMs)) {
    fail('POLICY_INVALID_BACKOFF', 'backoff 必须满足 0 < base <= max');
  }
  if (!(policy.jitterRatio >= 0 && policy.jitterRatio <= 1)) {
    fail('POLICY_INVALID_JITTER', 'jitterRatio 必须落在 [0, 1]');
  }
  if (!(policy.maxConcurrency >= 1) || !Number.isInteger(policy.maxConcurrency)) {
    fail('POLICY_INVALID_CONCURRENCY', 'maxConcurrency 必须是 >= 1 的整数');
  }
  if (!(policy.cooldownMs >= 0)) {
    fail('POLICY_INVALID_COOLDOWN', 'cooldownMs 必须 >= 0');
  }
  if (!(policy.maxRetryAfterMs > 0)) {
    fail('POLICY_INVALID_RATE', 'maxRetryAfterMs 必须为正数（用于收敛 provider retry-after）');
  }
  if (!Array.isArray(policy.dimensionKeys) || policy.dimensionKeys.length === 0) {
    fail('POLICY_INVALID_DIMENSIONS', 'dimensionKeys 不得为空');
  }
  for (const key of policy.dimensionKeys) {
    if (!(PROVIDER_SUBMISSION_DIMENSION_KEYS as readonly string[]).includes(key)) {
      fail('POLICY_INVALID_DIMENSIONS', `未知 dimension key：${String(key)}`);
    }
  }
  if (policy.providerProfileId.trim().length === 0 || policy.version.trim().length === 0) {
    fail('POLICY_INVALID_DIMENSIONS', 'providerProfileId / version 必须非空（策略必须可追溯）');
  }
  return policy;
}

/** 策略摘要：进入每条 durable 证据，保证事后可证明“当时用的是哪一版策略”。 */
export function providerSubmissionPolicyDigest(policy: ProviderSubmissionPolicy): string {
  return digestOf({ policyEnvelopeVersion: PROVIDER_SUBMISSION_POLICY_VERSION, ...policy });
}

export interface ProviderPolicyRegistryPort {
  /** 只读查询：找不到策略 → undefined（调用方必须 fail-closed，不得使用默认值） */
  findPolicy(input: {
    platform: ProviderSubmissionPlatform;
    operation: ProviderSubmissionOperation;
  }): ProviderSubmissionPolicy | undefined;
}

export function createInMemoryProviderPolicyRegistry(
  policies: readonly ProviderSubmissionPolicy[],
): ProviderPolicyRegistryPort {
  const table = new Map<string, ProviderSubmissionPolicy>();
  for (const policy of policies) {
    assertProviderSubmissionPolicy(policy);
    for (const operation of PROVIDER_SUBMISSION_OPERATIONS) {
      table.set(`${policy.platform}|${operation}`, policy);
    }
  }
  return {
    findPolicy({ platform, operation }) {
      return table.get(`${platform}|${operation}`);
    },
  };
}
