/**
 * C20 — REFUND → SETTLEMENT → 15% FEE 契约层（HOST DIRECTIVE §3 / MSG-20261003-122 ㊱）
 * ---------------------------------------------------------------
 * 复用既有资金链：Provider/Authority refund evidence → Verified Recovery Receipt → Settlement
 *              → Reconciliation → Verified Actual Incremental Recovery → 15% Fee。
 * 只有 **verified actual incremental recovered** 才能触发成功费；本模块不写任何资金事实。
 */

import { evaluateFeeGuard, type FeePolicy } from '../commercial/fee-policy';

export interface CustomsRefundEvidence {
  opportunityId: string;
  providerReference: string | null;
  sourceLevel: 'USER_REPORTED' | 'PROVIDER_VERIFIED' | 'AUTHORITY_VERIFIED';
  amount: string | null;
  currency: string | null;
}

export interface CustomsVerifiedRecoveryReceipt {
  settlementId: string;
  verifiedAmount: string;
  currency: string;
  confirmationStatus: 'CONFIRMED';
  reconciliationStatus: 'RECONCILED' | 'PARTIAL';
  evidenceSourceLevel: 'PROVIDER_VERIFIED' | 'AUTHORITY_VERIFIED';
}

export type CustomsRefundFeeReason =
  | 'REFUND_EVIDENCE_UNVERIFIED'
  | 'NO_VERIFIED_RECEIPT'
  | 'FEE_GUARD_REJECTED';

export type CustomsRefundFeeDecision =
  | { billable: true; fee: { feeAmount: string; currency: string; policyId: string; policyVersion: string; settlementId: string } }
  | { billable: false; reasonCode: CustomsRefundFeeReason; detail?: string };

export function evaluateCustomsRefundFeeTrigger(
  input: {
    refundEvidence: CustomsRefundEvidence;
    verifiedReceipt: CustomsVerifiedRecoveryReceipt | null;
    policy: FeePolicy;
  },
): CustomsRefundFeeDecision {
  if (input.refundEvidence.sourceLevel === 'USER_REPORTED') {
    return { billable: false, reasonCode: 'REFUND_EVIDENCE_UNVERIFIED' };
  }
  if (input.verifiedReceipt === null) return { billable: false, reasonCode: 'NO_VERIFIED_RECEIPT' };
  const guarded = evaluateFeeGuard({
    policy: input.policy,
    basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
    verifiedRecovered: {
      settlementId: input.verifiedReceipt.settlementId,
      verifiedAmount: input.verifiedReceipt.verifiedAmount,
      currency: input.verifiedReceipt.currency,
      confirmationStatus: input.verifiedReceipt.confirmationStatus,
      reconciliationStatus: input.verifiedReceipt.reconciliationStatus,
    },
  });
  if (!guarded.allowed) {
    return { billable: false, reasonCode: 'FEE_GUARD_REJECTED', detail: guarded.reasonCode };
  }
  return {
    billable: true,
    fee: {
      feeAmount: guarded.fee.feeAmount,
      currency: guarded.fee.currency,
      policyId: guarded.fee.policyId,
      policyVersion: guarded.fee.policyVersion,
      settlementId: guarded.fee.settlementId,
    },
  };
}

/** 边界自证：本契约层不写 Settlement / 不扣款 / 不收款。 */
export const CUSTOMS_REFUND_LINKAGE_BOUNDARY = {
  writesSettlement: false,
  writesRecoveryPayout: false,
  paymentCollectionPerformed: false,
  autopayEnabled: false,
  externalPaymentWrite: false,
  productionCredentials: 'ABSENT',
} as const;
