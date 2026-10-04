/** C18-5 单元验收：provider 幂等/重试/对账策略（分类 / 退避 / 禁止盲目重发）。 */

import { describe, expect, it } from 'vitest';

import {
  assertResubmitAllowed,
  buildProviderReconciliationPlan,
  classifyProviderOutcome,
  isAutoRetryable,
  nextRetryDelayMs,
  PROVIDER_RETRY_POLICIES,
  ProviderBlindRetryError,
} from '../services/customs/customs-provider-reconciliation';

describe('C18-5 — provider idempotency / retry / reconciliation（unit）', () => {
  it('结果分类：2xx=SUCCESS；429/5xx=RETRYABLE；4xx=PERMANENT_FAILURE；409=CONFLICT；无响应=AMBIGUOUS', () => {
    expect(classifyProviderOutcome({ httpStatus: 200, transportCompleted: true })).toBe('SUCCESS');
    expect(classifyProviderOutcome({ httpStatus: 429, transportCompleted: true })).toBe('RETRYABLE');
    expect(classifyProviderOutcome({ httpStatus: 503, transportCompleted: true })).toBe('RETRYABLE');
    expect(classifyProviderOutcome({ httpStatus: 400, transportCompleted: true })).toBe('PERMANENT_FAILURE');
    expect(classifyProviderOutcome({ httpStatus: 422, transportCompleted: true })).toBe('PERMANENT_FAILURE');
    expect(classifyProviderOutcome({ httpStatus: 409, transportCompleted: true })).toBe('CONFLICT');
    expect(
      classifyProviderOutcome({ httpStatus: 200, transportCompleted: true, errorCode: 'idempotency_key_conflict' }),
    ).toBe('CONFLICT');
    expect(classifyProviderOutcome({ httpStatus: null, transportCompleted: false })).toBe('AMBIGUOUS');
    expect(classifyProviderOutcome({ httpStatus: 504, transportCompleted: false })).toBe('AMBIGUOUS');
  });

  it('只有 RETRYABLE 允许自动重试（CONFLICT / AMBIGUOUS / PERMANENT_FAILURE 都不允许）', () => {
    expect(isAutoRetryable('RETRYABLE')).toBe(true);
    for (const outcome of ['SUCCESS', 'CONFLICT', 'PERMANENT_FAILURE', 'AMBIGUOUS'] as const) {
      expect(isAutoRetryable(outcome)).toBe(false);
    }
  });

  it('指数退避 + 抖动 + 上限（注入 random 后确定性可断言）', () => {
    const noJitter = () => 0.5; // 抖动项为 0
    expect(nextRetryDelayMs({ operation: 'UPLOAD_EVIDENCE', attempt: 1, random: noJitter })).toBe(1000);
    expect(nextRetryDelayMs({ operation: 'UPLOAD_EVIDENCE', attempt: 2, random: noJitter })).toBe(2000);
    expect(nextRetryDelayMs({ operation: 'UPLOAD_EVIDENCE', attempt: 3, random: noJitter })).toBe(4000);
    // 超过 maxAttempts 时按 maxAttempts 封顶
    expect(nextRetryDelayMs({ operation: 'UPLOAD_EVIDENCE', attempt: 99, random: noJitter })).toBe(
      Math.min(1000 * 2 ** (PROVIDER_RETRY_POLICIES.UPLOAD_EVIDENCE.maxAttempts - 1), 30000),
    );
    // 抖动落在 ±ratio 区间内
    const low = nextRetryDelayMs({ operation: 'CREATE_SUBMISSION', attempt: 1, random: () => 0 });
    const high = nextRetryDelayMs({ operation: 'CREATE_SUBMISSION', attempt: 1, random: () => 1 });
    expect(low).toBeGreaterThanOrEqual(1500);
    expect(low).toBeLessThanOrEqual(2000);
    expect(high).toBeGreaterThanOrEqual(2000);
    expect(high).toBeLessThanOrEqual(2500);
  });

  it('AMBIGUOUS → 必须对账，步骤确定且明确禁止重发', () => {
    const plan = buildProviderReconciliationPlan({ operation: 'CREATE_SUBMISSION', outcome: 'AMBIGUOUS' });
    expect(plan.required).toBe(true);
    expect(plan.actions).toEqual([
      'LOOKUP_BY_IDEMPOTENCY_KEY',
      'COMPARE_PAYLOAD_DIGEST',
      'ADOPT_EXISTING_ON_MATCH',
      'MARK_CONFLICT_ON_MISMATCH',
      'NEVER_RESUBMIT_BLIND',
    ]);
    expect(plan.resubmitAllowed).toBe(false);

    const notNeeded = buildProviderReconciliationPlan({ operation: 'CREATE_SUBMISSION', outcome: 'SUCCESS' });
    expect(notNeeded.required).toBe(false);
    expect(notNeeded.actions).toEqual([]);
  });

  it('执行守卫：AMBIGUOUS 抛 ProviderBlindRetryError；CONFLICT / PERMANENT_FAILURE 不可重试', () => {
    expect(() => assertResubmitAllowed({ operation: 'CREATE_SUBMISSION', outcome: 'AMBIGUOUS' })).toThrow(
      ProviderBlindRetryError,
    );
    expect(() => assertResubmitAllowed({ operation: 'UPLOAD_EVIDENCE', outcome: 'CONFLICT' })).toThrow(
      'PROVIDER_OUTCOME_NOT_RETRYABLE',
    );
    expect(() => assertResubmitAllowed({ operation: 'UPLOAD_EVIDENCE', outcome: 'PERMANENT_FAILURE' })).toThrow(
      'PROVIDER_OUTCOME_NOT_RETRYABLE',
    );
    expect(() => assertResubmitAllowed({ operation: 'UPLOAD_EVIDENCE', outcome: 'RETRYABLE' })).not.toThrow();
  });
});
