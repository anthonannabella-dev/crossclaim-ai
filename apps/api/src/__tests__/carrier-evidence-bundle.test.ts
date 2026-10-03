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
    expect(outcome.bundle.slaInputs.billedTotals).toHaveLength(1);
    expect(outcome.bundle.slaInputs.billedTotals[0].currency).toBe('USD');
    expect(outcome.bundle.slaInputs.billedTotals[0].totalCharge).toBe('51.50');
    expect(outcome.bundle.slaInputs.billedTotals[0].invoiceCount).toBe(2);
    // total − Σ(components) 只作为事实保留（组件齐全时非 null；不据此判定 provider 数据错误）
    expect(outcome.bundle.slaInputs.billedTotals[0].deltaFromComponents).not.toBeNull();
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

describe('CARRIER QUEUE #6 FINAL — EVIDENCE FACT / CONFLICT SEMANTICS（MSG-20261003-112 ⑫–⑲㉒）', () => {
  it('⑫ CHANGE A：slaCommitmentHours != null 时 shipDate 不得成为 promisedDeliveryAt', () => {
    const outcome = assemble({ terms: { ...TERMS, slaCommitmentHours: 72, serviceLevel: 'GROUND' } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.slaInputs.promisedDeliveryAt).toBe('2026-10-01T12:00:00.000Z');
    expect(outcome.bundle.slaInputs.promisedDeliveryAt).not.toBe(TRACKING_FACT.shipDate);
    expect(outcome.bundle.slaInputs.promisedDeliveryAt).not.toBe('2026-09-28');
    // slaCommitmentHours 仍作为独立 evidence input 保留（不被用于推算 deadline）
    expect(outcome.bundle.slaInputs.slaCommitmentHours).toBe(72);
  });

  it('⑫：estimatedDeliveryAt 存在 → promisedDeliveryAt = estimatedDeliveryAt', () => {
    const outcome = assemble();
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.slaInputs.promisedDeliveryAt).toBe(TRACKING_FACT.estimatedDeliveryAt);
  });

  it('⑫：estimatedDeliveryAt = null → promisedDeliveryAt = null（即使 slaCommitmentHours 存在）', () => {
    const outcome = assemble({ tracking: { ...TRACKING_FACT, estimatedDeliveryAt: null }, terms: { ...TERMS, slaCommitmentHours: 48 } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.slaInputs.promisedDeliveryAt).toBeNull();
    expect(outcome.bundle.slaInputs.slaCommitmentHours).toBe(48);
    expect(outcome.bundle.slaInputs.promisedDeliveryAt).not.toBe(TRACKING_FACT.shipDate);
  });

  it('⑭ CHANGE B：仅 tracking deliveredAt → actualDeliveryAt = tracking 值（无冲突）', () => {
    const outcome = assemble({ pod: { ...POD, deliveredAt: null } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.slaInputs.actualDeliveryAt).toBe("2026-10-01T14:00:00.000Z");
    expect(outcome.bundle.slaInputs.deliveryTimes).toEqual({ trackingDeliveredAt: "2026-10-01T14:00:00.000Z", podDeliveredAt: null });
    expect(outcome.bundle.evidenceConflicts).toEqual([]);
  });

  it('⑭：仅 POD deliveredAt → actualDeliveryAt = POD 值（无冲突）', () => {
    const outcome = assemble({ tracking: { ...TRACKING_FACT, deliveredAt: null } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.slaInputs.actualDeliveryAt).toBe("2026-10-01T14:00:00.000Z");
    expect(outcome.bundle.slaInputs.deliveryTimes).toEqual({ trackingDeliveredAt: null, podDeliveredAt: "2026-10-01T14:00:00.000Z" });
    expect(outcome.bundle.evidenceConflicts).toEqual([]);
  });

  it('⑭：tracking / POD deliveredAt 一致 → actualDeliveryAt 输出该值', () => {
    const outcome = assemble({ pod: { ...POD, deliveredAt: '2026-10-01T14:00:00.000Z' } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.slaInputs.actualDeliveryAt).toBe('2026-10-01T14:00:00.000Z');
    expect(outcome.bundle.evidenceConflicts).toEqual([]);
  });

  it('⑭：tracking / POD deliveredAt 冲突 → DELIVERY_TIME_CONFLICT 且不得静默择一', () => {
    const outcome = assemble({ pod: { ...POD, deliveredAt: '2026-10-01T16:00:00.000Z' } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.evidenceConflicts).toContain('DELIVERY_TIME_CONFLICT');
    expect(outcome.bundle.slaInputs.actualDeliveryAt).toBeNull();
    expect(outcome.bundle.slaInputs.deliveryTimes).toEqual({ trackingDeliveredAt: "2026-10-01T14:00:00.000Z", podDeliveredAt: '2026-10-01T16:00:00.000Z' });
    expect(outcome.bundle.slaInputs.actualDeliveryAt).not.toBe('2026-10-01T14:00:00.000Z');
    // 冲突不得被塞进 missing evidence
    expect(outcome.bundle.missingEvidence).toEqual([]);
    expect(outcome.bundle.completeness).toBe('COMPLETE');
  });

  it('⑯ CHANGE C：tracking / terms serviceLevel 一致 → canonical serviceLevel（无冲突）', () => {
    const outcome = assemble({ tracking: { ...TRACKING_FACT, serviceLevel: 'GROUND' }, terms: { ...TERMS, serviceLevel: 'GROUND' } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.slaInputs.serviceLevel).toBe('GROUND');
    expect(outcome.bundle.slaInputs.trackingServiceLevel).toBe('GROUND');
    expect(outcome.bundle.slaInputs.termsServiceLevel).toBe('GROUND');
    expect(outcome.bundle.evidenceConflicts).toEqual([]);
  });

  it('⑯：serviceLevel 冲突 → SERVICE_LEVEL_CONFLICT 且 serviceLevel=null（暴露两来源，不静默覆盖）', () => {
    const outcome = assemble({ tracking: { ...TRACKING_FACT, serviceLevel: 'GROUND' }, terms: { ...TERMS, serviceLevel: 'EXPRESS' } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.evidenceConflicts).toContain('SERVICE_LEVEL_CONFLICT');
    expect(outcome.bundle.slaInputs.serviceLevel).toBeNull();
    expect(outcome.bundle.slaInputs.trackingServiceLevel).toBe('GROUND');
    expect(outcome.bundle.slaInputs.termsServiceLevel).toBe('EXPRESS');
  });

  it('⑲：conflict 与 completeness 独立（COMPLETE + SERVICE_LEVEL_CONFLICT 合法）', () => {
    const outcome = assemble({ tracking: { ...TRACKING_FACT, serviceLevel: 'GROUND' }, terms: { ...TERMS, serviceLevel: 'EXPRESS' } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.completeness).toBe('COMPLETE');
    expect(outcome.bundle.missingEvidence).toEqual([]);
    expect(outcome.bundle.evidenceConflicts).toEqual(['SERVICE_LEVEL_CONFLICT']);
  });

  it('⑰：terms effectiveFrom / effectiveTo 仅作 evidence 保留，不做条款适用性判断', () => {
    const outcome = assemble({ terms: { ...TERMS, effectiveFrom: '2020-01-01', effectiveTo: '2020-12-31' } });
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.bundle.terms?.effectiveFrom).toBe('2020-01-01');
    expect(outcome.bundle.terms?.effectiveTo).toBe('2020-12-31');
    expect(outcome.bundle.slaInputs.serviceLevel).toBe('GROUND');
    const serialized = JSON.stringify(outcome.bundle);
    for (const forbidden of ['termsApplicable', 'termsExpired', 'slaEligible']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('㉑ 冲突字段加入后 bundleId 仍 deterministic', () => {
    const first = assemble({ pod: { ...POD, deliveredAt: '2026-10-01T16:00:00.000Z' } });
    const second = assemble({ pod: { ...POD, deliveredAt: '2026-10-01T16:00:00.000Z' } });
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.bundle.bundleId).toBe(second.bundle.bundleId);
  });

  it('⑲：冲突状态下仍不产生任何判定字段', () => {
    const outcome = assemble({ pod: { ...POD, deliveredAt: '2026-10-01T16:00:00.000Z' }, terms: { ...TERMS, serviceLevel: 'EXPRESS' } });
    if (!outcome.ok) throw new Error('expected ok');
    const serialized = JSON.stringify(outcome.bundle);
    for (const forbidden of ['refundDue', 'slaEligible', 'claimValue', 'recoveryAmount', 'successFee']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(outcome.bundle.evidenceConflicts).toEqual(['DELIVERY_TIME_CONFLICT', 'SERVICE_LEVEL_CONFLICT']);
    expect(outcome.bundle.evidenceOnly).toBe(true);
    expect(outcome.bundle.adjudicationPerformed).toBe(false);
  });
});
