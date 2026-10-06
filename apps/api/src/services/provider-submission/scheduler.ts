// PROVIDER FOLLOW-UP INTELLIGENCE / P1 —— Scheduler 纯决策（无 IO、无进程内状态）
// ---------------------------------------------------------------------------
// 链：ClaimReady → Approval → SubmissionIntent → ProviderQueue → AccountRateLimit
//     → OperationRateLimit → TransportGate → Provider
// 本轮 transport = FALSE：dispatch 只能产出 READY_FOR_PROVIDER / RATE_LIMITED / WAITING / NEEDS_MANUAL。
// UNKNOWN provider 响应：禁止 blind retry，必须先做只读 reconciliation。

import { digestOf } from '../config-execution-durability/digests';
import {
  PROVIDER_SUBMISSION_OPERATIONS,
  type ProviderSubmissionDimensionKey,
  type ProviderSubmissionOperation,
  type ProviderSubmissionPlatform,
  type ProviderSubmissionPolicy,
} from './policy';

export const PROVIDER_SUBMISSION_INTENT_STATES = [
  'QUEUED',
  'WAITING',
  'RATE_LIMITED',
  'READY_FOR_PROVIDER',
  'LEASED',
  'NEEDS_MANUAL',
  'DEAD_LETTER',
  'CANCELLED',
] as const;
export type ProviderSubmissionIntentState = (typeof PROVIDER_SUBMISSION_INTENT_STATES)[number];

export const PROVIDER_SUBMISSION_TERMINAL_STATES = ['NEEDS_MANUAL', 'DEAD_LETTER', 'CANCELLED'] as const;
export type ProviderSubmissionTerminalState = (typeof PROVIDER_SUBMISSION_TERMINAL_STATES)[number];

/** provider 响应分类（429 / retryable 5xx / timeout / connection reset / unknown）。 */
export const PROVIDER_RESPONSE_KINDS = [
  'SUCCESS',
  'RATE_LIMITED_429',
  'RETRYABLE_5XX',
  'TIMEOUT',
  'CONNECTION_RESET',
  'UNKNOWN',
] as const;
export type ProviderResponseKind = (typeof PROVIDER_RESPONSE_KINDS)[number];

export const PROVIDER_SUBMISSION_EVENT_KINDS = [
  'ENQUEUED',
  'DISPATCH_READY',
  'RATE_LIMITED',
  'WAITING',
  'LEASE_ACQUIRED',
  'LEASE_RECLAIMED',
  'OUTCOME_RECORDED',
  'RECONCILIATION_REQUIRED',
  'DEAD_LETTERED',
  'MANUAL_REVIEW',
  'CANCELLED',
] as const;
export type ProviderSubmissionEventKind = (typeof PROVIDER_SUBMISSION_EVENT_KINDS)[number];

export interface ProviderSubmissionIntentView {
  id: string;
  organizationId: string;
  platform: ProviderSubmissionPlatform;
  platformAccountId: string;
  connectionRef: string;
  operation: ProviderSubmissionOperation;
  state: ProviderSubmissionIntentState;
  priority: number;
  attemptCount: number;
  availableAt: Date;
  retryAfterAt: Date | null;
  cooldownUntil: Date | null;
  idempotencyKey: string;
  payloadDigest: string;
  basisDigest: string;
  ownerRef: string | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
}

/** provider-aware 限流窗口（durable；由 store 维护，这里只看快照）。 */
export interface ProviderRateWindowView {
  scopeKey: string;
  windowStart: Date;
  windowMs: number;
  count: number;
}

export interface ProviderConcurrencyView {
  /** 当前已持有执行权（LEASED 且 lease 未过期）的数量，按 dim key 统计 */
  activeByDimension: Readonly<Record<string, number>>;
}

export function providerSubmissionDimensionKey(input: {
  key: ProviderSubmissionDimensionKey;
  organizationId: string;
  platform: ProviderSubmissionPlatform;
  platformAccountId: string;
  operation: ProviderSubmissionOperation;
  connectionRef: string;
}): string {
  switch (input.key) {
    case 'ORGANIZATION':
      return `org:${input.organizationId}`;
    case 'PLATFORM':
      return `org:${input.organizationId}|platform:${input.platform}`;
    case 'PLATFORM_ACCOUNT':
      return `org:${input.organizationId}|account:${input.platformAccountId}`;
    case 'OPERATION':
      return `org:${input.organizationId}|platform:${input.platform}|op:${input.operation}`;
    case 'CONNECTION':
      return `org:${input.organizationId}|connection:${input.connectionRef}`;
    default:
      return `org:${input.organizationId}`;
  }
}

export function providerRateScopeKey(input: {
  policy: ProviderSubmissionPolicy;
  organizationId: string;
  platform: ProviderSubmissionPlatform;
  platformAccountId: string;
  operation: ProviderSubmissionOperation;
  connectionRef: string;
}): string {
  const dims = input.policy.dimensionKeys.map((key) =>
    providerSubmissionDimensionKey({
      key,
      organizationId: input.organizationId,
      platform: input.platform,
      platformAccountId: input.platformAccountId,
      operation: input.operation,
      connectionRef: input.connectionRef,
    }),
  );
  return `${input.policy.providerProfileId}|${dims.join('&')}`;
}

export interface ProviderSubmissionIdempotencyPlan {
  idempotencyKey: string;
  payloadDigest: string;
  basisDigest: string;
}

/** 入队身份：同幂等键 + 同载荷 → 复用；同键异载荷 → fail-closed。 */
export function planProviderSubmissionIdempotency(input: {
  idempotencyKey: string;
  payload: unknown;
  basis: unknown;
}): ProviderSubmissionIdempotencyPlan {
  const idempotencyKey = (input.idempotencyKey ?? '').trim();
  if (idempotencyKey.length === 0) {
    throw new Error('PROVIDER_SUBMISSION_IDEMPOTENCY_KEY_REQUIRED');
  }
  return {
    idempotencyKey,
    payloadDigest: digestOf(input.payload),
    basisDigest: digestOf(input.basis),
  };
}

export type ProviderEnqueueDecision =
  | { kind: 'CREATE'; idempotencyKey: string }
  | { kind: 'REUSE'; intentId: string; state: ProviderSubmissionIntentState }
  | { kind: 'FAIL_CLOSED'; code: 'IDEMPOTENCY_KEY_CONFLICT'; message: string };

export function decideProviderEnqueue(
  existing: { id: string; payloadDigest: string; state: ProviderSubmissionIntentState } | null,
  plan: ProviderSubmissionIdempotencyPlan,
): ProviderEnqueueDecision {
  if (!existing) return { kind: 'CREATE', idempotencyKey: plan.idempotencyKey };
  if (existing.payloadDigest === plan.payloadDigest) {
    return { kind: 'REUSE', intentId: existing.id, state: existing.state };
  }
  return {
    kind: 'FAIL_CLOSED',
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    message: '同一 idempotencyKey 的载荷摘要不一致（禁止 silent overwrite / 重复提交）',
  };
}

export interface ProviderDispatchWindows {
  /** 当前窗口（未命中则为 null） */
  window: ProviderRateWindowView | null;
  /** (platformAccountId, operation) 维度并发占用 */
  concurrency: ProviderConcurrencyView;
}

export type ProviderDispatchDecision =
  | { kind: 'READY_FOR_PROVIDER'; reason: 'WITHIN_RATE_AND_CONCURRENCY' }
  | { kind: 'RATE_LIMITED'; retryAfterMs: number; reason: 'WINDOW_EXHAUSTED' }
  | { kind: 'WAITING'; waitUntilMs: number; reason: 'AVAILABLE_AT' | 'RETRY_AFTER' | 'COOLDOWN' }
  | { kind: 'NEEDS_MANUAL'; reason: 'POLICY_MISSING' | 'ATTEMPTS_EXHAUSTED' };

/**
 * 派发决策（纯函数）：
 *   冷却 → retry-after/availableAt → 并发上限 → 速率窗口 → READY_FOR_PROVIDER
 * 任何维度不足都只降级为 WAITING / RATE_LIMITED；绝不因为“等太久”而放宽策略。
 */
export function planProviderDispatch(input: {
  intent: ProviderSubmissionIntentView;
  policy: ProviderSubmissionPolicy | null;
  windows: ProviderDispatchWindows;
  now: Date;
  maxAttempts: number;
}): ProviderDispatchDecision {
  const { intent, policy, windows, now, maxAttempts } = input;
  if (!policy) return { kind: 'NEEDS_MANUAL', reason: 'POLICY_MISSING' };
  if (intent.attemptCount >= maxAttempts) {
    return { kind: 'NEEDS_MANUAL', reason: 'ATTEMPTS_EXHAUSTED' };
  }
  if (intent.cooldownUntil && intent.cooldownUntil.getTime() > now.getTime()) {
    return {
      kind: 'WAITING',
      waitUntilMs: intent.cooldownUntil.getTime() - now.getTime(),
      reason: 'COOLDOWN',
    };
  }
  if (intent.retryAfterAt && intent.retryAfterAt.getTime() > now.getTime()) {
    return {
      kind: 'WAITING',
      waitUntilMs: intent.retryAfterAt.getTime() - now.getTime(),
      reason: 'RETRY_AFTER',
    };
  }
  if (intent.availableAt.getTime() > now.getTime()) {
    return {
      kind: 'WAITING',
      waitUntilMs: intent.availableAt.getTime() - now.getTime(),
      reason: 'AVAILABLE_AT',
    };
  }
  const concurrencyKey = providerSubmissionDimensionKey({
    key: 'OPERATION',
    organizationId: intent.organizationId,
    platform: intent.platform,
    platformAccountId: intent.platformAccountId,
    operation: intent.operation,
    connectionRef: intent.connectionRef,
  });
  const active = windows.concurrency.activeByDimension[concurrencyKey] ?? 0;
  if (active >= policy.maxConcurrency) {
    return {
      kind: 'WAITING',
      waitUntilMs: policy.cooldownMs > 0 ? policy.cooldownMs : 1_000,
      reason: 'COOLDOWN',
    };
  }
  const scopeKey = providerRateScopeKey({
    policy,
    organizationId: intent.organizationId,
    platform: intent.platform,
    platformAccountId: intent.platformAccountId,
    operation: intent.operation,
    connectionRef: intent.connectionRef,
  });
  if (windows.window && windows.window.scopeKey === scopeKey) {
    const capacity = Math.floor(policy.ratePerMinute) + policy.burst;
    const elapsedMs = now.getTime() - windows.window.windowStart.getTime();
    if (windows.window.count >= capacity && elapsedMs < windows.window.windowMs) {
      return {
        kind: 'RATE_LIMITED',
        retryAfterMs: windows.window.windowMs - elapsedMs,
        reason: 'WINDOW_EXHAUSTED',
      };
    }
  }
  return { kind: 'READY_FOR_PROVIDER', reason: 'WITHIN_RATE_AND_CONCURRENCY' };
}

export interface ProviderSubmissionLease {
  ownerRef: string;
  leaseId: string;
  acquiredAt: Date;
  expiresAt: Date;
  attemptNo: number;
}

export type ProviderLeaseDecision =
  | { kind: 'ACQUIRE'; lease: ProviderSubmissionLease; fromState: 'READY_FOR_PROVIDER' | 'QUEUED' }
  | { kind: 'RENEW'; leaseId: string; expiresAt: Date }
  | { kind: 'LEASE_HELD'; ownerRef: string | null; expiresAt: Date }
  | { kind: 'NOT_DISPATCHABLE'; state: ProviderSubmissionIntentState };

/** exactly-once execution right：只有 READY_FOR_PROVIDER / QUEUED 且无有效 lease 才能取得执行权。 */
export function planProviderLease(input: {
  intent: ProviderSubmissionIntentView;
  ownerRef: string;
  leaseId: string;
  now: Date;
  leaseTtlMs: number;
}): ProviderLeaseDecision {
  const { intent, ownerRef, leaseId, now, leaseTtlMs } = input;
  const active = intent.leaseExpiresAt !== null && intent.leaseExpiresAt.getTime() > now.getTime();
  if (intent.state === 'LEASED' && active) {
    if (intent.ownerRef === ownerRef && intent.leaseId === leaseId) {
      return { kind: 'RENEW', leaseId, expiresAt: new Date(now.getTime() + leaseTtlMs) };
    }
    return {
      kind: 'LEASE_HELD',
      ownerRef: intent.ownerRef,
      expiresAt: intent.leaseExpiresAt as Date,
    };
  }
  if (intent.state !== 'READY_FOR_PROVIDER' && intent.state !== 'QUEUED') {
    return { kind: 'NOT_DISPATCHABLE', state: intent.state };
  }
  return {
    kind: 'ACQUIRE',
    fromState: intent.state === 'READY_FOR_PROVIDER' ? 'READY_FOR_PROVIDER' : 'QUEUED',
    lease: {
      ownerRef,
      leaseId,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + leaseTtlMs),
      attemptNo: intent.attemptCount + 1,
    },
  };
}

export type ProviderOutcomeAction =
  | { kind: 'MARK_SENT_SIMULATED'; reason: 'SUCCESS' }
  | { kind: 'RETRY_LATER'; retryAfterMs: number; reason: 'RATE_LIMITED_429' | 'RETRYABLE_5XX' | 'TIMEOUT' | 'CONNECTION_RESET' }
  | { kind: 'RECONCILE_READ_ONLY'; reason: 'UNKNOWN_RESPONSE' }
  | { kind: 'DEAD_LETTER'; reason: 'ATTEMPTS_EXHAUSTED' };

/**
 * provider 响应 → 下一步动作。
 * 关键：UNKNOWN **绝不** blind retry —— 必须先做只读 reconciliation，拿到“未执行”的可信证据后才允许重发。
 * 429 使用 provider 给出的 retry-after（收敛在上限内）；可重试 5xx / timeout / connection reset 走指数退避 + 抖动。
 */
export function planProviderOutcome(input: {
  responseKind: ProviderResponseKind;
  policy: ProviderSubmissionPolicy;
  attemptCount: number;
  maxAttempts: number;
  retryAfterMs?: number | null;
  rng?: () => number;
}): ProviderOutcomeAction {
  const { responseKind, policy, attemptCount, maxAttempts } = input;
  const exhausted = attemptCount >= maxAttempts;
  const rng = input.rng ?? (() => 0.5);
  const withJitter = (base: number): number => {
    const jitter = Math.round(base * policy.jitterRatio * (rng() * 2 - 1));
    return Math.max(0, base + jitter);
  };

  switch (responseKind) {
    case 'SUCCESS':
      return { kind: 'MARK_SENT_SIMULATED', reason: 'SUCCESS' };
    case 'RATE_LIMITED_429': {
      if (exhausted) return { kind: 'DEAD_LETTER', reason: 'ATTEMPTS_EXHAUSTED' };
      const providerRetryAfter = input.retryAfterMs ?? policy.backoffBaseMs;
      const bounded = Math.min(Math.max(providerRetryAfter, 0), policy.maxRetryAfterMs);
      return {
        kind: 'RETRY_LATER',
        retryAfterMs: withJitter(bounded),
        reason: 'RATE_LIMITED_429',
      };
    }
    case 'RETRYABLE_5XX':
    case 'TIMEOUT':
    case 'CONNECTION_RESET': {
      if (exhausted) return { kind: 'DEAD_LETTER', reason: 'ATTEMPTS_EXHAUSTED' };
      const backoff = Math.min(policy.backoffBaseMs * 2 ** Math.max(0, attemptCount - 1), policy.backoffMaxMs);
      return { kind: 'RETRY_LATER', retryAfterMs: withJitter(backoff), reason: responseKind };
    }
    case 'UNKNOWN':
    default:
      // 未知结果：先只读对账；禁止直接重发。
      return { kind: 'RECONCILE_READ_ONLY', reason: 'UNKNOWN_RESPONSE' };
  }
}

export function isProviderSubmissionOperation(value: string): value is ProviderSubmissionOperation {
  return (PROVIDER_SUBMISSION_OPERATIONS as readonly string[]).includes(value);
}

/** transport gate：本轮恒为 false；调度器最多产出 READY_FOR_PROVIDER。 */
export const PROVIDER_SUBMISSION_TRANSPORT_ENABLED = false;

export function assertProviderTransportDisabled(): void {
  if (PROVIDER_SUBMISSION_TRANSPORT_ENABLED !== false) {
    throw new Error('PROVIDER_SUBMISSION_TRANSPORT_MUST_BE_FALSE');
  }
}
