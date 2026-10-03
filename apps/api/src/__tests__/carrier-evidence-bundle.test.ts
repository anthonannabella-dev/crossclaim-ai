/**
 * CARRIER QUEUE #6（MSG-20261003-111 ⑤）— ShipmentEvidenceBundle 装配回归。
 * 断言：证据装配、completeness/gap、跨平面身份一致、金额按币种分组、无判定字段、无真实请求、read-only 边界。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assembleShipmentEvidence, type CarrierTermsEvidence } from '../services/carriers/carrier-evidence-bundle';
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
    { occurredAt: '2026-09-28T10:00:00.000Z', status: 'LABEL_CREATED', rawStatusCode: 'M', description: 'Label created', location: 'Louisville, KY', source: 'PROVIDER_API', eventKey: 'k1' },
    { occurredAt: '2026-10-01T14:00:00.000Z', status: 'DELAYED', rawStatusCode: 'DO', description: 'Delayed', location: 'Austin, TX', source: 'PROVIDER_SCAN', eventKey: 'k2' },
    { occurredAt: '2026-10-01T15:00:00.000Z', status: 'DELIVERED', rawStatusCode: 'D', description: 'Delivered', location: 'Austin, TX', source: 'PROVIDER_API', eventKey: 'k3' },
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
  accessorialCharges: '1.05',
  tax: null,
  totalCharge: '41.30',
  billedWeight: '12.5',
  billedZone: 'Z2',
  rawChargeCodes: ['BASE', 'FUEL', 'RES', 'MYSTERY-CODE'],
  charges: [
    { kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' },
    { kind: 'FUEL', rawChargeCode: 'FUEL', amount: '5.25', currency: 'USD' },
  ],
  rawReference: 'sha256:inv-1',
  observedAt: NOW.toISOString(),
};

const SECOND_INVOICE: CarrierInvoiceFact = {
  ...INVOICE,
  invoiceReference: 'UPS-INV-2',
  totalCharge: '10.20',
  rawReference: 'sha256:inv-2',
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

function assemble(overrides: Parameters<typeof assembleShipmentEvidence>[0] extends never ? never : Partial<Parameters<typeof assembleShipmentEvidence>[0]> = {}) {
  return assembleShipmentEvidence(
    { organizationId: 'org-a', tracking: TRACKING_FACT, invoices: [INVOICE], pod: POD, terms: TERMS, ...overrides },
    { now: () => NOW },
  );
}

describe('CARRIER QUEUE #6 — evidence assembly', () => {
  it('完整证据 → COMPLETE（无 gap）且明确 evidenceOnly / adjudicationPerformed=false', () => {
    const outcome = assemble();
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.completeness).toBe('COMPLETE');
    expect(outcome.bundle.missingEvidence).toEqual([]);
    expect(outcome.bundle.evidenceOnly).toBe(true);
    expect(outcome.bundle.adjudicationPerformed).toBe(false);
    expect(outcome.bundle.readOnly).toBe(true);
    expect(outcome.bundle.transportEnabled).toBe(false);
    expect(outcome.bundle.platformWriteEnabled).toBe(false);
    expect(outcome.bundle.productionCredentials).toBe('ABSENT');
    expect(outcome.bundle.organizationId).toBe('org-a');
  });

  it('缺 POD / INVOICE / TERMS 时 → PARTIAL 并列出对应 gap（不失败）', () => {
    const noPod = assemble({ pod: null });
    if (!noPod.ok) throw new Error('expected ok');
    expect(noPod.bundle.completeness).toBe('PARTIAL');
    expect(noPod.bundle.missingEvidence).toContain('POD_FACT');
    const noInvoice = assemble({ invoices: [] });
    if (!noInvoice.ok) throw new Error('expected ok');
    expect(noInvoice.bundle.missingEvidence).toContain('INVOICE_FACT');
    const noTerms = assemble({ terms: null });
    if (!noTerms.ok) throw new Error('expected ok');
    expect(noTerms.bundle.missingEvidence).toContain('CARRIER_TERMS');
  });

  it('缺 tracking fact / tenant context → fail-closed', () => {
    const noTracking = assembleShipmentEvidence({ organizationId: 'org-a', tracking: null });
    expect(noTracking.ok ? null : noTracking.reason).toBe('TRACKING_FACT_REQUIRED');
    const noOrg = assembleShipmentEvidence({ organizationId: '  ', tracking: TRACKING_FACT });
    expect(noOrg.ok ? null : noOrg.reason).toBe('TENANT_CONTEXT_REQUIRED');
  });

  it('跨平面身份不一致（account / tracking / provider）→ EVIDENCE_IDENTITY_MISMATCH', () => {
    const wrongAccount = assemble({ invoices: [{ ...INVOICE, externalAccountId: 'UPS-ACCT-2' }] });
    expect(wrongAccount.ok ? null : wrongAccount.reason).toBe('EVIDENCE_IDENTITY_MISMATCH');
    const wrongTracking = assemble({ pod: { ...POD, trackingNumber: '1Z999AA10123456799' } });
    expect(wrongTracking.ok ? null : wrongTracking.reason).toBe('EVIDENCE_IDENTITY_MISMATCH');
    const wrongProvider = assemble({ terms: { ...TERMS, provider: 'FEDEX' } });
    expect(wrongProvider.ok ? null : wrongProvider.reason).toBe('EVIDENCE_IDENTITY_MISMATCH');
  });

  it('slaInputs 只描述事实：promised/actual/exception/delay/scan 数', () => {
    const outcome = assemble();
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.slaInputs.actualDeliveryAt).toBe('2026-10-01T14:00:00.000Z');
    expect(outcome.bundle.slaInputs.exceptionOrDelayObserved).toBe(true);
    expect(outcome.bundle.slaInputs.scanEventCount).toBe(3);
    expect(outcome.bundle.slaInputs.slaCommitmentHours).toBe(72);
    expect(outcome.bundle.slaInputs.serviceLevel).toBe('GROUND');
  });

  it('金额按币种分组合计（不跨币种相加）', () => {
    const outcome = assemble({ invoices: [INVOICE, SECOND_INVOICE] });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.slaInputs.billedTotals).toEqual([{ currency: 'USD', totalCharge: '51.50', invoiceCount: 2 }]);
  });

  it('bundleId 确定性 + 只带 safe reference（无 raw payload / signature / 完整姓名）', () => {
    const first = assemble();
    const second = assemble();
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.bundle.bundleId).toBe(second.bundle.bundleId);
    const serialized = JSON.stringify(first.bundle);
    for (const forbidden of ['refundDue', 'slaEligible', 'claimValue', 'recoveryAmount', 'successFee']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain('Jane Doe');
    expect(first.bundle.evidenceReferences).toContain('sha256:pod-1');
    expect(first.bundle.evidenceReferences).toContain('artifact:pod-1');
  });

  it('纯装配：不触发任何网络请求', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const outcome = assemble();
    expect(outcome.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
