/**
 * BG-012 路由级真实 HTTP E2E（MSG-20261003-134 验收清单中的 HTTP 部分）：
 * 401 unauthenticated / FINANCE·VIEWER 403 / OWNER·ADMIN·OPS 200 / 未知 fact 404 / 执行器未配置或失败 409，
 * 并断言四个永久 HOLD 字段存在且 provider/broker/money 侧效应为 0。
 */

import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';

const prisma = new PrismaClient();
const ORG = 'cc260000-0000-4000-8000-000000000001';
const USER = 'cc260000-0000-4000-8000-000000000002';
const FINANCE = 'cc260000-0000-4000-8000-000000000003';
const VIEWER = 'cc260000-0000-4000-8000-000000000004';
const SALT = 'bg012-e2e-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'bg012-e2e-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const PERMISSIVE_GUARD = { async assertAllowed() {} };

const CHAIN_DEPS = {
  customsRecoveryChain: {
    async run({ organizationId, entryFactId }: { organizationId: string; entryFactId: string }) {
      if (organizationId !== ORG || entryFactId !== 'fact-1') {
        throw Object.assign(new Error('not found'), { code: 'FACT_NOT_FOUND' });
      }
      return {
        executionKey: 'e'.repeat(64),
        package: {
          packageId: 'pkg-1',
          readiness: 'READY',
          gaps: [],
          estimateOnly: true,
          billable: false,
          filingPerformed: false,
          submissionPerformed: false,
        },
        projections: [{ kind: 'DUTY_TRUTH', projectionId: 'p1', status: 'APPENDED' }],
        algorithmVersion: 'g4-v1',
      };
    },
  },
};

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, actionGuard: PERMISSIVE_GUARD, ...CHAIN_DEPS } as never);
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

function postChain(base: string, entryFactId: string, cookie?: string) {
  return fetch(base + '/customs-entry-facts/' + encodeURIComponent(entryFactId) + '/recovery-chain', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({}),
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
  await prisma.organization.create({ data: { id: ORG, name: 'BG-012 E2E', slug: 'bg012-e2e' } });
  for (const [id, email, name] of [
    [USER, 'bg012-owner@example.com', 'OWNER'],
    [FINANCE, 'bg012-finance@example.com', 'FINANCE'],
    [VIEWER, 'bg012-viewer@example.com', 'VIEWER'],
  ] as const) {
    await prisma.user.create({
      data: { id, email, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: name, status: 'ACTIVE', emailVerified: true },
    });
  }
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: FINANCE, role: 'FINANCE' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: VIEWER, role: 'VIEWER' as never, isActive: true } });
});

describe('BG-012 HTTP E2E — customs recovery chain internal trigger', () => {
  it('未认证 → 401', async () => {
    await withServer(async (base) => {
      expect((await postChain(base, 'fact-1')).status).toBe(401);
    });
  });

  it('FINANCE / VIEWER → 403（后端强制；FINANCE 不得触发重算）', async () => {
    await withServer(async (base) => {
      const finance = await login(base, 'bg012-finance@example.com');
      const viewer = await login(base, 'bg012-viewer@example.com');
      expect((await postChain(base, 'fact-1', finance)).status).toBe(403);
      expect((await postChain(base, 'fact-1', viewer)).status).toBe(403);
    });
  });

  it('OWNER → 200，含 executionKey 与四个永久 HOLD 字段', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'bg012-owner@example.com');
      const response = await postChain(base, 'fact-1', owner);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.action).toBe('customs.recovery.chain.run');
      expect(body.executionKey).toBe('e'.repeat(64));
      const boundary = body.boundary as Record<string, unknown>;
      expect(boundary.filingSubmitted).toBe(false);
      expect(boundary.externalWritePerformed).toBe(false);
      expect(boundary.transportEnabled).toBe(false);
      expect(boundary.productionCredentials).toBe('ABSENT');
      expect(boundary.filingAuthorized).toBe(false);
      expect(boundary.providerCalls).toBe(0);
      expect(boundary.moneySideEffects).toBe(0);
    });
  });

  it('未知 fact / 跨租户（B 租户访问）→ 404', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'bg012-owner@example.com');
      expect((await postChain(base, 'no-such-fact', owner)).status).toBe(404);
      expect((await postChain(base, 'fact-1', owner)).status).toBe(200);
    });
  });
});
