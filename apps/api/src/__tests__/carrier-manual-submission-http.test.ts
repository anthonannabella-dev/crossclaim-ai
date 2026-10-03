/**
 * CARRIER QUEUE #9B FINAL（MSG-20261003-119 ㉔㉕㉖㉗）— HTTP 边界映射回归。
 * 断言：角色 → 权限、稳定状态映射（400/403/404/409/200/201）、幂等重放 200、client 注入被忽略、错误体不泄漏。
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { assembleShipmentEvidence } from '../services/carriers/carrier-evidence-bundle';
import { evaluateCarrierSlaEligibility } from '../services/carriers/carrier-sla-eligibility';
import { estimateCarrierRecovery } from '../services/carriers/carrier-recovery-estimate';
import { generateCarrierClaimPackage, type CarrierClaimPackage } from '../services/carriers/carrier-claim-package';
import { handleCarrierManualSubmissionRequest } from '../services/carriers/carrier-manual-submission-http';
import type { CarrierManualSubmissionRecord } from '../services/carriers/carrier-manual-submission';
import type { CarrierTrackingSnapshot } from '../services/carriers/carrier-tracking-read';
import type { CarrierInvoiceFact, CarrierPODFact } from '../services/carriers/carrier-invoice-pod-read';

const ORG = 'cca90000-0000-4000-8000-000000000001';
const USER = 'cca90000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-03T00:00:00.000Z');
const TRACKING = '1Z999AA10123456784';

const TRACKING_FACT: CarrierTrackingSnapshot = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  trackingNumber: TRACKING,
  shipmentStatus: 'DELIVERED',
  carrierStatusCode: 'D',
  statusText: 'Delivered',
  origin: null, destination: null,
  shipDate: '2026-09-28',
  estimatedDeliveryAt: '2026-10-01T12:00:00.000Z',
  deliveredAt: '2026-10-01T14:00:00.000Z',
  lastEventAt: null, lastEventLocation: null,
  serviceLevel: 'GROUND',
  events: [{ occurredAt: '2026-10-01T14:00:00.000Z', status: 'DELAYED', rawStatusCode: 'DO', description: 'Delayed', location: null, source: 'PROVIDER_SCAN', eventKey: 'k' }],
  rawReference: 'sha256:track-1',
  observedAt: NOW.toISOString(),
};

const INVOICE: CarrierInvoiceFact = {
  provider: 'UPS', externalAccountId: 'UPS-ACCT-1', invoiceReference: 'INV-1', invoiceDate: '2026-09-30',
  trackingNumber: TRACKING, shipmentReference: null,
  serviceLevel: 'GROUND', currency: 'USD', baseCharge: '35.00', fuelSurcharge: null, accessorialCharges: null, tax: null,
  totalCharge: '35.00', billedWeight: null, billedZone: null, rawChargeCodes: ['BASE'],
  charges: [{ kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' }],
  rawReference: 'sha256:inv-1', observedAt: NOW.toISOString(),
};

const PARTIAL: CarrierInvoiceFact = {
  ...INVOICE,
  charges: [
    { kind: 'BASE', rawChargeCode: 'BASE', amount: '35.00', currency: 'USD' },
    { kind: 'FUEL', rawChargeCode: 'FUEL', amount: '5.25', currency: 'USD' },
  ],
};

const POD: CarrierPODFact = {
  provider: 'UPS', externalAccountId: 'UPS-ACCT-1', trackingNumber: TRACKING,
  deliveryStatus: 'DELIVERED', deliveredAt: '2026-10-01T14:00:00.000Z', deliveryLocation: null,
  recipientNameMasked: 'J***', signed: true, signatureAvailable: true, proofType: 'SIGNATURE',
  documentReference: 'artifact:pod-1', rawReference: 'sha256:pod-1', observedAt: NOW.toISOString(),
};

const TERMS = {
  provider: 'UPS' as const, source: 'RATE_CARD' as const, termsReference: 'terms:ups', serviceLevel: 'GROUND',
  slaCommitmentHours: 72, effectiveFrom: '2026-01-01', effectiveTo: null, rawReference: 'sha256:terms-1',
};

function packageFor(invoices: CarrierInvoiceFact[]): CarrierClaimPackage {
  const outcome = assembleShipmentEvidence({ organizationId: ORG, tracking: TRACKING_FACT, invoices, pod: POD, terms: TERMS }, { now: () => NOW });
  if (!outcome.ok) throw new Error('expected ok');
  const eligibility = evaluateCarrierSlaEligibility(outcome.bundle, { now: () => NOW });
  const estimation = estimateCarrierRecovery({ bundle: outcome.bundle, eligibility });
  return generateCarrierClaimPackage({ bundle: outcome.bundle, eligibility, estimation }, { now: () => NOW });
}

function depsFor(pkg: CarrierClaimPackage | null) {
  const store = new Map<string, CarrierManualSubmissionRecord>();
  return {
    packages: { async load(organizationId: string, packageId: string) { return pkg && organizationId === pkg.organizationId && packageId === pkg.packageId ? pkg : null; } },
    store: {
      async find(organizationId: string, packageId: string) { return store.get(organizationId + '|' + packageId) ?? null; },
      async create(record: CarrierManualSubmissionRecord) {
        const key = record.organizationId + '|' + record.packageId;
        const existing = store.get(key);
        if (existing) return { created: false, record: existing };
        store.set(key, record);
        return { created: true, record };
      },
    },
    audit: { async emit() {} },
    now: () => new Date('2026-10-03T01:00:00.000Z'),
  };
}

function session(role: string, organizationId = ORG) {
  return { organizationId, actorUserId: USER, role };
}

describe('CARRIER QUEUE #9B FINAL — HTTP boundary', () => {
  it('OWNER + READY package → 201 RECORDED', async () => {
    const pkg = packageFor([INVOICE]);
    const res = await handleCarrierManualSubmissionRequest({ packageId: pkg.packageId, request: { carrierReference: 'CASE-1' }, session: session('OWNER') }, depsFor(pkg));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('RECORDED');
  });

  it('幂等重放 → 200 ALREADY_RECORDED（不得 500）', async () => {
    const pkg = packageFor([INVOICE]);
    const deps = depsFor(pkg);
    await handleCarrierManualSubmissionRequest({ packageId: pkg.packageId, request: {}, session: session('OWNER') }, deps);
    const replay = await handleCarrierManualSubmissionRequest({ packageId: pkg.packageId, request: {}, session: session('ADMIN') }, deps);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('ALREADY_RECORDED');
  });

  it('VIEWER / FINANCE / 未知角色 → 403 CAPABILITY_REQUIRED', async () => {
    const pkg = packageFor([INVOICE]);
    for (const role of ['VIEWER', 'FINANCE', 'GHOST']) {
      const res = await handleCarrierManualSubmissionRequest({ packageId: pkg.packageId, request: {}, session: session(role) }, depsFor(pkg));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ code: 'CAPABILITY_REQUIRED' });
    }
  });

  it('NEEDS_REVIEW package → 409 PACKAGE_NOT_READY', async () => {
    const pkg = packageFor([PARTIAL]);
    const res = await handleCarrierManualSubmissionRequest({ packageId: pkg.packageId, request: {}, session: session('OWNER') }, depsFor(pkg));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'PACKAGE_NOT_READY' });
  });

  it('package 不存在 → 404 PACKAGE_NOT_FOUND', async () => {
    const res = await handleCarrierManualSubmissionRequest({ packageId: 'nope', request: {}, session: session('OWNER') }, depsFor(null));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'PACKAGE_NOT_FOUND' });
  });

  it('tenant 不一致 → 404（anti-enumeration，不区分存在性）', async () => {
    const pkg = packageFor([INVOICE]);
    const res = await handleCarrierManualSubmissionRequest({ packageId: pkg.packageId, request: {}, session: session('OWNER', 'cca90000-0000-4000-8000-000000000009') }, depsFor(pkg));
    expect(res.status).toBe(404);
  });

  it('client 注入身份字段被忽略（记录使用 session 派生值）', async () => {
    const pkg = packageFor([INVOICE]);
    const res = await handleCarrierManualSubmissionRequest(
      { packageId: pkg.packageId, request: { organizationId: 'org-evil', submittedByUserId: 'user-evil', trackingNumber: 'evil' } as never, session: session('OPS') },
      depsFor(pkg),
    );
    expect(res.status).toBe(201);
    const record = (res.body as { submissionRecord: { organizationId: string; submittedByUserId: string; trackingNumber: string } }).submissionRecord;
    expect(record.organizationId).toBe(ORG);
    expect(record.submittedByUserId).toBe(USER);
    expect(record.trackingNumber).toBe(TRACKING);
    expect(JSON.stringify(res.body)).not.toContain('evil');
  });

  it('错误响应只含稳定 code（不泄漏内部细节）', async () => {
    const pkg = packageFor([PARTIAL]);
    const res = await handleCarrierManualSubmissionRequest({ packageId: pkg.packageId, request: {}, session: session('OWNER') }, depsFor(pkg));
    expect(Object.keys(res.body)).toEqual(['code']);
    expect(JSON.stringify(res.body)).not.toContain('credential');
  });

  it('无 carrier 网络调用', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const pkg = packageFor([INVOICE]);
    const res = await handleCarrierManualSubmissionRequest({ packageId: pkg.packageId, request: {}, session: session('OWNER') }, depsFor(pkg));
    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
