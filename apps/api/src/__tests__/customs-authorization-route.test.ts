/**
 * CA-1 验收（MSG-20261004-02 §三/§五/§六/§十三 A–N）：
 * route-aware 授权、三阶段 readiness、POA 生命周期、三域独立、fail-closed。
 */

import { describe, expect, it } from 'vitest';

import {
  assertAuthorizationDomainsIndependent,
  defaultPolicyForRoute,
  evaluateCustomsAuthorizationForRoute,
  resolveBrokerPoaFacts,
  type BrokerPoaRow,
  type CustomsAuthorizationFacts,
} from '../services/customs/customs-authorization-route';
import {
  evaluateCustomsAuthorizationReadiness,
  type CustomsAuthorizationFlags,
} from '../services/customs/customs-authorization-readiness';

const AT = new Date('2026-10-04T00:00:00.000Z');

const facts = (overrides: Partial<CustomsAuthorizationFacts> = {}): CustomsAuthorizationFacts => ({
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
  filingPermissionValid: true,
  providerCapabilityReady: true,
  payeeIdentityConfirmed: true,
  refundDestinationVerified: true,
  aceEnrollmentReady: true,
  ...overrides,
});

const poaRow = (overrides: Partial<BrokerPoaRow> = {}): BrokerPoaRow => ({
  id: 'poa-1',
  principalRef: 'principal-1',
  brokerRef: 'broker-1',
  jurisdiction: 'US',
  authorizationType: 'CBP_FORM_5291',
  scopeRemedies: ['*'],
  effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
  expiresAt: new Date('2027-09-01T00:00:00.000Z'),
  verificationStatus: 'VERIFIED',
  observedAt: new Date('2026-09-01T00:00:00.000Z'),
  contentDigest: 'a'.repeat(64),
  ...overrides,
});

describe('CA-1 — route-aware customs authorization（unit）', () => {
  it('A：BROKER_FILED 无 POA → READY_TO_PREPARE 成立、READY_TO_FILE=false、BROKER_POA_REQUIRED', () => {
    const result = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ brokerConnected: false, brokerPoaStatus: 'MISSING', brokerPoaSource: 'MISSING' }),
    });
    expect(result.READY_TO_PREPARE).toBe(true);
    expect(result.READY_TO_FILE).toBe(false);
    expect(result.blockers).toContain('BROKER_NOT_CONNECTED');
    expect(result.prepare.blockers).toEqual([]);
    expect(result.filingSubmitted).toBe(false);
    expect(result.externalWritePerformed).toBe(false);
    expect(result.transportEnabled).toBe(false);
    expect(result.productionCredentials).toBe('ABSENT');
  });

  it('A2：Broker 已连接但 POA 缺失 → BROKER_POA_REQUIRED', () => {
    const result = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ brokerPoaStatus: 'MISSING', brokerPoaSource: 'MISSING' }),
    });
    expect(result.READY_TO_PREPARE).toBe(true);
    expect(result.READY_TO_FILE).toBe(false);
    expect(result.file.blockers).toContain('BROKER_POA_REQUIRED');
  });

  it('B：BROKER_FILED + verified POA（scope/jurisdiction 覆盖）→ READY_TO_FILE', () => {
    const result = evaluateCustomsAuthorizationForRoute({ route: 'BROKER_FILED', remedy: 'DUTY_REFUND', facts: facts() });
    expect(result.READY_TO_PREPARE).toBe(true);
    expect(result.READY_TO_FILE).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('C：SELF_FILED 不得要求 Broker POA（要求签署权限）', () => {
    const result = evaluateCustomsAuthorizationForRoute({
      route: 'SELF_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ brokerConnected: false, brokerPoaStatus: 'MISSING', brokerPoaSource: 'MISSING' }),
    });
    expect(result.file.blockers).not.toContain('BROKER_POA_REQUIRED');
    expect(result.file.blockers).not.toContain('BROKER_NOT_CONNECTED');
    expect(result.READY_TO_FILE).toBe(true);

    const missingSigner = evaluateCustomsAuthorizationForRoute({
      route: 'SELF_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ signerStatus: 'MISSING', signerSource: 'MISSING' }),
    });
    expect(missingSigner.READY_TO_FILE).toBe(false);
    expect(missingSigner.file.blockers).toContain('SIGNER_AUTHORITY_REQUIRED');
  });

  it('D/E：撤销 / 过期 POA → READY_TO_FILE=false（NOT_USABLE）', () => {
    for (const status of ['REVOKED', 'EXPIRED'] as const) {
      const result = evaluateCustomsAuthorizationForRoute({
        route: 'BROKER_FILED',
        remedy: 'DUTY_REFUND',
        facts: facts({ brokerPoaStatus: status }),
      });
      expect(result.READY_TO_FILE).toBe(false);
      expect(result.file.blockers).toContain('BROKER_POA_NOT_USABLE');
    }
  });

  it('E2：到期由 expiresAt 派生（resolve 层）', () => {
    const resolved = resolveBrokerPoaFacts(
      [poaRow({ expiresAt: new Date('2026-10-01T00:00:00.000Z') })],
      { at: AT, remedy: 'DUTY_REFUND' },
    );
    expect(resolved.status).toBe('EXPIRED');
    const result = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ brokerPoaStatus: resolved.status }),
    });
    expect(result.READY_TO_FILE).toBe(false);
  });

  it('F：新 POA 取代旧 POA（旧 fact 不可用，新 fact 可用）', () => {
    const older = poaRow({ id: 'poa-old', observedAt: new Date('2026-08-01T00:00:00.000Z'), contentDigest: 'b'.repeat(64) });
    const newer = poaRow({ id: 'poa-new', observedAt: new Date('2026-09-20T00:00:00.000Z'), contentDigest: 'c'.repeat(64) });

    const resolved = resolveBrokerPoaFacts([older, newer], { at: AT, remedy: 'DUTY_REFUND', principalRef: 'principal-1' });
    expect(resolved.rowId).toBe('poa-new');
    expect(resolved.status).toBe('VERIFIED');
    expect(resolved.supersededById).toBe('poa-old');

    const revoked = resolveBrokerPoaFacts(
      [older, poaRow({ id: 'poa-new', observedAt: new Date('2026-09-20T00:00:00.000Z'), contentDigest: 'c'.repeat(64), verificationStatus: 'REVOKED' })],
      { at: AT, remedy: 'DUTY_REFUND', principalRef: 'principal-1' },
    );
    expect(revoked.status).toBe('REVOKED');
  });

  it('F2：latest usable 选择确定（observedAt → effectiveAt → contentDigest）', () => {
    const rows = [
      poaRow({ id: 'poa-b', observedAt: new Date('2026-09-01T00:00:00.000Z'), contentDigest: 'b'.repeat(64) }),
      poaRow({ id: 'poa-a', observedAt: new Date('2026-09-01T00:00:00.000Z'), contentDigest: 'a'.repeat(64) }),
    ];
    const first = resolveBrokerPoaFacts(rows, { at: AT, remedy: 'DUTY_REFUND' });
    const second = resolveBrokerPoaFacts([...rows].reverse(), { at: AT, remedy: 'DUTY_REFUND' });
    expect(first.rowId).toBe('poa-a');
    expect(second.rowId).toBe(first.rowId);
  });

  it('G/H：签署权限 scope 不覆盖 / 已撤销 → fail-closed', () => {
    const mismatch = evaluateCustomsAuthorizationForRoute({
      route: 'SELF_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ signerScopeCoversRemedy: false }),
    });
    expect(mismatch.READY_TO_FILE).toBe(false);
    expect(mismatch.file.blockers).toContain('SIGNER_SCOPE_MISMATCH');

    const revoked = evaluateCustomsAuthorizationForRoute({
      route: 'SELF_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ signerStatus: 'REVOKED' }),
    });
    expect(revoked.READY_TO_FILE).toBe(false);
    expect(revoked.file.blockers).toContain('SIGNER_NOT_USABLE');
  });

  it('I：退款账户未就绪 → 不阻塞 prepare，但 READY_TO_RECEIVE_REFUND=false', () => {
    const result = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ payeeIdentityConfirmed: false, refundDestinationVerified: false, aceEnrollmentReady: false }),
    });
    expect(result.READY_TO_PREPARE).toBe(true);
    expect(result.READY_TO_FILE).toBe(true);
    expect(result.READY_TO_RECEIVE_REFUND).toBe(false);
    expect(result.refund.blockers).toEqual(['PAYEE_IDENTITY_NOT_CONFIRMED', 'REFUND_DESTINATION_NOT_VERIFIED']);
  });

  it('J/M/N：三域独立——平台 OAuth / 支付授权不得满足 Broker 或签署授权', () => {
    for (const source of ['PLATFORM_OAUTH', 'PAYMENT_AUTHORIZATION'] as const) {
      const broker = evaluateCustomsAuthorizationForRoute({
        route: 'BROKER_FILED',
        remedy: 'DUTY_REFUND',
        facts: facts({ brokerPoaSource: source }),
      });
      expect(broker.READY_TO_FILE).toBe(false);
      expect(broker.file.blockers).toContain('AUTHORIZATION_SOURCE_NOT_ALLOWED');

      const signer = evaluateCustomsAuthorizationForRoute({
        route: 'SELF_FILED',
        remedy: 'DUTY_REFUND',
        facts: facts({ signerSource: source }),
      });
      expect(signer.READY_TO_FILE).toBe(false);
      expect(signer.file.blockers).toContain('AUTHORIZATION_SOURCE_NOT_ALLOWED');

      const audit = assertAuthorizationDomainsIndependent({
        brokerPoaStatus: 'VERIFIED',
        brokerPoaSource: source,
        signerStatus: 'VERIFIED',
        signerSource: source,
      });
      expect(audit.independent).toBe(false);
      expect(audit.violations).toHaveLength(2);
    }
    expect(
      assertAuthorizationDomainsIndependent({
        brokerPoaStatus: 'VERIFIED',
        brokerPoaSource: 'BROKER_POA_FACT',
        signerStatus: 'VERIFIED',
        signerSource: 'SIGNER_AUTHORITY_FACT',
      }),
    ).toEqual({ independent: true, violations: [] });
  });

  it('K（模型层）：principal 不匹配的授权 fact 不参与判定', () => {
    const resolved = resolveBrokerPoaFacts([poaRow({ principalRef: 'other-principal' })], {
      at: AT,
      remedy: 'DUTY_REFUND',
      principalRef: 'principal-1',
    });
    expect(resolved.status).toBe('MISSING');
    expect(resolved.rowId).toBeNull();
  });

  it('辖区不符：显式 policy jurisdiction 与 POA jurisdiction 不一致 → JURISDICTION_MISMATCH', () => {
    const mismatch = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ brokerPoaJurisdiction: 'DE' }),
      policy: {
        jurisdiction: 'US',
        brokerPoaRequired: true,
        authorizedSignerRequired: false,
        filingPermissionRequired: true,
        providerCapabilityRequired: true,
        refundEnrollmentRequired: false,
      },
    });
    expect(mismatch.READY_TO_FILE).toBe(false);
    expect(mismatch.file.blockers).toContain('JURISDICTION_MISMATCH');

    const wildcard = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ brokerPoaJurisdiction: null }),
    });
    expect(wildcard.READY_TO_FILE).toBe(true);
  });

  it('route 策略：SELF_FILED 不要求 POA；SERVICE_PROVIDER_TRANSMIT 无默认策略 → fail-closed', () => {
    const selfFiled = defaultPolicyForRoute('SELF_FILED', 'US');
    expect(selfFiled?.brokerPoaRequired).toBe(false);
    expect(selfFiled?.authorizedSignerRequired).toBe(true);
    const brokerFiled = defaultPolicyForRoute('BROKER_FILED', 'US');
    expect(brokerFiled?.brokerPoaRequired).toBe(true);
    expect(brokerFiled?.authorizedSignerRequired).toBe(false);
    expect(defaultPolicyForRoute('SERVICE_PROVIDER_TRANSMIT', 'US')).toBeNull();

    const providerTransmit = evaluateCustomsAuthorizationForRoute({
      route: 'SERVICE_PROVIDER_TRANSMIT',
      remedy: 'DUTY_REFUND',
      facts: facts(),
    });
    expect(providerTransmit.policyApplied).toBe(false);
    expect(providerTransmit.READY_TO_FILE).toBe(false);
    expect(providerTransmit.file.blockers).toContain('PROVIDER_POLICY_REQUIRED');
    expect(providerTransmit.READY_TO_PREPARE).toBe(true);
  });

  it('prepare 阶段：身份 / 追回权缺失 → fail-closed（不与 POA 混为一项）', () => {
    const result = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: facts({ iorConfirmed: false, recoveryRightForRemedy: false }),
    });
    expect(result.READY_TO_PREPARE).toBe(false);
    expect(result.READY_TO_FILE).toBe(false);
    expect(result.prepare.blockers).toEqual(['IOR_NOT_CONFIRMED', 'RECOVERY_RIGHT_NOT_CONFIRMED']);
  });

  it('向后兼容：C16 旧口径（BROKER_FILED 等价）blocker 词表与顺序不变', () => {
    const full: CustomsAuthorizationFlags = {
      customsAgreementSigned: true,
      importerOfRecordConfirmed: true,
      claimantConfirmed: true,
      recoveryRightConfirmed: true,
      brokerConnected: true,
      brokerAuthorizationValid: true,
      filingPermissionValid: true,
      providerCapabilityReady: true,
    };
    expect(evaluateCustomsAuthorizationReadiness(full)).toEqual({
      ready: true,
      disposition: 'READY_TO_FILE',
      blockers: [],
      filingSubmitted: false,
      externalWritePerformed: false,
      productionCredentials: 'ABSENT',
    });

    const partial = evaluateCustomsAuthorizationReadiness({
      ...full,
      brokerConnected: false,
      claimantConfirmed: false,
    });
    expect(partial.blockers).toEqual(['CLAIMANT_NOT_CONFIRMED', 'BROKER_NOT_CONNECTED']);
    expect(partial.disposition).toBe('AUTHORIZATION_INCOMPLETE');

    const flagCases: Array<[keyof CustomsAuthorizationFlags, string]> = [
      ['customsAgreementSigned', 'CUSTOMS_AGREEMENT_REQUIRED'],
      ['importerOfRecordConfirmed', 'IOR_NOT_CONFIRMED'],
      ['claimantConfirmed', 'CLAIMANT_NOT_CONFIRMED'],
      ['recoveryRightConfirmed', 'RECOVERY_RIGHT_NOT_CONFIRMED'],
      ['brokerConnected', 'BROKER_NOT_CONNECTED'],
      ['brokerAuthorizationValid', 'BROKER_POA_REQUIRED'],
      ['filingPermissionValid', 'FILING_PERMISSION_REQUIRED'],
      ['providerCapabilityReady', 'FILING_PROVIDER_NOT_READY'],
    ];
    for (const [flag, code] of flagCases) {
      const readiness = evaluateCustomsAuthorizationReadiness({ ...full, [flag]: false });
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers).toContain(code);
    }
  });
});
