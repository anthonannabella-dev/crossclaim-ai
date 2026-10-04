/**
 * CA-5 — CUSTOMS AUTHORIZATION CENTER（客户视角授权中心，MSG-20261004-02 §9）
 * MSG-20261004-08 REVISE A/B/C + MSG-20261004-09 REVISE B2（route-aware filing permission ownership）。
 * 纯投影：只消费 CA-1 的 server-derived snapshot，不做任何 policy 二次推断。
 */

import type {
  CustomsFilingRoute,
  CustomsRouteAuthorizationReadiness,
  CustomsStageBlocker,
} from './customs-authorization-route';

export const CUSTOMS_AUTHORIZATION_CENTER_ITEM_KEYS = [
  'ENTERPRISE_IDENTITY',
  'RECOVERY_RIGHT',
  'SIGNER_AUTHORITY',
  'BROKER_AUTHORIZATION',
  'REFUND_ACCOUNT',
  'SUBMISSION_READINESS',
] as const;

export type CustomsAuthorizationCenterItemKey = (typeof CUSTOMS_AUTHORIZATION_CENTER_ITEM_KEYS)[number];

export type CustomsAuthorizationChecklistState =
  | 'CONFIRMED'
  | 'NEEDS_ACTION'
  | 'NOT_REQUIRED'
  | 'PENDING_POLICY';

export type CustomsAuthorizationSubmitState = 'IN_PREPARATION' | 'READY_TO_SUBMIT' | 'WAITING_AUTHORIZATION';

export type CustomsAuthorizationNextAction =
  | 'CONFIRM_ENTERPRISE_IDENTITY'
  | 'SUPPLY_DOCUMENTS'
  | 'CONFIRM_SIGNING_AUTHORITY'
  | 'COMPLETE_BROKER_AUTHORIZATION'
  | 'CONFIRM_REFUND_ACCOUNT'
  | 'START_RECOVERY';

export interface CustomsAuthorizationCenterItem {
  key: CustomsAuthorizationCenterItemKey;
  state: CustomsAuthorizationChecklistState | CustomsAuthorizationSubmitState;
  action: CustomsAuthorizationNextAction | null;
  blockerCodes: readonly CustomsStageBlocker[];
}

export interface CustomsAuthorizationCenter {
  route: CustomsFilingRoute;
  remedy: string;
  jurisdiction: string | null;
  items: readonly CustomsAuthorizationCenterItem[];
  nextAction: CustomsAuthorizationNextAction | null;
  stages: { READY_TO_PREPARE: boolean; READY_TO_FILE: boolean; READY_TO_RECEIVE_REFUND: boolean };
  advancedBlockerCodes: readonly CustomsStageBlocker[];
  filingSubmitted: false;
  externalWritePerformed: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
  serverDerived: true;
}

const IDENTITY_BLOCKERS: readonly CustomsStageBlocker[] = [
  'CUSTOMS_AGREEMENT_REQUIRED',
  'IOR_NOT_CONFIRMED',
  'CLAIMANT_NOT_CONFIRMED',
];

const SIGNER_BLOCKERS: readonly CustomsStageBlocker[] = [
  'SIGNER_AUTHORITY_REQUIRED',
  'SIGNER_NOT_USABLE',
  'SIGNER_SCOPE_MISMATCH',
  'SIGNER_JURISDICTION_MISMATCH',
  'AUTHORIZATION_SOURCE_NOT_ALLOWED',
];

const BROKER_BLOCKERS: readonly CustomsStageBlocker[] = [
  'BROKER_NOT_CONNECTED',
  'BROKER_POA_REQUIRED',
  'BROKER_POA_NOT_USABLE',
  'BROKER_POA_SCOPE_MISMATCH',
  'JURISDICTION_MISMATCH',
  'AUTHORIZATION_SOURCE_NOT_ALLOWED',
];

/** 与 route 无关的 provider/authority 侧 blocker。 */
export const CUSTOMS_AUTHORIZATION_PROVIDER_SIDE_BLOCKERS: readonly CustomsStageBlocker[] = [
  'FILING_PROVIDER_NOT_READY',
  'PROVIDER_POLICY_REQUIRED',
  'FILING_PERMISSION_REQUIRED',
];

/**
 * REVISE B2：FILING_PERMISSION_REQUIRED 的 ownership 是 route-aware 的。
 *   BROKER_FILED / SERVICE_PROVIDER_TRANSMIT → provider / broker / authority 侧（客户等待即可）
 *   SELF_FILED → 客户/其授权签署人自行申报 → 归 ③ 签署权限（不是 ④ Broker Authorization）
 */
export function customsAuthorizationFilingPermissionOwnership(
  route: CustomsFilingRoute,
): 'PROVIDER' | 'CUSTOMER_SIGNER' {
  return route === 'SELF_FILED' ? 'CUSTOMER_SIGNER' : 'PROVIDER';
}

function pick(blockers: readonly CustomsStageBlocker[], wanted: readonly CustomsStageBlocker[]): CustomsStageBlocker[] {
  return blockers.filter((code) => wanted.includes(code));
}

export function buildCustomsAuthorizationCenter(input: {
  readiness: CustomsRouteAuthorizationReadiness;
}): CustomsAuthorizationCenter {
  const { readiness } = input;
  const requirements = readiness.requirements;
  const policyResolved = readiness.policyApplied && requirements !== null;
  const filingPermissionOwnership = customsAuthorizationFilingPermissionOwnership(readiness.route);

  const identityCodes = pick(readiness.prepare.blockers, IDENTITY_BLOCKERS);
  const recoveryRightCodes = pick(readiness.prepare.blockers, ['RECOVERY_RIGHT_NOT_CONFIRMED']);
  const signerCodes = pick(readiness.file.blockers, SIGNER_BLOCKERS);
  const brokerCodes = pick(readiness.file.blockers, BROKER_BLOCKERS);
  const refundCodes = pick(readiness.refund.blockers, [
    'PAYEE_IDENTITY_NOT_CONFIRMED',
    'REFUND_DESTINATION_NOT_VERIFIED',
    'ACE_ENROLLMENT_NOT_READY',
  ]);
  // REVISE B2：SELF_FILED 缺 filing permission 时归 ③（客户签署权限），不是 provider 侧
  const selfFiledPermissionCodes =
    filingPermissionOwnership === 'CUSTOMER_SIGNER' ? pick(readiness.file.blockers, ['FILING_PERMISSION_REQUIRED']) : [];

  const authItem = (
    required: boolean,
    codes: CustomsStageBlocker[],
  ): { state: CustomsAuthorizationChecklistState; action: CustomsAuthorizationNextAction | null; codes: CustomsStageBlocker[] } => {
    if (!policyResolved) return { state: 'PENDING_POLICY', action: null, codes: [] };
    if (!required) return { state: 'NOT_REQUIRED', action: null, codes: [] };
    if (codes.length === 0) return { state: 'CONFIRMED', action: null, codes: [] };
    return { state: 'NEEDS_ACTION', action: null, codes };
  };

  const signer = authItem(requirements?.authorizedSignerRequired ?? false, [...signerCodes, ...selfFiledPermissionCodes]);
  const broker = authItem(requirements?.brokerPoaRequired ?? false, brokerCodes);

  const items: CustomsAuthorizationCenterItem[] = [
    {
      key: 'ENTERPRISE_IDENTITY',
      state: identityCodes.length > 0 ? 'NEEDS_ACTION' : 'CONFIRMED',
      action: identityCodes.length > 0 ? 'CONFIRM_ENTERPRISE_IDENTITY' : null,
      blockerCodes: identityCodes,
    },
    {
      key: 'RECOVERY_RIGHT',
      state: recoveryRightCodes.length > 0 ? 'NEEDS_ACTION' : 'CONFIRMED',
      action: recoveryRightCodes.length > 0 ? 'SUPPLY_DOCUMENTS' : null,
      blockerCodes: recoveryRightCodes,
    },
    {
      key: 'SIGNER_AUTHORITY',
      state: signer.state,
      action: signer.state === 'NEEDS_ACTION' ? 'CONFIRM_SIGNING_AUTHORITY' : null,
      blockerCodes: signer.codes,
    },
    {
      key: 'BROKER_AUTHORIZATION',
      state: broker.state,
      action: broker.state === 'NEEDS_ACTION' ? 'COMPLETE_BROKER_AUTHORIZATION' : null,
      blockerCodes: broker.codes,
    },
    {
      key: 'REFUND_ACCOUNT',
      state: refundCodes.length > 0 ? 'NEEDS_ACTION' : 'CONFIRMED',
      action: refundCodes.length > 0 ? 'CONFIRM_REFUND_ACCOUNT' : null,
      blockerCodes: refundCodes,
    },
  ];

  const providerSide = readiness.file.blockers.filter(
    (code) =>
      CUSTOMS_AUTHORIZATION_PROVIDER_SIDE_BLOCKERS.includes(code) &&
      !(code === 'FILING_PERMISSION_REQUIRED' && filingPermissionOwnership === 'CUSTOMER_SIGNER'),
  );
  const customerSide = readiness.file.blockers.filter((code) => !providerSide.includes(code));
  const submitState: CustomsAuthorizationSubmitState = readiness.file.ready
    ? 'READY_TO_SUBMIT'
    : customerSide.length === 0 && providerSide.length > 0
      ? 'WAITING_AUTHORIZATION'
      : 'IN_PREPARATION';

  items.push({
    key: 'SUBMISSION_READINESS',
    state: submitState,
    action: submitState === 'READY_TO_SUBMIT' ? 'START_RECOVERY' : null,
    blockerCodes: providerSide,
  });

  const firstActionable = items.find((item) => item.key !== 'SUBMISSION_READINESS' && item.action !== null);
  const nextAction: CustomsAuthorizationNextAction | null =
    submitState === 'READY_TO_SUBMIT' ? 'START_RECOVERY' : firstActionable?.action ?? null;

  return {
    route: readiness.route,
    remedy: readiness.remedy,
    jurisdiction: readiness.jurisdiction,
    items,
    nextAction,
    stages: {
      READY_TO_PREPARE: readiness.READY_TO_PREPARE,
      READY_TO_FILE: readiness.READY_TO_FILE,
      READY_TO_RECEIVE_REFUND: readiness.READY_TO_RECEIVE_REFUND,
    },
    advancedBlockerCodes: readiness.blockers,
    filingSubmitted: false,
    externalWritePerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
    serverDerived: true,
  };
}
