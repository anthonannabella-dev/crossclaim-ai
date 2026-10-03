/**
 * CARRIER QUEUE #9B FINAL（MSG-20261003-119 ⑳㉘㉙㉚㉛㉜㊱）— 真实 PostgreSQL 验收。
 * 断言：UNIQUE(org, packageId) 幂等、真实并发只产生一条 row、business audit 同事务恰好一次、
 *       append-only 不可改、租户/身份 server-derived、无 carrier 网络。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assembleShipmentEvidence } from '../services/carriers/carrier-evidence-bundle';
import { evaluateCarrierSlaEligibility } from '../services/carriers/carrier-sla-eligibility';
import { estimateCarrierRecovery } from '../services/carriers/carrier-recovery-estimate';
import { generateCarrierClaimPackage, type CarrierClaimPackage } from '../services/carriers/carrier-claim-package';
import {
  CARRIER_MANUAL_SUBMISSION_CAPABILITY,
  recordCarrierManualSubmission,
  type CarrierManualSubmissionContext,
} from '../services/carriers/carrier-manual-submission';
import { createPrismaCarrierManualSubmissionStore } from '../services/carriers/carrier-manual-submission-prisma-store';
import type { CarrierTrackingSnapshot } from '../services/carriers/carrier-tracking-read';
import type { CarrierInvoiceFact, CarrierPODFact } from '../services/carriers/carrier-invoice-pod-read';

const prisma = new PrismaClient();
const prismaB = new PrismaClient();
const ORG = 'cca90000-0000-4000-8000-000000000001';
const ORG_B = 'cca90000-0000-4000-8000-000000000009';
const USER = 'cca90000-0000-4000-8000-000000000002';
const USER_B = 'cca90000-0000-4000-8000-00000000000a';
const NOW = new Date('2026-10-03T00:00:00.000Z');
const TRACKING = '1Z999AA10123456784';

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

const INVOICE: CarrierInvoiceFact = {
  provider: 'UPS',
  externalAccountId: 'UPS-ACCT-1',
  invoiceReference: 'UPS-INV-1',
  invoiceDate: '2026-09-30',
  trackingNumber: TRACKING,
  shipmentReference: null,
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
  ...INVOICE,
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

const TERMS = {
  provider: 'UPS' as const,
  source: 'RATE_CARD' as const,
  termsReference: 'terms:ups-ground-2026',
  serviceLevel: 'GROUND',
  slaCommitmentHours: 72,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  rawReference: 'sha256:terms-1',
};

function packageFor(invoices: CarrierInvoiceFact[]): CarrierClaimPackage {
  const outcome = assembleShipmentEvidence(
    { organizationId: ORG, tracking: TRACKING_FACT, invoices, pod: POD, terms: TERMS },
    { now: () => NOW },
  );
  if (!outcome.ok) throw new Error('expected ok, got ' + outcome.reason);
  const eligibility = evaluateCarrierSlaEligibility(outcome.bundle, { now: () => NOW });
  const estimation = estimateCarrierRecovery({ bundle: outcome.bundle, eligibility });
  return generateCarrierClaimPackage({ bundle: outcome.bundle, eligibility, estimation }, { now: () => NOW });
}

function sourceFor(pkg: CarrierClaimPackage) {
  return {
    async load(organizationId: string, packageId: string) {
      return organizationId === pkg.organizationId && packageId === pkg.packageId ? pkg : null;
    },
  };
}

function contextFor(overrides: Partial<CarrierManualSubmissionContext> = {}): CarrierManualSubmissionContext {
  return {
    organizationId: ORG,
    actorUserId: USER,
    actorCapabilities: [CARRIER_MANUAL_SUBMISSION_CAPABILITY],
    ...overrides,
  };
}

function depsFor(pkg: CarrierClaimPackage | null, client = prisma) {
  return {
    packages: pkg === null ? { async load() { return null; } } : sourceFor(pkg),
    store: createPrismaCarrierManualSubmissionStore(client),
    audit: { async emit() {} },
    now: () => new Date('2026-10-03T01:00:00.000Z'),
  };
}

const AUDIT_ACTION = 'carrier.manual_submission_recorded';

beforeAll(async () => {
  await prisma.$connect();
  await prismaB.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await prismaB.$disconnect();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "CarrierManualSubmission", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'Q9B 租户', slug: 'q9b-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'Q9B 租户B', slug: 'q9b-org-b' } });
  await prisma.user.create({
    data: { id: USER, email: 'q9b-owner@example.com', passwordHash: 'x', displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.user.create({
    data: { id: USER_B, email: 'q9b-other@example.com', passwordHash: 'x', displayName: 'OTHER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG_B, userId: USER_B, role: 'OWNER' as never, isActive: true } });
});

describe('CARRIER QUEUE #9B FINAL — PostgreSQL manual submission record', () => {
  it('READY package + authorized actor → 一行 DB record + 一条同事务 business audit', async () => {
    const pkg = packageFor([INVOICE]);
    const outcome = await recordCarrierManualSubmission(
      { packageId: pkg.packageId, request: { carrierReference: 'CASE-1' }, context: contextFor() },
      depsFor(pkg),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe('RECORDED');
    const rows = await prisma.carrierManualSubmission.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(ORG);
    expect(rows[0].submittedByUserId).toBe(USER);
    expect(rows[0].carrierConfirmationStatus).toBe('NOT_VERIFIED');
    expect(rows[0].carrierReferenceProvenance).toBe('USER_PROVIDED_UNVERIFIED');
    expect(rows[0].submissionMode).toBe('MANUAL');
    const audits = await prisma.auditLog.findMany({ where: { action: AUDIT_ACTION } });
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(rows[0].id);
  });

  it('重复顺序调用 → 仍只有一行，且 audit 仍只有一条', async () => {
    const pkg = packageFor([INVOICE]);
    const first = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextFor() }, depsFor(pkg));
    const second = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextFor() }, depsFor(pkg));
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.status).toBe('RECORDED');
    expect(second.status).toBe('ALREADY_RECORDED');
    expect(second.record.submissionRecordId).toBe(first.record.submissionRecordId);
    expect(await prisma.carrierManualSubmission.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION } })).toBe(1);
  });

  it('㉙ 真实并发（两个独立连接）→ 只产生一行，结果为 RECORDED + ALREADY_RECORDED', async () => {
    const pkg = packageFor([INVOICE]);
    const [a, b] = await Promise.all([
      recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextFor() }, depsFor(pkg, prisma)),
      recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextFor() }, depsFor(pkg, prismaB)),
    ]);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect([a.status, b.status].sort()).toEqual(['ALREADY_RECORDED', 'RECORDED']);
    expect(a.record.submissionRecordId).toBe(b.record.submissionRecordId);
    expect(await prisma.carrierManualSubmission.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION } })).toBe(1);
  });

  it('NEEDS_REVIEW package → 零 row、零 audit', async () => {
    const pkg = packageFor([PARTIAL_INVOICE]);
    expect(pkg.packageStatus).toBe('NEEDS_REVIEW');
    const outcome = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextFor() }, depsFor(pkg));
    expect(outcome.ok ? null : outcome.reason).toBe('PACKAGE_NOT_READY');
    expect(await prisma.carrierManualSubmission.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION } })).toBe(0);
  });

  it('cross-tenant（context org 与 package org 不同）→ 零 row', async () => {
    const pkg = packageFor([INVOICE]);
    const outcome = await recordCarrierManualSubmission(
      { packageId: pkg.packageId, request: {}, context: contextFor({ organizationId: ORG_B, actorUserId: USER_B }) },
      depsFor(pkg),
    );
    expect(outcome.ok ? null : outcome.reason).toBe('PACKAGE_NOT_FOUND');
    expect(await prisma.carrierManualSubmission.count()).toBe(0);
  });

  it('无 capability → 零 row', async () => {
    const pkg = packageFor([INVOICE]);
    const outcome = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextFor({ actorCapabilities: [] }) }, depsFor(pkg));
    expect(outcome.ok ? null : outcome.reason).toBe('CAPABILITY_REQUIRED');
    expect(await prisma.carrierManualSubmission.count()).toBe(0);
  });

  it('client 注入身份被忽略（DB row 使用 server-derived 值）', async () => {
    const pkg = packageFor([INVOICE]);
    const outcome = await recordCarrierManualSubmission(
      {
        packageId: pkg.packageId,
        request: { carrierReference: null, organizationId: ORG_B, submittedByUserId: USER_B } as never,
        context: contextFor(),
      },
      depsFor(pkg),
    );
    if (!outcome.ok) throw new Error('expected ok');
    const row = await prisma.carrierManualSubmission.findFirstOrThrow({});
    expect(row.organizationId).toBe(ORG);
    expect(row.submittedByUserId).toBe(USER);
  });

  it('㉜ append-only：UPDATE / DELETE 被数据库拒绝', async () => {
    const pkg = packageFor([INVOICE]);
    const outcome = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextFor() }, depsFor(pkg));
    if (!outcome.ok) throw new Error('expected ok');
    await expect(
      prisma.$executeRawUnsafe('UPDATE "CarrierManualSubmission" SET "note" = \'tampered\''),
    ).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('DELETE FROM "CarrierManualSubmission"')).rejects.toThrow();
    expect(await prisma.carrierManualSubmission.count()).toBe(1);
  });

  it('无 carrier 网络调用（record 路径）', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const pkg = packageFor([INVOICE]);
    const outcome = await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextFor() }, depsFor(pkg));
    expect(outcome.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('㉟ 不产生 recovered-money 字段（DB row 列集合固定）', async () => {
    const pkg = packageFor([INVOICE]);
    await recordCarrierManualSubmission({ packageId: pkg.packageId, request: {}, context: contextFor() }, depsFor(pkg));
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      'SELECT column_name FROM information_schema.columns WHERE table_name = \'CarrierManualSubmission\'',
    );
    const names = columns.map((c) => c.column_name);
    for (const forbidden of ['actualRecovered', 'recoveryPayout', 'successFee', 'commission', 'credentialRef', 'accessToken']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
