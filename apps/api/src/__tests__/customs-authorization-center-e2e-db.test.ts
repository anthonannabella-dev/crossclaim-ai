/**
 * CA-5 REVISE D（MSG-20261004-09）真实端到端验收：
 * **真实 PostgreSQL 授权事实**（CustomsRightLineageFact / CustomsIorIdentityFact / CustomsBrokerPoaFact /
 * RecoveryRoute）→ Prisma 只读 loader → GET /customs-opportunities/:id/authorization-center。
 * 覆盖：200 本租户 / 403 VIEWER / 401 未认证 / 404 无 route 或无 lineage / 404 跨租户 / 405 非 GET。
 */

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { hashPassword } from '../services/auth';

const prisma = new PrismaClient();
const ORG = 'ca510000-0000-4000-8000-000000000001';
const ORG2 = 'ca510000-0000-4000-8000-000000000009';
const USER = 'ca510000-0000-4000-8000-000000000002';
const VIEWER = 'ca510000-0000-4000-8000-000000000003';
const OTHER = 'ca510000-0000-4000-8000-000000000004';
const OPP = 'ca5-e2e-opp';
const OPP_NO_ROUTE = 'ca5-e2e-opp-no-route';
const OPP_NO_LINEAGE = 'ca5-e2e-opp-no-lineage';
const OPP_EXPIRED_IOR = 'ca5-e2e-opp-expired-ior';
const OPP_NO_FILING_AUTH = 'ca5-e2e-opp-no-filing-auth';
const OPP_SELF = 'ca5-e2e-opp-self-filed';
const ENTRY = 'ENTRY-CA5-1';
const SALT = 'ca5-final2-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'ca5-final2-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const PERMISSIVE_GUARD = { async assertAllowed() {} };
const digest = () => randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64);

const PROVIDER = {
  providerId: 'broker-a',
  capabilities: { DATA_READ: true, FILING_CREATE: true, DOCUMENT_UPLOAD: true, STATUS_READ: true },
};

function withServer<T>(deps: Record<string, unknown>, run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, actionGuard: PERMISSIVE_GUARD, ...deps } as never);
  return new Promise<T>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      run('http://127.0.0.1:' + port).then(
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

function getPlan(base: string, opportunityId: string, cookie?: string) {
  return fetch(base + '/customs-opportunities/' + encodeURIComponent(opportunityId) + '/authorization-plan', {
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
    'TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "CustomsBrokerPoaFact", "CustomsRightLineageFact", "CustomsIorIdentityFact", "RecoveryRoute", "RecoveryOpportunity", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'CA5 FINAL E2E', slug: 'ca5-final2' } });
  await prisma.organization.create({ data: { id: ORG2, name: 'CA5 FINAL OTHER', slug: 'ca5-final2-other' } });
  for (const [id, email, name] of [
    [USER, 'ca5f2-owner@example.com', 'OWNER'],
    [VIEWER, 'ca5f2-viewer@example.com', 'VIEWER'],
    [OTHER, 'ca5f2-other@example.com', 'OTHER'],
  ] as const) {
    await prisma.user.create({
      data: {
        id,
        email,
        passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
        displayName: name,
        status: 'ACTIVE',
        emailVerified: true,
      },
    });
  }
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: VIEWER, role: 'VIEWER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG2, userId: OTHER, role: 'OWNER' as never, isActive: true } });

  await prisma.recoveryOpportunity.create({
    data: {
      id: OPP,
      organizationId: ORG,
      domain: 'CUSTOMS' as never,
      channel: 'CUSTOMS_BROKER' as never,
      opportunityType: ENTRY,
      title: 'Duty recovery candidate',
    },
  });
  await prisma.recoveryOpportunity.create({
    data: {
      id: OPP_NO_ROUTE,
      organizationId: ORG,
      domain: 'CUSTOMS' as never,
      channel: 'CUSTOMS_BROKER' as never,
      opportunityType: 'ENTRY-NO-ROUTE',
      title: 'No route decision yet',
    },
  });
  await prisma.recoveryOpportunity.create({
    data: {
      id: OPP_NO_LINEAGE,
      organizationId: ORG,
      domain: 'CUSTOMS' as never,
      channel: 'CUSTOMS_BROKER' as never,
      opportunityType: 'ENTRY-NO-LINEAGE',
      title: 'No right-lineage fact yet',
    },
  });
  await prisma.recoveryRoute.create({
    data: { id: randomUUID(), organizationId: ORG, opportunityId: OPP, target: 'CUSTOMS_BROKER' as never },
  });
  await prisma.recoveryRoute.create({
    data: { id: randomUUID(), organizationId: ORG, opportunityId: OPP_NO_LINEAGE, target: 'CUSTOMS_BROKER' as never },
  });
  for (const [id, entry, target] of [
    [OPP_EXPIRED_IOR, 'ENTRY-EXPIRED', 'CUSTOMS_BROKER'],
    [OPP_NO_FILING_AUTH, 'ENTRY-NO-FILING-AUTH', 'CUSTOMS_BROKER'],
    [OPP_SELF, 'ENTRY-SELF', 'CUSTOMER_SELF'],
  ] as const) {
    await prisma.recoveryOpportunity.create({
      data: {
        id,
        organizationId: ORG,
        domain: 'CUSTOMS' as never,
        channel: 'CUSTOMS_BROKER' as never,
        opportunityType: entry,
        title: 'CA5 ' + entry,
      },
    });
    await prisma.recoveryRoute.create({
      data: { id: randomUUID(), organizationId: ORG, opportunityId: id, target: target as never },
    });
  }
  await prisma.customsIorIdentityFact.create({
    data: {
      id: randomUUID(),
      organizationId: ORG,
      jurisdiction: 'US',
      principalType: 'IMPORTER_OF_RECORD' as never,
      importerOfRecordRef: 'ior:acme',
      legalEntityRef: 'entity:acme',
      verificationStatus: 'VERIFIED' as never,
      verificationSource: 'CUSTOMER_DOCUMENT' as never,
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      contentDigest: digest(),
      sourceReference: 'doc:acme',
      observedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  await prisma.customsRightLineageFact.create({
    data: {
      id: randomUUID(),
      organizationId: ORG,
      entryReference: ENTRY,
      importerOfRecordRef: 'ior:acme',
      claimantRef: 'entity:acme',
      remedyRoute: 'DRAWBACK',
      iorRightsForRemedy: 'CONFIRMED',
      claimantRightsForRemedy: 'CONFIRMED',
      filingAuthorized: true,
      outcome: 'COMPLETE' as never,
      reasonCodes: [] as never,
      evidenceKinds: [] as never,
      contentDigest: digest(),
      observedAt: new Date('2026-09-02T00:00:00.000Z'),
    },
  });
  await prisma.customsBrokerPoaFact.create({
    data: {
      id: randomUUID(),
      organizationId: ORG,
      principalRef: 'ior:acme',
      brokerRef: 'broker:a',
      jurisdiction: 'US',
      authorizationType: 'CBP_FORM_5291' as never,
      scope: ['DRAWBACK'] as never,
      effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: null,
      evidenceArtifactRef: 'evidence:poa',
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      revokedAt: null,
      supersededAt: null,
      lifecycleKey: 'ca5-final2-poa',
      verificationStatus: 'VERIFIED' as never,
      verificationSource: 'BROKER_ATTESTATION' as never,
      contentDigest: digest(),
      observedAt: new Date('2026-09-02T00:00:00.000Z'),
    },
  });
  // CHANGE B 夹具：VERIFIED 但已过期（effectiveTo 过去）
  await prisma.customsIorIdentityFact.create({
    data: {
      id: randomUUID(),
      organizationId: ORG,
      jurisdiction: 'US',
      principalType: 'IMPORTER_OF_RECORD' as never,
      importerOfRecordRef: 'ior:expired',
      legalEntityRef: 'entity:expired',
      verificationStatus: 'VERIFIED' as never,
      verificationSource: 'CUSTOMER_DOCUMENT' as never,
      verifiedAt: new Date('2025-01-01T00:00:00.000Z'),
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
      contentDigest: digest(),
      sourceReference: 'doc:expired',
      observedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  // CHANGE A 夹具：权利 CONFIRMED 但缺 filing authorization（outcome 会因此是 NEEDS_MANUAL）
  for (const [entry, principal] of [
    ['ENTRY-EXPIRED', 'ior:expired'],
    ['ENTRY-NO-FILING-AUTH', 'ior:acme'],
    ['ENTRY-SELF', 'ior:acme'],
  ] as const) {
    await prisma.customsRightLineageFact.create({
      data: {
        id: randomUUID(),
        organizationId: ORG,
        entryReference: entry,
        importerOfRecordRef: principal,
        claimantRef: 'entity:acme',
        remedyRoute: 'DRAWBACK',
        iorRightsForRemedy: 'CONFIRMED',
        claimantRightsForRemedy: 'CONFIRMED',
        filingAuthorized: entry === 'ENTRY-EXPIRED',
        outcome: (entry === 'ENTRY-EXPIRED' ? 'COMPLETE' : 'NEEDS_MANUAL') as never,
        reasonCodes: [] as never,
        evidenceKinds: [] as never,
        contentDigest: digest(),
        observedAt: new Date('2026-09-02T00:00:00.000Z'),
      },
    });
  }
  // SELF_FILED：签署权限事实（VERIFIED）
  await prisma.customsAuthorizedSignerFact.create({
    data: {
      id: randomUUID(),
      organizationId: ORG,
      principalRef: 'ior:acme',
      signerRef: 'signer:acme-legal-rep',
      signerType: 'LEGAL_REPRESENTATIVE' as never,
      authorityBasis: 'LEGAL_REPRESENTATIVE',
      scope: ['DRAWBACK'] as never,
      jurisdiction: 'US',
      effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: null,
      verificationStatus: 'VERIFIED' as never,
      verificationSource: 'CUSTOMER_DOCUMENT' as never,
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      evidenceArtifactRef: 'evidence:signer',
      revokedAt: null,
      supersededAt: null,
      lifecycleKey: 'ca5-final2-signer',
      contentDigest: digest(),
      observedAt: new Date('2026-09-02T00:00:00.000Z'),
    },
  });
});

describe('CA-5 — authorization center real-fact E2E（真实 PostgreSQL 授权事实）', () => {
  it('未认证 → 401', async () => {
    await withServer({ customsFilingProvider: PROVIDER }, async (base) => {
      expect((await getCenter(base, OPP)).status).toBe(401);
    });
  });

  it('VIEWER → 403', async () => {
    await withServer({ customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5f2-viewer@example.com');
      const res = await getCenter(base, OPP, cookie);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { reason: string }).reason).toBe('ROLE_NOT_PERMITTED');
    });
  });

  it('OWNER 本租户真实事实 → 200：POA VERIFIED 使 ④ 已确认，退款账户保守显示需要处理', async () => {
    await withServer({ customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5f2-owner@example.com');
      const res = await getCenter(base, OPP, cookie);
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as {
        authorizationCenter: {
          route: string;
          items: Array<{ key: string; state: string; action: string | null }>;
          stages: { READY_TO_FILE: boolean };
          nextAction: string | null;
          filingSubmitted: boolean;
        };
        boundary: Record<string, unknown>;
      };
      const center = body.authorizationCenter;
      expect(center.route).toBe('BROKER_FILED');
      expect(center.items).toHaveLength(6);
      const byKey = (key: string) => center.items.find((entry) => entry.key === key);
      // 真实 POA 事实 → ④ 已确认（不是 NEEDS_ACTION）
      expect(byKey('BROKER_AUTHORIZATION')?.state).toBe('CONFIRMED');
      // 无已核验退款账户事实 → ⑤ 需要处理（绝不默认 true）
      expect(byKey('REFUND_ACCOUNT')?.state).toBe('NEEDS_ACTION');
      expect(byKey('REFUND_ACCOUNT')?.action).toBe('CONFIRM_REFUND_ACCOUNT');
      // 仍缺企业身份确认事实（无服务端来源）→ ① 需要处理
      expect(byKey('ENTERPRISE_IDENTITY')?.state).toBe('NEEDS_ACTION');
      expect(center.filingSubmitted).toBe(false);
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

  it('无 route 决策 / 无 right-lineage 事实 → 404（fail-closed，不伪造）', async () => {
    await withServer({ customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5f2-owner@example.com');
      expect((await getCenter(base, OPP_NO_ROUTE, cookie)).status).toBe(404);
      expect((await getCenter(base, OPP_NO_LINEAGE, cookie)).status).toBe(404);
      expect((await getCenter(base, 'unknown-opp', cookie)).status).toBe(404);
    });
  });

  it('跨租户（另一租户会话请求同一 opportunity）→ 404', async () => {
    await withServer({ customsFilingProvider: PROVIDER }, async (base) => {
      const otherCookie = await login(base, 'ca5f2-other@example.com');
      expect((await getCenter(base, OPP, otherCookie)).status).toBe(404);
    });
  });

  it('非 GET → 405', async () => {
    await withServer({ customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5f2-owner@example.com');
      const res = await fetch(base + '/customs-opportunities/' + OPP + '/authorization-center', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{}',
      });
      expect(res.status).toBe(405);
    });
  });

  it('CHANGE A/B：追回权与申报授权分离；IOR VERIFIED 但过期 → ① 需要处理', async () => {
    await withServer({ customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5f2-owner@example.com');
      const read = async (id: string) => {
        const res = await getCenter(base, id, cookie);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          authorizationCenter: { items: Array<{ key: string; state: string; action: string | null }>; route: string };
        };
        return {
          route: body.authorizationCenter.route,
          byKey: (key: string) => body.authorizationCenter.items.find((entry) => entry.key === key),
        };
      };

      // A（BROKER_FILED）：权利 CONFIRMED 但缺 filing authorization → ② 已确认，⑥ 等待申报授权
      const broker = await read(OPP_NO_FILING_AUTH);
      expect(broker.route).toBe('BROKER_FILED');
      // 追回权只看权利字段：即使 outcome=NEEDS_MANUAL（仅因缺 filing authorization），② 仍必须是已确认
      expect(broker.byKey('RECOVERY_RIGHT')?.state).toBe('CONFIRMED');
      // 本夹具没有 service agreement 事实（loader 保守 false），因此 file 阶段仍有客户侧 blocker →
      // ⑥ 停在准备中而不是等待申报授权；关键不变量是"绝不 READY_TO_SUBMIT"。
      // （"只剩 filing authorization 时 → WAITING_AUTHORIZATION" 由 center unit 的 ownership 用例覆盖。）
      expect(broker.byKey('SUBMISSION_READINESS')?.state).not.toBe('READY_TO_SUBMIT');

      // A（SELF_FILED）：同样的缺口归 ③ 签署权限，⑥ 保持准备中
      const self = await read(OPP_SELF);
      expect(self.route).toBe('SELF_FILED');
      expect(self.byKey('RECOVERY_RIGHT')?.state).toBe('CONFIRMED');
      expect(self.byKey('SIGNER_AUTHORITY')?.state).toBe('NEEDS_ACTION');
      expect(self.byKey('SIGNER_AUTHORITY')?.action).toBe('CONFIRM_SIGNING_AUTHORITY');
      expect(self.byKey('SUBMISSION_READINESS')?.state).toBe('IN_PREPARATION');

      // B：IOR VERIFIED 但超出有效窗口 → ① 需要处理（不得显示已确认）
      const expired = await read(OPP_EXPIRED_IOR);
      expect(expired.byKey('ENTERPRISE_IDENTITY')?.state).toBe('NEEDS_ACTION');
      expect(expired.byKey('RECOVERY_RIGHT')?.state).toBe('CONFIRMED');
    });
  });

  it('CA-6：授权计划只读端点——既有 POA 可复用（不重复签署），只列真正缺失项', async () => {
    await withServer({ customsFilingProvider: PROVIDER }, async (base) => {
      const cookie = await login(base, 'ca5f2-owner@example.com');
      const res = await getPlan(base, OPP, cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        authorizationPlan: {
          gate: string;
          missingItemKeys: string[];
          missingActions: string[];
          reuseExistingAuthorization: boolean;
          reasonCodes: string[];
          nextAction: string | null;
          filingSubmitted: boolean;
          transportEnabled: boolean;
        };
        boundary: Record<string, unknown>;
      };
      const plan = body.authorizationPlan;
      // 真实 POA VERIFIED 且 scope/辖区/主体一致 → 复用既有授权，不要求再次签署
      expect(plan.reuseExistingAuthorization).toBe(true);
      expect(plan.reasonCodes).toEqual([]);
      expect(plan.missingItemKeys).not.toContain('BROKER_AUTHORIZATION');
      expect(plan.missingItemKeys).toContain('ENTERPRISE_IDENTITY');
      expect(plan.gate).toBe('NEEDS_AUTHORIZATION');
      expect(plan.nextAction).toBe('CONFIRM_ENTERPRISE_IDENTITY');
      expect(plan.filingSubmitted).toBe(false);
      expect(plan.transportEnabled).toBe(false);
      expect(body.boundary).toEqual({
        readOnly: true,
        filingSubmitted: false,
        transportEnabled: false,
        externalWritePerformed: false,
        productionCredentials: 'ABSENT',
      });
      // 无 route / 无 lineage → 404；跨租户 → 404；非 GET → 405
      expect((await getPlan(base, OPP_NO_LINEAGE, cookie)).status).toBe(404);
      const otherCookie = await login(base, 'ca5f2-other@example.com');
      expect((await getPlan(base, OPP, otherCookie)).status).toBe(404);
      const post = await fetch(base + '/customs-opportunities/' + OPP + '/authorization-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{}',
      });
      expect(post.status).toBe(405);
    });
  });
});
