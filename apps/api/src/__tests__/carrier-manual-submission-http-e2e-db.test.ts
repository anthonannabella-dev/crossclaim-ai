/**
 * CARRIER QUEUE #9B FINAL（MSG-20261003-119 ㉕㉖㊱）— 真实 HTTP 端到端验收。
 * 断言：401 未认证 / 403 无权限 / 404 未知 package（anti-enumeration）/ 409 NEEDS_REVIEW /
 *       201 首次记录（DB row + 同事务 business audit）/ 200 幂等重放。
 */

import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { assembleShipmentEvidence } from '../services/carriers/carrier-evidence-bundle';
import { evaluateCarrierSlaEligibility } from '../services/carriers/carrier-sla-eligibility';
import { estimateCarrierRecovery } from '../services/carriers/carrier-recovery-estimate';
import { generateCarrierClaimPackage, type CarrierClaimPackage } from '../services/carriers/carrier-claim-package';
import type { CarrierTrackingSnapshot } from '../services/carriers/carrier-tracking-read';
import type { CarrierInvoiceFact, CarrierPODFact } from '../services/carriers/carrier-invoice-pod-read';

const prisma = new PrismaClient();
const ORG = 'cca90000-0000-4000-8000-000000000001';
const USER = 'cca90000-0000-4000-8000-000000000002';
const VIEWER = 'cca90000-0000-4000-8000-000000000003';
const SALT = 'q9bf-e2e-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'q9bf-e2e-pass-1';
const NOW = new Date('2026-10-03T00:00:00.000Z');
const TRACKING = '1Z999AA10123456784';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });

const TRACKING_FACT: CarrierTrackingSnapshot = {
  provider: 'UPS', externalAccountId: 'UPS-ACCT-1', trackingNumber: TRACKING,
  shipmentStatus: 'DELIVERED', carrierStatusCode: 'D', statusText: 'Delivered',
  origin: null, destination: null,
  shipDate: '2026-09-28', estimatedDeliveryAt: '2026-10-01T12:00:00.000Z', deliveredAt: '2026-10-01T14:00:00.000Z',
  lastEventAt: null, lastEventLocation: null,
  serviceLevel: 'GROUND',
  events: [{ occurredAt: '2026-10-01T14:00:00.000Z', status: 'DELAYED', rawStatusCode: 'DO', description: 'Delayed', location: null, source: 'PROVIDER_SCAN', eventKey: 'k' }],
  rawReference: 'sha256:track-1', observedAt: NOW.toISOString(),
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

const READY_PKG = packageFor([INVOICE]);
const NOT_READY_PKG = packageFor([PARTIAL]);

const PACKAGES = {
  async load(organizationId: string, packageId: string) {
    for (const pkg of [READY_PKG, NOT_READY_PKG]) {
      if (pkg.organizationId === organizationId && pkg.packageId === packageId) return pkg;
    }
    return null;
  },
};

const PERMISSIVE_GUARD = { async assertAllowed() {} };

async function withServer<T>(run: (base: string, guard: { assertAllowed(): Promise<void> }) => Promise<T>, opts: { permissive?: boolean } = {}): Promise<T> {
  const guard = opts.permissive === false ? { async assertAllowed() { throw new Error('ACTION_GUARD_REQUIREMENTS_NOT_MET'); } } : PERMISSIVE_GUARD;
  const server = createServer({ prisma, log, audit, carrierClaimPackages: PACKAGES as never, actionGuard: guard as never } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run('http://127.0.0.1:' + port, guard);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function login(base: string, email: string): Promise<string> {
  const response = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('LOGIN_FAILED ' + response.status);
  return cookie.split(';')[0];
}

function submit(base: string, packageId: string, cookie?: string, body: unknown = {}) {
  return fetch(base + '/carrier-claim-packages/' + encodeURIComponent(packageId) + '/manual-submission', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "CarrierManualSubmission", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'Q9BF 租户', slug: 'q9bf-org' } });
  await prisma.user.create({
    data: { id: USER, email: 'q9bf-owner@example.com', passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.user.create({
    data: { id: VIEWER, email: 'q9bf-viewer@example.com', passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'VIEWER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: VIEWER, role: 'VIEWER' as never, isActive: true } });
});

describe('CARRIER QUEUE #9B FINAL — HTTP E2E', () => {
  it('未认证 → 401', async () => {
    await withServer(async (base) => {
      const res = await submit(base, READY_PKG.packageId, undefined, {});
      expect(res.status).toBe(401);
      expect(await prisma.carrierManualSubmission.count()).toBe(0);
    });
  });

  it('VIEWER（无 capability）→ 403 且零 row', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q9bf-viewer@example.com');
      const res = await submit(base, READY_PKG.packageId, cookie, {});
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'CAPABILITY_REQUIRED' });
      expect(await prisma.carrierManualSubmission.count()).toBe(0);
    });
  });

  it('未知 package → 404（anti-enumeration）且零 row', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q9bf-owner@example.com');
      const res = await submit(base, 'does-not-exist', cookie, {});
      expect(res.status).toBe(404);
      expect(await prisma.carrierManualSubmission.count()).toBe(0);
    });
  });

  it('NEEDS_REVIEW package → 409 且零 row', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q9bf-owner@example.com');
      const res = await submit(base, NOT_READY_PKG.packageId, cookie, {});
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ code: 'PACKAGE_NOT_READY' });
      expect(await prisma.carrierManualSubmission.count()).toBe(0);
    });
  });

  it('READY package + OWNER → 201 首次记录（DB row + 审计恰好一次）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q9bf-owner@example.com');
      const res = await submit(base, READY_PKG.packageId, cookie, { carrierReference: 'CASE-1' });
      expect(res.status).toBe(201);
      const payload = (await res.json()) as { status: string; submissionRecord: { carrierConfirmationStatus: string } };
      expect(payload.status).toBe('RECORDED');
      expect(payload.submissionRecord.carrierConfirmationStatus).toBe('NOT_VERIFIED');
      expect(await prisma.carrierManualSubmission.count()).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'carrier.manual_submission_recorded' } })).toBe(1);
    });
  });

  it('重复 POST → 200 ALREADY_RECORDED 且仍只有一行', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q9bf-owner@example.com');
      const first = await submit(base, READY_PKG.packageId, cookie, {});
      const second = await submit(base, READY_PKG.packageId, cookie, {});
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      const payload = (await second.json()) as { status: string };
      expect(payload.status).toBe('ALREADY_RECORDED');
      expect(await prisma.carrierManualSubmission.count()).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'carrier.manual_submission_recorded' } })).toBe(1);
    });
  });
});
