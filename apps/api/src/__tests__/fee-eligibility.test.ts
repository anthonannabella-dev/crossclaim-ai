/** R46 S4 —— Fee 资格判定纯函数测试 */

import { describe, expect, it } from 'vitest';

import {
  buildFeeMembership,
  isSettlementFeeEligible,
  type SettlementEligibilityInput,
} from '../services/settlement/fee-eligibility';

const base = (over: Partial<SettlementEligibilityInput> = {}): SettlementEligibilityInput => ({
  settlementId: 'st-1',
  status: 'RECEIVED',
  confirmationStatus: 'CONFIRMED',
  reconciliationStatus: 'RECONCILED',
  amount: '1000.0000',
  currency: 'USD',
  evidenceId: 'ev-1',
  reversedBySettlementId: null,
  hasActiveReversalAdjustment: false,
  ...over,
});

describe('R46 S4 fee 资格判定', () => {
  it('confirmed + unreversed + eligible → ELIGIBLE，membership 规范化（4dp / 大写币种）', () => {
    expect(isSettlementFeeEligible(base())).toEqual({ eligible: true, reason: 'ELIGIBLE' });
    expect(buildFeeMembership(base({ amount: '1000', currency: 'usd' }))).toEqual({
      settlementId: 'st-1',
      amount: '1000.0000',
      currency: 'USD',
    });
  });

  it('reversed / 有效冲回调整 / 未确认 / 未对账 / 缺证据 / 非到账状态 → 各自 fail-closed', () => {
    expect(isSettlementFeeEligible(base({ reversedBySettlementId: 'rev-1' }))).toEqual({ eligible: false, reason: 'REVERSED' });
    expect(isSettlementFeeEligible(base({ hasActiveReversalAdjustment: true }))).toEqual({
      eligible: false,
      reason: 'REVERSAL_ADJUSTMENT_PRESENT',
    });
    expect(isSettlementFeeEligible(base({ confirmationStatus: 'PENDING_CONFIRMATION' }))).toEqual({
      eligible: false,
      reason: 'NOT_CONFIRMED',
    });
    expect(isSettlementFeeEligible(base({ reconciliationStatus: 'NOT_STARTED' }))).toEqual({
      eligible: false,
      reason: 'NOT_RECONCILED',
    });
    expect(isSettlementFeeEligible(base({ evidenceId: null }))).toEqual({ eligible: false, reason: 'MISSING_EVIDENCE' });
    expect(isSettlementFeeEligible(base({ status: 'EXPECTED' }))).toEqual({ eligible: false, reason: 'STATUS_NOT_RECEIVED' });
    expect(isSettlementFeeEligible(base({ amount: '0' }))).toEqual({ eligible: false, reason: 'INVALID_AMOUNT' });
  });

  it('PARTIAL 到账可作为资格来源；非 eligible 不得生成 membership', () => {
    expect(isSettlementFeeEligible(base({ status: 'PARTIAL', amount: '300.0000' })).eligible).toBe(true);
    expect(() => buildFeeMembership(base({ status: 'VOID' }))).toThrowError(/SETTLEMENT_NOT_FEE_ELIGIBLE/);
  });
});
