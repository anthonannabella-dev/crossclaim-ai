/**
 * ENTERPRISE IOR RECOVERY LAYER — ⑦ REFUND DESTINATION READINESS（只读就绪抽象）。
 * ---------------------------------------------------------------
 * CrossClaim 不代收 Customs refund；不得存银行账户原文；APPROVED ≠ PAID；estimated recovery ≠ fee basis。
 */

export const REFUND_DESTINATION_REASONS = [
  'OK',
  'PAYEE_IDENTITY_NOT_CONFIRMED',
  'ACE_ENROLLMENT_NOT_READY',
  'DESTINATION_NOT_VERIFIED',
  'THIRD_PARTY_DESIGNATION_PRESENT',
  'RAW_BANK_ACCOUNT_NOT_ALLOWED',
] as const;
export type RefundDestinationReason = (typeof REFUND_DESTINATION_REASONS)[number];

export interface RefundDestinationInput {
  organizationId: string;
  claimantRef: string;
  payeeIdentityConfirmed: boolean;
  aceRefundEnrollmentStatus: 'READY' | 'PENDING' | 'ABSENT' | 'UNKNOWN';
  refundDestinationVerified: boolean;
  thirdPartyDesignationPresent: boolean;
  verifiedAt: string | null;
  bankAccountReference: string | null;
}

export interface RefundDestinationReadiness {
  ready: boolean;
  reasonCodes: readonly RefundDestinationReason[];
  readonly storesRawBankAccount: false;
  readonly collectsRefund: false;
  readonly approvedIsPaid: false;
  readonly estimatedIsFeeBasis: false;
}

export function evaluateRefundDestinationReadiness(input: RefundDestinationInput): RefundDestinationReadiness {
  const reasons: RefundDestinationReason[] = [];
  if (!input.payeeIdentityConfirmed) reasons.push('PAYEE_IDENTITY_NOT_CONFIRMED');
  if (input.aceRefundEnrollmentStatus !== 'READY') reasons.push('ACE_ENROLLMENT_NOT_READY');
  if (!input.refundDestinationVerified) reasons.push('DESTINATION_NOT_VERIFIED');
  if (input.thirdPartyDesignationPresent) reasons.push('THIRD_PARTY_DESIGNATION_PRESENT');
  if (input.bankAccountReference !== null && /^\d{6,}$/.test(String(input.bankAccountReference).trim())) {
    reasons.push('RAW_BANK_ACCOUNT_NOT_ALLOWED');
  }
  const blocking = reasons.filter((reason) => reason !== 'THIRD_PARTY_DESIGNATION_PRESENT');
  return {
    ready: blocking.length === 0,
    reasonCodes: reasons.length > 0 ? reasons : ['OK'],
    storesRawBankAccount: false,
    collectsRefund: false,
    approvedIsPaid: false,
    estimatedIsFeeBasis: false,
  };
}

export const REFUND_DESTINATION_BOUNDARY = {
  crossclaimCollectsRefund: false,
  storesRawBankAccount: false,
  approvedIsPaid: false,
  estimatedIsFeeBasis: false,
  requiresVerifiedReceiptBeforeSettlement: true,
  productionCredentials: 'ABSENT',
} as const;
