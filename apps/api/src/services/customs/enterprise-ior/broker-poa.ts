/**
 * ENTERPRISE IOR RECOVERY LAYER — ③ BROKER POA（CBP Form 5291 语义；与 Platform OAuth / Payment Authorization 严格分离）。
 * ---------------------------------------------------------------
 * · 不得使用 Form 4811 作为 Broker POA；4811 仅可作 refund destination / special address / third-party designation。
 * · Broker POA 必须由 Broker 与 importer / drawback claimant 的直接授权关系证明。
 */

export const BROKER_AUTHORIZATION_TYPES = ['CBP_FORM_5291', 'EQUIVALENT_REGULATORY_POA'] as const;
export type BrokerAuthorizationType = (typeof BROKER_AUTHORIZATION_TYPES)[number];

export const BROKER_POA_REASONS = [
  'OK',
  'MISSING_PRINCIPAL',
  'MISSING_BROKER',
  'WRONG_AUTHORIZATION_TYPE',
  'MISSING_SCOPE',
  'MISSING_EVIDENCE',
  'EXPIRED',
  'UNVERIFIED',
] as const;
export type BrokerPoaReason = (typeof BROKER_POA_REASONS)[number];

export interface BrokerAuthorizationInput {
  organizationId: string;
  principalRef: string;
  brokerRef: string;
  jurisdiction: string;
  authorizationType: string;
  scope: readonly string[];
  effectiveAt: string;
  expiresAt: string | null;
  evidenceArtifactRef: string | null;
  verificationStatus: string;
  verificationSource: string;
}

export interface BrokerAuthorizationResult {
  usable: boolean;
  reasonCodes: readonly BrokerPoaReason[];
  /** 明确区分三种授权域，防止混用。 */
  readonly platformOAuthIsBrokerPoa: false;
  readonly paymentAuthorizationIsBrokerPoa: false;
  readonly form4811UsedAsBrokerPoa: false;
}

export function evaluateBrokerAuthorization(input: BrokerAuthorizationInput, now: string): BrokerAuthorizationResult {
  const reasons: BrokerPoaReason[] = [];
  if (!input.principalRef) reasons.push('MISSING_PRINCIPAL');
  if (!input.brokerRef) reasons.push('MISSING_BROKER');
  const type = String(input.authorizationType ?? '').toUpperCase();
  if (!(BROKER_AUTHORIZATION_TYPES as readonly string[]).includes(type)) reasons.push('WRONG_AUTHORIZATION_TYPE');
  if (!Array.isArray(input.scope) || input.scope.length === 0) reasons.push('MISSING_SCOPE');
  if (!input.evidenceArtifactRef) reasons.push('MISSING_EVIDENCE');
  if (input.expiresAt !== null && Date.parse(input.expiresAt) < Date.parse(now)) reasons.push('EXPIRED');
  if (String(input.verificationStatus ?? '').toUpperCase() !== 'VERIFIED') reasons.push('UNVERIFIED');
  return {
    usable: reasons.length === 0,
    reasonCodes: reasons.length > 0 ? reasons : ['OK'],
    platformOAuthIsBrokerPoa: false,
    paymentAuthorizationIsBrokerPoa: false,
    form4811UsedAsBrokerPoa: false,
  };
}

export const BROKER_POA_BOUNDARY = {
  brokerPoaForm: 'CBP_FORM_5291',
  form4811AllowedForBrokerPoa: false,
  form4811AllowedForRefundDestinationOnly: true,
  platformOAuthIsBrokerPoa: false,
  paymentAuthorizationIsBrokerPoa: false,
  productionCredentials: 'ABSENT',
} as const;
