/**
 * CHANGE D + E（MSG-20261003-142）— Independent-site Phase-1 **producer + runtime composition** HTTP E2E。
 * 关键点：
 *   · 不手工 seed 投影：先正常跑一次 Phase-1（runPs04Phase1 → 现有内部链），投影必须**自动产生**；
 *   · 不手工注入 independentSiteState：使用 createDefaultReadDeps（createRuntime 的默认装配）；
 *   · 真实登录会话 → GET /independent-site-disputes/:ref/state → 200 且 phase1 != null、notPersisted=[]。
 */

import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createDefaultReadDeps, createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { createPrismaPs04Phase1ProjectionStore } from '../services/independent-site/ps04-phase1-projection-store';
import { runPs04Phase1 } from '../services/independent-site/ps04-phase1-runner';

const prisma = new PrismaClient();
const ORG = 'cc300000-0000-4000-8000-000000000001';
const USER = 'cc300000-0000-4000-8000-000000000002';
const SALT = 'change-de-e2e-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'change-de-e2e-pass-1';
const NOW = '2026-10-04T10:00:00.000Z';
const DISPUTE = 'dp:1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const PERMISSIVE_GUARD = { async assertAllowed() {} };

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({
    prisma,
    log,
    audit,
    actionGuard: PERMISSIVE_GUARD,
    ...createDefaultReadDeps(prisma),
  } as never);
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

const getState = (base: string, cookie: string, disputeReference = DISPUTE) =>
  fetch(base + '/independent-site-disputes/' + encodeURIComponent(disputeReference) + '/state', { headers: { cookie } });

const seedHandoff = () =>
  prisma.$executeRawUnsafe(
    'INSERT INTO "IndependentSiteHandoffFact" ("id","organizationId","merchantRef","paymentAccountRef","disputeReference","packageId","packageDigest","channel","handoffReference","attestedByActorId","executionKey","contentDigest","observedAt") ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"Ps04HandoffChannel",$9,$10,$11,$12,$13::timestamp)',
    'h-1',
    ORG,
    'merchant:1',
    'pa:token:1',
    DISPUTE,
    'pkg:1',
    '1'.repeat(64),
    'MANUAL_PORTAL',
    'portal:1',
    'actor-1',
    'exec-1',
    '1'.repeat(64),
    NOW,
  );

const phase1Input = () => ({
  organizationId: ORG,
  disputeReference: DISPUTE,
  disputeFacts: [
    {
      organizationId: ORG,
      account: { organizationId: ORG, merchantId: 'merchant-1', paymentAccountId: 'pa-1', channel: 'STRIPE' },
      disputeReference: DISPUTE,
      transactionReference: 'tx-1',
      status: 'NEEDS_RESPONSE',
      amount: '250.00',
      currency: 'USD',
      evidenceDueBy: '2026-10-20T00:00:00.000Z',
      reasonCode: 'product_not_received',
      observedAt: NOW,
    },
  ],
  evidenceRecords: [
    { organizationId: ORG, disputeReference: DISPUTE, kind: 'ORDER_RECORD', reference: 'order:1', observedAt: NOW },
    { organizationId: ORG, disputeReference: DISPUTE, kind: 'DELIVERY_PROOF', reference: 'pod:1', observedAt: NOW },
  ],
  policyId: 'ps04-policy-2026',
  policyVersion: '1.0.0',
  algorithmVersion: 'ps04-phase1-v1',
  now: NOW,
});

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "IndependentSitePhase1Projection", "IndependentSiteSettlementFact", "IndependentSiteResponseFact", "IndependentSiteHandoffFact", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'CHANGE D/E E2E', slug: 'change-de-e2e' } });
  await prisma.user.create({
    data: { id: USER, email: 'change-de-owner@example.com', passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
});

describe('CHANGE D/E — Phase-1 producer + runtime composition（真实 HTTP + PostgreSQL）', () => {
  it('正常跑一次 Phase 1 → 投影自动产生 → 默认 runtime HTTP state 返回 phase1 != null 且 notPersisted=[]', async () => {
    await seedHandoff();
    const store = createPrismaPs04Phase1ProjectionStore(prisma);
    expect(await store.listProjections({ organizationId: ORG, disputeReference: DISPUTE })).toHaveLength(0);

    const run = await runPs04Phase1(phase1Input(), { store });
    expect(run.projection.status).toBe('APPENDED');
    expect(await store.listProjections({ organizationId: ORG, disputeReference: DISPUTE })).toHaveLength(1);

    // 幂等：同一 immutable Phase-1 结果再跑一次 → ALREADY_APPENDED，不产生第二行
    const rerun = await runPs04Phase1(phase1Input(), { store });
    expect(rerun.projection.status).toBe('ALREADY_APPENDED');
    expect(await store.listProjections({ organizationId: ORG, disputeReference: DISPUTE })).toHaveLength(1);

    await withServer(async (base) => {
      const owner = await login(base, 'change-de-owner@example.com');
      const unauthenticated = await fetch(base + '/independent-site-disputes/' + encodeURIComponent(DISPUTE) + '/state');
      expect(unauthenticated.status).toBe(401);

      const response = await getState(base, owner);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { phase1: Record<string, never> | null; notPersisted: string[] };
      expect(body.phase1).not.toBeNull();
      expect(body.notPersisted).toEqual([]);
      expect((body.phase1?.qualification as unknown as Record<string, unknown>).status).toBe('QUALIFIED');
      expect((body.phase1?.evidence as unknown as Record<string, unknown>).readinessStatus).toBe('READY');
      expect((body.phase1?.claimReady as unknown as Record<string, unknown>).status).toBe('READY');
    });
  });
});
