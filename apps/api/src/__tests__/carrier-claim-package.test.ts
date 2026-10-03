/**
 * CARRIER QUEUE #9A（MSG-20261003-117 ⑱–㉜）— Claim Package Generation 回归。
 * 断言：COMPLETE→READY_FOR_MANUAL_SUBMISSION / PARTIAL→NEEDS_REVIEW、refs 与 rule version 保留、
 *       多币种分离、无 raw payload/credential、estimated 标签、零提交、deterministic、无网络。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assembleShipmentEvidence, type CarrierTermsEvidence, type ShipmentEvidenceBundle } from '../services/carriers/carrier-evidence-bundle';
import { evaluateCarrierSlaEligibility } from '../services/carriers/carrier-sla-eligibility';
import { estimateCarrierRecovery } from '../services/carriers/carrier-recovery-estimate';
import { CARRIER_CLAIM_EVIDENCE_TYPES, generateCarrierClaimPackage } from '../services/carriers/carrier-claim-package';
import type { CarrierTrackingSnapshot } from '../services/carriers/carrier-tracking-read';
import type { CarrierInvoiceFact, CarrierPODFact } from '../services/carriers/carrier-invoice-pod-read';

const NOW = new Date('2026-10-03T00:00:00.000Z');
const TRACKING = '1Z999AA10123456784';

const TRACKING_FACT: CarrierTrackingSnapshot = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  trackingNumber: TRACKING,
  shipmentStatus: 'DELIVERED',
  carrierStatusCode: 'D',
  statusText: 'Delivered',
  origin: 'US-KY',
  destination: 'US-TX',
  shipDate: '2026-09-28',
  estimatedDeliveryAt: '2026-10-01T12:00:00.000Z',
  deliveredAt: '2026-10-01T14:00:00.000Z',
  lastEventAt: '2026-10-01T14:00:00.000Z',
  lastEventLocation: 'Austin, TX',
  serviceLevel: 'GROUND',
  events: [
    { occurredAt: '2026-10-01T14:00:00.000Z', status: 'DELAYED', rawStatusCode: 'DO', description: 'Delayed', location: 'Austin, TX', source: 'PROVIDER_SCAN', eventKey: 'k2' },
  ],
  rawReference: 'sha256:track-1',
  observedAt: NOW.toISOString(),
};

const COMPLETE_INVOICE: CarrierInvoiceFact = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  invoiceReference: 'UPS-INV-1',
  invoiceDate: '2026-09-30',
  trackingNumber: TRACKING,
  shipmentReference: 'SHP-1',
  serviceLevel: 'GROUND',
  currency: 'USD',
  baseCharge: '35.00',
  fuelSurcharge: null,
  accessorialCharges: null,
  tax: '1.05',
  totalCharge: '36.05',
  billedWeight: '12.5',
  billedZone: 'Z2',
  rawChargeCodes: ['BASE', 'DUTY'],
  charges: [
    { kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' },
    { kind: 'DUTY_TAX', rawChargeCode: 'DUTY', amount: '1.05', currency: 'USD' },
  ],
  rawReference: 'sha256:inv-1',
  observedAt: NOW.toISOString(),
};

const PARTIAL_INVOICE: CarrierInvoiceFact = {
  ...COMPLETE_INVOICE,
  rawReference: 'sha256:inv-partial',
  rawChargeCodes: ['BASE', 'FUEL', 'DUTY'],
  charges: [
    { kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' },
    { kind: 'FUEL', rawChargeCode: 'FUEL', amount: '5.25', currency: 'USD' },
    { kind: 'DUTY_TAX', rawChargeCode: 'DUTY', amount: '1.05', currency: 'USD' },
  ],
};

const EUR_COMPLETE: CarrierInvoiceFact = {
  ...COMPLETE_INVOICE,
  invoiceReference: 'UPS-INV-EUR',
  currency: 'EUR',
  baseCharge: '20.00',
  tax: null,
  totalCharge: '20.00',
  rawChargeCodes: ['BASE'],
  charges: [{ kind: 'BASE', rawChargeCode: 'BASE', amount: '20.00', currency: 'EUR' }],
  rawReference: 'sha256:inv-eur',
};

const POD: CarrierPODFact = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  trackingNumber: TRACKING,
  deliveryStatus: 'DELIVERED',
  deliveredAt: '2026-10-01T14:00:00.000Z',
  deliveryLocation: 'Austin, TX',
  recipientNameMasked: 'J***',
  signed: true,
  signatureAvailable: true,
  proofType: 'SIGNATURE',
  documentReference: 'artifact:pod-1',
  rawReference: 'sha256:pod-1',
  observedAt: NOW.toISOString(),
};

const TERMS: CarrierTermsEvidence = {
  provider: 'UPS',
  source: 'RATE_CARD',
  termsReference: 'terms:ups-ground-2026',
  serviceLevel: 'GROUND',
  slaCommitmentHours: 72,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  rawReference: 'sha256:terms-1',
};

type AssemblyInput = Parameters<typeof assembleShipmentEvidence>[0];

function bundleWith(overrides: Partial<AssemblyInput> = {}): ShipmentEvidenceBundle {
  const outcome = assembleShipmentEvidence(
    { organizationId: 'org-a', tracking: TRACKING_FACT, invoices: [COMPLETE_INVOICE], pod: POD, terms: TERMS, ...overrides },
    { now: () => NOW },
  );
  if (!outcome.ok) throw new Error('expected ok, got ' + outcome.reason);
  return outcome.bundle;
}

function packageWith(overrides: Partial<AssemblyInput> = {}) {
  const bundle = bundleWith(overrides);
  const eligibility = evaluateCarrierSlaEligibility(bundle, { now: () => NOW });
  const estimation = estimateCarrierRecovery({ bundle, eligibility });
  const pkg = generateCarrierClaimPackage({ bundle, eligibility, estimation }, { now: () => NOW });
  return { bundle, eligibility, estimation, pkg };
}

describe('CARRIER QUEUE #9A — claim package generation', () => {
  it('⑳㉜ COMPLETE input → READY_FOR_MANUAL_SUBMISSION', () => {
    const { pkg } = packageWith();
    expect(pkg.packageCompleteness).toBe('COMPLETE');
    expect(pkg.packageStatus).toBe('READY_FOR_MANUAL_SUBMISSION');
    expect(pkg.blockers).toEqual([]);
  });

  it('⑳㉜ PARTIAL input → NEEDS_REVIEW 且 blockers 保留', () => {
    const { pkg } = packageWith({ invoices: [PARTIAL_INVOICE] });
    expect(pkg.packageCompleteness).toBe('PARTIAL');
    expect(pkg.packageStatus).toBe('NEEDS_REVIEW');
    expect(pkg.blockers).toContain('USD:UNKNOWN_CHARGE_ELIGIBILITY_EXCLUDED');
  });

  it('㉑㉜ eligibility / estimate refs 与 rule version 保留', () => {
    const { pkg } = packageWith();
    expect(pkg.eligibilityReference.ruleSetId).toBe('carrier-sla-eligibility');
    expect(pkg.eligibilityReference.ruleSetVersion).toBe('1.0.1');
    expect(pkg.eligibilityReference.decision).toBe('ELIGIBLE');
    expect(pkg.eligibilityReference.bundleId).toBe(pkg.bundleId);
    expect(pkg.estimateRuleSetId).toBe('carrier-recovery-estimate');
    expect(pkg.estimateRuleSetVersion).toBe('1.0.0');
    expect(pkg.claimAmountsByCurrency[0].estimateBasis).toBe('COMPLETE_RULE_BASIS');
    expect(pkg.claimAmountsByCurrency[0].estimatedRecoverableAmount).toBe('35.00');
  });

  it('㉓㉜ 多币种保持分离（claimAmountsByCurrency[]，无单一总额、无 FX）', () => {
    const { pkg } = packageWith({ invoices: [COMPLETE_INVOICE, EUR_COMPLETE] });
    expect(pkg.claimAmountsByCurrency.map((line) => line.currency)).toEqual(['EUR', 'USD']);
    expect(pkg.claimAmountsByCurrency[0].estimatedRecoverableAmount).toBe('20.00');
    expect(pkg.claimAmountsByCurrency[1].estimatedRecoverableAmount).toBe('35.00');
    const serialized = JSON.stringify(pkg);
    for (const forbidden of ['exchangeRate', 'fxRate', 'convertedAmount', 'totalAcrossCurrencies']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('㉔㉜ evidence manifest 稳定且覆盖全部类型', () => {
    const first = packageWith().pkg.evidenceManifest;
    const second = packageWith().pkg.evidenceManifest;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((item) => item.type)).toEqual([...CARRIER_CLAIM_EVIDENCE_TYPES]);
    expect(first.every((item) => item.present)).toBe(true);
    expect(first.find((item) => item.type === 'POD')?.reference).toBe('sha256:pod-1');
    expect(first.find((item) => item.type === 'TERMS')?.reference).toBe('terms:ups-ground-2026');
  });

  it('㉔㉜ 缺 required evidence → NEEDS_REVIEW + MISSING_REQUIRED_EVIDENCE', () => {
    const { pkg } = packageWith({ pod: null });
    expect(pkg.packageStatus).toBe('NEEDS_REVIEW');
    expect(pkg.blockers).toContain('MISSING_REQUIRED_EVIDENCE:POD');
  });

  it('㉔㉜ 不携带 raw payload / credential / token / inline signature', () => {
    const serialized = JSON.stringify(packageWith().pkg);
    for (const forbidden of ['accessToken', 'credential', 'credentialRef', 'signatureImage', 'rawPayload', 'recipientName']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('㉒㉜ 金额标签明确为 estimated，且无混淆性字段', () => {
    const { pkg } = packageWith();
    expect(pkg.amountLabel).toBe('ESTIMATED_RECOVERABLE');
    const serialized = JSON.stringify(pkg);
    for (const forbidden of ['amountDue', 'refundApproved', 'guaranteedRecovery']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('⑫㉜ 无 successFee / commission / collectionAmount / actualRecovered', () => {
    const serialized = JSON.stringify(packageWith().pkg);
    for (const forbidden of ['successFee', 'commission', 'collectionAmount', 'actualRecovered', 'payoutAmount']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('⑬㉜ 零提交边界（manual only / 无 transport·platformWrite·credential）', () => {
    const { pkg } = packageWith();
    expect(pkg.submissionMode).toBe('MANUAL');
    expect(pkg.packageOnly).toBe(true);
    expect(pkg.manualSubmissionRequired).toBe(true);
    expect(pkg.claimSubmissionPerformed).toBe(false);
    expect(pkg.transportEnabled).toBe(false);
    expect(pkg.platformWriteEnabled).toBe(false);
    expect(pkg.productionCredentials).toBe('ABSENT');
    expect(pkg.submissionDestination.referenceUrl).toBeNull();
  });

  it('㉙ 只能产生 NEEDS_REVIEW / READY_FOR_MANUAL_SUBMISSION（不产生 MANUALLY_SUBMITTED）', () => {
    const ready = packageWith().pkg;
    const needsReview = packageWith({ invoices: [PARTIAL_INVOICE] }).pkg;
    expect(ready.packageStatus).toBe('READY_FOR_MANUAL_SUBMISSION');
    expect(needsReview.packageStatus).toBe('NEEDS_REVIEW');
    expect(JSON.stringify([ready, needsReview])).not.toContain('MANUALLY_SUBMITTED');
  });

  it('㉗ provider template 分离（UPS → PORTAL；FEDEX → SUPPORT_CASE）', () => {
    const fedexTracking: CarrierTrackingSnapshot = { ...TRACKING_FACT, provider: 'FEDEX', externalAccountId: 'FDX-1' };
    const fedexInvoice: CarrierInvoiceFact = { ...COMPLETE_INVOICE, provider: 'FEDEX', externalAccountId: 'FDX-1' };
    const fedexPod: CarrierPODFact = { ...POD, provider: 'FEDEX', externalAccountId: 'FDX-1' };
    const fedexTerms: CarrierTermsEvidence = { ...TERMS, provider: 'FEDEX' };
    const ups = packageWith().pkg;
    expect(ups.submissionDestination.channel).toBe('PORTAL');
    const fedex = packageWith({ tracking: fedexTracking, invoices: [fedexInvoice], pod: fedexPod, terms: fedexTerms }).pkg;
    expect(fedex.provider).toBe('FEDEX');
    expect(fedex.submissionDestination.channel).toBe('SUPPORT_CASE');
    expect(fedex.submissionInstructions.some((line) => line.includes('FEDEX'))).toBe(true);
  });

  it('㉘㉜ same input → same logical package（packageId deterministic）', () => {
    const first = packageWith().pkg;
    const second = packageWith().pkg;
    expect(first.packageId).toBe(second.packageId);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.generatedAt).toBe(NOW.toISOString());
  });

  it('㉜ eligibility / estimation 不一致 → NEEDS_REVIEW（fail-closed）', () => {
    const bundle = bundleWith();
    const otherBundle = bundleWith({ invoices: [EUR_COMPLETE] });
    const eligibility = evaluateCarrierSlaEligibility(bundle, { now: () => NOW });
    const estimation = estimateCarrierRecovery({ bundle, eligibility: evaluateCarrierSlaEligibility(otherBundle, { now: () => NOW }) });
    const pkg = generateCarrierClaimPackage({ bundle, eligibility, estimation }, { now: () => NOW });
    expect(pkg.packageStatus).toBe('NEEDS_REVIEW');
    expect(pkg.blockers).toContain('ELIGIBILITY_BUNDLE_MISMATCH');
  });

  it('㉜ NOT_ELIGIBLE / INDETERMINATE → NEEDS_REVIEW（不会包装成可直接提交）', () => {
    const notEligible = packageWith({
      tracking: { ...TRACKING_FACT, deliveredAt: '2026-10-01T12:00:00.000Z' },
      pod: { ...POD, deliveredAt: '2026-10-01T12:00:00.000Z' },
    }).pkg;
    expect(notEligible.eligibilityReference.decision).toBe('NOT_ELIGIBLE');
    expect(notEligible.packageStatus).toBe('NEEDS_REVIEW');
    const indeterminate = packageWith({ pod: null }).pkg;
    expect(indeterminate.packageStatus).toBe('NEEDS_REVIEW');
  });

  it('㉜ 纯生成：不触发任何网络请求', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { pkg } = packageWith();
    expect(pkg.packageStatus).toBe('READY_FOR_MANUAL_SUBMISSION');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('㉜ 资格规则版本不一致 → ELIGIBILITY_ESTIMATION_MISMATCH', () => {
    const bundle = bundleWith();
    const eligibility = evaluateCarrierSlaEligibility(bundle, { now: () => NOW });
    const estimation = estimateCarrierRecovery({ bundle, eligibility });
    const staleEligibility = { ...eligibility, ruleSetVersion: '0.9.0' };
    const pkg = generateCarrierClaimPackage({ bundle, eligibility: staleEligibility, estimation }, { now: () => NOW });
    expect(pkg.packageStatus).toBe('NEEDS_REVIEW');
    expect(pkg.blockers).toContain('ELIGIBILITY_ESTIMATION_MISMATCH');
  });

});

afterEach(() => {
  vi.unstubAllGlobals();
});
