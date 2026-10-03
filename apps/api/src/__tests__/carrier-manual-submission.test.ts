/**
 * CARRIER QUEUE #9B（MSG-20261003-118 ⑲–㊴）— Human Attestation Record 回归。
 * 断言：READY gate、server-derived 身份、package 绑定、幂等/并发、不可变核心事实、审计恰好一次、
 *       无 carrier write / 无 recovered-money 污染 / 无 carrier confirmation 伪造。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assembleShipmentEvidence, type CarrierTermsEvidence, type ShipmentEvidenceBundle } from '../services/carriers/carrier-evidence-bundle';
import { evaluateCarrierSlaEligibility } from '../services/carriers/carrier-sla-eligibility';
import { estimateCarrierRecovery } from '../services/carriers/carrier-recovery-estimate';
import { generateCarrierClaimPackage, type CarrierClaimPackage } from '../services/carriers/carrier-claim-package';
import {
  CARRIER_MANUAL_SUBMISSION_AUDIT_EVENT,
  CARRIER_MANUAL_SUBMISSION_CAPABILITY,
  recordCarrierManualSubmission,
  type CarrierManualSubmissionAuditEvent,
  type CarrierManualSubmissionRecord,
  type CarrierManualSubmissionStore,
} from '../services/carriers/carrier-manual-submission';
import type { CarrierTrackingSnapshot } from '../services/carriers/carrier-tracking-read';
import type { CarrierInvoiceFact, CarrierPODFact } from '../services/carriers/carrier-invoice-pod-read';

const NOW = new Date('2026-10-03T00:00:00.000Z');
const LATER = new Date('2026-10-03T01:00:00.000Z');
const TRACKING = '1Z999AA10123456784';
const CAP = [CARRIER_MANUAL_SUBMISSION_CAPABILITY];

const TRACKING_FACT: CarrierTrackingSnapshot = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  trackingNumber: TRACKING,
  shipmentStatus: 'DELIVERED',
  carrierStatusCode: 'D',
  statusText: 'Delivered',
  origin: null,
  destination: null,
  shipDate: '2026-09-28',
  estimatedDeliveryAt: '2026-10-01T12:00:00.000Z',
  deliveredAt: '2026-10-01T14:00:00.000Z',
  lastEventAt: null,
  lastEventLocation: null,
  serviceLevel: 'GROUND',
  events: [
    { occurredAt: '2026-10-01T14:00:00.000Z', status: 'DELAYED', rawStatusCode: 'DO', description: 'Delayed', location: null, source: 'PROVIDER_SCAN', eventKey: 'k2' },
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
  tax: null,
  totalCharge: '35.00',
  billedWeight: null,
  billedZone: null,
  rawChargeCodes: ['BASE'],
  charges: [{ kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' }],
  rawReference: 'sha256:inv-1',
  observedAt: NOW.toISOString(),
};

const PARTIAL_INVOICE: CarrierInvoiceFact = {
  ...COMPLETE_INVOICE,
  rawChargeCodes: ['BASE', 'FUEL'],
  charges: [
    { kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' },
    { kind: 'FUEL', rawChargeCode: 'FUEL', amount: '5.25', currency: 'USD' },
  ],
};

const POD: CarrierPODFact = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  trackingNumber: TRACKING,
  deliveryStatus: 'DELIVERED',
  deliveredAt: '2026-10-01T14:00:00.000Z',
  deliveryLocation: null,
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

function packageFor(overrides: Partial<AssemblyInput> = {}): CarrierClaimPackage {
  const bundle = bundleWith(overrides);
  const eligibility = evaluateCarrierSlaEligibility(bundle, { now: () => NOW });
  const estimation = estimateCarrierRecovery({ bundle, eligibility });
  return generateCarrierClaimPackage({ bundle, eligibility, estimation }, { now: () => NOW });
}

function makeDeps(pkg: CarrierClaimPackage | null) {
  const store = new Map<string, CarrierManualSubmissionRecord>();
  let createCalls = 0;
  const audits: CarrierManualSubmissionAuditEvent[] = [];
  const storeImpl: CarrierManualSubmissionStore = {
    async find(organizationId, packageId) {
      return store.get(organizationId + '|' + packageId) ?? null;
    },
    async create(record) {
      createCalls += 1;
      await Promise.resolve();
      const key = record.organizationId + '|' + record.packageId;
      const existing = store.get(key);
      if (existing) return { created: false, record: existing };
      store.set(key, record);
      return { created: true, record };
    },
  };
  return {
    deps: {
      packages: { async load() { return pkg; } },
      store: storeImpl,
      audit: { async emit(event: CarrierManualSubmissionAuditEvent) { audits.push(event); } },
      now: () => LATER,
    },
    audits,
    createCalls: () => createCalls,
  };
}

function contextWith(overrides: Partial<{ organizationId: string; actorUserId: string; actorCapabilities: readonly string[] }> = {}) {
  return { organizationId: 'org-a', actorUserId: 'user-1', actorCapabilities: CAP, ...overrides };
}

describe('CARRIER QUEUE #9B — manual submission record', () => {
  it('㉑㉒ READY package + authorized actor → 记录人工提交（human attestation）', async () => {
    const pkg = packageFor();
    const { deps, audits } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission(
      { packageId: pkg.packageId, request: { note: 'submitted via portal' }, context: contextWith() },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe('RECORDED');
    expect(outcome.record.humanAttestation.submitted).toBe(true);
    expect(outcome.record.humanRecorded).toBe(true);
    expect(outcome.record.submittedByUserId).toBe('user-1');
    expect(outcome.record.organizationId).toBe('org-a');
    expect(audits).toHaveLength(1);
  });

  it('㉑㉖ NEEDS_REVIEW package（PARTIAL）→ PACKAGE_NOT_READY', async () => {
    const pkg = packageFor({ invoices: [PARTIAL_INVOICE] });
    expect(pkg.packageStatus).toBe('NEEDS_REVIEW');
    const { deps } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission(
      { packageId: pkg.packageId, request: {}, context: contextWith() },
      deps,
    );
    expect(outcome.ok ? null : outcome.reason).toBe('PACKAGE_NOT_READY');
  });

  it('㉕ package 不存在 → PACKAGE_NOT_FOUND', async () => {
    const { deps } = makeDeps(null);
    const outcome = await recordCarrierManualSubmission(
      { packageId: 'missing', request: {}, context: contextWith() },
      deps,
    );
    expect(outcome.ok ? null : outcome.reason).toBe('PACKAGE_NOT_FOUND');
  });

  it('㉓ cross-tenant package → TENANT_MISMATCH', async () => {
    const pkg = { ...packageFor(), organizationId: 'org-b' };
    const { deps } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission(
      { packageId: pkg.packageId, request: {}, context: contextWith() },
      deps,
    );
    expect(outcome.ok ? null : outcome.reason).toBe('TENANT_MISMATCH');
  });

  it('㉔ 缺少 capability（VIEWER）→ CAPABILITY_REQUIRED', async () => {
    const pkg = packageFor();
    const { deps } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission(
      { packageId: pkg.packageId, request: {}, context: contextWith({ actorCapabilities: ['viewer'] }) },
      deps,
    );
    expect(outcome.ok ? null : outcome.reason).toBe('CAPABILITY_REQUIRED');
  });

  it('㉓㊳ client 注入身份字段被忽略（server-derived 生效）', async () => {
    const pkg = packageFor();
    const { deps } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission(
      {
        packageId: pkg.packageId,
        request: {
          carrierReference: 'CASE-123',
          organizationId: 'org-evil',
          submittedByUserId: 'user-evil',
          trackingNumber: 'evil-tracking',
        } as never,
        context: contextWith(),
      },
      deps,
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.record.organizationId).toBe('org-a');
    expect(outcome.record.submittedByUserId).toBe('user-1');
    expect(outcome.record.trackingNumber).toBe(pkg.trackingNumber);
    expect(JSON.stringify(outcome.record)).not.toContain('evil');
  });

  it('㉘ submittedAt 为 server timestamp；用户自报过去时间单独标注', async () => {
    const pkg = packageFor();
    const { deps } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission(
      {
        packageId: pkg.packageId,
        request: { reportedCarrierSubmissionAt: '2026-09-30T10:00:00.000Z' },
        context: contextWith(),
      },
      deps,
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.record.submittedAt).toBe(LATER.toISOString());
    expect(outcome.record.recordedAt).toBe(LATER.toISOString());
    expect(outcome.record.humanAttestation.reportedCarrierSubmissionAt).toBe('2026-09-30T10:00:00.000Z');
    expect(outcome.record.submittedAt).not.toBe(outcome.record.humanAttestation.reportedCarrierSubmissionAt);
  });

  it('㉙㉝ carrierReference 标为 USER_PROVIDED_UNVERIFIED 且 confirmation = NOT_VERIFIED', async () => {
    const pkg = packageFor();
    const { deps } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: { carrierReference: 'CASE-123' }, context: contextWith() }, deps);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.record.humanAttestation.carrierReferenceProvenance).toBe('USER_PROVIDED_UNVERIFIED');
    expect(outcome.record.carrierConfirmationStatus).toBe('NOT_VERIFIED');
    const serialized = JSON.stringify(outcome.record);
    for (const forbidden of ['providerAccepted', 'providerConfirmed', 'claimApproved', 'refundApproved']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('㉚㊳ 重复调用幂等（不产生第二条 submitted fact，不重复审计）', async () => {
    const pkg = packageFor();
    const { deps, audits, createCalls } = makeDeps(pkg);
    const first = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith() }, deps);
    const second = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith() }, deps);
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.status).toBe('RECORDED');
    expect(second.status).toBe('ALREADY_RECORDED');
    expect(second.record.submissionRecordId).toBe(first.record.submissionRecordId);
    expect(createCalls()).toBe(1);
    expect(audits).toHaveLength(1);
  });

  it('㊲㊳ 并发请求最多创建一条 record', async () => {
    const pkg = packageFor();
    const { deps, audits } = makeDeps(pkg);
    const [a, b] = await Promise.all([
      recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith() }, deps),
      recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith() }, deps),
    ]);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect([a.status, b.status].sort()).toEqual(['ALREADY_RECORDED', 'RECORDED']);
    expect(a.record.submissionRecordId).toBe(b.record.submissionRecordId);
    expect(audits).toHaveLength(1);
  });

  it('㉛㉜ 核心 lineage 与 rule versions 保留，审计事件结构正确', async () => {
    const pkg = packageFor();
    const { deps, audits } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith() }, deps);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.record.packageId).toBe(pkg.packageId);
    expect(outcome.record.bundleId).toBe(pkg.bundleId);
    expect(outcome.record.provider).toBe(pkg.provider);
    expect(outcome.record.externalAccountId).toBe(pkg.externalAccountId);
    expect(outcome.record.eligibilityRuleSetVersion).toBe(pkg.eligibilityReference.ruleSetVersion);
    expect(outcome.record.estimateRuleSetVersion).toBe(pkg.estimateRuleSetVersion);
    expect(outcome.record.submissionMode).toBe('MANUAL');
    expect(outcome.record.channel).toBe(pkg.submissionDestination.channel);
    const [event] = audits;
    expect(event.event).toBe(CARRIER_MANUAL_SUBMISSION_AUDIT_EVENT);
    expect(event.organizationId).toBe('org-a');
    expect(event.actorUserId).toBe('user-1');
    expect(event.packageId).toBe(pkg.packageId);
    expect(event.trackingNumber).toBe(pkg.trackingNumber);
    expect(event.result).toBe('RECORDED');
    expect(JSON.stringify(event)).not.toContain('credential');
  });

  it('㉞㉟ 无 carrier write / 无 recovered-money 污染', async () => {
    const pkg = packageFor();
    const { deps } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith() }, deps);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.record.carrierWritePerformed).toBe(false);
    expect(outcome.record.transportEnabled).toBe(false);
    expect(outcome.record.platformWriteEnabled).toBe(false);
    expect(outcome.record.productionCredentials).toBe('ABSENT');
    const serialized = JSON.stringify(outcome.record);
    for (const forbidden of ['actualRecovered', 'recoveryPayout', 'successFee', 'commission', 'settlementAmount']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('㊳ submissionRecordId deterministic（同一 org + package）', async () => {
    const pkg = packageFor();
    const first = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith() }, makeDeps(pkg).deps);
    const second = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith() }, makeDeps(pkg).deps);
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.record.submissionRecordId).toBe(second.record.submissionRecordId);
  });

  it('入力校验：空 packageId / org / actor → INVALID_REQUEST', async () => {
    const pkg = packageFor();
    const { deps } = makeDeps(pkg);
    const emptyPackage = await recordCarrierManualSubmission({ packageId: '  ', request: {}, context: contextWith() }, deps);
    expect(emptyPackage.ok ? null : emptyPackage.reason).toBe('INVALID_REQUEST');
    const emptyOrg = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith({ organizationId: '' }) }, deps);
    expect(emptyOrg.ok ? null : emptyOrg.reason).toBe('INVALID_REQUEST');
    const emptyActor = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith({ actorUserId: ' ' }) }, deps);
    expect(emptyActor.ok ? null : emptyActor.reason).toBe('INVALID_REQUEST');
  });

  it('㊳ 纯契约层：不触发任何网络请求', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const pkg = packageFor();
    const { deps } = makeDeps(pkg);
    const outcome = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextWith() }, deps);
    expect(outcome.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
