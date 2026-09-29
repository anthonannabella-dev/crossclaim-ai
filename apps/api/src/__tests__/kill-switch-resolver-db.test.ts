// MSG-20260929-65 — Effective Kill Switch Resolver（真实 HTTP + 真实 PostgreSQL）
// 覆盖：读层生效值来自控制面 / 写路径缓存失效 / 租户隔离 / latest wins

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
import { __resetKillSwitchRateLimit } from '../services/operations/kill-switch';
import { createEffectiveKillSwitchResolver } from '../services/operations/kill-switch-resolver';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000d1';
const ORG_B = 'cf000000-0000-4000-8000-0000000000d2';
const SALT = 'gate7-ks-resolver-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'kill-switch-resolver-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-ks-resolver-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const uuid = (n: number) => `4f1a7f2e-1111-4222-8333-44445555${String(n).padStart(4, '0')}`;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  __resetKillSwitchRateLimit();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "KillSwitchRequest", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'KS Resolver 租户', slug: 'ks-resolver-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'KS Resolver 他租户', slug: 'ks-resolver-org-b' } });
  for (const [email, role] of [
    ['ksr-owner@example.com', 'OWNER'],
    ['ksr-admin@example.com', 'ADMIN'],
  ] as const) {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
        displayName: role,
        status: 'ACTIVE',
        emailVerified: true,
      },
    });
    await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role, isActive: true } });
  }
});

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function post(base: string, cookie: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/admin/kill-switch`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: base,
      referer: `${base}/operations`,
      'x-crossclaim-csrf': '1',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface SwitchView {
  scope: string;
  value: string;
  source: string;
  controlState?: string;
  degraded?: boolean;
  stale?: boolean;
  evaluatedAt?: string;
}

async function getSwitches(base: string, cookie: string): Promise<SwitchView[]> {
  const res = await fetch(`${base}/admin/kill-switch`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { switches: SwitchView[] };
  return body.switches;
}

const byScope = (switches: SwitchView[]): Record<string, SwitchView> =>
  Object.fromEntries(switches.map((item) => [item.scope, item]));

/** 直接构造 resolver（真实 DB 只读端口），避免测试间共享进程内缓存 */
function resolver() {
  return createEffectiveKillSwitchResolver({
    controlRequests: { findMany: (args) => prisma.killSwitchRequest.findMany(args) },
  });
}

describe('Effective Resolver — 读层生效值（真实 HTTP + PostgreSQL）', () => {
  it('01 基线：无控制面记录 → 业务五项 disabled / environment-default，observability enabled', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksr-owner@example.com');
      const switches = byScope(await getSwitches(base, owner));
      for (const scope of ['submission', 'billing', 'integration', 'platform_connector', 'workflow']) {
        expect(switches[scope].value, scope).toBe('disabled');
        expect(switches[scope].source, scope).toBe('environment-default');
      }
      expect(switches.observability.value).toBe('enabled');
      expect(switches.observability.source).toBe('environment-default');
      // 评估元数据（MSG-20260929-65：value + source + metadata 一致返回）
      expect(typeof switches.submission.evaluatedAt).toBe('string');
      expect(switches.submission.controlState).toBe('NONE');
    });
  });

  it('02 双人确认生效后：读层立即反映 tenant-control（且写路径已失效缓存）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksr-owner@example.com');
      const admin = await login(base, 'ksr-admin@example.com');

      // 读一次，确保缓存被填充（随后必须由写路径 invalidate）
      await getSwitches(base, owner);

      const requested = await post(base, owner, {
        scope: 'submission',
        target: 'enabled',
        phase: 'request',
        reasonCode: 'MAINTENANCE',
        idempotencyKey: uuid(1),
      });
      expect(requested.status).toBe(200);
      expect(requested.body.status).toBe('awaiting_confirmation');

      // 未确认前：effective 不变（PENDING_ENABLE 不参与）
      const pendingView = byScope(await getSwitches(base, owner));
      expect(pendingView.submission.value).toBe('disabled');
      expect(pendingView.submission.source).toBe('environment-default');
      expect(pendingView.submission.controlState).toBe('PENDING_ENABLE');

      const confirmed = await post(base, admin, {
        scope: 'submission',
        target: 'enabled',
        phase: 'confirm',
        reasonCode: 'MAINTENANCE',
        requestId: requested.body.requestId,
        idempotencyKey: uuid(2),
      });
      expect(confirmed.status).toBe(200);

      const appliedView = byScope(await getSwitches(base, owner));
      expect(appliedView.submission.value).toBe('enabled');
      expect(appliedView.submission.source).toBe('tenant-control');
      expect(appliedView.submission.controlState).toBe('APPLIED');
    });
  });

  it('03 紧急拉闸后：读层 disabled / tenant-control（安全方向单人即时）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksr-owner@example.com');
      const res = await post(base, owner, {
        scope: 'billing',
        target: 'disabled',
        phase: 'request',
        reasonCode: 'SECURITY_INCIDENT',
        idempotencyKey: uuid(3),
      });
      expect(res.status).toBe(200);
      const switches = byScope(await getSwitches(base, owner));
      expect(switches.billing.value).toBe('disabled');
      expect(switches.billing.source).toBe('tenant-control');
    });
  });
});

describe('Effective Resolver — 真实数据库读取（隔离 / latest wins）', () => {
  it('04 租户隔离：只读本租户控制面，不泄漏他租户（矩阵 #15）', async () => {
    await prisma.killSwitchRequest.create({
      data: {
        organizationId: ORG_B,
        scope: 'submission',
        target: 'ENABLED',
        state: 'APPLIED',
        reasonCode: 'MAINTENANCE',
        requestedBy: 'other-owner',
        requestedAt: new Date('2026-09-29T10:00:00Z'),
        expiresAt: new Date('2026-09-29T10:00:00Z'),
        appliedAt: new Date('2026-09-29T10:00:00Z'),
        idempotencyKey: uuid(4),
      },
    });
    const port = { findMany: (args: { where: { organizationId: string } }) => prisma.killSwitchRequest.findMany(args) };
    const a = await createEffectiveKillSwitchResolver({ controlRequests: port }).resolve('submission', ORG);
    const b = await createEffectiveKillSwitchResolver({ controlRequests: port }).resolve('submission', ORG_B);
    expect(a.value).toBe('disabled'); // ORG 不受 ORG_B 的 APPLIED 影响
    expect(b.value).toBe('enabled');
    expect(b.source).toBe('tenant-control');
  });

  it('05 latest wins（真实 DB）：取 appliedAt 最新的 APPLIED（矩阵 #9）', async () => {
    const base = {
      organizationId: ORG,
      scope: 'workflow',
      state: 'APPLIED' as const,
      reasonCode: 'MAINTENANCE',
      requestedBy: 'owner',
      expiresAt: new Date('2026-09-29T12:00:00Z'),
    };
    await prisma.killSwitchRequest.create({
      data: {
        ...base,
        target: 'ENABLED',
        requestedAt: new Date('2026-09-29T09:00:00Z'),
        appliedAt: new Date('2026-09-29T09:00:00Z'),
        idempotencyKey: uuid(5),
      },
    });
    await prisma.killSwitchRequest.create({
      data: {
        ...base,
        target: 'DISABLED',
        requestedAt: new Date('2026-09-29T11:00:00Z'),
        appliedAt: new Date('2026-09-29T11:00:00Z'),
        idempotencyKey: uuid(6),
      },
    });
    const result = await resolver().resolve('workflow', ORG);
    expect(result.value).toBe('disabled');
    expect(result.source).toBe('tenant-control');
    expect(result.controlState).toBe('APPLIED');
  });

  it('06 缓存失效（真实 DB）：写入后 invalidate 立即取到新值（矩阵 #16）', async () => {
    const r = resolver();
    const before = await r.resolve('integration', ORG);
    expect(before.value).toBe('disabled');
    const cached = await r.resolve('integration', ORG);
    expect(cached.cacheHit).toBe(true);

    await prisma.killSwitchRequest.create({
      data: {
        organizationId: ORG,
        scope: 'integration',
        target: 'ENABLED',
        state: 'APPLIED',
        reasonCode: 'MAINTENANCE',
        requestedBy: 'owner',
        requestedAt: new Date('2026-09-29T11:30:00Z'),
        expiresAt: new Date('2026-09-29T11:30:00Z'),
        appliedAt: new Date('2026-09-29T11:30:00Z'),
        idempotencyKey: uuid(7),
      },
    });
    const stillCached = await r.resolve('integration', ORG);
    expect(stillCached.value).toBe('disabled'); // TTL 内仍为旧值（跨实例陈旧 <= TTL，可解释）
    expect(stillCached.cacheHit).toBe(true);

    r.invalidate(ORG, 'integration');
    const refreshed = await r.resolve('integration', ORG);
    expect(refreshed.value).toBe('enabled');
    expect(refreshed.source).toBe('tenant-control');
    expect(refreshed.cacheHit).toBe(false);
  });
});
