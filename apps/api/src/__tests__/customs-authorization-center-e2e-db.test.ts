/**
 * CA-5 REVISE D 真实端到端验收（MSG-20261004-08）：
 * login session → WORKFLOW_PATH → GET /customs-opportunities/:id/authorization-center → 真实只读 loader。
 * 覆盖：200 本租户 / 403 VIEWER / 401 未认证 / 404 不存在 / 404 跨租户 / 405 非 GET / 无授权事实时 fail-closed。
 * 注意：本测试**不注入** customsAuthorizationCenter，刻意验证 composition root 自动装配。
 */

import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { hashPassword } from '../services/auth';
import type { CustomsOpportunityTruth } from '../services/customs/customs-one-click-start';

const prisma = new PrismaClient();
const ORG = 'ca500000-0000-4000-8000-000000000001';
const ORG2 = 'ca500000-0000-4000-8000-000000000009';
const USER = 'ca500000-0000-4000-8000-000000000002';
const VIEWER = 'ca500000-0000-4000-8000-000000000003';
const OTHER = 'ca500000-0000-4000-8000-000000000004';
const OPP = 'opp-ca5-e2e';
const SALT = 'ca5-e2e-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'ca5-e2e-pass-1';

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

const OPPORTUNITIES = {
  async load(organizationId: string, opportunityId: string) {
    return organizationId === ORG && opportunityId === OPP ? TRUTH : null;
  },
};

const READY_FLAGS = {
  customsAgreementSigned: true,
  importerOfRecordConfirmed: true,
  claimantConfirmed: true,
  recoveryRightConfirmed: true,
  brokerConnected: true,
  brokerAuthorizationValid: true,
  filingPermissionValid: true,
  providerCapabilityReady: true,
};

const PROVIDER = {
  providerId: 'broker-a',
  capabilities: { DATA_READ: true, FILING_CREATE: true, DOCUMENT_UPLOAD: true, STATUS_READ: true },
};

function withServer<T>(
  deps: Record<string, unknown>,
  run: (base: string) => Promise<T>,
): Promise<T> {
  const server = createServer({ prisma, log, audit, actionGuard: PERMISSIVE_GUARD, ...deps } as never);
  return new Promise<T>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const base = 'http://127.0.0.1:' + port;
      run(base).then(
        async (value) => {
          await new Promise<void>((done) => server.close(() => done()));
          resolve(value);
        },
        async (error) => {
          await new Promise<void>((done) => server.close(() => done()));
          reject(error);
        },
      );
    });
  });
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

function getCenter(base: string, opportunityId: string, cookie?: string) {
  return fetch(base + '/customs-opportunities/' + encodeURIComponent(opportunityId) + '/authorization-center', {
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
    'TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'CA5 E2E', slug: 'ca5-e2e' } });
  await prisma.organization.create({ data: { id: ORG2, name: 'CA5 E2E OTHER', slug: 'ca5-e2e-other' } });
  await prisma.user.create({
    data: {
      id: USER,
      email: 'ca5-owner@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.user.create({
    data: {
      id: VIEWER,
      email: 'ca5-viewer@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'VIEWER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: VIEWER, role: 'VIEWER' as never, isActive: true } });
  await prisma.user.create({
    data: {
      id: OTHER,
      email: 'ca5-other@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OTHER OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: ORG2, userId: OTHER, role: 'OWNER' as never, isActive: true } });
});

describe('CA-5 — authorization center HTTP E2E（真实 PostgreSQL + composition root）', () => {
  it('未认证 → 401', async () => {
    await withServer({ customsOpportunities: OPPORTUNITIES, customsAuthorization: READY_FLAGS, customsFilingProvider: PROVIDER }, async (base) => {
      const res = await getCenter(base, OPP);
      expect(res.status).toBe(401);
    });
  });

  it('VIEWER → 403（复用既有海关只读角色，不新造权限）', async () => {
    await withServer({ customsOpportunities: OPPORTUNITIES, customsAuthorization: READY_FLAGS, customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5-viewer@example.com');
      const res = await getCenter(base, OPP, cookie);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { reason: string }).reason).toBe('ROLE_NOT_PERMITTED');
    });
  });

  it('OWNER 本租户 → 200：六项清单 + 只读边界（composition root 自动装配 loader）', async () => {
    await withServer({ customsOpportunities: OPPORTUNITIES, customsAuthorization: READY_FLAGS, customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5-owner@example.com');
      const res = await getCenter(base, OPP, cookie);
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as {
        opportunityId: string;
        authorizationCenter: { items: unknown[]; nextAction: string; filingSubmitted: boolean };
        boundary: Record<string, unknown>;
      };
      expect(body.opportunityId).toBe(OPP);
      expect(body.authorizationCenter.items).toHaveLength(6);
      expect(body.authorizationCenter.nextAction).toBe('START_RECOVERY');
      expect(body.authorizationCenter.filingSubmitted).toBe(false);
      expect(body.boundary).toEqual({
        readOnly: true,
        filingSubmitted: false,
        transportEnabled: false,
        externalWritePerformed: false,
        productionCredentials: 'ABSENT',
      });
      for (const forbidden of ['credential', 'accessToken', 'providerWrite']) {
        expect(text).not.toContain(forbidden);
      }
    });
  });

  it('未知 opportunity → 404；跨租户 opportunity → 404（不泄露存在性）', async () => {
    await withServer({ customsOpportunities: OPPORTUNITIES, customsAuthorization: READY_FLAGS, customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5-owner@example.com');
      const missing = await getCenter(base, 'opp-missing', cookie);
      expect(missing.status).toBe(404);
      // 同 id 但另一租户的会话：loader 收到该会话的 organizationId → null（anti-enumeration）
      const otherCookie = await login(base, 'ca5-other@example.com');
      const crossTenant = await getCenter(base, OPP, otherCookie);
      expect(crossTenant.status).toBe(404);
    });
  });

  it('非 GET → 405', async () => {
    await withServer({ customsOpportunities: OPPORTUNITIES, customsAuthorization: READY_FLAGS, customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5-owner@example.com');
      const res = await fetch(base + '/customs-opportunities/' + OPP + '/authorization-center', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{}',
      });
      expect(res.status).toBe(405);
    });
  });

  it('无授权事实（fail-closed）：不得显示已确认 / 可提交', async () => {
    await withServer({ customsOpportunities: OPPORTUNITIES }, async (base) => {
      const cookie = await login(base, 'ca5-owner@example.com');
      const res = await getCenter(base, OPP, cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        authorizationCenter: {
          items: Array<{ key: string; state: string; action: string | null }>;
          nextAction: string | null;
          stages: { READY_TO_FILE: boolean };
        };
      };
      const broker = body.authorizationCenter.items.find((entry) => entry.key === 'BROKER_AUTHORIZATION');
      expect(broker?.state).toBe('NEEDS_ACTION');
      expect(body.authorizationCenter.stages.READY_TO_FILE).toBe(false);
      expect(body.authorizationCenter.nextAction).not.toBe('START_RECOVERY');
    });
  });
});
