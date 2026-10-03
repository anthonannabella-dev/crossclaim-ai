/**
 * TRACK A / PC-06 —— ACCOUNT MANAGEMENT 验收（真实 HTTP + PostgreSQL）
 * MSG-20261003-89 ⑭：多平台 / 多账户分组、PlatformAccount 与 SourceConnection 分层、
 * connection 只暴露安全字段、BOUND_ACTIVE / BOUND_INACTIVE / UNBOUND_LEGACY 语义、
 * legacy unbound 不猜 account、onboarding 只指向既有安全入口（不接真实 OAuth）。
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

const prisma = new PrismaClient();
const ORG = 'aa111111-0000-4000-8000-00000000000a';
const ORG_B = 'aa111111-0000-4000-8000-00000000000b';
const SALT = 'pc06-accounts-salt-0123456789a';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'accounts-pass-1';
const RAW_ERROR = 'upstream 503 token=abc123 relation "secret_table"';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc06-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

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

async function seedUser(email: string, role: string, organizationId = ORG): Promise<void> {
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: role, status: 'ACTIVE', emailVerified: true },
    select: { id: true },
  });
  await prisma.membership.create({ data: { organizationId, userId: user.id, role: role as never, isActive: true } });
}

async function seedAccount(organizationId: string, platform: 'AMAZON' | 'UPS', externalAccountId: string, displayName: string): Promise<string> {
  const created = await prisma.platformAccount.create({
    data: { organizationId, platform, externalAccountId, displayName },
    select: { id: true },
  });
  return created.id;
}

async function seedConnection(input: {
  organizationId?: string;
  platformAccountId: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'NEEDS_AUTH' | 'ERROR' | 'REVOKED';
  label: string;
  channel?: 'AMAZON_OTHER' | 'UPS';
  lastError?: string | null;
}): Promise<string> {
  const created = await prisma.sourceConnection.create({
    data: {
      organizationId: input.organizationId ?? ORG,
      domain: 'LOGISTICS',
      channel: input.channel ?? 'AMAZON_OTHER',
      kind: 'FILE_UPLOAD',
      status: input.status,
      label: input.label,
      platformAccountId: input.platformAccountId,
      lastError: input.lastError ?? null,
      lastErrorAt: input.lastError ? new Date('2026-09-30T00:00:00.000Z') : null,
      lastSyncAt: new Date('2026-09-29T00:00:00.000Z'),
      credentialRef: 'vault:account-ref-should-not-leak',
    },
    select: { id: true },
  });
  return created.id;
}

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
      { id: ORG, name: 'PC06 租户', slug: 'pc06-org' },
      { id: ORG_B, name: '外部租户', slug: 'pc06-org-b' },
    ],
  });
  await seedUser('admin-pc06@example.com', 'ADMIN');
  await seedUser('ops-pc06@example.com', 'OPS');
  await seedUser('finance-pc06@example.com', 'FINANCE');
  await seedUser('viewer-pc06@example.com', 'VIEWER');
});

describe('PC-06 — account management projection', () => {
  it('unauthorized → 401；OPS / FINANCE / VIEWER → 403（manageConnections）', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/accounts')).status).toBe(401);
      for (const email of ['ops-pc06@example.com', 'finance-pc06@example.com', 'viewer-pc06@example.com']) {
        const cookie = await login(base, email);
        expect((await fetch(base + '/accounts', { headers: { cookie } })).status).toBe(403);
      }
      const admin = await login(base, 'admin-pc06@example.com');
      expect((await fetch(base + '/accounts', { headers: { cookie: admin } })).status).toBe(200);
    });
  });

  it('多账户分组：同一 platform 下并列多个 account（不引入 provider singleton 假设）', async () => {
    const amazonA = await seedAccount(ORG, 'AMAZON', 'AMZ-A', 'Amazon 账户 A');
    const amazonB = await seedAccount(ORG, 'AMAZON', 'AMZ-B', 'Amazon 账户 B');
    const upsA = await seedAccount(ORG, 'UPS', 'UPS-A', 'UPS 账户 A');
    await seedConnection({ platformAccountId: amazonA, status: 'ACTIVE', label: 'amz-a-conn' });
    await seedConnection({ platformAccountId: amazonB, status: 'PAUSED', label: 'amz-b-conn' });
    await seedConnection({ platformAccountId: upsA, status: 'ACTIVE', label: 'ups-a-conn', channel: 'UPS' });

    await withServer(async (base) => {
      const cookie = await login(base, 'admin-pc06@example.com');
      const body = (await (await fetch(base + '/accounts', { headers: { cookie } })).json()) as {
        platforms: Array<{ platform: string; accounts: Array<{ id: string; externalAccountId: string; identityVersion: string; activeConnectionCount: number; connections: Array<{ accountState: string; status: string }> }> }>;
        legend: Record<string, string>;
        onboarding: { connectAccountEntry: string; explicitRebindEntry: string; realOAuthState: string };
      };
      const amazon = body.platforms.find((group) => group.platform === 'AMAZON');
      expect(amazon?.accounts).toHaveLength(2);
      expect(amazon?.accounts.map((account) => account.externalAccountId).sort()).toEqual(['AMZ-A', 'AMZ-B']);
      const ups = body.platforms.find((group) => group.platform === 'UPS');
      expect(ups?.accounts).toHaveLength(1);
      expect(ups?.accounts[0].identityVersion).toBe('v1');
      // bound 语义：ACTIVE → BOUND_ACTIVE；PAUSED → BOUND_INACTIVE
      const amazonStates = amazon?.accounts.flatMap((account) => account.connections.map((connection) => connection.accountState));
      expect(amazonStates).toContain('BOUND_ACTIVE');
      expect(amazonStates).toContain('BOUND_INACTIVE');
      expect(Object.keys(body.legend)).toEqual(['BOUND_ACTIVE', 'BOUND_INACTIVE', 'UNBOUND_LEGACY']);
      // onboarding 只指向既有安全入口；真实 OAuth 仍为 gate
      expect(body.onboarding.connectAccountEntry).toBe('/connections');
      expect(body.onboarding.realOAuthState).toBe('EXTERNAL_INTEGRATION_GATE');
    });
  });

  it('connection 只暴露安全字段（无 credentialRef / token / secret / 原始错误文本）', async () => {
    const account = await seedAccount(ORG, 'AMAZON', 'AMZ-SAFE', 'Amazon Safe');
    await seedConnection({ platformAccountId: account, status: 'ERROR', label: 'error-conn', lastError: RAW_ERROR });
    await withServer(async (base) => {
      const cookie = await login(base, 'admin-pc06@example.com');
      const response = await fetch(base + '/accounts', { headers: { cookie } });
      const raw = await response.text();
      const body = JSON.parse(raw) as { platforms: Array<{ accounts: Array<{ connections: Array<{ safeHealthNote: string | null; lastErrorAt: string | null }> }> }> };
      expect(raw).not.toContain('credentialRef');
      expect(raw).not.toContain('vault:account-ref-should-not-leak');
      expect(raw).not.toContain('token');
      expect(raw).not.toContain('secret_table');
      expect(raw).not.toContain('abc123');
      expect(raw).not.toContain('"config"');
      const connection = body.platforms[0].accounts[0].connections[0];
      expect(connection.lastErrorAt).toContain('2026-09-30');
      expect(connection.safeHealthNote).toContain('内部可见');
    });
  });

  it('UNBOUND_LEGACY：未绑定连接单独列出且不自动猜 account；重绑可用', async () => {
    const account = await seedAccount(ORG, 'AMAZON', 'AMZ-BOUND', 'Amazon Bound');
    await seedConnection({ platformAccountId: account, status: 'ACTIVE', label: 'bound-conn' });
    await seedConnection({ platformAccountId: null, status: 'NEEDS_AUTH', label: 'legacy-conn' });

    await withServer(async (base) => {
      const cookie = await login(base, 'admin-pc06@example.com');
      const body = (await (await fetch(base + '/accounts', { headers: { cookie } })).json()) as {
        platforms: Array<{ accounts: Array<{ id: string; connections: Array<{ label: string; rebind: { available: boolean; reason: string } }> }> }>;
        unboundLegacyConnections: Array<{ label: string; accountState: string; rebind: { available: boolean; reason: string } }>;
      };
      // legacy 不出现在任何 account 之下
      const accountConnectionLabels = body.platforms.flatMap((group) => group.accounts.flatMap((item) => item.connections.map((connection) => connection.label)));
      expect(accountConnectionLabels).toEqual(['bound-conn']);
      expect(body.unboundLegacyConnections).toHaveLength(1);
      expect(body.unboundLegacyConnections[0].accountState).toBe('UNBOUND_LEGACY');
      expect(body.unboundLegacyConnections[0].rebind).toEqual({ available: true, reason: 'LEGACY_UNBOUND_EXPLICIT_REBIND' });
      // 已绑定连接不可重绑（binding immutable）
      const bound = body.platforms[0].accounts[0].connections.find((connection) => connection.label === 'bound-conn');
      expect(bound?.rebind).toEqual({ available: false, reason: 'ALREADY_BOUND_IMMUTABLE' });
    });
  });

  it('CHANGE A：账户维度导航只对真实支持 account filter 的入口声明可执行（不得伪造）', async () => {
    const account = await seedAccount(ORG, 'AMAZON', 'AMZ-NAV', 'Amazon Nav');
    await seedConnection({ platformAccountId: account, status: 'ACTIVE', label: 'nav-conn' });
    await withServer(async (base) => {
      const cookie = await login(base, 'admin-pc06@example.com');
      const body = (await (await fetch(base + '/accounts', { headers: { cookie } })).json()) as {
        platforms: Array<{ accounts: Array<{ id: string; navigation: Record<string, { available: boolean; entry: string; reason: string }> }> }>;
      };
      const nav = body.platforms[0].accounts[0].navigation;
      // /opportunities 真实支持 accountId 过滤（PC-02）→ executable
      expect(nav.opportunities.available).toBe(true);
      expect(nav.opportunities.entry).toBe('/opportunities?accountId=' + account);
      expect(nav.opportunities.reason).toBe('SUPPORTED_ACCOUNT_FILTER');
      // /money、/cases、/connections 当前没有 accountId 过滤 → 只给 guidance，不伪造
      expect(nav.recoveryMoney.available).toBe(false);
      expect(nav.recoveryMoney.reason).toBe('NO_ACCOUNT_FILTER');
      expect(nav.cases.reason).toBe('NO_ACCOUNT_FILTER');
      expect(nav.connections.reason).toBe('NO_ACCOUNT_FILTER');
    });
  });

  it('CHANGE B：reconnect / rebind 能力由服务端按事实推导（前端不得猜）', async () => {
    const account = await seedAccount(ORG, 'AMAZON', 'AMZ-ACT', 'Amazon Act');
    await seedConnection({ platformAccountId: account, status: 'ACTIVE', label: 'active-conn' });
    await seedConnection({ platformAccountId: account, status: 'NEEDS_AUTH', label: 'needs-auth-conn' });
    await seedConnection({ platformAccountId: account, status: 'REVOKED', label: 'revoked-conn' });
    await seedConnection({ platformAccountId: null, status: 'NEEDS_AUTH', label: 'legacy-conn' });
    await withServer(async (base) => {
      const cookie = await login(base, 'admin-pc06@example.com');
      const body = (await (await fetch(base + '/accounts', { headers: { cookie } })).json()) as {
        platforms: Array<{ accounts: Array<{ connections: Array<{ label: string; actions: { reconnect: { available: boolean; reason: string }; rebind: { available: boolean; reason: string } } }> }> }>;
        unboundLegacyConnections: Array<{ label: string; actions: { reconnect: { available: boolean }; rebind: { available: boolean; reason: string } } }>;
      };
      const connections = new Map(
        body.platforms[0].accounts[0].connections.map((connection) => [connection.label, connection]),
      );
      expect(connections.get('active-conn')?.actions.reconnect.available).toBe(false);
      // CHANGE B2：真实 OAuth/API 仍被 gate 阻塞 → 不得声称可执行，只给原因
      expect(connections.get('needs-auth-conn')?.actions.reconnect).toEqual({
        available: false,
        reason: 'REAL_OAUTH_EXTERNAL_GATE',
        entry: '/connections',
      });
      expect(connections.get('revoked-conn')?.actions.reconnect.reason).toBe('REAL_OAUTH_EXTERNAL_GATE');
      // 已绑定连接 rebind 不可用（binding immutable）
      expect(connections.get('active-conn')?.actions.rebind).toEqual({ available: false, reason: 'ALREADY_BOUND_IMMUTABLE', entry: '/connections' });
      // legacy unbound 的 rebind 可用；reconnect 也可用（NEEDS_AUTH）
      expect(body.unboundLegacyConnections[0].actions.rebind).toEqual({ available: true, reason: 'LEGACY_UNBOUND_EXPLICIT_REBIND', entry: '/connections' });
      expect(body.unboundLegacyConnections[0].actions.reconnect.available).toBe(false);
    });
  });

  it('tenant isolation：外部租户的 account / connection 不可见', async () => {
    const foreign = await seedAccount(ORG_B, 'AMAZON', 'AMZ-FOREIGN', 'Foreign Amazon');
    await seedConnection({ organizationId: ORG_B, platformAccountId: foreign, status: 'ACTIVE', label: 'foreign-conn' });
    await seedAccount(ORG, 'AMAZON', 'AMZ-MINE', 'My Amazon');
    await withServer(async (base) => {
      const cookie = await login(base, 'admin-pc06@example.com');
      const raw = await (await fetch(base + '/accounts', { headers: { cookie } })).text();
      expect(raw).toContain('AMZ-MINE');
      expect(raw).not.toContain('AMZ-FOREIGN');
      expect(raw).not.toContain('foreign-conn');
    });
  });
});
