/**
 * CARRIER QUEUE #10 FINAL（MSG-20261003-122 ⑳–㉝）— 真实 PostgreSQL 验收。
 * 断言：DB 真值 CHECK（USER_REPORTED → UNVERIFIED；非法组合拒绝）、provider reference 必填、
 *       append-only 拒绝 UPDATE/DELETE、tenant guard（跨租户引用被拒）、DB 幂等（UNIQUE）、
 *       fact + business audit 同事务恰好一次、真实并发只产生一行、投影确定性、资金边界。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARRIER_CLAIM_RESPONSE_CAPABILITY,
  projectCarrierClaimResponse,
  recordCarrierClaimResponse,
  type CarrierClaimResponseContext,
  type CarrierClaimResponseDeps,
} from '../services/carriers/carrier-claim-response';
import { createPrismaCarrierClaimResponseStore } from '../services/carriers/carrier-claim-response-prisma-store';

const prisma = new PrismaClient();
const prismaB = new PrismaClient();
const ORG = 'ccd00000-0000-4000-8000-000000000001';
const ORG_B = 'ccd00000-0000-4000-8000-000000000009';
const USER = 'ccd00000-0000-4000-8000-000000000002';
const USER_B = 'ccd00000-0000-4000-8000-00000000000a';
const SUB_A = 'ccd10000-0000-4000-8000-000000000001';
const SUB_B = 'ccd10000-0000-4000-8000-000000000009';
const PKG = 'pkg-q10f-a';
const PKG_B = 'pkg-q10f-b';
const TRACK = '1Z999AA10123456784';
const NOW = new Date('2026-10-03T09:00:00.000Z');
const AUDIT_ACTION = 'carrier.claim_response_recorded';

function submissionData(id: string, organizationId: string, packageId: string, userId: string) {
  return {
    id,
    organizationId,
    packageId,
    bundleId: 'bundle-q10f',
    provider: 'UPS',
    externalAccountId: 'UPS-ACCT-1',
    trackingNumber: TRACK,
    submittedByUserId: userId,
    submittedAt: NOW,
    recordedAt: NOW,
    carrierConfirmationStatus: 'NOT_VERIFIED',
    submissionMode: 'MANUAL',
    channel: 'PORTAL',
    eligibilityRuleSetId: 'rs-elig',
    eligibilityRuleSetVersion: '1.0.1',
    estimateRuleSetId: 'rs-est',
    estimateRuleSetVersion: '1.0.0',
    packageSnapshotReference: 'pkg-snapshot:sha256:q10f',
  };
}

function contextFor(overrides: Partial<CarrierClaimResponseContext> = {}): CarrierClaimResponseContext {
  return {
    organizationId: ORG,
    actorUserId: USER,
    actorCapabilities: [CARRIER_CLAIM_RESPONSE_CAPABILITY],
    ...overrides,
  };
}

function depsFor(client = prisma): CarrierClaimResponseDeps {
  return {
    submissions: {
      async load(organizationId, packageId) {
        if (organizationId === ORG && packageId === PKG) {
          return {
            packageId: PKG,
            submissionRecordId: SUB_A,
            provider: 'UPS' as const,
            externalAccountId: 'UPS-ACCT-1',
            trackingNumber: TRACK,
          };
        }
        if (organizationId === ORG_B && packageId === PKG_B) {
          return {
            packageId: PKG_B,
            submissionRecordId: SUB_B,
            provider: 'UPS' as const,
            externalAccountId: 'UPS-ACCT-1',
            trackingNumber: TRACK,
          };
        }
        return null;
      },
    },
    store: createPrismaCarrierClaimResponseStore(client),
    now: () => NOW,
  };
}

const RAW_COLUMNS = [
  '"id"',
  '"organizationId"',
  '"packageId"',
  '"submissionRecordId"',
  '"provider"',
  '"externalAccountId"',
  '"trackingNumber"',
  '"status"',
  '"source"',
  '"verificationLevel"',
  '"providerReference"',
  '"observedAt"',
  '"recordedAt"',
  '"recordedByUserId"',
  '"idempotencyKey"',
].join(', ');

function directInsert(opts: {
  id: string;
  organizationId?: string;
  submissionRecordId?: string;
  status?: string;
  source?: string;
  verificationLevel?: string;
  providerReference?: string | null;
  idempotencyKey?: string;
  packageId?: string;
}) {
  return prisma.$executeRawUnsafe(
    'INSERT INTO "CarrierClaimResponseFact" (' +
      RAW_COLUMNS +
      ') VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now(),$12,$13)',
    opts.id,
    opts.organizationId ?? ORG,
    opts.packageId ?? PKG,
    opts.submissionRecordId ?? SUB_A,
    'UPS',
    'UPS-ACCT-1',
    TRACK,
    opts.status ?? 'APPROVED',
    opts.source ?? 'USER_REPORTED',
    opts.verificationLevel ?? 'UNVERIFIED',
    opts.providerReference ?? null,
    USER,
    opts.idempotencyKey ?? 'raw-' + opts.id,
  );
}

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
    'TRUNCATE TABLE "CarrierClaimResponseFact", "AuditLog", "CarrierManualSubmission", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'Q10F 租户', slug: 'q10f-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'Q10F 租户B', slug: 'q10f-org-b' } });
  await prisma.user.create({
    data: { id: USER, email: 'q10f@example.com', passwordHash: 'x', displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.user.create({
    data: { id: USER_B, email: 'q10f-b@example.com', passwordHash: 'x', displayName: 'OTHER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG_B, userId: USER_B, role: 'OWNER' as never, isActive: true } });
  await prisma.carrierManualSubmission.create({ data: submissionData(SUB_A, ORG, PKG, USER) as never });
  await prisma.carrierManualSubmission.create({ data: submissionData(SUB_B, ORG_B, PKG_B, USER_B) as never });
});

describe('CARRIER QUEUE #10 FINAL — PostgreSQL response facts', () => {
  it('㉖㉝ USER_REPORTED 事实：一行 DB record + 同事务 business audit 恰好一次', async () => {
    const outcome = await recordCarrierClaimResponse(
      { packageId: PKG, request: { status: 'APPROVED', source: 'USER_REPORTED', providerReference: 'CASE-1' }, context: contextFor() },
      depsFor(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe('RECORDED');
    expect(outcome.fact.verificationLevel).toBe('UNVERIFIED');
    const rows = await prisma.carrierClaimResponseFact.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(ORG);
    expect(rows[0].submissionRecordId).toBe(SUB_A);
    expect(rows[0].verificationLevel).toBe('UNVERIFIED');
    const audits = await prisma.auditLog.findMany({ where: { action: AUDIT_ACTION } });
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(rows[0].id);
  });

  it('㉕㉝ 重复 append → ALREADY_RECORDED，仍一行、审计仍一次', async () => {
    const request = { status: 'UNDER_REVIEW' as const, source: 'USER_REPORTED' as const };
    const first = await recordCarrierClaimResponse({ packageId: PKG, request, context: contextFor() }, depsFor());
    const second = await recordCarrierClaimResponse({ packageId: PKG, request, context: contextFor() }, depsFor());
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.status).toBe('RECORDED');
    expect(second.status).toBe('ALREADY_RECORDED');
    expect(second.fact.factId).toBe(first.fact.factId);
    expect(await prisma.carrierClaimResponseFact.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION } })).toBe(1);
  });

  it('㉝ 真实并发（两个独立连接）→ 只产生一行，结果为 RECORDED + ALREADY_RECORDED，审计一次', async () => {
    const request = { status: 'PAID' as const, source: 'USER_REPORTED' as const };
    const [a, b] = await Promise.all([
      recordCarrierClaimResponse({ packageId: PKG, request, context: contextFor() }, depsFor(prisma)),
      recordCarrierClaimResponse({ packageId: PKG, request, context: contextFor() }, depsFor(prismaB)),
    ]);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect([a.status, b.status].sort()).toEqual(['ALREADY_RECORDED', 'RECORDED']);
    expect(a.fact.factId).toBe(b.fact.factId);
    expect(await prisma.carrierClaimResponseFact.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION } })).toBe(1);
  });

  it('㉑ DB enum 真值：未知 status / source / verificationLevel 直写被拒绝', async () => {
    await expect(directInsert({ id: 'ccd2-1', status: 'BOGUS' })).rejects.toThrow();
    await expect(directInsert({ id: 'ccd2-2', source: 'BOGUS' })).rejects.toThrow();
    await expect(directInsert({ id: 'ccd2-3', verificationLevel: 'BOGUS' })).rejects.toThrow();
    expect(await prisma.carrierClaimResponseFact.count()).toBe(0);
  });

  it('㉑㉒ DB truth：USER_REPORTED + PROVIDER_VERIFIED 直写被拒绝（两层 CHECK 之一）', async () => {
    await expect(
      directInsert({ id: 'ccd3-1', source: 'USER_REPORTED', verificationLevel: 'PROVIDER_VERIFIED' }),
    ).rejects.toThrow();
    expect(await prisma.carrierClaimResponseFact.count()).toBe(0);
  });

  it('㉑ provider 来源必须携带 providerReference（直写缺 reference 被拒绝）', async () => {
    await expect(
      directInsert({ id: 'ccd4-1', source: 'PROVIDER_API', verificationLevel: 'PROVIDER_VERIFIED', providerReference: null }),
    ).rejects.toThrow();
    await directInsert({
      id: 'ccd4-2',
      source: 'PROVIDER_API',
      verificationLevel: 'PROVIDER_VERIFIED',
      providerReference: 'CASE-P1',
    });
    expect(await prisma.carrierClaimResponseFact.count()).toBe(1);
  });

  it('㉓ append-only：UPDATE / DELETE 被数据库拒绝', async () => {
    await recordCarrierClaimResponse(
      { packageId: PKG, request: { status: 'APPROVED', source: 'USER_REPORTED' }, context: contextFor() },
      depsFor(),
    );
    await expect(
      prisma.$executeRawUnsafe('UPDATE "CarrierClaimResponseFact" SET "status" = \'PAID\''),
    ).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('DELETE FROM "CarrierClaimResponseFact"')).rejects.toThrow();
    expect(await prisma.carrierClaimResponseFact.count()).toBe(1);
  });

  it('㉔ tenant guard：跨租户引用（fact.org=ORG 但 submission 属于 ORG_B）被拒绝', async () => {
    await expect(
      directInsert({ id: 'ccd5-1', organizationId: ORG, submissionRecordId: SUB_B, idempotencyKey: 'cross-1' }),
    ).rejects.toThrow();
    expect(await prisma.carrierClaimResponseFact.count()).toBe(0);
  });

  it('㉝ tenant-scoped 读：listByPackage 不返回其他租户事实', async () => {
    await recordCarrierClaimResponse(
      { packageId: PKG, request: { status: 'APPROVED', source: 'USER_REPORTED' }, context: contextFor() },
      depsFor(),
    );
    const store = createPrismaCarrierClaimResponseStore(prisma);
    expect(await store.listByPackage(ORG_B, PKG_B)).toHaveLength(0);
    expect(await store.listByPackage(ORG, PKG)).toHaveLength(1);
  });

  it('㉝ 投影确定性 + APPROVED != PAID（从 DB 事实 derive）', async () => {
    const deps = depsFor();
    await recordCarrierClaimResponse(
      { packageId: PKG, request: { status: 'PENDING', source: 'USER_REPORTED', observedAt: '2026-10-03T06:00:00.000Z' }, context: contextFor() },
      deps,
    );
    await recordCarrierClaimResponse(
      { packageId: PKG, request: { status: 'APPROVED', source: 'USER_REPORTED', observedAt: '2026-10-03T07:00:00.000Z' }, context: contextFor() },
      deps,
    );
    const facts = await createPrismaCarrierClaimResponseStore(prisma).listByPackage(ORG, PKG);
    const projection = projectCarrierClaimResponse(facts, { organizationId: ORG, packageId: PKG });
    expect(projection.statusHistory.map((h) => h.status)).toEqual(['PENDING', 'APPROVED']);
    expect(projection.currentStatus).toBe('APPROVED');
    expect(projection.currentStatus).not.toBe('PAID');
    expect(projection.derivesRecoveredCash).toBe(false);
    const reversed = projectCarrierClaimResponse(facts.slice().reverse(), { organizationId: ORG, packageId: PKG });
    expect(reversed).toEqual(projection);
  });

  it('㉝ PAID 事实不产生资金真值（RecoveryPayout / actualRecovered / FeeCalculation 零行）', async () => {
    const outcome = await recordCarrierClaimResponse(
      { packageId: PKG, request: { status: 'PAID', source: 'USER_REPORTED' }, context: contextFor() },
      depsFor(),
    );
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.fact.recoveredCashUpdated).toBe(false);
    expect(outcome.fact.successFeeCalculated).toBe(false);
    expect(outcome.fact.paymentCollectionPerformed).toBe(false);
    expect(await prisma.recoveryPayout.count()).toBe(0);
    expect(await prisma.feeCalculation.count()).toBe(0);
    expect(await prisma.settlement.count()).toBe(0);
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      'SELECT column_name FROM information_schema.columns WHERE table_name = \'CarrierClaimResponseFact\'',
    );
    const names = columns.map((c) => c.column_name);
    for (const forbidden of ['actualRecovered', 'successFee', 'commission', 'collectionAmount', 'credentialRef', 'accessToken']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('㉝ 记录路径无网络 / 无 carrier write', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const outcome = await recordCarrierClaimResponse(
        { packageId: PKG, request: { status: 'CLOSED', source: 'USER_REPORTED' }, context: contextFor() },
        depsFor(),
      );
      if (!outcome.ok) throw new Error('expected ok');
      expect(outcome.fact.externalWritePerformed).toBe(false);
      expect(outcome.fact.transportEnabled).toBe(false);
      expect(outcome.fact.platformWriteEnabled).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
