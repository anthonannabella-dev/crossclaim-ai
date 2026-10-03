/**
 * COMMERCIAL C10–C11（MSG-20261003-122 ㊱ / MSG-20261003-123 ⑦）契约层验收。
 * 断言：15% 版本化策略；estimate 只出 ESTIMATE_ONLY 预览；fee due 仅来自 verified actual incremental recovered；
 *       client 提供费率一律拒绝；waiver / micro 策略非计费；边界不做任何资金动作。
 */

import { describe, expect, it } from 'vitest';

import {
  FEE_POLICY_BOUNDARY,
  FEE_POLICY_REGISTRY,
  FeePolicyNotEffectiveError,
  FeePolicyNotFoundError,
  SUCCESS_FEE_15_RATE_BPS,
  applyRateBps,
  computeEstimatedFeePreview,
  evaluateFeeGuard,
  resolveFeePolicy,
} from '../services/commercial/fee-policy';

const AT = '2026-10-03';
const STANDARD = resolveFeePolicy('STANDARD_SUCCESS_15', AT);
const CUSTOMS = resolveFeePolicy('CUSTOMS_SUCCESS_15', AT);
const WAIVER = resolveFeePolicy('CUSTOMS_VIP_WAIVER', AT);
const MICRO = resolveFeePolicy('MICRO_NOT_SERVICED', AT);

function verified(amount: string, currency = 'USD') {
  return {
    settlementId: 'stl-1',
    verifiedAmount: amount,
    currency,
    confirmationStatus: 'CONFIRMED' as const,
    reconciliationStatus: 'RECONCILED' as const,
  };
}

describe('COMMERCIAL C10–C11 — 15% versioned fee policy', () => {
  it('② 注册表：STANDARD_SUCCESS_15 / CUSTOMS_SUCCESS_15 均为 1500 bps（=15%），且版本化', () => {
    expect(SUCCESS_FEE_15_RATE_BPS).toBe(1500);
    expect(STANDARD.rateBps).toBe(1500);
    expect(CUSTOMS.rateBps).toBe(1500);
    expect(STANDARD.version).toBe('v1');
    expect(FEE_POLICY_REGISTRY.every((p) => typeof p.version === 'string' && p.version.length > 0)).toBe(true);
  });

  it('② 策略解析：未知策略 → FeePolicyNotFoundError；未生效 → FeePolicyNotEffectiveError', () => {
    expect(() => resolveFeePolicy('NOPE', AT)).toThrow(FeePolicyNotFoundError);
    expect(() => resolveFeePolicy('STANDARD_SUCCESS_15', '2026-09-01')).toThrow(FeePolicyNotEffectiveError);
  });

  it('③ 费率数学：整数 bps、无浮点（35.00 × 15% = 5.25；100.00 → 15.00）', () => {
    expect(applyRateBps('35.00', 1500)).toBe('5.25');
    expect(applyRateBps('100.00', 1500)).toBe('15.00');
    expect(applyRateBps('18620.00', 1500)).toBe('2793.00');
    expect(applyRateBps('0.01', 1500)).toBe('0.00');
  });

  it('① estimate 只产生 ESTIMATE_ONLY 预览（永不 billable、永不收款）', () => {
    const preview = computeEstimatedFeePreview({
      estimatedRecoverableAmount: '35.00',
      currency: 'USD',
      policy: STANDARD,
    });
    expect(preview.amountLabel).toBe('ESTIMATE_ONLY');
    expect(preview.basis).toBe('ESTIMATED_RECOVERABLE');
    expect(preview.estimatedFeeAmount).toBe('5.25');
    expect(preview.billable).toBe(false);
    expect(preview.paymentCollectionPerformed).toBe(false);
    expect(preview.autopayEnabled).toBe(false);
  });

  it('① 无金额 / 非法币种 → 预览金额 null（不猜）', () => {
    expect(
      computeEstimatedFeePreview({ estimatedRecoverableAmount: null, currency: 'USD', policy: STANDARD }).estimatedFeeAmount,
    ).toBeNull();
    expect(
      computeEstimatedFeePreview({ estimatedRecoverableAmount: '35.00', currency: 'usd', policy: STANDARD })
        .estimatedFeeAmount,
    ).toBeNull();
  });

  it('④ fee guard：estimate basis 一律拒绝（ESTIMATE_NOT_BILLABLE）', () => {
    const decision = evaluateFeeGuard({
      policy: STANDARD,
      basis: 'ESTIMATED_RECOVERABLE',
      verifiedRecovered: verified('35.00'),
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCode).toBe('ESTIMATE_NOT_BILLABLE');
  });

  it('④ fee guard：client 提供费率 → CLIENT_SUPPLIED_RATE_REJECTED', () => {
    const decision = evaluateFeeGuard({
      policy: STANDARD,
      basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
      verifiedRecovered: verified('100.00'),
      clientSuppliedRateBps: 2000,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCode).toBe('CLIENT_SUPPLIED_RATE_REJECTED');
  });

  it('④ fee guard：无 verified recovered truth → NO_VERIFIED_RECOVERED_TRUTH（fail closed）', () => {
    const decision = evaluateFeeGuard({
      policy: STANDARD,
      basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
      verifiedRecovered: null,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCode).toBe('NO_VERIFIED_RECOVERED_TRUTH');
  });

  it('④ fee guard：verified recovered + 服务端策略 → 15% fee due（带 settlement lineage）', () => {
    const decision = evaluateFeeGuard({
      policy: STANDARD,
      basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
      verifiedRecovered: verified('100.00'),
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.fee.feeAmount).toBe('15.00');
    expect(decision.fee.rateBps).toBe(1500);
    expect(decision.fee.basis).toBe('VERIFIED_ACTUAL_INCREMENTAL_RECOVERED');
    expect(decision.fee.policyId).toBe('STANDARD_SUCCESS_15');
    expect(decision.fee.settlementId).toBe('stl-1');
  });

  it('④ Customs 策略同样 15%（不另开资金系统）', () => {
    const decision = evaluateFeeGuard({
      policy: CUSTOMS,
      basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
      verifiedRecovered: verified('200.00'),
    });
    if (!decision.allowed) throw new Error('expected allowed');
    expect(decision.fee.feeAmount).toBe('30.00');
    expect(decision.fee.policyId).toBe('CUSTOMS_SUCCESS_15');
  });

  it('④ waiver / micro 策略非计费（POLICY_NOT_BILLABLE）', () => {
    for (const policy of [WAIVER, MICRO]) {
      const decision = evaluateFeeGuard({
        policy,
        basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
        verifiedRecovered: verified('100.00'),
      });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reasonCode).toBe('POLICY_NOT_BILLABLE');
    }
    expect(WAIVER.waiverCapAmount).toBe('500.00');
  });

  it('④ 币种不符 / 非法金额 → CURRENCY_MISMATCH / INVALID_AMOUNT', () => {
    const currencyPolicy = { ...STANDARD, currency: 'EUR' };
    const mismatch = evaluateFeeGuard({
      policy: currencyPolicy,
      basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
      verifiedRecovered: verified('100.00', 'USD'),
    });
    expect(mismatch.allowed).toBe(false);
    if (!mismatch.allowed) expect(mismatch.reasonCode).toBe('CURRENCY_MISMATCH');

    const invalid = evaluateFeeGuard({
      policy: STANDARD,
      basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
      verifiedRecovered: verified('abc'),
    });
    expect(invalid.allowed).toBe(false);
    if (!invalid.allowed) expect(invalid.reasonCode).toBe('INVALID_AMOUNT');
  });

  it('⑤ 边界自证：策略/预览层不做任何资金动作', () => {
    expect(FEE_POLICY_BOUNDARY.paymentCollectionPerformed).toBe(false);
    expect(FEE_POLICY_BOUNDARY.autopayEnabled).toBe(false);
    expect(FEE_POLICY_BOUNDARY.externalPaymentWrite).toBe(false);
    expect(FEE_POLICY_BOUNDARY.chargesCustomer).toBe(false);
    expect(FEE_POLICY_BOUNDARY.platformWriteEnabled).toBe(false);
    expect(FEE_POLICY_BOUNDARY.productionCredentials).toBe('ABSENT');
  });

  it('⑥ 预览确定性：相同输入 → 相同预览（含策略版本 provenance）', () => {
    const a = computeEstimatedFeePreview({ estimatedRecoverableAmount: '35.00', currency: 'USD', policy: STANDARD });
    const b = computeEstimatedFeePreview({ estimatedRecoverableAmount: '35.00', currency: 'USD', policy: STANDARD });
    expect(b).toEqual(a);
    expect(a.policyId).toBe('STANDARD_SUCCESS_15');
    expect(a.policyVersion).toBe('v1');
  });
});
