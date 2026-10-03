/**
 * TRACK A / PC-07 —— ENTITLEMENT + PACKAGE UNLOCK 验收（真实 HTTP + PostgreSQL）
 * MSG-20261003-92 ⑨：entitlement projection / package unlock state / 资格与付款分离 /
 * source of truth 复用 Organization.plan / usage 不猜 / capability surface /
 * 下载 server-side guard / fail-closed / 权限边界。
 */

import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';
import { assertPackageDownloadEntitled } from '../services/workflow/entitlement-view';

const prisma = new PrismaClient();
const ORG = 'bb222222-0000-4000-8000-00000000000a';
const ORG_B = 'bb222222-0000-4000-8000-00000000000b';
const SALT = 'pc07-entitlements-salt-012345678';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'entitlements-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc07-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

interface EntitlementResponse {
  plan: string;
  planKnown: boolean;
  entitlements: Array<{
    key: string;
    allowed: boolean;
    limit: number | null;
    used: number | null;
    remaining: number | null;
    usageState: string;
    reason: string;
    available: boolean;
    upgradeRequired: boolean;
    paymentRequired: boolean;
    entry: string;
  }>;
  packageUnlock: {
    state: string;
    label: string;
    eligibility: string;
    paymentCompleted: boolean;
    paymentState: string;
    collectionState: string;
    reason: string;
  };
  upgrade: { available: boolean; reason: string; guidance: string };
}

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage });
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

async function seedUser(email: string, role: string, organizationId = ORG): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: role,
      status: 'ACTIVE',
      emailVerified: true,
    },
    select: { id: true },
  });
  await prisma.membership.create({ data: { organizationId, userId: user.id, role: role as never, isActive: true } });
  return user.id;
}

async function fetchEntitlements(base: string, cookie: string): Promise<{ status: number; body: EntitlementResponse }> {
  const response = await fetch(base + '/entitlements', { headers: { cookie } });
  return { status: response.status, body: (await response.json()) as EntitlementResponse };
}

const byKey = (body: EntitlementResponse, key: string) => body.entitlements.find((item) => item.key === key);

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "SourceConnection", "PlatformAccount", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'PC07 租户', slug: 'pc07-org', plan: 'TRIAL' },
      { id: ORG_B, name: '外部租户', slug: 'pc07-org-b', plan: 'STANDARD' },
    ],
  });
  await seedUser('owner-pc07@example.com', 'OWNER');
  await seedUser('finance-pc07@example.com', 'FINANCE');
  await seedUser('viewer-pc07@example.com', 'VIEWER');
});

describe('PC-07 — entitlement projection & package unlock', () => {
  it('unauthorized → 401；VIEWER → 403；FINANCE → 200（与既有权限模型一致）', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/entitlements')).status).toBe(401);
      const viewer = await login(base, 'viewer-pc07@example.com');
      expect((await fetch(base + '/entitlements', { headers: { cookie: viewer } })).status).toBe(403);
      const finance = await login(base, 'finance-pc07@example.com');
      expect((await fetch(base + '/entitlements', { headers: { cookie: finance } })).status).toBe(200);
    });
  });

  it('known plan → 正确 entitlement 与 package unlock（TRIAL：view 可用、download 锁定）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'owner-pc07@example.com');
      const { status, body } = await fetchEntitlements(base, cookie);
      expect(status).toBe(200);
      expect(body.plan).toBe('TRIAL');
      expect(body.planKnown).toBe(true);
      expect(byKey(body, 'opportunities.read')?.allowed).toBe(true);
      expect(byKey(body, 'claim.package.view')?.allowed).toBe(true);
      const download = byKey(body, 'claim.package.download');
      expect(download?.available).toBe(false);
      expect(download?.reason).toBe('TRIAL_PLAN_EXCLUDES_PACKAGE_DOWNLOAD');
      expect(download?.upgradeRequired).toBe(true);
      expect(download?.paymentRequired).toBe(true);
      expect(body.packageUnlock.state).toBe('LOCKED');
      expect(body.packageUnlock.eligibility).toBe('ELIGIBLE');
      expect(body.packageUnlock.paymentCompleted).toBe(false);
      expect(body.packageUnlock.paymentState).toBe('ZERO');
      expect(body.packageUnlock.collectionState).toBe('OFF');
    });
  });

  it('STANDARD plan → download 可用且 package unlock = UNLOCKED', async () => {
    await seedUser('owner-b-pc07@example.com', 'OWNER', ORG_B);
    await withServer(async (base) => {
      const cookie = await login(base, 'owner-b-pc07@example.com');
      const { body } = await fetchEntitlements(base, cookie);
      expect(body.plan).toBe('STANDARD');
      const download = byKey(body, 'claim.package.download');
      expect(download?.available).toBe(true);
      expect(download?.reason).toBe('ALLOWED_BY_PLAN');
      expect(body.packageUnlock.state).toBe('UNLOCKED');
      expect(body.packageUnlock.reason).toBe('INCLUDED_IN_CURRENT_PLAN');
    });
  });

  it('same tenant 可见 / foreign tenant 不可见（各自只看自己的 plan）', async () => {
    await seedUser('owner-b2-pc07@example.com', 'OWNER', ORG_B);
    await withServer(async (base) => {
      const a = await fetchEntitlements(base, await login(base, 'owner-pc07@example.com'));
      const b = await fetchEntitlements(base, await login(base, 'owner-b2-pc07@example.com'));
      expect(a.body.plan).toBe('TRIAL');
      expect(b.body.plan).toBe('STANDARD');
      expect(byKey(a.body, 'claim.package.download')?.available).toBe(false);
      expect(byKey(b.body, 'claim.package.download')?.available).toBe(true);
    });
  });

  it('unknown plan → fail-closed（全部 DENIED，不 allow-by-default）', async () => {
    await prisma.organization.update({ where: { id: ORG }, data: { plan: 'MYSTERY_PLAN' } });
    await withServer(async (base) => {
      const cookie = await login(base, 'owner-pc07@example.com');
      const { body } = await fetchEntitlements(base, cookie);
      expect(body.planKnown).toBe(false);
      expect(body.entitlements.every((item) => item.allowed === false)).toBe(true);
      expect(body.entitlements.every((item) => item.reason === 'UNKNOWN_PLAN_FAIL_CLOSED')).toBe(true);
      expect(body.packageUnlock.state).toBe('NOT_AVAILABLE');
    });
  });

  it('usage：真实可计数能力给出 used/limit/remaining；无可靠事实的能力 = NOT_TRACKED', async () => {
    await prisma.platformAccount.create({
      data: { organizationId: ORG, platform: 'AMAZON', externalAccountId: 'PC07-A1', displayName: 'A1' },
    });
    await prisma.platformAccount.create({
      data: { organizationId: ORG, platform: 'AMAZON', externalAccountId: 'PC07-A2', displayName: 'A2' },
    });
    await withServer(async (base) => {
      const cookie = await login(base, 'owner-pc07@example.com');
      const { body } = await fetchEntitlements(base, cookie);
      const accounts = byKey(body, 'account.count');
      expect(accounts?.usageState).toBe('TRACKED');
      expect(accounts?.limit).toBe(3);
      expect(accounts?.used).toBe(2);
      expect(accounts?.remaining).toBe(1);

      const opportunities = byKey(body, 'opportunities.read');
      expect(opportunities?.usageState).toBe('NOT_TRACKED');
      expect(opportunities?.used).toBeNull();
      expect(opportunities?.remaining).toBeNull();
    });
  });

  it('exhausted limit → denied（LIMIT_EXHAUSTED），remaining 不为负', async () => {
    for (const suffix of ['1', '2', '3']) {
      await prisma.platformAccount.create({
        data: { organizationId: ORG, platform: 'AMAZON', externalAccountId: 'PC07-FULL-' + suffix, displayName: suffix },
      });
    }
    await withServer(async (base) => {
      const cookie = await login(base, 'owner-pc07@example.com');
      const { body } = await fetchEntitlements(base, cookie);
      const accounts = byKey(body, 'account.count');
      expect(accounts?.allowed).toBe(false);
      expect(accounts?.reason).toBe('LIMIT_EXHAUSTED');
      expect(accounts?.remaining).toBe(0);
    });
  });

  it('升级动作在 Payment=0 时不可执行（无假 checkout）；paymentRequired ≠ 可付款', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'owner-pc07@example.com');
      const { body } = await fetchEntitlements(base, cookie);
      expect(body.upgrade.available).toBe(false);
      expect(body.upgrade.reason).toBe('PAYMENT_NOT_ENABLED');
      expect(body.upgrade.guidance).toContain('不会发起任何扣款');
      expect(byKey(body, 'claim.package.download')?.paymentRequired).toBe(true);
    });
  });

  it('package 下载 server-side guard：TRIAL 拒绝 / STANDARD 放行（UI 隐藏不等于允许）', async () => {
    const actorTrial = { organizationId: ORG, actorUserId: 'u1', role: 'OWNER' };
    const actorStandard = { organizationId: ORG_B, actorUserId: 'u2', role: 'OWNER' };
    await expect(assertPackageDownloadEntitled(prisma, actorTrial)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assertPackageDownloadEntitled(prisma, actorStandard)).resolves.toBeUndefined();
  });
});
