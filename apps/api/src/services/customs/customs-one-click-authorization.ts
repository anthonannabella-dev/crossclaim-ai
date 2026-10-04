/**
 * CA-6 — ONE-CLICK CUSTOMS RECOVERY AUTHORIZATION（MSG-20261004-02 §十 / MSG-20261004-11 授权）
 * ---------------------------------------------------------------
 * 纯编排判定（零外写、零授权获取）：
 *   · 复用 CA-5 的六项 server-derived 投影，只挑出「客户真正缺的」项目；
 *   · 判定既有授权（Broker POA / Authorized Signer）能否**复用**——
 *     相同 principal / jurisdiction / scope / route（+ 同一 broker/signer）时，客户不必逐单重复签署；
 *   · 只有 expired / revoked / superseded / broker changed / legal entity changed / route changed /
 *     jurisdiction changed / scope mismatch / provider renewal 才要求重新授权。
 * 真实 filing / provider transport 继续 HOLD：本模块只产出"要不要重签、缺什么、下一步"。
 */

import type {
  CustomsAuthorizationCenter,
  CustomsAuthorizationCenterItemKey,
  CustomsAuthorizationNextAction,
} from './customs-authorization-center';

export type CustomsOneClickAuthGate =
  | 'READY_TO_START'
  | 'NEEDS_AUTHORIZATION'
  | 'REAUTHORIZATION_REQUIRED'
  | 'WAITING_ON_PROVIDER';

export const CUSTOMS_REAUTHORIZATION_REASONS = [
  'NO_EXISTING_AUTHORIZATION',
  'AUTHORIZATION_PENDING',
  'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_REVOKED',
  'AUTHORIZATION_SUPERSEDED',
  'AUTHORIZATION_NOT_YET_EFFECTIVE',
  'SCOPE_MISMATCH',
  'JURISDICTION_CHANGED',
  'ROUTE_CHANGED',
  'LEGAL_ENTITY_CHANGED',
  'BROKER_CHANGED',
  'PROVIDER_RENEWAL_REQUIRED',
  'TARGET_BROKER_UNKNOWN',
] as const;

export type CustomsReauthorizationReason = (typeof CUSTOMS_REAUTHORIZATION_REASONS)[number];

export interface CustomsExistingAuthorizationSnapshot {
  subject: 'BROKER_POA' | 'AUTHORIZED_SIGNER';
  status:
    | 'VERIFIED'
    | 'PENDING'
    | 'MISSING'
    | 'REVOKED'
    | 'EXPIRED'
    | 'SUPERSEDED'
    | 'NOT_YET_EFFECTIVE';
  /** 既有授权 scope 是否覆盖本次 remedy。 */
  scopeCoversRequested: boolean;
  jurisdictionMatches: boolean;
  routeMatches: boolean;
  /** 同一 principal（法人变更会使其为 false）。 */
  samePrincipal: boolean;
  /** 同一 broker / 同一 authorized signer。 */
  sameBrokerOrSigner: boolean;
  /** provider / 法规要求续期。 */
  providerRenewalRequired?: boolean;
}

export interface CustomsOneClickAuthorizationPlan {
  gate: CustomsOneClickAuthGate;
  /** 只列客户真正缺的项目（CA-5 六项里 action !== null 的项）。 */
  missingItemKeys: readonly CustomsAuthorizationCenterItemKey[];
  missingActions: readonly CustomsAuthorizationNextAction[];
  /** true = 既有授权可复用，不需要为这一单重新签署同一份 POA/签署权限。 */
  reuseExistingAuthorization: boolean;
  /** 仅在需要重新授权时非空（客户可见的解释依据归 UI，工程码归高级详情）。 */
  reasonCodes: readonly CustomsReauthorizationReason[];
  nextAction: CustomsAuthorizationNextAction | null;
  serverDerived: true;
  filingSubmitted: false;
  externalWritePerformed: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
}

function authorizationUsable(existing: CustomsExistingAuthorizationSnapshot | null | undefined): boolean {
  if (!existing) return false;
  if (existing.status !== 'VERIFIED') return false;
  if (!existing.scopeCoversRequested) return false;
  if (!existing.jurisdictionMatches) return false;
  if (!existing.routeMatches) return false;
  if (!existing.samePrincipal) return false;
  if (!existing.sameBrokerOrSigner) return false;
  if (existing.providerRenewalRequired === true) return false;
  return true;
}

export function customsReauthorizationReasons(
  existing: CustomsExistingAuthorizationSnapshot | null | undefined,
): CustomsReauthorizationReason[] {
  if (!existing) return ['NO_EXISTING_AUTHORIZATION'];
  const reasons: CustomsReauthorizationReason[] = [];
  switch (existing.status) {
    case 'VERIFIED':
      break;
    case 'PENDING':
      reasons.push('AUTHORIZATION_PENDING');
      break;
    case 'MISSING':
      reasons.push('NO_EXISTING_AUTHORIZATION');
      break;
    case 'REVOKED':
      reasons.push('AUTHORIZATION_REVOKED');
      break;
    case 'EXPIRED':
      reasons.push('AUTHORIZATION_EXPIRED');
      break;
    case 'SUPERSEDED':
      reasons.push('AUTHORIZATION_SUPERSEDED');
      break;
    case 'NOT_YET_EFFECTIVE':
      reasons.push('AUTHORIZATION_NOT_YET_EFFECTIVE');
      break;
  }
  if (!existing.scopeCoversRequested) reasons.push('SCOPE_MISMATCH');
  if (!existing.jurisdictionMatches) reasons.push('JURISDICTION_CHANGED');
  if (!existing.routeMatches) reasons.push('ROUTE_CHANGED');
  if (!existing.samePrincipal) reasons.push('LEGAL_ENTITY_CHANGED');
  if (!existing.sameBrokerOrSigner) reasons.push('BROKER_CHANGED');
  if (existing.providerRenewalRequired === true) reasons.push('PROVIDER_RENEWAL_REQUIRED');
  return reasons.length > 0 ? reasons : ['NO_EXISTING_AUTHORIZATION'];
}

/**
 * 一键追回授权计划：
 *   READY_TO_START          — 六项齐备，可直接开始追回（START_RECOVERY）
 *   NEEDS_AUTHORIZATION     — 还缺项目，但既有授权可复用（只补缺失项，不重签同一份授权）
 *   REAUTHORIZATION_REQUIRED— 必须重新授权（expired/revoked/superseded/主体或路线/辖区/scope 变化/provider 续期）
 *   WAITING_ON_PROVIDER     — 客户侧齐备，只剩 provider/authority 侧（等待即可，无需签署）
 */
export function planCustomsOneClickAuthorization(input: {
  center: CustomsAuthorizationCenter;
  existingAuthorization?: CustomsExistingAuthorizationSnapshot | null;
  /** true = 当前目标 broker/signer 绑定尚未由 server truth 确定（不得猜、也不得让客户重签）。 */
  targetBindingUnknown?: boolean;
}): CustomsOneClickAuthorizationPlan {
  const { center } = input;
  const missingItems = center.items.filter(
    (item) => item.key !== 'SUBMISSION_READINESS' && item.action !== null,
  );
  const missingItemKeys = missingItems.map((item) => item.key);
  const missingActions = missingItems
    .map((item) => item.action)
    .filter((action): action is CustomsAuthorizationNextAction => action !== null);

  const reuse = authorizationUsable(input.existingAuthorization);
  const boundary = {
    serverDerived: true as const,
    filingSubmitted: false as const,
    externalWritePerformed: false as const,
    transportEnabled: false as const,
    productionCredentials: 'ABSENT' as const,
  };

  // REVISE（MSG-20261004-12）：目标 broker/signer 尚未由 server truth 确定时 fail-closed 到 WAITING_ON_PROVIDER
  // （既不能猜"可复用"，也不能让客户先重复签一次）
  if (input.targetBindingUnknown === true) {
    return {
      gate: 'WAITING_ON_PROVIDER',
      missingItemKeys,
      missingActions,
      reuseExistingAuthorization: false,
      reasonCodes: ['TARGET_BROKER_UNKNOWN'],
      nextAction: null,
      ...boundary,
    };
  }

  if (center.stages.READY_TO_FILE) {
    return {
      gate: 'READY_TO_START',
      missingItemKeys,
      missingActions,
      reuseExistingAuthorization: true,
      reasonCodes: [],
      nextAction: 'START_RECOVERY',
      ...boundary,
    };
  }

  const submission = center.items.find((item) => item.key === 'SUBMISSION_READINESS');
  if (missingItems.length === 0 && submission?.state === 'WAITING_AUTHORIZATION') {
    return {
      gate: 'WAITING_ON_PROVIDER',
      missingItemKeys,
      missingActions,
      reuseExistingAuthorization: reuse,
      reasonCodes: [],
      nextAction: null,
      ...boundary,
    };
  }

  const requiresNewAuthorization =
    missingItemKeys.includes('SIGNER_AUTHORITY') || missingItemKeys.includes('BROKER_AUTHORIZATION');
  if (requiresNewAuthorization && !reuse) {
    return {
      gate: 'REAUTHORIZATION_REQUIRED',
      missingItemKeys,
      missingActions,
      reuseExistingAuthorization: false,
      reasonCodes: customsReauthorizationReasons(input.existingAuthorization),
      nextAction: missingActions[0] ?? null,
      ...boundary,
    };
  }

  return {
    gate: 'NEEDS_AUTHORIZATION',
    missingItemKeys,
    missingActions,
    reuseExistingAuthorization: reuse,
    reasonCodes: [],
    nextAction: missingActions[0] ?? null,
    ...boundary,
  };
}

