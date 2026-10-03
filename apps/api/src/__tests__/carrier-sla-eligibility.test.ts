/**
 * CARRIER QUEUE #7（MSG-20261003-113 ⑲–㉞）— SLA Eligibility Evaluation 回归。
 * 断言：确定性、ELIGIBLE/NOT_ELIGIBLE/INDETERMINATE 三值语义、UNKNOWN≠FAIL、PARTIAL≠NOT_ELIGIBLE、
 *       conflict → 依赖规则 UNKNOWN、terms 适用性显式判断、无金额字段、无 network / 无 platform write。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assembleShipmentEvidence, type CarrierTermsEvidence, type ShipmentEvidenceBundle } from '../services/carriers/carrier-evidence-bundle';
import { CARRIER_SLA_RULE_SET_ID, CARRIER_SLA_RULE_SET_VERSION, evaluateCarrierSlaEligibility, type CarrierSlaRuleId } from '../services/carriers/carrier-sla-eligibility';
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
  rawChargeCodes: ['BASE', 'FUEL'],
  charges: [
    { kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' },
    { kind: 'FUEL', rawChargeCode: 'FUEL', amount: '5.25', currency: 'USD' },
  ],
  rawReference: 'sha256:inv-1',
  observedAt: NOW.toISOString(),
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

function evaluateWith(overrides: Partial<AssemblyInput> = {}) {
  return evaluateCarrierSlaEligibility(bundleWith(overrides), { now: () => NOW });
}

function statusOf(evaluation: ReturnType<typeof evaluateCarrierSlaEligibility>, ruleId: CarrierSlaRuleId) {
  const result = evaluation.ruleResults.find((entry) => entry.ruleId === ruleId);
  if (!result) throw new Error('missing rule ' + ruleId);
  return result.status;
}

function reasonOf(evaluation: ReturnType<typeof evaluateCarrierSlaEligibility>, ruleId: CarrierSlaRuleId) {
  const result = evaluation.ruleResults.find((entry) => entry.ruleId === ruleId);
  if (!result) throw new Error('missing rule ' + ruleId);
  return result.reasonCode;
}

describe('CARRIER QUEUE #7 — SLA eligibility evaluation', () => {
  it("㉝ COMPLETE clean bundle（late delivery）→ 确定性 ELIGIBLE", () => {
    const evaluation = evaluateWith();
    expect(evaluation.decision).toBe('ELIGIBLE');
    expect(evaluation.ruleResults).toHaveLength(8);
    expect(evaluation.ruleResults.every((result) => result.status === 'PASS')).toBe(true);
    expect(evaluation.blockers).toEqual([]);
    expect(statusOf(evaluation, 'DELIVERY_TIMING')).toBe('PASS');
    expect(reasonOf(evaluation, 'DELIVERY_TIMING')).toBe('LATE_DELIVERY_OBSERVED');
  });

  it("㉚ same bundle twice → identical evaluation（deterministic）", () => {
    const first = evaluateWith();
    const second = evaluateWith();
    expect(JSON.stringify(first.ruleResults)).toBe(JSON.stringify(second.ruleResults));
    expect(first.decision).toBe(second.decision);
    expect(first.bundleId).toBe(second.bundleId);
  });

  it("㉝ PARTIAL evidence → INDETERMINATE（不是 NOT_ELIGIBLE）", () => {
    const evaluation = evaluateWith({ pod: null });
    expect(evaluation.decision).toBe('INDETERMINATE');
    expect(statusOf(evaluation, 'EVIDENCE_COMPLETENESS')).toBe('UNKNOWN');
    expect(reasonOf(evaluation, 'EVIDENCE_COMPLETENESS')).toBe('EVIDENCE_INCOMPLETE');
    expect(evaluation.ruleResults.some((result) => result.status === "FAIL")).toBe(false);
  });

  it("㉖ DELIVERY_TIME_CONFLICT → 依赖 timing 的规则 UNKNOWN", () => {
    const evaluation = evaluateWith({ pod: { ...POD, deliveredAt: "2026-10-01T16:00:00.000Z" } });
    expect(statusOf(evaluation, 'DELIVERY_TIMING')).toBe('UNKNOWN');
    expect(reasonOf(evaluation, 'DELIVERY_TIMING')).toBe('DELIVERY_TIME_CONFLICT');
    expect(statusOf(evaluation, 'EVIDENCE_CONFLICTS')).toBe('UNKNOWN');
    expect(evaluation.decision).toBe('INDETERMINATE');
  });

  it("㉖ SERVICE_LEVEL_CONFLICT → 依赖 service level 的规则 UNKNOWN", () => {
    const evaluation = evaluateWith({ terms: { ...TERMS, serviceLevel: "EXPRESS" } });
    expect(statusOf(evaluation, 'SERVICE_LEVEL_MATCH')).toBe('UNKNOWN');
    expect(reasonOf(evaluation, 'SERVICE_LEVEL_MATCH')).toBe('SERVICE_LEVEL_CONFLICT');
    expect(evaluation.decision).toBe('INDETERMINATE');
  });

  it("㉔ promised/actual 都有且 actual 更晚 → 迟到观察 PASS", () => {
    const evaluation = evaluateWith();
    expect(statusOf(evaluation, 'DELIVERY_TIMING')).toBe('PASS');
  });

  it("㉔ actual 早于/等于 promised → 迟到观察 FAIL → NOT_ELIGIBLE", () => {
    const evaluation = evaluateWith({ tracking: { ...TRACKING_FACT, deliveredAt: "2026-10-01T12:00:00.000Z" }, pod: { ...POD, deliveredAt: "2026-10-01T12:00:00.000Z" } });
    expect(statusOf(evaluation, 'DELIVERY_TIMING')).toBe('FAIL');
    expect(reasonOf(evaluation, 'DELIVERY_TIMING')).toBe('ON_TIME_OR_EARLY');
    expect(evaluation.decision).toBe('NOT_ELIGIBLE');
  });

  it("㉝ promised 缺失 → timing UNKNOWN（不得用 slaCommitmentHours 推算）", () => {
    const evaluation = evaluateWith({ tracking: { ...TRACKING_FACT, estimatedDeliveryAt: null } });
    expect(statusOf(evaluation, 'DELIVERY_TIMING')).toBe('UNKNOWN');
    expect(reasonOf(evaluation, 'DELIVERY_TIMING')).toBe('PROMISED_DELIVERY_UNAVAILABLE');
    expect(evaluation.evaluationBasis.promisedDeliveryAt).toBeNull();
  });

  it("㉝ actual 缺失 → timing UNKNOWN", () => {
    const evaluation = evaluateWith({ tracking: { ...TRACKING_FACT, deliveredAt: null }, pod: { ...POD, deliveredAt: null } });
    expect(statusOf(evaluation, 'DELIVERY_TIMING')).toBe('UNKNOWN');
    expect(reasonOf(evaluation, 'DELIVERY_TIMING')).toBe('ACTUAL_DELIVERY_UNAVAILABLE');
  });

  it("㉝ terms 缺失 → terms 相关规则 UNKNOWN", () => {
    const evaluation = evaluateWith({ terms: null });
    expect(statusOf(evaluation, 'TERMS_EVIDENCE_PRESENT')).toBe('UNKNOWN');
    expect(statusOf(evaluation, 'TERMS_EFFECTIVE_RANGE')).toBe('UNKNOWN');
    expect(evaluation.decision).toBe('INDETERMINATE');
  });

  it("㉓ effective range 覆盖 relevant date → PASS", () => {
    const evaluation = evaluateWith();
    expect(statusOf(evaluation, 'TERMS_EFFECTIVE_RANGE')).toBe('PASS');
    expect(evaluation.evaluationBasis.relevantDateSource).toBe('TRACKING_SHIP_DATE');
    expect(evaluation.evaluationBasis.relevantDate).toBe('2026-09-28');
  });

  it("㉓ effective range 排除 relevant date → FAIL", () => {
    const evaluation = evaluateWith({ terms: { ...TERMS, effectiveTo: "2020-12-31" } });
    expect(statusOf(evaluation, 'TERMS_EFFECTIVE_RANGE')).toBe('FAIL');
    expect(reasonOf(evaluation, 'TERMS_EFFECTIVE_RANGE')).toBe('TERMS_NOT_EFFECTIVE');
    expect(evaluation.decision).toBe('NOT_ELIGIBLE');
  });

  it("㉓ relevant date 缺失 → UNKNOWN（不得假设有 terms 就一定适用）", () => {
    const evaluation = evaluateWith({ tracking: { ...TRACKING_FACT, shipDate: null } });
    expect(statusOf(evaluation, 'TERMS_EFFECTIVE_RANGE')).toBe('UNKNOWN');
    expect(reasonOf(evaluation, 'TERMS_EFFECTIVE_RANGE')).toBe('RELEVANT_DATE_UNAVAILABLE');
    expect(statusOf(evaluation, 'TERMS_EVIDENCE_PRESENT')).toBe('PASS');
    expect(evaluation.decision).toBe('INDETERMINATE');
  });

  it("㉓ terms range 完全缺失 → UNKNOWN", () => {
    const evaluation = evaluateWith({ terms: { ...TERMS, effectiveFrom: null, effectiveTo: null } });
    expect(statusOf(evaluation, 'TERMS_EFFECTIVE_RANGE')).toBe('UNKNOWN');
    expect(reasonOf(evaluation, 'TERMS_EFFECTIVE_RANGE')).toBe('TERMS_RANGE_UNAVAILABLE');
  });

  it("㉝ invoice 缺失 → invoice 规则 UNKNOWN", () => {
    const evaluation = evaluateWith({ invoices: [] });
    expect(statusOf(evaluation, 'BILLED_INVOICE_PRESENT')).toBe('UNKNOWN');
    expect(reasonOf(evaluation, 'BILLED_INVOICE_PRESENT')).toBe('INVOICE_EVIDENCE_MISSING');
    expect(evaluation.decision).toBe('INDETERMINATE');
  });

  it('㉘ 输出不含任何金额 / 追回 / 费用字段', () => {
    const evaluation = evaluateWith();
    const serialized = JSON.stringify(evaluation);
    for (const forbidden of ['recoveryAmount', 'claimValue', 'refundDue', 'successFee', 'billedTotals', 'totalCharge']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('㉙ 不含任何提交 / 外写动作标志', () => {
    const evaluation = evaluateWith();
    expect(evaluation.claimSubmissionPerformed).toBe(false);
    expect(evaluation.evaluationOnly).toBe(true);
    expect(evaluation.readOnly).toBe(true);
    expect(evaluation.transportEnabled).toBe(false);
    expect(evaluation.platformWriteEnabled).toBe(false);
    expect(evaluation.productionCredentials).toBe('ABSENT');
    const serialized = JSON.stringify(evaluation);
    expect(serialized).not.toContain('submitClaim');
    expect(serialized).not.toContain('carrierWrite');
  });

  it('㉛ ruleSetId / ruleSetVersion / evaluatedAt / bundleId 均存在', () => {
    const evaluation = evaluateWith();
    expect(evaluation.ruleSetId).toBe(CARRIER_SLA_RULE_SET_ID);
    expect(evaluation.ruleSetVersion).toBe(CARRIER_SLA_RULE_SET_VERSION);
    expect(evaluation.evaluatedAt).toBe(NOW.toISOString());
    expect(evaluation.bundleId).toBe(bundleWith().bundleId);
  });

  it('㉞ UNKNOWN 不得被当作 FAIL（PARTIAL 不产生 FAIL 规则）', () => {
    const evaluation = evaluateWith({ pod: null, invoices: [] });
    const fails = evaluation.ruleResults.filter((result) => result.status === 'FAIL');
    expect(fails).toEqual([]);
    const unknowns = evaluation.ruleResults.filter((result) => result.status === "UNKNOWN");
    expect(unknowns.length).toBeGreaterThan(0);
  });

  it('㉗ PARTIAL 不得被当作 NOT_ELIGIBLE', () => {
    const evaluation = evaluateWith({ terms: null });
    expect(evaluation.decision).not.toBe('NOT_ELIGIBLE');
    expect(evaluation.decision).toBe('INDETERMINATE');
  });

  it('㉞ conflict 不被静默消解：blockers 明确列出冲突原因', () => {
    const evaluation = evaluateWith({ terms: { ...TERMS, serviceLevel: "EXPRESS" }, pod: { ...POD, deliveredAt: "2026-10-01T16:00:00.000Z" } });
    expect(evaluation.decision).toBe('INDETERMINATE');
    expect(evaluation.blockers).toContain('EVIDENCE_CONFLICTS:EVIDENCE_CONFLICT_PRESENT');
    expect(evaluation.blockers).toContain('SERVICE_LEVEL_MATCH:SERVICE_LEVEL_CONFLICT');
    expect(evaluation.blockers).toContain('DELIVERY_TIMING:DELIVERY_TIME_CONFLICT');
    expect(evaluation.evaluationBasis.serviceLevel).toBeNull();
  });

  it('⑧ serviceLevel 仅一方有值时仍可用该事实值（PASS）', () => {
    const trackingOnly = evaluateWith({ terms: null, tracking: { ...TRACKING_FACT, serviceLevel: "GROUND" } });
    expect(trackingOnly.evaluationBasis.serviceLevelSource).toBe('TRACKING_ONLY');
    expect(statusOf(trackingOnly, 'SERVICE_LEVEL_MATCH')).toBe('PASS');
    const termsOnly = evaluateWith({ tracking: { ...TRACKING_FACT, serviceLevel: null } });
    expect(termsOnly.evaluationBasis.serviceLevelSource).toBe('TERMS_ONLY');
    expect(statusOf(termsOnly, 'SERVICE_LEVEL_MATCH')).toBe('PASS');
  });

  it('⑭ exception/delay observation 只作观察，不产生 eligibility 结论', () => {
    const observed = evaluateWith();
    expect(statusOf(observed, 'EXCEPTION_OR_DELAY_OBSERVED')).toBe('PASS');
    const noEvents = evaluateWith({ tracking: { ...TRACKING_FACT, events: [] } });
    expect(statusOf(noEvents, 'EXCEPTION_OR_DELAY_OBSERVED')).toBe('FAIL');
    expect(reasonOf(noEvents, 'EXCEPTION_OR_DELAY_OBSERVED')).toBe('EXCEPTION_DELAY_NOT_OBSERVED');
  });

  it('⑭ 纯评估：不触发任何网络请求', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const evaluation = evaluateWith();
    expect(evaluation.decision).toBe('ELIGIBLE');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
