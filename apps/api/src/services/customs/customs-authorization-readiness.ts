/**
 * C16 — CUSTOMS AUTHORIZATION READINESS（HOST DIRECTIVE 2026-10-03 补充四 §3）
 * ---------------------------------------------------------------
 * 三类授权完全独立（Platform OAuth != Broker POA != Payment Authorization）；
 * 只有全部就绪才允许 READY_TO_FILE；否则返回明确、可解释的拒绝码（fail-closed）。
 * 本模块只做**判定**，不做任何授权获取、外写或申报。
 */

export interface CustomsAuthorizationFlags {
  customsAgreementSigned: boolean;
  importerOfRecordConfirmed: boolean;
  claimantConfirmed: boolean;
  recoveryRightConfirmed: boolean;
  brokerConnected: boolean;
  brokerAuthorizationValid: boolean;
  filingPermissionValid: boolean;
  providerCapabilityReady: boolean;
}

export type CustomsAuthorizationBlocker =
  | 'CUSTOMS_AGREEMENT_REQUIRED'
  | 'IOR_NOT_CONFIRMED'
  | 'CLAIMANT_NOT_CONFIRMED'
  | 'RECOVERY_RIGHT_NOT_CONFIRMED'
  | 'BROKER_NOT_CONNECTED'
  | 'BROKER_POA_REQUIRED'
  | 'FILING_PERMISSION_REQUIRED'
  | 'FILING_PROVIDER_NOT_READY';

export interface CustomsAuthorizationReadiness {
  ready: boolean;
  disposition: 'READY_TO_FILE' | 'AUTHORIZATION_INCOMPLETE';
  blockers: readonly CustomsAuthorizationBlocker[];
  filingSubmitted: false;
  externalWritePerformed: false;
  productionCredentials: 'ABSENT';
}

const CHECKS: ReadonlyArray<{ flag: keyof CustomsAuthorizationFlags; blocker: CustomsAuthorizationBlocker }> = [
  { flag: 'customsAgreementSigned', blocker: 'CUSTOMS_AGREEMENT_REQUIRED' },
  { flag: 'importerOfRecordConfirmed', blocker: 'IOR_NOT_CONFIRMED' },
  { flag: 'claimantConfirmed', blocker: 'CLAIMANT_NOT_CONFIRMED' },
  { flag: 'recoveryRightConfirmed', blocker: 'RECOVERY_RIGHT_NOT_CONFIRMED' },
  { flag: 'brokerConnected', blocker: 'BROKER_NOT_CONNECTED' },
  { flag: 'brokerAuthorizationValid', blocker: 'BROKER_POA_REQUIRED' },
  { flag: 'filingPermissionValid', blocker: 'FILING_PERMISSION_REQUIRED' },
  { flag: 'providerCapabilityReady', blocker: 'FILING_PROVIDER_NOT_READY' },
];

export function evaluateCustomsAuthorizationReadiness(
  flags: CustomsAuthorizationFlags,
): CustomsAuthorizationReadiness {
  const blockers = CHECKS.filter((check) => flags[check.flag] !== true).map((check) => check.blocker);
  return {
    ready: blockers.length === 0,
    disposition: blockers.length === 0 ? 'READY_TO_FILE' : 'AUTHORIZATION_INCOMPLETE',
    blockers,
    filingSubmitted: false,
    externalWritePerformed: false,
    productionCredentials: 'ABSENT',
  };
}
