// CUSTOMS / DUTY RECOVERY — slice B-S11 — Success Fee guard 严格化与回归
// ---------------------------------------------------------------------------
// 覆盖：来源级别必须 VERIFIED、结算必须 CONFIRMED、对账必须 RECONCILED（PARTIAL 不可计费）、
//   争议/冲正 → 需冲回已计费、同一 settlement 幂等（重复计费抑制）、estimate 不可计费、
//   拒绝 client 费率、金额与币种由既有 fee guard 兜底、边界断言、确定性摘要。

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY,
  CUSTOMS_SUCCESS_FEE_GUARD_VERSION,
  CustomsSuccessFeeGuardError,
  FEE_GUARD_DECISIONS,
  assertFeeGuardDidNotCharge,
  evaluateCustomsSuccessFeeGuard,
  type CustomsSettlementMoneyTruth,
  type CustomsSuccessFeeGuardInput,
} from '../services/customs/customs-success-fee-guard';
import { resolveFeePolicy } from '../services/commercial/fee-policy';
import {
  CUSTOMS_REFUND_LINKAGE_BOUNDARY,
  evaluateCustomsRefundFeeTrigger,
} from '../services/customs/customs-refund-settlement-linkage';

const NOW = new Date('2026-10-06T22:00:00.000Z');
const SCOPE = { organizationId: 'org-fee-1', platformAccountId: 'acct-fee-a' };
const POLICY = resolveFeePolicy('CUSTOMS_SUCCESS_15', '2026-10-06');

function truth(overrides: Partial<CustomsSettlementMoneyTruth> = {}): CustomsSettlementMoneyTruth {
  return {
    settlementId: 'st-1',
    sourceLevel: 'PROVIDER_VERIFIED',
    confirmationStatus: 'CONFIRMED',
    reconciliationStatus: 'RECONCILED',
    verifiedAmount: '1000.00',
    currency: 'USD',
    ...overrides,
  };
}

function guard(overrides: Partial<CustomsSuccessFeeGuardInput> = {}) {
  return evaluateCustomsSuccessFeeGuard({
    scope: SCOPE,
    moneyTruth: truth(),
    policy: POLICY,
    now: NOW,
    ...overrides,
  });
}

describe('B-S11 Fee guard — 严格计费资格', () => {
  it('VERIFIED 来源 + CONFIRMED + RECONCILED → BILLABLE（金额来自既有 fee guard）', () => {
    const result = guard();
    expect(result.kind).toBe('CUSTOMS_SUCCESS_FEE_GUARD');
    expect(result.version).toBe(CUSTOMS_SUCCESS_FEE_GUARD_VERSION);
    expect(result.decision).toBe('BILLABLE');
    expect(result.billable).toBe(true);
    expect(result.fee?.feeAmount).toBe('150.00'); // 15% of 1000.00
    expect(result.fee?.policyId).toBe('CUSTOMS_SUCCESS_15');
    expect(result.fee?.settlementId).toBe('st-1');
    expect(result.sourceLevelVerified).toBe(true);
    expect(result.autoChargePerformed).toBe(false);
    expect(result.paymentCollectionPerformed).toBe(false);
    expect(result.autopayEnabled).toBe(false);
    expect(result.externalPaymentWrite).toBe(false);
    expect(result.productionCredentials).toBe('ABSENT');
    expect(() => assertFeeGuardDidNotCharge(result)).not.toThrow();
  });

  it('AUTHORITY_VERIFIED 同样是可计费来源', () => {
    const result = guard({ moneyTruth: truth({ sourceLevel: 'AUTHORITY_VERIFIED' }) });
    expect(result.decision).toBe('BILLABLE');
  });

  it('USER_REPORTED / UNVERIFIED 来源 → NOT_BILLABLE（绝不依据未验证来源计费）', () => {
    for (const sourceLevel of ['USER_REPORTED', 'UNVERIFIED'] as const) {
      const result = guard({ moneyTruth: truth({ sourceLevel }) });
      expect(result.decision).toBe('NOT_BILLABLE');
      expect(result.billable).toBe(false);
      expect(result.sourceLevelVerified).toBe(false);
      expect(result.reasonCodes).toContain(`SOURCE_LEVEL_NOT_VERIFIED:${sourceLevel}`);
    }
  });

  it('未确认结算（PENDING / REJECTED_BY_REVIEW）→ NOT_BILLABLE', () => {
    for (const confirmationStatus of ['PENDING_CONFIRMATION', 'REJECTED_BY_REVIEW'] as const) {
      const result = guard({ moneyTruth: truth({ confirmationStatus }) });
      expect(result.decision).toBe('NOT_BILLABLE');
      expect(result.reasonCodes).toContain(`SETTLEMENT_NOT_CONFIRMED:${confirmationStatus}`);
    }
  });

  it('仅 PARTIAL / NOT_STARTED 对账 → NEEDS_RECONCILIATION（不得计费）', () => {
    for (const reconciliationStatus of ['PARTIAL', 'NOT_STARTED'] as const) {
      const result = guard({ moneyTruth: truth({ reconciliationStatus }) });
      expect(result.decision).toBe('NEEDS_RECONCILIATION');
      expect(result.billable).toBe(false);
      expect(result.reasonCodes).toContain(`RECONCILIATION_NOT_COMPLETE:${reconciliationStatus}`);
      expect(result.reconciliationStrict).toBe(true);
    }
  });

  it('争议 / 冲正 → 不可计费；若已有费用则要求冲回', () => {
    const disputed = guard({ moneyTruth: truth({ reconciliationStatus: 'DISPUTED' }) });
    expect(disputed.decision).toBe('NOT_BILLABLE');
    expect(disputed.requiresFeeReversal).toBe(false);

    const reversedWithFee = guard({
      moneyTruth: truth({ reconciliationStatus: 'REVERSED' }),
      existingFees: [{ settlementId: 'st-1', feeId: 'fee-1', feeAmount: '150.00', chargedAt: '2026-10-05T00:00:00.000Z' }],
    });
    expect(reversedWithFee.decision).toBe('FEE_REVERSAL_REQUIRED');
    expect(reversedWithFee.requiresFeeReversal).toBe(true);
    expect(reversedWithFee.billable).toBe(false);
    expect(reversedWithFee.warnings).toContain('EXISTING_FEE_MUST_BE_REVERSED');
  });

  it('同一 settlement 已有费用 → 重复计费被抑制（幂等）', () => {
    const result = guard({
      existingFees: [{ settlementId: 'st-1', feeId: 'fee-1', feeAmount: '150.00', chargedAt: '2026-10-05T00:00:00.000Z' }],
    });
    expect(result.decision).toBe('DUPLICATE_FEE_SUPPRESSED');
    expect(result.duplicateFeeDetected).toBe(true);
    expect(result.billable).toBe(false);
    expect(result.warnings).toContain('ONE_FEE_PER_SETTLEMENT');
  });

  it('其它 settlement 的既有费用不影响本笔（隔离）', () => {
    const result = guard({
      existingFees: [{ settlementId: 'st-OTHER', feeId: 'fee-9', feeAmount: '15.00', chargedAt: '2026-10-05T00:00:00.000Z' }],
    });
    expect(result.duplicateFeeDetected).toBe(false);
    expect(result.decision).toBe('BILLABLE');
  });
});

describe('B-S11 — estimate / client 费率 / 金额兜底', () => {
  it('estimate 作为计费依据 → NOT_BILLABLE（预估不是账单基数）', () => {
    const result = guard({ basis: 'ESTIMATED_RECOVERABLE' });
    expect(result.decision).toBe('NOT_BILLABLE');
    expect(result.reasonCodes).toContain('ESTIMATE_NOT_BILLABLE');
  });

  it('client 提供费率 → 拒绝并不可计费', () => {
    const result = guard({ clientSuppliedRateBps: 5_000 });
    expect(result.decision).toBe('NOT_BILLABLE');
    expect(result.reasonCodes).toContain('CLIENT_SUPPLIED_RATE_REJECTED');
  });

  it('金额非法 / waiver 策略（rateBps=null）→ 由既有 fee guard 兜底拒绝', () => {
    const invalidAmount = guard({ moneyTruth: truth({ verifiedAmount: 'not-a-number' }) });
    expect(invalidAmount.billable).toBe(false);
    expect(invalidAmount.reasonCodes).toContain('FEE_GUARD_REJECTED:INVALID_AMOUNT');

    const waiver = resolveFeePolicy('CUSTOMS_VIP_WAIVER', '2026-10-06');
    const waiverResult = guard({ policy: waiver });
    expect(waiverResult.billable).toBe(false);
    expect(waiverResult.reasonCodes).toContain('FEE_GUARD_REJECTED:POLICY_NOT_BILLABLE');
  });

  it('币种与策略不一致 → 由既有 fee guard 拒绝', () => {
    const currencyBound = { ...POLICY, currency: 'EUR' };
    const result = guard({ policy: currencyBound });
    expect(result.billable).toBe(false);
    expect(result.reasonCodes).toContain('FEE_GUARD_REJECTED:CURRENCY_MISMATCH');
  });
});

describe('B-S11 — 与既有 linkage 的一致性回归', () => {
  it('既有 evaluateCustomsRefundFeeTrigger 与严格 guard 在 happy path 上结论一致', () => {
    const legacy = evaluateCustomsRefundFeeTrigger({
      refundEvidence: {
        opportunityId: 'opp-1',
        providerReference: 'AMZ-1',
        sourceLevel: 'PROVIDER_VERIFIED',
        amount: '1000.00',
        currency: 'USD',
      },
      verifiedReceipt: {
        settlementId: 'st-1',
        verifiedAmount: '1000.00',
        currency: 'USD',
        confirmationStatus: 'CONFIRMED',
        reconciliationStatus: 'RECONCILED',
        evidenceSourceLevel: 'PROVIDER_VERIFIED',
      },
      policy: POLICY,
    });
    const strict = guard();
    expect(legacy.billable).toBe(true);
    expect(strict.billable).toBe(true);
    if (legacy.billable && strict.fee) {
      expect(strict.fee.feeAmount).toBe(legacy.fee.feeAmount);
      expect(strict.fee.policyId).toBe(legacy.fee.policyId);
    }
  });

  it('严格 guard 补上既有 guard 未覆盖的两类缺口（未验证来源 / 仅 PARTIAL 对账）', () => {
    // 既有 guard 只看金额与策略，因此这两种输入在金额层会「通过」——严格 guard 必须拒绝
    const userReported = guard({ moneyTruth: truth({ sourceLevel: 'USER_REPORTED' }) });
    expect(userReported.billable).toBe(false);
    expect(userReported.decision).toBe('NOT_BILLABLE');

    const partial = guard({ moneyTruth: truth({ reconciliationStatus: 'PARTIAL' }) });
    expect(partial.billable).toBe(false);
    expect(partial.decision).toBe('NEEDS_RECONCILIATION');
  });

  it('既有 linkage 边界与严格 guard 边界都声明「不收款 / 不自动扣佣」', () => {
    expect(CUSTOMS_REFUND_LINKAGE_BOUNDARY.paymentCollectionPerformed).toBe(false);
    expect(CUSTOMS_REFUND_LINKAGE_BOUNDARY.autopayEnabled).toBe(false);
    expect(CUSTOMS_REFUND_LINKAGE_BOUNDARY.externalPaymentWrite).toBe(false);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.paymentCollectionPerformed).toBe(false);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.autopayEnabled).toBe(false);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.externalPaymentWrite).toBe(false);
  });
});

describe('B-S11 — 边界断言与确定性', () => {
  it('边界常量：严格来源/对账、每 settlement 一次、estimate 不可计费、拒绝 client 费率、不自动扣佣', () => {
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.strictSourceLevel).toBe(true);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.strictReconciliation).toBe(true);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.oneFeePerSettlement).toBe(true);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.estimateIsNotBillable).toBe(true);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.clientSuppliedRateRejected).toBe(true);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.autoChargePerformed).toBe(false);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.reversalOnDisputeOrReversal).toBe(true);
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.forbidden).toContain('billing on an estimate');
    expect(CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY.forbidden).toContain('collecting payment / auto-charging a success fee');
    expect(FEE_GUARD_DECISIONS).not.toContain('AUTO_CHARGED' as never);
  });

  it('assertFeeGuardDidNotCharge：真实结果通过；伪造扣款 / 依据未验证来源计费 → 拒绝', () => {
    const result = guard();
    expect(() => assertFeeGuardDidNotCharge(result)).not.toThrow();
    expect(() => assertFeeGuardDidNotCharge({ autoChargePerformed: true as never })).toThrowError(
      CustomsSuccessFeeGuardError,
    );
    expect(() => assertFeeGuardDidNotCharge({ paymentCollectionPerformed: true as never })).toThrowError(
      CustomsSuccessFeeGuardError,
    );
    expect(() => assertFeeGuardDidNotCharge({ autopayEnabled: true as never })).toThrowError(
      CustomsSuccessFeeGuardError,
    );
    expect(() => assertFeeGuardDidNotCharge({ externalPaymentWrite: true as never })).toThrowError(
      CustomsSuccessFeeGuardError,
    );
    expect(() =>
      assertFeeGuardDidNotCharge({ billable: true, sourceLevelVerified: false }),
    ).toThrowError(CustomsSuccessFeeGuardError);
  });

  it('确定性：同输入同 now → 同 guardDigest；对账状态变化 → 摘要变', () => {
    const a = guard();
    const b = guard();
    const c = guard({ moneyTruth: truth({ reconciliationStatus: 'PARTIAL' }) });
    expect(a.guardDigest).toBe(b.guardDigest);
    expect(a.guardDigest).not.toBe(c.guardDigest);
    expect(a.guardDigest).toHaveLength(64);
    expect(a.evaluatedAt).toBe(NOW.toISOString());
  });
});
