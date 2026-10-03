/**
 * CARRIER QUEUE #10 FINAL（MSG-20261003-122 ㉙㉛㉝）— 真实 HTTP 端到端验收。
 * 断言：401 未认证 / 403 VIEWER / 404 未知 package（anti-enumeration）/ 400 client 提交 source
 *       / 201 首次人工补录（DB row + 同事务审计恰好一次，source 恒 USER_REPORTED）/ 200 幂等重放
 *       / GET 读模型 tenant-scoped（currentStatus + history，无 credential）。
 */

import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';

const prisma = new PrismaClient();
const ORG = 'cce00000-0000-4000-8000-000000000001';
const USER = 'cce00000-0000-4000-8000-000000000002';
const VIEWER = 'cce00000-0000-4000-8000-000000000003';
const SUB = 'cce10000-0000-4000-8000-000000000001';
const PKG = 'pkg-q10f-e2e';
const SALT = 'q10f-e2e-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'q10f-e2e-pass-1';
const NOW = new Date('2026-10-03T11:00:00.000Z');
const AUDIT_ACTION = 'carrier.claim_response_recorded';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const PERMISSIVE_GUARD = { async assertAllowed() {} };

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, actionGuard: PERMISSIVE_GUARD } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run('http://127.0.0.1:' + port);
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

function submit(base: string, packageId: string, cookie: string | undefined, body: unknown) {
  return fetch(base + '/carrier-claim-packages/' + encodeURIComponent(packageId) + '/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function read(base: string, packageId: string, cookie?: string) {
  return fetch(base + '/carrier-claim-packages/' + encodeURIComponent(packageId) + '/responses', {
    headers: { ...(cookie ? { cookie } : {}) },
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
    'TRUNCATE TABLE "CarrierClaimResponseFact", "AuditLog", "CarrierManualSubmission", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'Q10F E2E 租户', slug: 'q10f-e2e-org' } });
  await prisma.user.create({
    data: { id: USER, email: 'q10f-e2e-owner@example.com', passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.user.create({
    data: { id: VIEWER, email: 'q10f-e2e-viewer@example.com', passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'VIEWER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: VIEWER, role: 'VIEWER' as never, isActive: true } });
  // server-side submission truth（Queue #9B 人工提交事实）——response 必须绑定真实 submission
  await prisma.carrierManualSubmission.create({
    data: {
      id: SUB,
      organizationId: ORG,
      packageId: PKG,
      bundleId: 'bundle-q10f-e2e',
      provider: 'UPS',
      externalAccountId: 'UPS-ACCT-1',
      trackingNumber: '1Z999AA10123456784',
      submittedByUserId: USER,
      submittedAt: NOW,
      recordedAt: NOW,
      carrierConfirmationStatus: 'NOT_VERIFIED',
      submissionMode: 'MANUAL',
      channel: 'PORTAL',
      eligibilityRuleSetId: 'rs-elig',
      eligibilityRuleSetVersion: '1.0.1',
      estimateRuleSetId: 'rs-est',
      estimateRuleSetVersion: '1.0.0',
      packageSnapshotReference: 'pkg-snapshot:sha256:e2e',
    } as never,
  });
});

describe('CARRIER QUEUE #10 FINAL — HTTP E2E', () => {
  it('未认证 POST → 401 且零 fact', async () => {
    await withServer(async (base) => {
      const res = await submit(base, PKG, undefined, { status: 'APPROVED' });
      expect(res.status).toBe(401);
      expect(await prisma.carrierClaimResponseFact.count()).toBe(0);
    });
  });

  it('VIEWER（无 capability）→ 403 且零 fact', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q10f-e2e-viewer@example.com');
      const res = await submit(base, PKG, cookie, { status: 'APPROVED' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'CAPABILITY_REQUIRED' });
      expect(await prisma.carrierClaimResponseFact.count()).toBe(0);
    });
  });

  it('未知 package → 404（anti-enumeration）且零 fact', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q10f-e2e-owner@example.com');
      const res = await submit(base, 'pkg-missing', cookie, { status: 'APPROVED' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'SUBMISSION_NOT_FOUND' });
      expect(await prisma.carrierClaimResponseFact.count()).toBe(0);
    });
  });

  it('㉙ client 试图提交 provider source → 400 且零 fact', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q10f-e2e-owner@example.com');
      const res = await submit(base, PKG, cookie, { status: 'APPROVED', source: 'PROVIDER_API', providerReference: 'X' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; detail?: string };
      expect(body.code).toBe('INVALID_REQUEST');
      expect(body.detail).toBe('FIELD_NOT_ALLOWED:source');
      expect(await prisma.carrierClaimResponseFact.count()).toBe(0);
    });
  });

  it('OWNER 人工补录 → 201（DB row 恒 USER_REPORTED/UNVERIFIED + 审计恰好一次）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q10f-e2e-owner@example.com');
      const res = await submit(base, PKG, cookie, { status: 'APPROVED', providerReference: 'CASE-E2E' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { status: string; responseFact: { source: string; verificationLevel: string } };
      expect(body.status).toBe('RECORDED');
      expect(body.responseFact.source).toBe('USER_REPORTED');
      expect(body.responseFact.verificationLevel).toBe('UNVERIFIED');
      const rows = await prisma.carrierClaimResponseFact.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0].organizationId).toBe(ORG);
      expect(rows[0].submissionRecordId).toBe(SUB);
      expect(rows[0].source).toBe('USER_REPORTED');
      expect(rows[0].verificationLevel).toBe('UNVERIFIED');
      expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION } })).toBe(1);
    });
  });

  it('重复 POST → 200 ALREADY_RECORDED，仍一行、审计一次', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q10f-e2e-owner@example.com');
      const first = await submit(base, PKG, cookie, { status: 'PAID' });
      const second = await submit(base, PKG, cookie, { status: 'PAID' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      const body = (await second.json()) as { status: string };
      expect(body.status).toBe('ALREADY_RECORDED');
      expect(await prisma.carrierClaimResponseFact.count()).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION } })).toBe(1);
    });
  });

  it('㉛ GET 读模型 → 200（currentStatus + history，无 credential）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q10f-e2e-owner@example.com');
      // 注意：observedAt 不得是未来时间（服务端 fail-closed 为 FUTURE_TIMESTAMP → 400）
      const first = await submit(base, PKG, cookie, { status: 'PENDING', observedAt: '2026-10-03T05:00:00.000Z' });
      const second = await submit(base, PKG, cookie, { status: 'APPROVED', observedAt: '2026-10-03T06:00:00.000Z' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const res = await read(base, PKG, cookie);
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as { responses: { currentStatus: string; history: unknown[]; derivesRecoveredCash: boolean } };
      expect(body.responses.currentStatus).toBe('APPROVED');
      expect(body.responses.history).toHaveLength(2);
      expect(body.responses.derivesRecoveredCash).toBe(false);
      for (const forbidden of ['credential', 'accessToken', 'secret', 'successFee', 'actualRecovered']) {
        expect(text).not.toContain(forbidden);
      }
    });
  });

  it('GET 未知 package → 404；GET 未认证 → 401', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'q10f-e2e-owner@example.com');
      const missing = await read(base, 'pkg-missing', cookie);
      expect(missing.status).toBe(404);
      const anonymous = await read(base, PKG);
      expect(anonymous.status).toBe(401);
    });
  });
});
