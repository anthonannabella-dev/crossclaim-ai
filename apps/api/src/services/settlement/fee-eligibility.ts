/**
 * R46 S4 —— Fee 资格判定（纯函数）
 * 依据：MSG-20261002-59（Fee 基数只能来自 confirmed + unreversed + eligible 的 Settlement 金额）
 * 与 R12 红线。
 *
 * 明确不构成资格来源：Claim amount / ExpectedRecoveryBasis / R45 projection / FULLY_RECONCILED /
 * manual override / estimated recovery / provider accepted but unpaid。
 */

import { canonicalAmount, canonicalCurrency } from './receipt-snapshot';

export type SettlementStatusLike = 'EXPECTED' | 'RECEIVED' | 'PARTIAL' | 'DISPUTED' | 'VOID';
export type ConfirmationStatusLike = 'CONFIRMED' | 'PENDING_CONFIRMATION' | 'REJECTED_BY_REVIEW';
export type ReconciliationStatusLike = 'NOT_STARTED' | 'PARTIAL' | 'RECONCILED' | 'DISPUTED' | 'REVERSED';

export interface SettlementEligibilityInput {
  settlementId: string;
  status: SettlementStatusLike;
  confirmationStatus: ConfirmationStatusLike;
  reconciliationStatus: ReconciliationStatusLike;
  amount: string;
  currency: string;
  evidenceId?: string | null;
  reversedBySettlementId?: string | null;
  /** 是否存在有效（未被再次冲回）的 SettlementAdjustment(REVERSAL) */
  hasActiveReversalAdjustment?: boolean;
}

export type FeeEligibilityReason =
  | 'ELIGIBLE'
  | 'STATUS_NOT_RECEIVED'
  | 'NOT_CONFIRMED'
  | 'NOT_RECONCILED'
  | 'MISSING_EVIDENCE'
  | 'REVERSED'
  | 'REVERSAL_ADJUSTMENT_PRESENT'
  | 'INVALID_AMOUNT';

export interface FeeEligibilityResult {
  eligible: boolean;
  reason: FeeEligibilityReason;
}

export function isSettlementFeeEligible(input: SettlementEligibilityInput): FeeEligibilityResult {
  if (input.status !== 'RECEIVED' && input.status !== 'PARTIAL') {
    return { eligible: false, reason: 'STATUS_NOT_RECEIVED' };
  }
  if (input.confirmationStatus !== 'CONFIRMED') return { eligible: false, reason: 'NOT_CONFIRMED' };
  if (input.reconciliationStatus !== 'RECONCILED' && input.reconciliationStatus !== 'PARTIAL') {
    return { eligible: false, reason: 'NOT_RECONCILED' };
  }
  if (!input.evidenceId) return { eligible: false, reason: 'MISSING_EVIDENCE' };
  if (input.reversedBySettlementId) return { eligible: false, reason: 'REVERSED' };
  if (input.hasActiveReversalAdjustment) return { eligible: false, reason: 'REVERSAL_ADJUSTMENT_PRESENT' };
  try {
    canonicalAmount(input.amount);
    canonicalCurrency(input.currency);
  } catch {
    return { eligible: false, reason: 'INVALID_AMOUNT' };
  }
  return { eligible: true, reason: 'ELIGIBLE' };
}

export interface FeeMembershipRow {
  settlementId: string;
  amount: string;
  currency: string;
}

/** 只接受 eligible 的 Settlement 生成 membership（canonical 4dp / 大写币种） */
export function buildFeeMembership(input: SettlementEligibilityInput): FeeMembershipRow {
  const verdict = isSettlementFeeEligible(input);
  if (!verdict.eligible) {
    throw new Error('SETTLEMENT_NOT_FEE_ELIGIBLE: ' + verdict.reason);
  }
  return {
    settlementId: input.settlementId,
    amount: canonicalAmount(input.amount),
    currency: canonicalCurrency(input.currency),
  };
}
