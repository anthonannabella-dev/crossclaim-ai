/**
 * HOST DIRECTIVE（Carrier SLA / Dual-Path / Customs）—— Carrier Connector Capability Interface 永久回归。
 * 断言：operation 契约完整；未知 provider fail-closed；**禁止假设 Direct Claim API**；
 * submission mode 与能力一致；凭据只以引用保存；不产生任何外写。
 */

import { describe, expect, it } from 'vitest';

import {
  CARRIER_CAPABILITY_FLAGS,
  CARRIER_CONNECTOR_DESCRIPTORS,
  CARRIER_CONNECTOR_OPERATIONS,
  SUBMISSION_MODES,
  assertCarrierSubmissionModeAllowed,
  negotiateCarrierCapabilities,
  requireCarrierCapability,
  resolveCarrierConnector,
  supportsDirectClaimSubmission,
} from '../services/carriers/connector-capability';

describe('Carrier Connector Capability Interface（HOST DIRECTIVE）', () => {
  it('operation 契约与指令一致（9 项）', () => {
    expect([...CARRIER_CONNECTOR_OPERATIONS]).toEqual([
      'authorize',
      'refreshAuthorization',
      'listShipments',
      'getTracking',
      'getInvoice',
      'getPOD',
      'prepareClaim',
      'submitClaim',
      'getClaimStatus',
    ]);
  });

  it('Submission Mode 只有三种登记模式', () => {
    expect([...SUBMISSION_MODES]).toEqual(['DIRECT_API', 'PORTAL_DEEPLINK', 'CLAIM_READY_PACKAGE']);
  });

  it('UPS / FedEx 均已登记，但 auth model 不同（不得假定流程相同）', () => {
    expect(resolveCarrierConnector('UPS')?.authModel).toBe('OAUTH_AUTH_CODE');
    expect(resolveCarrierConnector('FEDEX')?.authModel).toBe('INTEGRATOR_CREDENTIAL_REGISTRATION');
    expect(resolveCarrierConnector('ups')?.provider).toBe('UPS');
    expect(resolveCarrierConnector('DHL')).toBeNull();
  });

  it('unknown provider → fail-closed（resolve null；negotiate / require / assert 抛错）', () => {
    expect(resolveCarrierConnector('NOT_A_CARRIER')).toBeNull();
    expect(() => negotiateCarrierCapabilities('NOT_A_CARRIER')).toThrow('CARRIER_PROVIDER_UNKNOWN');
    expect(() => requireCarrierCapability('NOT_A_CARRIER', 'supportsTrackingRead')).toThrow('CARRIER_PROVIDER_UNKNOWN');
    expect(() => assertCarrierSubmissionModeAllowed('NOT_A_CARRIER', 'CLAIM_READY_PACKAGE')).toThrow(
      'CARRIER_PROVIDER_UNKNOWN',
    );
  });

  it('禁止假设 Direct Claim API：UPS / FedEx direct submission 恒 false 且不在 submissionModes 中', () => {
    for (const descriptor of CARRIER_CONNECTOR_DESCRIPTORS) {
      expect(descriptor.capabilities.supportsDirectClaimSubmission).toBe(false);
      expect(descriptor.capabilityAudit.supportsDirectClaimSubmission.audited).toBe(false);
      expect(descriptor.submissionModes).not.toContain('DIRECT_API');
      expect(supportsDirectClaimSubmission(descriptor.provider)).toBe(false);
      expect(() => requireCarrierCapability(descriptor.provider, 'supportsDirectClaimSubmission')).toThrow(
        'CAPABILITY_NOT_SUPPORTED',
      );
    }
  });

  it('submission mode 守护：CLAIM_READY_PACKAGE / PORTAL_DEEPLINK 允许；DIRECT_API 拒绝', () => {
    for (const provider of ['UPS', 'FEDEX']) {
      expect(() => assertCarrierSubmissionModeAllowed(provider, 'CLAIM_READY_PACKAGE')).not.toThrow();
      expect(() => assertCarrierSubmissionModeAllowed(provider, 'PORTAL_DEEPLINK')).not.toThrow();
      expect(() => assertCarrierSubmissionModeAllowed(provider, 'DIRECT_API')).toThrow(
        'SUBMISSION_MODE_NOT_SUPPORTED',
      );
    }
  });

  it('已声明能力可 require；未声明能力 fail-closed', () => {
    expect(() => requireCarrierCapability('UPS', 'supportsTrackingRead')).not.toThrow();
    expect(() => requireCarrierCapability('UPS', 'supportsInvoiceRead')).not.toThrow();
    expect(() => requireCarrierCapability('UPS', 'supportsPODRead')).not.toThrow();
    expect(() => requireCarrierCapability('UPS', 'supportsClaimStatusRead')).toThrow('CAPABILITY_NOT_SUPPORTED');
  });

  it('协商结果：capability 标志齐全、readiness 恒 EXTERNAL_GATE、无外写能力', () => {
    for (const provider of ['UPS', 'FEDEX']) {
      const negotiation = negotiateCarrierCapabilities(provider);
      expect(Object.keys(negotiation.capabilities).sort()).toEqual([...CARRIER_CAPABILITY_FLAGS].sort());
      expect(negotiation.readiness).toBe('EXTERNAL_GATE');
      expect(negotiation.directSubmissionAllowed).toBe(false);
      const descriptor = resolveCarrierConnector(provider)!;
      expect(descriptor.credentialReferenceOnly).toBe(true);
      expect(descriptor.platformWriteEnabled).toBe(false);
      expect(descriptor.multiAccountPerCustomer).toBe(true);
      expect(descriptor.requiredHostActions.length).toBeGreaterThan(0);
    }
  });
});
