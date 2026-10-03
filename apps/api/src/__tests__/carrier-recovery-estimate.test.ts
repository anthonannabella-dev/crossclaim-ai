/**
 * CARRIER QUEUE #8（MSG-20261003-115 ⑯–㉝）— Recovery Amount Estimation + Claim-Ready Package Input 回归。
 * 断言：只有 ELIGIBLE 才产生金额、INDETERMINATE/NOT_ELIGIBLE → null（不用 0.00 冒充）、金额来自 explicit eligible charge basis、
 *       多币种不合并、无 successFee/commission/actualRecovered、claim-ready 只是输入而非提交 payload、无网络。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assembleShipmentEvidence, type CarrierTermsEvidence, type ShipmentEvidenceBundle } from '../services/carriers/carrier-evidence-bundle';
import { evaluateCarrierSlaEligibility, type CarrierSlaEligibilityEvaluation } from '../services/carriers/carrier-sla-eligibility';
import { CARRIER_ESTIMATE_RULE_SET_ID, CARRIER_ESTIMATE_RULE_SET_VERSION, estimateCarrierRecovery } from '../services/carriers/carrier-recovery-estimate';
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

const INVOICE: CarrierInvoiceFact = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  invoiceReference: 'UPS-INV-1',
  invoiceDate: '2026-09-30',
  trackingNumber: TRACKING,
  shipmentReference: 'SHP-1',
  serviceLevel: 'GROUND',
  currency: 'USD',
  baseCharge: '35.00',
  fuelSurcharge: '5.25',
  accessorialCharges: null,
  tax: '1.05',
  totalCharge: '41.30',
  billedWeight: '12.5',
  billedZone: 'Z2',
  rawChargeCodes: ['BASE', 'FUEL', 'DUTY'],
  charges: [
    { kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' },
    { kind: 'FUEL', rawChargeCode: 'FUEL', amount: '5.25', currency: 'USD' },
    { kind: 'DUTY_TAX', rawChargeCode: 'DUTY', amount: '1.05', currency: 'USD' },
  ],
  rawReference: 'sha256:inv-1',
  observedAt: NOW.toISOString(),
};

const EUR_INVOICE: CarrierInvoiceFact = {
  ...INVOICE,
  invoiceReference: 'UPS-INV-EUR',
  currency: 'EUR',
  baseCharge: '20.00',
  fuelSurcharge: null,
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
    { organizationId: 'org-a', tracking: TRACKING_FACT, invoices: [INVOICE], pod: POD, terms: TERMS, ...overrides },
    { now: () => NOW },
  );
  if (!outcome.ok) throw new Error('expected ok, got ' + outcome.reason);
  return outcome.bundle;
}

function eligibilityFor(bundle: ShipmentEvidenceBundle): CarrierSlaEligibilityEvaluation {
  return evaluateCarrierSlaEligibility(bundle, { now: () => NOW });
}

function estimateWith(overrides: Partial<AssemblyInput> = {}) {
  const bundle = bundleWith(overrides);
  return { bundle, estimation: estimateCarrierRecovery({ bundle, eligibility: eligibilityFor(bundle) }) };
}

describe('CARRIER QUEUE #8 — recovery amount estimation', () => {
  it('㉚ ELIGIBLE + single USD invoice → deterministic estimate（只含 BASE 35.00）', () => {
    const { estimation } = estimateWith();
    expect(estimation.eligibilityDecision).toBe('ELIGIBLE');
    expect(estimation.estimatesByCurrency).toHaveLength(1);
    const usd = estimation.estimatesByCurrency[0];
    expect(usd.currency).toBe('USD');
    expect(usd.status).toBe('ESTIMATED');
    expect(usd.estimatedRecoverableAmount).toBe('35.00');
    expect(usd.estimateBasis).toBe('PARTIAL_PROVIDER_RULE_BASIS');
  });

  it('㉚ same input twice → same estimate（deterministic）', () => {
    const first = estimateWith().estimation;
    const second = estimateWith().estimation;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('⑲㉚ NOT_ELIGIBLE → 无金额（null，不用 0.00）', () => {
    const { estimation } = estimateWith({
      tracking: { ...TRACKING_FACT, deliveredAt: '2026-10-01T12:00:00.000Z' },
      pod: { ...POD, deliveredAt: '2026-10-01T12:00:00.000Z' },
    });
    expect(estimation.eligibilityDecision).toBe('NOT_ELIGIBLE');
    expect(estimation.estimatesByCurrency[0].status).toBe('NOT_ELIGIBLE');
    expect(estimation.estimatesByCurrency[0].estimatedRecoverableAmount).toBeNull();
    expect(JSON.stringify(estimation.estimatesByCurrency[0])).not.toContain('0.00');
  });

  it('⑱㉚ INDETERMINATE → BLOCKED_INDETERMINATE + null + blockers（不猜金额）', () => {
    const { estimation } = estimateWith({ pod: null });
    expect(estimation.eligibilityDecision).toBe('INDETERMINATE');
    expect(estimation.estimatesByCurrency[0].status).toBe('BLOCKED_INDETERMINATE');
    expect(estimation.estimatesByCurrency[0].estimatedRecoverableAmount).toBeNull();
    expect(estimation.estimatesByCurrency[0].blockers).toContain('ELIGIBILITY_INDETERMINATE');
    expect(estimation.estimatesByCurrency[0].blockers.length).toBeGreaterThan(1);
  });

  it('㉚ missing invoice → no estimate', () => {
    const { estimation } = estimateWith({ invoices: [] });
    expect(estimation.estimatesByCurrency).toEqual([]);
    expect(estimation.claimReadyPackageInput.blockers).toContain('INVOICE_EVIDENCE_MISSING');
    expect(estimation.claimReadyPackageInput.packageCompleteness).toBe('PARTIAL');
  });

  it('㉒㉚ multi-currency → separate estimates，绝不跨币种合并', () => {
    const { estimation } = estimateWith({ invoices: [INVOICE, EUR_INVOICE] });
    expect(estimation.estimatesByCurrency).toHaveLength(2);
    expect(estimation.estimatesByCurrency.map((entry) => entry.currency)).toEqual(['EUR', 'USD']);
    expect(estimation.estimatesByCurrency[0].estimatedRecoverableAmount).toBe('20.00');
    expect(estimation.estimatesByCurrency[1].estimatedRecoverableAmount).toBe('35.00');
  });

  it('㉓㉚ included / excluded charge list 显式且保守', () => {
    const usd = estimateWith().estimation.estimatesByCurrency[0];
    expect(usd.includedCharges.map((entry) => entry.kind)).toEqual(['BASE']);
    expect(usd.includedCharges[0].eligibility).toBe('INCLUDED');
    expect(usd.excludedCharges.map((entry) => entry.kind)).toEqual(['FUEL', 'DUTY_TAX']);
    // FUEL：provider-rule dependent → UNKNOWN（保守排除，不猜）
    const fuel = usd.excludedCharges.find((entry) => entry.kind === 'FUEL');
    expect(fuel?.eligibility).toBe('UNKNOWN');
    expect(fuel?.reasonCode).toBe('PROVIDER_RULE_DEPENDENT_UNKNOWN');
    // tax/duty 不得被静默计入
    const duty = usd.excludedCharges.find((entry) => entry.kind === 'DUTY_TAX');
    expect(duty?.eligibility).toBe('EXCLUDED_FROM_CARRIER_SLA_ESTIMATE');
    expect(duty?.included).toBe(false);
  });

  it('㉓ 全部 charge 可判定（无 UNKNOWN）→ COMPLETE_RULE_BASIS', () => {
    const bare: CarrierInvoiceFact = {
      ...INVOICE,
      charges: [
        { kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' },
        { kind: 'DUTY_TAX', rawChargeCode: 'DUTY', amount: '1.05', currency: 'USD' },
      ],
    };
    const { estimation } = estimateWith({ invoices: [bare] });
    const usd = estimation.estimatesByCurrency[0];
    expect(usd.status).toBe('ESTIMATED');
    expect(usd.estimateBasis).toBe('COMPLETE_RULE_BASIS');
    expect(usd.estimatedRecoverableAmount).toBe('35.00');
  });

  it('㉑㉚ 无 explicit eligible charge basis → MISSING_AMOUNT_BASIS（绝不用 0.00 冒充）', () => {
    const noCharges: CarrierInvoiceFact = { ...INVOICE, charges: [] };
    const { estimation } = estimateWith({ invoices: [noCharges] });
    const usd = estimation.estimatesByCurrency[0];
    expect(usd.status).toBe('MISSING_AMOUNT_BASIS');
    expect(usd.estimatedRecoverableAmount).toBeNull();
    expect(usd.blockers).toContain('NO_CHARGE_RECORDS');
  });

  it('㉔㉚ estimate rule version + eligibility rule version 均携带', () => {
    const { estimation } = estimateWith();
    expect(estimation.estimateRuleSetId).toBe(CARRIER_ESTIMATE_RULE_SET_ID);
    expect(estimation.estimateRuleSetVersion).toBe(CARRIER_ESTIMATE_RULE_SET_VERSION);
    expect(estimation.eligibilityRuleSetId).toBe('carrier-sla-eligibility');
    expect(estimation.eligibilityRuleSetVersion).toBe('1.0.1');
  });

  it('㉕㉚ claim-ready package 引用 estimate 与 eligibility，且 evidence refs 保留', () => {
    const { estimation } = estimateWith();
    const pkg = estimation.claimReadyPackageInput;
    expect(pkg.eligibilityEvaluationReference.bundleId).toBe(estimation.bundleId);
    expect(pkg.eligibilityEvaluationReference.decision).toBe('ELIGIBLE');
    expect(pkg.amountEstimateReferences).toHaveLength(1);
    expect(pkg.amountEstimateReferences[0].estimatedRecoverableAmount).toBe('35.00');
    expect(pkg.eligibleChargeReferences.map((entry) => entry.kind)).toEqual(['BASE']);
    expect(pkg.termsReference).toBe('terms:ups-ground-2026');
    expect(pkg.trackingEvidenceReference).toBe('sha256:track-1');
    expect(pkg.invoiceEvidenceReferences).toContain('sha256:inv-1');
    expect(pkg.podReference).toBe('sha256:pod-1');
    // MSG-116 ⑲：本 fixture 含 FUEL(UNKNOWN) → basis 为 PARTIAL_PROVIDER_RULE_BASIS，package 必须 PARTIAL
    expect(pkg.packageCompleteness).toBe('PARTIAL');
  });

  it('㉕㉚ package 不含 credential / raw payload / signature image', () => {
    const { estimation } = estimateWith();
    const serialized = JSON.stringify(estimation.claimReadyPackageInput);
    for (const forbidden of ['credential', 'credentialRef', 'accessToken', 'signatureImage', 'rawPayload', 'recipientName']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('㉗㉘㉚ 无 successFee / commission / collectionAmount / actualRecovered', () => {
    const { estimation } = estimateWith();
    const serialized = JSON.stringify(estimation);
    for (const forbidden of ['successFee', 'commission', 'collectionAmount', 'actualRecovered', 'payoutAmount']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('㉖㉚ 仍是 estimate-only / 零提交 / 无 network', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { estimation } = estimateWith();
    expect(estimation.estimateOnly).toBe(true);
    expect(estimation.claimSubmissionPerformed).toBe(false);
    expect(estimation.transportEnabled).toBe(false);
    expect(estimation.platformWriteEnabled).toBe(false);
    expect(estimation.productionCredentials).toBe('ABSENT');
    expect(estimation.claimReadyPackageInput.packageOnly).toBe(true);
    expect(estimation.claimReadyPackageInput.claimSubmissionPerformed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bundle / eligibility 不匹配 → fail-closed（不产生任何 estimate）', () => {
    const { bundle } = estimateWith();
    const otherBundle = bundleWith({ invoices: [EUR_INVOICE] });
    const estimation = estimateCarrierRecovery({ bundle, eligibility: eligibilityFor(otherBundle) });
    expect(estimation.estimatesByCurrency).toEqual([]);
    expect(estimation.claimReadyPackageInput.blockers).toContain('ELIGIBILITY_BUNDLE_MISMATCH');
    expect(estimation.claimReadyPackageInput.packageCompleteness).toBe('PARTIAL');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CARRIER QUEUE #8 FINAL — CLAIM-READY PACKAGE COMPLETENESS SEMANTICS（MSG-20261003-116 ⑱–㉔）', () => {
  const BASE_AND_DUTY: CarrierInvoiceFact = {
    ...INVOICE,
    charges: [
      { kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' },
      { kind: 'DUTY_TAX', rawChargeCode: 'DUTY', amount: '1.05', currency: 'USD' },
    ],
  };
  const EUR_COMPLETE: CarrierInvoiceFact = {
    ...EUR_INVOICE,
    charges: [
      { kind: 'BASE', rawChargeCode: 'BASE', amount: '20.00', currency: 'EUR' },
      { kind: 'DUTY_TAX', rawChargeCode: 'DUTY', amount: '1.00', currency: 'EUR' },
    ],
  };
  const EUR_PARTIAL: CarrierInvoiceFact = {
    ...EUR_INVOICE,
    charges: [
      { kind: 'BASE', rawChargeCode: 'BASE', amount: '20.00', currency: 'EUR' },
      { kind: 'FUEL', rawChargeCode: 'FUEL', amount: '2.00', currency: 'EUR' },
    ],
  };

  it('⑱㉒㉔ ELIGIBLE + BASE/DUTY only → COMPLETE_RULE_BASIS 且 package COMPLETE', () => {
    const { estimation } = estimateWith({ invoices: [BASE_AND_DUTY] });
    const usd = estimation.estimatesByCurrency[0];
    expect(usd.status).toBe('ESTIMATED');
    expect(usd.estimateBasis).toBe('COMPLETE_RULE_BASIS');
    expect(usd.blockers).toEqual([]);
    expect(estimation.claimReadyPackageInput.packageCompleteness).toBe('COMPLETE');
    expect(estimation.claimReadyPackageInput.blockers).toEqual([]);
  });

  it('⑲㉔ BASE + FUEL(UNKNOWN) → estimate 仍 ESTIMATED，但 package PARTIAL 且 blocker 透传', () => {
    const { estimation } = estimateWith();
    const usd = estimation.estimatesByCurrency[0];
    expect(usd.status).toBe('ESTIMATED');
    expect(usd.estimateBasis).toBe('PARTIAL_PROVIDER_RULE_BASIS');
    expect(estimation.claimReadyPackageInput.packageCompleteness).toBe('PARTIAL');
    expect(estimation.claimReadyPackageInput.blockers).toContain('USD:UNKNOWN_CHARGE_ELIGIBILITY_EXCLUDED');
  });

  it('⑳ invariant：package COMPLETE → blockers 必须为空', () => {
    const complete = estimateWith({ invoices: [BASE_AND_DUTY] }).estimation.claimReadyPackageInput;
    expect(complete.packageCompleteness).toBe('COMPLETE');
    expect(complete.blockers).toEqual([]);
    const partial = estimateWith().estimation.claimReadyPackageInput;
    expect(partial.packageCompleteness).toBe('PARTIAL');
    expect(partial.blockers.length).toBeGreaterThan(0);
  });

  it('㉑ PARTIAL_PROVIDER_RULE_BASIS 不得被改判成 MISSING_AMOUNT_BASIS', () => {
    const usd = estimateWith().estimation.estimatesByCurrency[0];
    expect(usd.status).not.toBe('MISSING_AMOUNT_BASIS');
    expect(usd.estimatedRecoverableAmount).toBe('35.00');
  });

  it('㉓㉔ 多币种：一个 complete + 一个 partial → package PARTIAL', () => {
    const { estimation } = estimateWith({ invoices: [BASE_AND_DUTY, EUR_PARTIAL] });
    expect(estimation.estimatesByCurrency.map((entry) => entry.currency)).toEqual(['EUR', 'USD']);
    expect(estimation.estimatesByCurrency[0].estimateBasis).toBe('PARTIAL_PROVIDER_RULE_BASIS');
    expect(estimation.estimatesByCurrency[1].estimateBasis).toBe('COMPLETE_RULE_BASIS');
    expect(estimation.claimReadyPackageInput.packageCompleteness).toBe('PARTIAL');
  });

  it('㉓㉔ 多币种：全部 complete → package COMPLETE', () => {
    const { estimation } = estimateWith({ invoices: [BASE_AND_DUTY, EUR_COMPLETE] });
    expect(estimation.estimatesByCurrency.every((entry) => entry.estimateBasis === 'COMPLETE_RULE_BASIS')).toBe(true);
    expect(estimation.claimReadyPackageInput.packageCompleteness).toBe('COMPLETE');
    expect(estimation.claimReadyPackageInput.blockers).toEqual([]);
  });

  it('㉔ NOT_ELIGIBLE / INDETERMINATE / MISSING_AMOUNT_BASIS 均保持 PARTIAL 且无金额', () => {
    const notEligible = estimateWith({
      tracking: { ...TRACKING_FACT, deliveredAt: '2026-10-01T12:00:00.000Z' },
      pod: { ...POD, deliveredAt: '2026-10-01T12:00:00.000Z' },
    }).estimation;
    expect(notEligible.claimReadyPackageInput.packageCompleteness).toBe('PARTIAL');
    expect(notEligible.estimatesByCurrency[0].estimatedRecoverableAmount).toBeNull();
    const indeterminate = estimateWith({ pod: null }).estimation;
    expect(indeterminate.claimReadyPackageInput.packageCompleteness).toBe('PARTIAL');
    expect(indeterminate.estimatesByCurrency[0].estimatedRecoverableAmount).toBeNull();
    const missing = estimateWith({ invoices: [{ ...INVOICE, charges: [] }] }).estimation;
    expect(missing.claimReadyPackageInput.packageCompleteness).toBe('PARTIAL');
    expect(missing.estimatesByCurrency[0].estimatedRecoverableAmount).toBeNull();
  });

  it('㉔ deterministic（含 completeness 语义）', () => {
    expect(JSON.stringify(estimateWith().estimation)).toBe(JSON.stringify(estimateWith().estimation));
    const first = estimateWith({ invoices: [BASE_AND_DUTY] }).estimation;
    const second = estimateWith({ invoices: [BASE_AND_DUTY] }).estimation;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.claimReadyPackageInput.packageCompleteness).toBe('COMPLETE');
  });
});
