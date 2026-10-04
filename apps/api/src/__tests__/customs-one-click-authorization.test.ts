/** CA-6 单元验收：一键追回授权计划（只列缺失项 / 既有授权复用 / 重签原因 / 等待 provider）。 */

import { describe, expect, it } from 'vitest';

import {
  customsReauthorizationReasons,
  planCustomsOneClickAuthorization,
  type CustomsExistingAuthorizationSnapshot,
} from '../services/customs/customs-one-click-authorization';
import { buildCustomsAuthorizationCenter } from '../services/customs/customs-authorization-center';
import {
  evaluateCustomsAuthorizationForRoute,
  type CustomsAuthorizationFacts,
  type CustomsAuthorizationPolicy,
  type CustomsFilingRoute,
} from '../services/customs/customs-authorization-route';

const baseFacts: CustomsAuthorizationFacts = {
  customsAgreementSigned: true,
  iorConfirmed: true,
  claimantConfirmed: true,
  recoveryRightForRemedy: true,
  brokerConnected: true,
  brokerPoaStatus: 'VERIFIED',
  brokerPoaScopeCoversRemedy: true,
  brokerPoaJurisdiction: 'US',
  brokerPoaSource: 'BROKER_POA_FACT',
  signerStatus: 'VERIFIED',
  signerScopeCoversRemedy: true,
  signerSource: 'SIGNER_AUTHORITY_FACT',
  signerJurisdiction: 'US',
  filingPermissionValid: true,
  providerCapabilityReady: true,
  payeeIdentityConfirmed: true,
  refundDestinationVerified: true,
  aceEnrollmentReady: true,
};

const selfFiledPolicy: CustomsAuthorizationPolicy = {
  jurisdiction: 'US',
  brokerPoaRequired: false,
  authorizedSignerRequired: true,
  filingPermissionRequired: true,
  providerCapabilityRequired: true,
  refundEnrollmentRequired: false,
};

function center(
  overrides: Partial<CustomsAuthorizationFacts> = {},
  route: CustomsFilingRoute = 'BROKER_FILED',
  policy?: CustomsAuthorizationPolicy,
) {
  return buildCustomsAuthorizationCenter({
    readiness: evaluateCustomsAuthorizationForRoute({
      route,
      remedy: 'DUTY_REFUND',
      facts: { ...baseFacts, ...overrides },
      ...(policy ? { policy } : {}),
    }),
  });
}

const usableExisting: CustomsExistingAuthorizationSnapshot = {
  subject: 'BROKER_POA',
  status: 'VERIFIED',
  scopeCoversRequested: true,
  jurisdictionMatches: true,
  routeMatches: true,
  samePrincipal: true,
  sameBrokerOrSigner: true,
};

describe('CA-6 — one-click customs recovery authorization plan（unit）', () => {
  it('六项齐备 → READY_TO_START + START_RECOVERY（无需任何签署）', () => {
    const plan = planCustomsOneClickAuthorization({ center: center() });
    expect(plan.gate).toBe('READY_TO_START');
    expect(plan.nextAction).toBe('START_RECOVERY');
    expect(plan.missingItemKeys).toEqual([]);
    expect(plan.reasonCodes).toEqual([]);
    expect(plan.reuseExistingAuthorization).toBe(true);
    expect(plan.filingSubmitted).toBe(false);
    expect(plan.transportEnabled).toBe(false);
    expect(plan.productionCredentials).toBe('ABSENT');
  });

  it('缺代理授权且无既有授权 → REAUTHORIZATION_REQUIRED（NO_EXISTING_AUTHORIZATION）', () => {
    const plan = planCustomsOneClickAuthorization({
      center: center({ brokerConnected: false, brokerPoaStatus: 'MISSING' }),
      existingAuthorization: null,
    });
    expect(plan.gate).toBe('REAUTHORIZATION_REQUIRED');
    expect(plan.missingItemKeys).toContain('BROKER_AUTHORIZATION');
    expect(plan.missingActions).toContain('COMPLETE_BROKER_AUTHORIZATION');
    expect(plan.reasonCodes).toEqual(['NO_EXISTING_AUTHORIZATION']);
    expect(plan.nextAction).toBe('COMPLETE_BROKER_AUTHORIZATION');
  });

  it('既有授权可复用：同一 POA 不因新单重复签署（只补其它缺失项）', () => {
    const plan = planCustomsOneClickAuthorization({
      center: center({ refundDestinationVerified: false }),
      existingAuthorization: usableExisting,
    });
    expect(plan.reuseExistingAuthorization).toBe(true);
    expect(plan.reasonCodes).toEqual([]);
    expect(plan.missingItemKeys).toEqual(['REFUND_ACCOUNT']);
    expect(plan.missingItemKeys).not.toContain('BROKER_AUTHORIZATION');
  });

  it('重签原因逐条可辨：expired / revoked / superseded / broker / legal entity / route / jurisdiction / scope / provider renewal', () => {
    const base = usableExisting;
    expect(customsReauthorizationReasons({ ...base, status: 'EXPIRED' })).toEqual(['AUTHORIZATION_EXPIRED']);
    expect(customsReauthorizationReasons({ ...base, status: 'REVOKED' })).toEqual(['AUTHORIZATION_REVOKED']);
    expect(customsReauthorizationReasons({ ...base, status: 'SUPERSEDED' })).toEqual(['AUTHORIZATION_SUPERSEDED']);
    expect(customsReauthorizationReasons({ ...base, sameBrokerOrSigner: false })).toEqual(['BROKER_CHANGED']);
    expect(customsReauthorizationReasons({ ...base, samePrincipal: false })).toEqual(['LEGAL_ENTITY_CHANGED']);
    expect(customsReauthorizationReasons({ ...base, routeMatches: false })).toEqual(['ROUTE_CHANGED']);
    expect(customsReauthorizationReasons({ ...base, jurisdictionMatches: false })).toEqual(['JURISDICTION_CHANGED']);
    expect(customsReauthorizationReasons({ ...base, scopeCoversRequested: false })).toEqual(['SCOPE_MISMATCH']);
    expect(customsReauthorizationReasons({ ...base, providerRenewalRequired: true })).toEqual([
      'PROVIDER_RENEWAL_REQUIRED',
    ]);
  });

  it('route 变更 / scope 不覆盖 → 即使 VERIFIED 也必须重签', () => {
    const routeChanged = planCustomsOneClickAuthorization({
      center: center({ brokerConnected: false, brokerPoaStatus: 'MISSING' }),
      existingAuthorization: { ...usableExisting, routeMatches: false },
    });
    expect(routeChanged.gate).toBe('REAUTHORIZATION_REQUIRED');
    expect(routeChanged.reasonCodes).toContain('ROUTE_CHANGED');

    const scopeMismatch = planCustomsOneClickAuthorization({
      center: center({ brokerPoaScopeCoversRemedy: false }),
      existingAuthorization: { ...usableExisting, scopeCoversRequested: false },
    });
    expect(scopeMismatch.gate).toBe('REAUTHORIZATION_REQUIRED');
    expect(scopeMismatch.reasonCodes).toContain('SCOPE_MISMATCH');
  });

  it('SELF_FILED 缺申报权限 → 走 ③ 签署权限（不是 ④ 代理授权）', () => {
    const plan = planCustomsOneClickAuthorization({
      center: center({ filingPermissionValid: false }, 'SELF_FILED', selfFiledPolicy),
      existingAuthorization: null,
    });
    expect(plan.missingItemKeys).toContain('SIGNER_AUTHORITY');
    expect(plan.missingItemKeys).not.toContain('BROKER_AUTHORIZATION');
    expect(plan.nextAction).toBe('CONFIRM_SIGNING_AUTHORITY');
  });

  it('客户侧齐备但 provider/authority 侧未就绪 → WAITING_ON_PROVIDER（无需签署）', () => {
    const plan = planCustomsOneClickAuthorization({
      center: center({ providerCapabilityReady: false }),
      existingAuthorization: usableExisting,
    });
    expect(plan.gate).toBe('WAITING_ON_PROVIDER');
    expect(plan.nextAction).toBeNull();
    expect(plan.reuseExistingAuthorization).toBe(true);
  });

  it('既有授权 PENDING → 归 NEEDS_AUTHORIZATION（不误判为已完成，也不重复签署新 POA）', () => {
    const plan = planCustomsOneClickAuthorization({
      center: center({ brokerConnected: false, brokerPoaStatus: 'MISSING' }),
      existingAuthorization: { ...usableExisting, status: 'PENDING' },
    });
    expect(plan.gate).toBe('REAUTHORIZATION_REQUIRED');
    expect(plan.reasonCodes).toEqual(['AUTHORIZATION_PENDING']);
  });

  it('REVISE：目标 broker/signer 未由 server truth 绑定时 fail-closed 到 WAITING_ON_PROVIDER', () => {
    const plan = planCustomsOneClickAuthorization({
      center: center(),
      existingAuthorization: usableExisting,
      targetBindingUnknown: true,
    });
    expect(plan.gate).toBe('WAITING_ON_PROVIDER');
    expect(plan.nextAction).toBeNull();
    expect(plan.reuseExistingAuthorization).toBe(false);
    expect(plan.reasonCodes).toEqual(['TARGET_BROKER_UNKNOWN']);
  });
});
