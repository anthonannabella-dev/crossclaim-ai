// PROVIDER FOLLOW-UP INTELLIGENCE / P1 —— Provider Submission Scheduler 纯决策回归（无数据库）

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_SUBMISSION_POLICY_BOUNDARY,
  PROVIDER_SUBMISSION_POLICY_VERSION,
  ProviderSubmissionPolicyError,
  assertProviderSubmissionPolicy,
  createInMemoryProviderPolicyRegistry,
  providerSubmissionPolicyDigest,
  type ProviderSubmissionPolicy,
} from '../services/provider-submission';
import {
  PROVIDER_SUBMISSION_TRANSPORT_ENABLED,
  assertProviderTransportDisabled,
  decideProviderEnqueue,
  planProviderDispatch,
  planProviderLease,
  planProviderOutcome,
  planProviderSubmissionIdempotency,
  providerRateScopeKey,
  providerSubmissionDimensionKey,
  type ProviderSubmissionIntentView,
} from '../services/provider-submission';

const NOW = new Date('2026-10-06T06:00:00.000Z');

function policy(overrides: Partial<ProviderSubmissionPolicy> = {}): ProviderSubmissionPolicy {
  return {
    providerProfileId: 'amazon-sp-api-support/v1',
    version: '2026-10-06',
    platform: 'AMAZON',
    ratePerMinute: 6,
    burst: 2,
    maxRetryAfterMs: 15 * 60 * 1000,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
    jitterRatio: 0.2,
    maxConcurrency: 2,
    cooldownMs: 5_000,
    dimensionKeys: ['ORGANIZATION', 'PLATFORM', 'PLATFORM_ACCOUNT', 'OPERATION', 'CONNECTION'],
    ...overrides,
  };
}

function intent(overrides: Partial<ProviderSubmissionIntentView> = {}): ProviderSubmissionIntentView {
  return {
    id: 'intent-1',
    organizationId: 'org-1',
    platform: 'AMAZON',
    platformAccountId: 'acct-A',
    connectionRef: 'conn-1',
    operation: 'CLAIM_SUBMIT',
    state: 'QUEUED',
    priority: 0,
    attemptCount: 0,
    availableAt: NOW,
    retryAfterAt: null,
    cooldownUntil: null,
    idempotencyKey: 'idem-1',
    payloadDigest: 'payload-1',
    basisDigest: 'basis-1',
    ownerRef: null,
    leaseId: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

describe('P1 Provider Submission Scheduler · policy', () => {
  it('策略必须由 provider profile 显式给出：缺失/非法一律 fail-closed（无默认惯例）', () => {
    expect(assertProviderSubmissionPolicy(policy()).platform).toBe('AMAZON');
    expect(() => assertProviderSubmissionPolicy(policy({ ratePerMinute: 0 }))).toThrow(ProviderSubmissionPolicyError);
    expect(assertProviderSubmissionPolicy(policy({ burst: 0 })).burst).toBe(0);
    expect(() => assertProviderSubmissionPolicy(policy({ burst: -1 }))).toThrow(/burst/);
    expect(() => assertProviderSubmissionPolicy(policy({ burst: 1.5 }))).toThrow(/burst/);
    expect(() => assertProviderSubmissionPolicy(policy({ backoffBaseMs: 5_000, backoffMaxMs: 1_000 }))).toThrow(/backoff/);
    expect(() => assertProviderSubmissionPolicy(policy({ jitterRatio: 1.5 }))).toThrow(/jitter/);
    expect(() => assertProviderSubmissionPolicy(policy({ maxConcurrency: 0 }))).toThrow(/maxConcurrency/);
    expect(() => assertProviderSubmissionPolicy(policy({ cooldownMs: -1 }))).toThrow(/cooldown/);
    expect(() =>
      assertProviderSubmissionPolicy(policy({ platform: 'EBAY' as unknown as ProviderSubmissionPolicy['platform'] })),
    ).toThrow(/platform/);
    expect(() => assertProviderSubmissionPolicy(policy({ dimensionKeys: [] }))).toThrow(/dimensionKeys/);
  });

  it('策略摘要可追溯；未知 platform/operation 的 registry 查询返回 undefined（调用方必须 fail-closed）', () => {
    const digest = providerSubmissionPolicyDigest(policy());
    expect(digest).toHaveLength(64);
    expect(digest).not.toBe(providerSubmissionPolicyDigest(policy({ burst: 3 })));

    const registry = createInMemoryProviderPolicyRegistry([policy()]);
    expect(registry.findPolicy({ platform: 'AMAZON', operation: 'CLAIM_SUBMIT' })).toBeTruthy();
    expect(registry.findPolicy({ platform: 'WALMART', operation: 'CLAIM_SUBMIT' })).toBeUndefined();
  });

  it('transport 恒为 FALSE（调度器不得发起任何外部写）', () => {
    expect(PROVIDER_SUBMISSION_TRANSPORT_ENABLED).toBe(false);
    expect(PROVIDER_SUBMISSION_POLICY_BOUNDARY.transportEnabled).toBe(false);
    expect(() => assertProviderTransportDisabled()).not.toThrow();
    expect(PROVIDER_SUBMISSION_POLICY_VERSION).toBe('provider-submission-policy/v1');
  });
});

describe('P1 Provider Submission Scheduler · 入队幂等与维度', () => {
  it('同幂等键同载荷 → REUSE；同键异载荷 → FAIL_CLOSED；空键 → 拒绝', () => {
    const plan = planProviderSubmissionIdempotency({
      idempotencyKey: 'idem-1',
      payload: { amount: '120.0000' },
      basis: { caseRef: 'case-1' },
    });
    expect(decideProviderEnqueue(null, plan)).toEqual({ kind: 'CREATE', idempotencyKey: 'idem-1' });
    expect(
      decideProviderEnqueue({ id: 'i1', payloadDigest: plan.payloadDigest, state: 'QUEUED' }, plan),
    ).toEqual({ kind: 'REUSE', intentId: 'i1', state: 'QUEUED' });
    const conflict = decideProviderEnqueue(
      { id: 'i1', payloadDigest: 'other', state: 'QUEUED' },
      plan,
    );
    expect(conflict.kind).toBe('FAIL_CLOSED');
    expect(() =>
      planProviderSubmissionIdempotency({ idempotencyKey: '  ', payload: {}, basis: {} }),
    ).toThrow(/IDEMPOTENCY_KEY_REQUIRED/);
  });

  it('维度键包含 org/platform/account/operation/connection（account 与 platform 相互隔离）', () => {
    const base = {
      organizationId: 'org-1',
      platform: 'AMAZON' as const,
      platformAccountId: 'acct-A',
      operation: 'CLAIM_SUBMIT' as const,
      connectionRef: 'conn-1',
    };
    expect(providerSubmissionDimensionKey({ key: 'ORGANIZATION', ...base })).toBe('org:org-1');
    expect(providerSubmissionDimensionKey({ key: 'PLATFORM_ACCOUNT', ...base })).toBe('org:org-1|account:acct-A');
    expect(providerSubmissionDimensionKey({ key: 'OPERATION', ...base })).toBe('org:org-1|platform:AMAZON|op:CLAIM_SUBMIT');
    expect(providerSubmissionDimensionKey({ key: 'CONNECTION', ...base })).toBe('org:org-1|connection:conn-1');

    const p = policy();
    const scopeA = providerRateScopeKey({ policy: p, ...base });
    const scopeB = providerRateScopeKey({ policy: p, ...base, platformAccountId: 'acct-B' });
    const scopeC = providerRateScopeKey({ policy: p, ...base, platform: 'TIKTOK' as const });
    expect(scopeA).not.toBe(scopeB);
    expect(scopeA).not.toBe(scopeC);
  });
});

describe('P1 Provider Submission Scheduler · 派发决策', () => {
  const windows = (overrides: Partial<Parameters<typeof planProviderDispatch>[0]['windows']> = {}) => ({
    window: null,
    concurrency: { activeByDimension: {} },
    ...overrides,
  });

  it('策略缺失 / 尝试耗尽 → NEEDS_MANUAL（绝不放宽策略）', () => {
    expect(
      planProviderDispatch({ intent: intent(), policy: null, windows: windows(), now: NOW, maxAttempts: 3 }),
    ).toEqual({ kind: 'NEEDS_MANUAL', reason: 'POLICY_MISSING' });
    expect(
      planProviderDispatch({
        intent: intent({ attemptCount: 3 }),
        policy: policy(),
        windows: windows(),
        now: NOW,
        maxAttempts: 3,
      }),
    ).toEqual({ kind: 'NEEDS_MANUAL', reason: 'ATTEMPTS_EXHAUSTED' });
  });

  it('cooldown / retry-after / availableAt 未到 → WAITING（不提前发送）', () => {
    expect(
      planProviderDispatch({
        intent: intent({ cooldownUntil: new Date(NOW.getTime() + 5_000) }),
        policy: policy(),
        windows: windows(),
        now: NOW,
        maxAttempts: 3,
      }),
    ).toMatchObject({ kind: 'WAITING', reason: 'COOLDOWN' });
    expect(
      planProviderDispatch({
        intent: intent({ retryAfterAt: new Date(NOW.getTime() + 2_000) }),
        policy: policy(),
        windows: windows(),
        now: NOW,
        maxAttempts: 3,
      }),
    ).toMatchObject({ kind: 'WAITING', reason: 'RETRY_AFTER' });
    expect(
      planProviderDispatch({
        intent: intent({ availableAt: new Date(NOW.getTime() + 1_000) }),
        policy: policy(),
        windows: windows(),
        now: NOW,
        maxAttempts: 3,
      }),
    ).toMatchObject({ kind: 'WAITING', reason: 'AVAILABLE_AT' });
  });

  it('速率窗口耗尽 → RATE_LIMITED（retryAfterMs 递减）；容量 = rate + burst', () => {
    const p = policy({ ratePerMinute: 6, burst: 2, dimensionKeys: ['ORGANIZATION', 'PLATFORM', 'PLATFORM_ACCOUNT', 'OPERATION', 'CONNECTION'] });
    const scopeKey = providerRateScopeKey({
      policy: p,
      organizationId: 'org-1',
      platform: 'AMAZON',
      platformAccountId: 'acct-A',
      operation: 'CLAIM_SUBMIT',
      connectionRef: 'conn-1',
    });
    const decision = planProviderDispatch({
      intent: intent(),
      policy: p,
      windows: windows({ window: { scopeKey, windowStart: NOW, windowMs: 60_000, count: 8 } }),
      now: NOW,
      maxAttempts: 5,
    });
    expect(decision.kind).toBe('RATE_LIMITED');
    if (decision.kind === 'RATE_LIMITED') expect(decision.retryAfterMs).toBe(60_000);

    // 另一个 account 的窗口（不同 scopeKey）不影响
    expect(
      planProviderDispatch({
        intent: intent({ platformAccountId: 'acct-B' }),
        policy: p,
        windows: windows({ window: { scopeKey, windowStart: NOW, windowMs: 60_000, count: 8 } }),
        now: NOW,
        maxAttempts: 5,
      }).kind,
    ).toBe('READY_FOR_PROVIDER');
  });

  it('并发耗尽 → WAITING；窗口未满且并发可用 → READY_FOR_PROVIDER', () => {
    const p = policy({ maxConcurrency: 1 });
    const key = providerSubmissionDimensionKey({
      key: 'OPERATION',
      organizationId: 'org-1',
      platform: 'AMAZON',
      platformAccountId: 'acct-A',
      operation: 'CLAIM_SUBMIT',
      connectionRef: 'conn-1',
    });
    expect(
      planProviderDispatch({
        intent: intent(),
        policy: p,
        windows: windows({ concurrency: { activeByDimension: { [key]: 1 } } }),
        now: NOW,
        maxAttempts: 5,
      }).kind,
    ).toBe('WAITING');
    expect(
      planProviderDispatch({ intent: intent(), policy: p, windows: windows(), now: NOW, maxAttempts: 5 }),
    ).toEqual({ kind: 'READY_FOR_PROVIDER', reason: 'WITHIN_RATE_AND_CONCURRENCY' });
  });
});

describe('P1 Provider Submission Scheduler · lease（exactly-once 执行权）', () => {
  it('QUEUED/READY 可 ACQUIRE；他人 lease 生效中 → LEASE_HELD；同 owner+leaseId → RENEW；终态 → NOT_DISPATCHABLE', () => {
    const acquire = planProviderLease({ intent: intent(), ownerRef: 'w1', leaseId: 'L1', now: NOW, leaseTtlMs: 30_000 });
    expect(acquire.kind).toBe('ACQUIRE');
    if (acquire.kind === 'ACQUIRE') expect(acquire.lease.attemptNo).toBe(1);

    const held = planProviderLease({
      intent: intent({ state: 'LEASED', ownerRef: 'w1', leaseId: 'L1', leaseExpiresAt: new Date(NOW.getTime() + 10_000) }),
      ownerRef: 'w2',
      leaseId: 'L2',
      now: NOW,
      leaseTtlMs: 30_000,
    });
    expect(held.kind).toBe('LEASE_HELD');

    const renew = planProviderLease({
      intent: intent({ state: 'LEASED', ownerRef: 'w1', leaseId: 'L1', leaseExpiresAt: new Date(NOW.getTime() + 10_000) }),
      ownerRef: 'w1',
      leaseId: 'L1',
      now: NOW,
      leaseTtlMs: 30_000,
    });
    expect(renew.kind).toBe('RENEW');

    const terminal = planProviderLease({
      intent: intent({ state: 'DEAD_LETTER' }),
      ownerRef: 'w1',
      leaseId: 'L1',
      now: NOW,
      leaseTtlMs: 30_000,
    });
    expect(terminal.kind).toBe('NOT_DISPATCHABLE');
  });
});

describe('P1 Provider Submission Scheduler · provider 响应语义', () => {
  const p = policy({ backoffBaseMs: 1_000, backoffMaxMs: 8_000, jitterRatio: 0.2, maxRetryAfterMs: 600_000 });

  it('SUCCESS → 模拟交付（transport=false，不产生外部写）', () => {
    expect(
      planProviderOutcome({ responseKind: 'SUCCESS', policy: p, attemptCount: 1, maxAttempts: 3 }),
    ).toEqual({ kind: 'MARK_SENT_SIMULATED', reason: 'SUCCESS' });
  });

  it('429 → 使用 provider retry-after 并收敛在策略上限内（含抖动）', () => {
    const noJitter = planProviderOutcome({
      responseKind: 'RATE_LIMITED_429',
      policy: policy({ ...p, jitterRatio: 0 }),
      attemptCount: 1,
      maxAttempts: 3,
      retryAfterMs: 30_000,
    });
    expect(noJitter).toEqual({ kind: 'RETRY_LATER', retryAfterMs: 30_000, reason: 'RATE_LIMITED_429' });

    const capped = planProviderOutcome({
      responseKind: 'RATE_LIMITED_429',
      policy: policy({ ...p, jitterRatio: 0, maxRetryAfterMs: 5_000 }),
      attemptCount: 1,
      maxAttempts: 3,
      retryAfterMs: 9_999_999,
    });
    expect(capped).toEqual({ kind: 'RETRY_LATER', retryAfterMs: 5_000, reason: 'RATE_LIMITED_429' });
  });

  it('可重试 5xx/timeout/connection reset → 指数退避 + 抖动（确定性 rng 可复现）', () => {
    const first = planProviderOutcome({
      responseKind: 'RETRYABLE_5XX',
      policy: policy({ ...p, jitterRatio: 0 }),
      attemptCount: 1,
      maxAttempts: 5,
    });
    expect(first).toEqual({ kind: 'RETRY_LATER', retryAfterMs: 1_000, reason: 'RETRYABLE_5XX' });
    const third = planProviderOutcome({
      responseKind: 'RETRYABLE_5XX',
      policy: policy({ ...p, jitterRatio: 0 }),
      attemptCount: 3,
      maxAttempts: 5,
    });
    expect(third).toEqual({ kind: 'RETRY_LATER', retryAfterMs: 4_000, reason: 'RETRYABLE_5XX' });
    const jittered = planProviderOutcome({
      responseKind: 'TIMEOUT',
      policy: p,
      attemptCount: 1,
      maxAttempts: 5,
      rng: () => 1,
    });
    expect(jittered).toEqual({ kind: 'RETRY_LATER', retryAfterMs: 1_200, reason: 'TIMEOUT' });
  });

  it('UNKNOWN → 只读 reconciliation（绝不 blind retry）；尝试耗尽 → DEAD_LETTER', () => {
    const unknown = planProviderOutcome({
      responseKind: 'UNKNOWN',
      policy: p,
      attemptCount: 1,
      maxAttempts: 3,
    });
    expect(unknown).toEqual({ kind: 'RECONCILE_READ_ONLY', reason: 'UNKNOWN_RESPONSE' });
    expect(
      planProviderOutcome({ responseKind: 'CONNECTION_RESET', policy: p, attemptCount: 3, maxAttempts: 3 }),
    ).toEqual({ kind: 'DEAD_LETTER', reason: 'ATTEMPTS_EXHAUSTED' });
    expect(
      planProviderOutcome({ responseKind: 'UNKNOWN', policy: p, attemptCount: 5, maxAttempts: 3 }),
    ).toEqual({ kind: 'RECONCILE_READ_ONLY', reason: 'UNKNOWN_RESPONSE' });
  });
});
