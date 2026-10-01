/** R46 S4 —— 确定性 Fee 计算纯函数测试（MSG-20261002-59 S4） */

import { describe, expect, it } from 'vitest';

import {
  computeMembershipDigest,
  computeSettlementFee,
  FeeComputeError,
  type FeeComputeInput,
} from '../services/settlement/fee-compute';

const base = (over: Partial<FeeComputeInput> = {}): FeeComputeInput => ({
  memberships: [{ settlementId: 'st-1', amount: '1000.0000', currency: 'USD' }],
  policy: {
    basis: 'RECOVERED_AMOUNT_PCT',
    rate: '0.15',
    policyRef: 'policy-2026-01',
    feeBasisVersion: 'v1',
    currency: 'USD',
  },
  ...over,
});

describe('R46 S4 确定性 fee 计算', () => {
  it('百分比 basis：net × rate，金额 4 位定点', () => {
    const r = computeSettlementFee(base());
    expect(r.baseAmount).toBe('1000.0000');
    expect(r.feeAmount).toBe('150.0000');
    expect(r.currency).toBe('USD');
  });

  it('FIXED basis 与 adjustment 净额（冲回后基数下降）', () => {
    const r = computeSettlementFee(
      base({
        policy: { basis: 'FIXED', fixedAmount: '299.0000', policyRef: 'p', feeBasisVersion: 'v1', currency: 'USD' },
        adjustments: [{ settlementId: 'adj-1', amount: '400.0000', currency: 'USD' }],
      }),
    );
    expect(r.baseAmount).toBe('600.0000');
    expect(r.feeAmount).toBe('299.0000');
  });

  it('membershipDigest 确定性：顺序无关、可由输入重建', () => {
    const a = base({ memberships: [
      { settlementId: 'st-1', amount: '1000.0000', currency: 'USD' },
      { settlementId: 'st-2', amount: '500.0000', currency: 'USD' },
    ] });
    const b = base({ memberships: [
      { settlementId: 'st-2', amount: '500.0000', currency: 'USD' },
      { settlementId: 'st-1', amount: '1000.0000', currency: 'USD' },
    ] });
    expect(computeSettlementFee(a).membershipDigest).toBe(computeSettlementFee(b).membershipDigest);
    expect(computeSettlementFee(a).membershipDigest).toBe(computeMembershipDigest(a));
  });

  it('客户端自报 rate / policy → 拒绝', () => {
    expect(() => computeSettlementFee(base({ clientSuppliedRate: '0.9' }))).toThrowError(FeeComputeError);
    expect(() => computeSettlementFee(base({ clientSuppliedPolicyRef: 'x' }))).toThrowError(/CLIENT_FEE_INPUT_NOT_TRUSTED/);
  });

  it('fail-closed：币种不一致 / NONE basis / 零基数 / 负净额 / 无 membership / 非法 rate', () => {
    expect(() =>
      computeSettlementFee(base({ memberships: [{ settlementId: 's', amount: '1.0000', currency: 'EUR' }] })),
    ).toThrowError(/CURRENCY_MISMATCH/);
    expect(() =>
      computeSettlementFee(base({ policy: { basis: 'NONE', policyRef: 'p', feeBasisVersion: 'v1', currency: 'USD' } })),
    ).toThrowError(/FEE_BASIS_NONE/);
    expect(() =>
      computeSettlementFee(base({ adjustments: [{ settlementId: 'a', amount: '1000.0000', currency: 'USD' }] })),
    ).toThrowError(/ZERO_BASIS/);
    expect(() =>
      computeSettlementFee(base({ adjustments: [{ settlementId: 'a', amount: '2000.0000', currency: 'USD' }] })),
    ).toThrowError(/NEGATIVE_NET_BASIS/);
    expect(() => computeSettlementFee(base({ memberships: [] }))).toThrowError(/MEMBERSHIP_REQUIRED/);
    expect(() =>
      computeSettlementFee(base({ policy: { basis: 'RECOVERED_AMOUNT_PCT', rate: '1.5', policyRef: 'p', feeBasisVersion: 'v1', currency: 'USD' } })),
    ).toThrowError(/INVALID_RATE/);
  });
});
