/**
 * R45 S3 —— deterministic projector 纯计算层单测（无 IO）
 * 依据：MSG-20261002-48（S3 范围冻结 + 永久验收清单）。
 */

import { describe, expect, it } from 'vitest';

import {
  PROJECTION_ALGORITHM_VERSION,
  PROJECTION_STATUS_MEANINGS,
  ProjectionComputeError,
  computeProjection,
  fromScaled,
  toScaled,
  type ProjectionComputationInput,
} from '../services/reconciliation/projection-compute';

const POLICY_EXACT = {
  id: 'cc0f0000-0000-4000-8000-000000000001',
  policyVersion: 'v1',
  absoluteTolerance: '0',
  relativeTolerance: '0',
};

const fact = (id: string, amount: string, overrides: Partial<ProjectionComputationInput['facts'][number]> = {}) => ({
  id,
  amount,
  currency: 'USD',
  providerEventId: 'evt-' + id,
  providerCaseRefCanonical: 'CASE-' + id,
  occurredAt: '2026-09-04T00:00:00.000Z',
  ...overrides,
});

const base = (overrides: Partial<ProjectionComputationInput> = {}): ProjectionComputationInput => ({
  claimItemId: 'claim-1',
  facts: [],
  basis: {
    id: 'basis-1',
    expectedRecoveryAmount: '100.0000',
    currency: 'USD',
    basisVersion: 'basis/v1',
  },
  policy: POLICY_EXACT,
  overrides: [],
  ...overrides,
});

describe('R45 S3 · 定点金额工具', () => {
  it('定点转换保持 4 位小数且不引入浮点误差', () => {
    expect(fromScaled(toScaled('0.1'))).toBe('0.1000');
    expect(fromScaled(toScaled('120.5'))).toBe('120.5000');
    expect(fromScaled(toScaled('0.00005'))).toBe('0.0000');
    expect(fromScaled(toScaled('100') + toScaled('0.0001'))).toBe('100.0001');
  });

  it('非法字面量 fail-closed', () => {
    expect(() => toScaled('1e3')).toThrowError(ProjectionComputeError);
    expect(() => toScaled('abc')).toThrowError(ProjectionComputeError);
  });
});

describe('R45 S3 · 状态判定（deterministic）', () => {
  it('无事实 → UNMATCHED；无 basis → MATCHED（不得宣称 recovered）', () => {
    expect(computeProjection(base()).status).toBe('UNMATCHED');
    const noBasis = computeProjection(base({ basis: null, facts: [fact('a', '10.0000')] }));
    expect(noBasis.status).toBe('MATCHED');
    expect(noBasis.expectedAmount).toBeNull();
  });

  it('exact policy：net == expected → FULLY_RECONCILED；net < expected → PARTIALLY_RECONCILED', () => {
    expect(computeProjection(base({ facts: [fact('a', '100.0000')] })).status).toBe('FULLY_RECONCILED');
    const partial = computeProjection(base({ facts: [fact('a', '40.0000'), fact('b', '30.0000')] }));
    expect(partial.status).toBe('PARTIALLY_RECONCILED');
    expect(partial.netMatchedObservedAmount).toBe('70.0000');
  });

  it('partial × N 累计：多笔相加达到 basis → FULLY（确定性）', () => {
    const result = computeProjection(base({ facts: [fact('a', '60.0000'), fact('b', '40.0000')] }));
    expect(result.status).toBe('FULLY_RECONCILED');
    expect(result.netMatchedObservedAmount).toBe('100.0000');
    expect(result.memberFactIds).toEqual(['a', 'b']);
  });

  it('超出容差的过度回收 → AMBIGUOUS（不自动宣称已完全追回）', () => {
    const result = computeProjection(base({ facts: [fact('a', '150.0000')] }));
    expect(result.status).toBe('AMBIGUOUS');
    // MSG-20261002-49 ②：金额异常必须与「匹配歧义」区分（结构化异常 reason）
    expect(result.ambiguityReasons).toContain('AMOUNT_EXCEEDS_EXPECTED');
  });

  it('MATCHED 语义冻结：不得被描述为 recovered / billable（MSG-20261002-49 ②）', () => {
    const meaning = PROJECTION_STATUS_MEANINGS.MATCHED;
    expect(meaning).toContain('不代表 recovered');
    expect(meaning).toContain('billable');
    expect(meaning).not.toMatch(/^事实已唯一关联到该 Claim，且已恢复/);
    expect(PROJECTION_STATUS_MEANINGS.FULLY_RECONCILED).toContain('不代表已可计费');
  });

  it('currency mismatch → AMBIGUOUS，且不做任何换算', () => {
    const result = computeProjection(base({ facts: [fact('a', '100.0000', { currency: 'EUR' })] }));
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.ambiguityReasons).toContain('CURRENCY_MISMATCH');
    expect(result.netMatchedObservedAmount).toBe('0.0000');
  });

  it('conflicting evidence（同 providerEventId 不同金额）→ AMBIGUOUS，不按来源等级择优', () => {
    const result = computeProjection(
      base({
        facts: [
          fact('a', '100.0000', { providerEventId: 'shared' }),
          fact('b', '80.0000', { providerEventId: 'shared' }),
        ],
      }),
    );
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.ambiguityReasons).toContain('CONFLICTING_EVIDENCE');
  });

  it('policy 变化会改变判定（版本化策略只影响重算结果）', () => {
    const tolerant = computeProjection(
      base({
        facts: [fact('a', '99.5000')],
        policy: { ...POLICY_EXACT, id: 'policy-2', absoluteTolerance: '0.5000' },
      }),
    );
    expect(tolerant.status).toBe('FULLY_RECONCILED');
    expect(tolerant.tolerancePolicyId).toBe('policy-2');
    const exact = computeProjection(base({ facts: [fact('a', '99.5000')] }));
    expect(exact.status).toBe('PARTIALLY_RECONCILED');
  });

  it('override UNMATCHED 排除事实（override 不改原始事实，只影响本次计算）', () => {
    const result = computeProjection(
      base({
        facts: [fact('a', '100.0000'), fact('b', '50.0000')],
        overrides: [{ reimbursementFactId: 'b', decisionKind: 'UNMATCHED' }],
      }),
    );
    expect(result.status).toBe('FULLY_RECONCILED');
    expect(result.netMatchedObservedAmount).toBe('100.0000');
    expect(result.memberFactIds).toEqual(['a']);
  });

  it('同一输入 → 同一 inputDigest；输入变化（事实/策略/override）→ digest 变化', () => {
    const a = computeProjection(base({ facts: [fact('a', '100.0000')] }));
    const b = computeProjection(base({ facts: [fact('a', '100.0000')] }));
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(a.inputDigest).toMatch(/^[0-9a-f]{64}$/);

    const reversedRemoved = computeProjection(base({ facts: [] }));
    expect(reversedRemoved.inputDigest).not.toBe(a.inputDigest);
    expect(reversedRemoved.status).toBe('UNMATCHED');

    const otherPolicy = computeProjection(
      base({ facts: [fact('a', '100.0000')], policy: { ...POLICY_EXACT, id: 'policy-2' } }),
    );
    expect(otherPolicy.inputDigest).not.toBe(a.inputDigest);
  });

  it('CHANGE B：digest 覆盖全部有效输入（basis id/version/amount/currency、policy abs/rel、override、算法版本）', () => {
    const baseline = computeProjection(base({ facts: [fact('a', '100.0000')] }));
    const variants = [
      computeProjection(base({ facts: [fact('a', '100.0000')], basis: { ...base().basis!, id: 'basis-2' } })),
      computeProjection(base({ facts: [fact('a', '100.0000')], basis: { ...base().basis!, basisVersion: 'basis/v2' } })),
      computeProjection(base({ facts: [fact('a', '100.0000')], basis: { ...base().basis!, expectedRecoveryAmount: '101.0000' } })),
      computeProjection(base({ facts: [fact('a', '100.0000', { currency: 'USD' })], basis: { ...base().basis!, currency: 'EUR' } })),
      computeProjection(base({ facts: [fact('a', '100.0000')], policy: { ...POLICY_EXACT, absoluteTolerance: '0.0100' } })),
      computeProjection(base({ facts: [fact('a', '100.0000')], policy: { ...POLICY_EXACT, relativeTolerance: '0.0100' } })),
      computeProjection(base({ facts: [fact('a', '100.0000')], policy: { ...POLICY_EXACT, id: 'policy-x' } })),
      computeProjection(
        base({
          facts: [fact('a', '100.0000')],
          overrides: [{ reimbursementFactId: 'a', decisionKind: 'MATCHED' }],
        }),
      ),
      computeProjection(base({ facts: [fact('a', '100.0000', { providerEventId: 'evt-other' })] })),
      computeProjection(base({ facts: [fact('a', '100.0000', { occurredAt: '2026-09-05T00:00:00.000Z' })] })),
    ];
    for (const variant of variants) {
      expect(variant.inputDigest).not.toBe(baseline.inputDigest);
    }
    // 算法版本参与 digest（常量断言：版本变更即新 digest 的来源之一）
    expect(PROJECTION_ALGORITHM_VERSION).toBe('reconciliation-projection/v1');
  });

  it('字段顺序不影响 digest（canonical JSON）', () => {
    const ordered = computeProjection(
      base({
        facts: [fact('a', '10.0000'), fact('b', '90.0000')],
      }),
    );
    const shuffled = computeProjection(
      base({
        facts: [fact('b', '90.0000'), fact('a', '10.0000')],
      }),
    );
    expect(shuffled.inputDigest).toBe(ordered.inputDigest);
    expect(shuffled.memberFactIds).toEqual(['a', 'b']);
  });

  it('policy 缺失 / 非法 → fail-closed（禁止隐式 fallback）', () => {
    expect(() => computeProjection(base({ policy: { ...POLICY_EXACT, id: '' } }))).toThrowError(ProjectionComputeError);
    expect(() =>
      computeProjection(base({ policy: { ...POLICY_EXACT, relativeTolerance: '2' } })),
    ).toThrowError(ProjectionComputeError);
  });
});
