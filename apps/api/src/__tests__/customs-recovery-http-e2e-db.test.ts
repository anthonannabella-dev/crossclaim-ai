/**
 * C21 HTTP 真实端到端验收（MSG-20261003-124 ⑭–㉑ / MSG-20261003-126 授权）。
 * 401 未认证 / 403 VIEWER / 404 未知 opportunity / 400 client 领域字段 / 200 READY_TO_FILE（filingSubmitted=false）
 * / GET filing-status 读模型 200 + 未认证 401。
 */

import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import type { CustomsOpportunityTruth } from '../services/customs/customs-one-click-start';

const prisma = new PrismaClient();
const ORG = 'cc210000-0000-4000-8000-000000000001';
const USER = 'cc210000-0000-4000-8000-000000000002';
const VIEWER = 'cc210000-0000-4000-8000-000000000003';
const OPP = 'opp-c21-e2e';
const SALT = 'c21-e2e-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'c21-e2e-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const PERMISSIVE_GUARD = { async assertAllowed() {} };

const TRUTH: CustomsOpportunityTruth = {
  opportunityId: OPP,
  organizationId: ORG,
  entryFactPresent: true,
  evidenceBundleCompleteness: 'COMPLETE',
  eligibilityDecision: 'ELIGIBLE',
  recoverableAmounts: [{ currency: 'USD', amount: '18620.00' }],
  remedyRoute: 'DRAWBACK',
  filingDeadline: '2027-05-01',
  recoveryPackageStatus: 'READY',
  ruleVersion: 'us-customs-v1',
};

const C21_DEPS = {
  customsOpportunities: {
    async load(organizationId: string, opportunityId: string) {
      return organizationId === ORG && opportunityId === OPP ? TRUTH : null;
    },
  },
  customsAuthorization: {
    customsAgreementSigned: true,
    importerOfRecordConfirmed: true,
    claimantConfirmed: true,
    recoveryRightConfirmed: true,
    brokerConnected: true,
    brokerAuthorizationValid: true,
    filingPermissionValid: true,
    providerCapabilityReady: true,
  },
  customsFilingProvider: { providerId: 'broker-a', capabilities: { DATA_READ: true, FILING_CREATE: true, DOCUMENT_UPLOAD: true, STATUS_READ: true } },
  customsFilingStatus: { async listFacts() { return []; } },
  now: () => new Date('2026-10-03T09:00:00.000Z'),
};

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, actionGuard: PERMISSIVE_GUARD, ...C21_DEPS } as never);
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

function postStart(base: string, opportunityId: string, cookie: string | undefined, body: unknown = {}) {
  return fetch(base + '/customs-opportunities/' + encodeURIComponent(opportunityId) + '/start-recovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function getStatus(base: string, opportunityId: string, cookie?: string) {
  return fetch(base + '/customs-opportunities/' + encodeURIComponent(opportunityId) + '/filing-status', {
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
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;');
  await prisma.organization.create({ data: { id: ORG, name: 'C21 E2E', slug: 'c21-e2e' } });
  await prisma.user.create({
    data: { id: USER, email: 'c21-owner@example.com', passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.user.create({
    data: { id: VIEWER, email: 'c21-viewer@example.com', passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'VIEWER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: VIEWER, role: 'VIEWER' as never, isActive: true } });
});

describe('C21 — customs recovery HTTP E2E', () => {
  it('未认证 POST → 401', async () => {
    await withServer(async (base) => {
      const res = await postStart(base, OPP, undefined, {});
      expect(res.status).toBe(401);
    });
  });

  it('VIEWER → 403 CAPABILITY_REQUIRED', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'c21-viewer@example.com');
      const res = await postStart(base, OPP, cookie, {});
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('CAPABILITY_REQUIRED');
    });
  });

  it('未知 opportunity → 404（anti-enumeration）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'c21-owner@example.com');
      const res = await postStart(base, 'opp-missing', cookie, {});
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe('OPPORTUNITY_NOT_FOUND');
    });
  });

  it('client 注入领域字段 → 400 且无 snapshot', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'c21-owner@example.com');
      const res = await postStart(base, OPP, cookie, { feeRate: '0.30' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; detail?: string };
      expect(body.code).toBe('INVALID_REQUEST');
      expect(body.detail).toBe('FIELD_NOT_ALLOWED:feeRate');
    });
  });

  it('OWNER 全通过 → 200 READY_TO_FILE 且 filingSubmitted=false / externalExecutionStatus=NOT_STARTED', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'c21-owner@example.com');
      const res = await postStart(base, OPP, cookie, {});
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body.recoveryStatus).toBe('READY_TO_FILE');
      expect(body.filingSubmitted).toBe(false);
      expect(body.externalExecutionStatus).toBe('NOT_STARTED');
      for (const forbidden of ['credential', 'accessToken', 'successFee', 'actualRecovered']) {
        expect(text).not.toContain(forbidden);
      }
    });
  });

  it('GET filing-status → 200 读模型；未认证 → 401', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'c21-owner@example.com');
      const ok = await getStatus(base, OPP, cookie);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { filingStatus: { currentStatus: unknown; derivesRecoveredCash: boolean } };
      expect(body.filingStatus.currentStatus).toBeNull();
      expect(body.filingStatus.derivesRecoveredCash).toBe(false);
      const anon = await getStatus(base, OPP);
      expect(anon.status).toBe(401);
    });
  });
});
