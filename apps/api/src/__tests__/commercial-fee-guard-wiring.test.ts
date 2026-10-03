/**
 * G1 — 统一 fee guard 收口验收（MSG-20261003-124 ㉓㉔㉕㉖㊱）。
 * 断言：agreement 费率绑定正确（历史 20% 不被回写）；guard 对 estimate basis / client 费率 /
 *       无 verified recovered truth / 非计费策略一律 fail-closed；verified recovered + 绑定策略放行。
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateFeeGuard,
  policyFromConfirmedAgreementRate,
} from '../services/commercial/fee-policy';

function verified(amount: string, currency = 'USD') {
  return { settlementId: 'stl-1', verifiedAmount: amount, currency, confirmationStatus: 'CONFIRMED' as const, reconciliationStatus: 'RECONCILED' as const };
}

describe('G1 — agreement-bound fee policy + unified guard', () => {
  it('已确认 20% 条款 → 绑定 STANDARD_SUCCESS_20（2000 bps，version v0）', () => {
    const policy = policyFromConfirmedAgreementRate('0.20', 'USD');
    expect(policy.policyId).toBe('STANDARD_SUCCESS_20');
    expect(policy.rateBps).toBe(2000);
    expect(policy.version).toBe('v0');
    expect(policy.policyRef).toBe('STANDARD_SUCCESS');
  });

  it('已确认 15% 条款 → 绑定 STANDARD_SUCCESS_15（1500 bps，version v1）', () => {
    const policy = policyFromConfirmedAgreementRate('0.15', 'USD');
    expect(policy.policyId).toBe('STANDARD_SUCCESS_15');
    expect(policy.rateBps).toBe(1500);
  });

  it('自定义协议费率 → AGREEMENT_BOUND_<bps>（仍 server-side 绑定，不被默认策略覆盖）', () => {
    const policy = policyFromConfirmedAgreementRate('0.125', 'EUR');
    expect(policy.policyId).toBe('AGREEMENT_BOUND_1250');
    expect(policy.rateBps).toBe(1250);
    expect(policy.currency).toBe('EUR');
  });

  it('非法费率 → 抛错（fail-closed，不静默取默认）', () => {
    expect(() => policyFromConfirmedAgreementRate('abc')).toThrow();
    expect(() => policyFromConfirmedAgreementRate('0')).toThrow();
    expect(() => policyFromConfirmedAgreementRate('2')).toThrow();
  });

  it('㊱ verified recovered + 绑定 20% → fee due 20%（历史条款保持）', () => {
    const policy = policyFromConfirmedAgreementRate('0.20');
    const decision = evaluateFeeGuard({ policy, basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED', verifiedRecovered: verified('100.00') });
    if (!decision.allowed) throw new Error('expected allowed');
    expect(decision.fee.feeAmount).toBe('20.00');
  });

  it('㊱ estimate basis / client 费率 / 无 verified recovered 一律拒绝', () => {
    const policy = policyFromConfirmedAgreementRate('0.15');
    expect(evaluateFeeGuard({ policy, basis: 'ESTIMATED_RECOVERABLE', verifiedRecovered: verified('100.00') }).allowed).toBe(false);
    expect(evaluateFeeGuard({ policy, basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED', verifiedRecovered: verified('100.00'), clientSuppliedRateBps: 2000 }).allowed).toBe(false);
    expect(evaluateFeeGuard({ policy, basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED', verifiedRecovered: null }).allowed).toBe(false);
  });
});
