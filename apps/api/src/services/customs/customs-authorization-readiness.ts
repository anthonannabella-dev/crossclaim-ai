/**
 * C16 — CUSTOMS AUTHORIZATION READINESS（HOST DIRECTIVE 2026-10-03 补充四 §3）
 * ---------------------------------------------------------------
 * CA-1（MSG-20261004-02 CHANGE A/D）：本函数等价于 **BROKER_FILED 默认策略** 的旧口径，
 * 继续服务既有 C16/C21 调用方（blocker 词表与顺序保持不变）；route-aware 三阶段判定
 * （READY_TO_PREPARE / READY_TO_FILE / READY_TO_RECEIVE_REFUND）与授权生命周期见
 * `./customs-authorization-route.ts`。
 *
 * 三类授权完全独立（Platform OAuth != Broker POA != Payment Authorization）；
 * 本模块只做**判定**，不做任何授权获取、外写或申报。
 */

import { evaluateCustomsAuthorizationForRoute, type CustomsStageBlocker } from './customs-authorization-route';

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

const LEGACY_BLOCKERS: readonly CustomsAuthorizationBlocker[] = [
  'CUSTOMS_AGREEMENT_REQUIRED',
  'IOR_NOT_CONFIRMED',
  'CLAIMANT_NOT_CONFIRMED',
  'RECOVERY_RIGHT_NOT_CONFIRMED',
  'BROKER_NOT_CONNECTED',
  'BROKER_POA_REQUIRED',
  'FILING_PERMISSION_REQUIRED',
  'FILING_PROVIDER_NOT_READY',
];

export function evaluateCustomsAuthorizationReadiness(
  flags: CustomsAuthorizationFlags,
): CustomsAuthorizationReadiness {
  const result = evaluateCustomsAuthorizationForRoute({
    route: 'BROKER_FILED',
    remedy: '*',
    facts: {
      customsAgreementSigned: flags.customsAgreementSigned,
      iorConfirmed: flags.importerOfRecordConfirmed,
      claimantConfirmed: flags.claimantConfirmed,
      recoveryRightForRemedy: flags.recoveryRightConfirmed,
      brokerConnected: flags.brokerConnected,
      brokerPoaStatus: flags.brokerAuthorizationValid ? 'VERIFIED' : 'MISSING',
      brokerPoaScopeCoversRemedy: true,
      brokerPoaJurisdiction: null,
      brokerPoaSource: 'BROKER_POA_FACT',
      signerStatus: 'MISSING',
      signerScopeCoversRemedy: false,
      signerSource: 'MISSING',
      signerJurisdiction: null,
      filingPermissionValid: flags.filingPermissionValid,
      providerCapabilityReady: flags.providerCapabilityReady,
      payeeIdentityConfirmed: true,
      refundDestinationVerified: true,
      aceEnrollmentReady: true,
    },
  });

  const blockers = result.file.blockers.filter((code): code is CustomsAuthorizationBlocker =>
    (LEGACY_BLOCKERS as readonly string[]).includes(code satisfies CustomsStageBlocker as string),
  );
  const ready = result.file.ready;

  return {
    ready,
    disposition: ready ? 'READY_TO_FILE' : 'AUTHORIZATION_INCOMPLETE',
    blockers,
    filingSubmitted: false,
    externalWritePerformed: false,
    productionCredentials: 'ABSENT',
  };
}
