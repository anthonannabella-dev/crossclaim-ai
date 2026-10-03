/**
 * P0-1 HTTP 真实端到端验收：GET /customs-entry-facts/:entryFactId/return-claim-evidence
 *  · 401 未认证 / 403 VIEWER / 404 未知或跨租户 / 200 已认证（只读边界：recomputedOnRead=false、filingSubmitted=false）。
 *  · deps 的 latest 为 tenant-scoped 查询；HTTP 层不得重算匹配或金额。
 */

import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { normalizeCustomsEntryFact } from '../services/customs/customs-entry-contract';
import { createPrismaCustomsEntryFactStore } from '../services/customs/customs-entry-fact-store';

const prisma = new PrismaClient();
const ORG = 'cc250000-0000-4000-8000-000000000001';
const ORG_B = 'cc250000-0000-4000-8000-000000000009';
const USER = 'cc250000-0000-4000-8000-000000000002';
const VIEWER = 'cc250000-0000-4000-8000-000000000003';
const OUTSIDER = 'cc250000-0000-4000-8000-000000000004';
const SALT = 'p01-e2e-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'p01-e2e-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const PERMISSIVE_GUARD = { async assertAllowed() {} };

let entryFactId = '';
let evidenceId = '';

const RETURN_EVIDENCE_DEPS = {
  customsReturnEvidence: {
    async latest(args: { organizationId: string; entryFactId: string }) {
      return prisma.customsReturnClaimEvidenceRecord.findFirst({
        where: { organizationId: args.organizationId, entryFactId: args.entryFactId },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      });
    },
  },
};

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, actionGuard: PERMISSIVE_GUARD, ...RETURN_EVIDENCE_DEPS } as never);
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

function getEvidence(base: string, factId: string, cookie?: string) {
  return fetch(base + '/customs-entry-facts/' + encodeURIComponent(factId) + '/return-claim-evidence', {
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
    'TRUNCATE TABLE "CustomsReturnClaimEvidenceRecord", "CustomsEntryDutyLineRecord", "CustomsEntryFactRecord", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'P0-1 HTTP E2E', slug: 'p01-http-e2e' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'P0-1 HTTP E2E B', slug: 'p01-http-e2e-b' } });
  for (const [id, email, name] of [
    [USER, 'p01-owner@example.com', 'OWNER'],
    [VIEWER, 'p01-viewer@example.com', 'VIEWER'],
    [OUTSIDER, 'p01-outsider@example.com', 'OUTSIDER'],
  ] as const) {
    await prisma.user.create({
      data: { id, email, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: name, status: 'ACTIVE', emailVerified: true },
    });
  }
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: VIEWER, role: 'VIEWER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG_B, userId: OUTSIDER, role: 'OWNER' as never, isActive: true } });

  const store = createPrismaCustomsEntryFactStore(prisma);
  const recorded = await store.recordFact({
    organizationId: ORG,
    fact: normalizeCustomsEntryFact({
      entryNumber: 'ABI-2026-000950',
      entryDate: '2026-09-18',
      jurisdiction: 'US',
      portOfEntry: 'Los Angeles, CA',
      importerOfRecordRef: 'ior_950',
      source: 'ABI_VENDOR',
      rawReference: 'abi:entry:950',
      observedAt: '2026-09-19T02:11:00.000Z',
      dutyLines: [{ kind: 'DUTY', rawCode: 'DUTY-9901', amount: '200.00', currency: 'USD' }],
    }),
  });
  entryFactId = recorded.factId;
  const row = await prisma.customsReturnClaimEvidenceRecord.create({
    data: {
      id: 'ev-p01-http',
      organizationId: ORG,
      entryFactId,
      policyId: 'customs-return-2026',
      policyVersion: '1.0.0',
      algorithmVersion: 'p0-1-e2e-v1',
      inputDigest: 'a'.repeat(64),
      resultDigest: 'b'.repeat(64),
      status: 'READY',
      qualificationStatus: 'QUALIFIED',
      confirmedRecoverableAmountByCurrency: { USD: '200.000000' } as never,
      eligibleQuantityByLine: [{ lineOrdinal: 0, status: 'EXACT', eligibleQuantity: '10.000000', confirmedDutyAmount: '200.000000' }] as never,
      reasonCodes: [] as never,
      payload: { note: 'pre-verified' } as never,
      computedAt: new Date('2026-10-03T13:10:00.000Z'),
    },
  });
  evidenceId = row.id;
});

describe('P0-1 HTTP E2E — return claim evidence read route', () => {
  it('未认证 → 401', async () => {
    await withServer(async (base) => {
      expect((await getEvidence(base, entryFactId)).status).toBe(401);
    });
  });

  it('VIEWER → 403（后端强制，前端无法绕过）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'p01-viewer@example.com');
      expect((await getEvidence(base, entryFactId, cookie)).status).toBe(403);
    });
  });

  it('OWNER → 200：返回已持久化证据 + 只读边界（不重算）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'p01-owner@example.com');
      const response = await getEvidence(base, entryFactId, cookie);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      const evidence = body.evidence as Record<string, unknown>;
      expect(evidence.evidenceId).toBe(evidenceId);
      expect(evidence.status).toBe('READY');
      expect(evidence.confirmedRecoverableAmountByCurrency).toEqual({ USD: '200.000000' });
      const boundary = body.boundary as Record<string, unknown>;
      expect(boundary.readOnly).toBe(true);
      expect(boundary.recomputedOnRead).toBe(false);
      expect(boundary.filingSubmitted).toBe(false);
      expect(boundary.transportEnabled).toBe(false);
      expect(boundary.productionCredentials).toBe('ABSENT');
    });
  });

  it('未知 factId → 404；跨租户（B 租户 owner 访问 A 的 fact）→ 404', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'p01-owner@example.com');
      expect((await getEvidence(base, 'no-such-fact', owner)).status).toBe(404);
      const outsider = await login(base, 'p01-outsider@example.com');
      expect((await getEvidence(base, entryFactId, outsider)).status).toBe(404);
    });
  });
});
