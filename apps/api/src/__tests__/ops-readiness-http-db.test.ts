/**
 * TRACK A / PC-08 —— OPS READINESS 验收（真实 HTTP + PostgreSQL）
 * MSG-20261003-93 ⑨：liveness vs readiness 分离、ops 只读视图（kill switch / action guard /
 * 失败任务积压 / rate limit 策略 / transport 关闭）、匿名入口限流基线、权限边界、无 secret。
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
const ORG = 'cc333333-0000-4000-8000-00000000000a';
const SALT = 'pc08-ops-salt-0123456789abcdef';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'ops-readiness-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc08-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

interface OpsReadinessBody {
  liveness: string;
  readiness: { ready: boolean; checks: { database: string } };
  killSwitch: { resolverReachable: boolean; posture: string };
  actionGuard: { configured: boolean; posture: string };
  failedJobs: { importFailed: number; importPartial: number; claimItemReviewRequired: number; platformWriteLedgerRef: string };
  rateLimit: { enabled: boolean; windowMs: number; max: number; scope: string[] };
  transport: string;
  runbookRef: string;
  facts: {
    migration: { status: string };
    configuration: { status: string; missing: string[] };
    storage: { status: string };
    integrations: Record<string, string>;
    payment: { billingModel: string; activation: string; payment: string; collection: string };
  };
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

async function seedUser(email: string, role: string): Promise<void> {
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: role, status: 'ACTIVE', emailVerified: true },
    select: { id: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role: role as never, isActive: true } });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env.RATE_LIMIT_MAX;
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "ImportBatch", "SourceConnection", "PlatformAccount", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'PC08 租户', slug: 'pc08-org' } });
  await seedUser('owner-pc08@example.com', 'OWNER');
  await seedUser('ops-pc08@example.com', 'OPS');
  await seedUser('viewer-pc08@example.com', 'VIEWER');
});

describe('PC-08 — ops readiness', () => {
  it('health：liveness 恒 200（不依赖下游）；readiness 反映数据库连通性', async () => {
    await withServer(async (base) => {
      const live = await fetch(base + '/health/live');
      expect(live.status).toBe(200);
      expect(((await live.json()) as { kind: string }).kind).toBe('liveness');

      // PC-08 CHANGE A：/health/ready 复用既有真实 readiness path（ready + 稳定 reason codes）
      const ready = await fetch(base + '/health/ready');
      expect(ready.status).toBe(200);
      const body = (await ready.json()) as { ready: boolean; reasons: string[]; version: string };
      expect(body.ready).toBe(true);
      expect(body.reasons).toEqual([]);
    });
  });

  it('/ops-readiness：未认证 401；OPS / VIEWER 403；OWNER 200（只读运维视图）', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/ops-readiness')).status).toBe(401);
      const ops = await login(base, 'ops-pc08@example.com');
      expect((await fetch(base + '/ops-readiness', { headers: { cookie: ops } })).status).toBe(403);
      const viewer = await login(base, 'viewer-pc08@example.com');
      expect((await fetch(base + '/ops-readiness', { headers: { cookie: viewer } })).status).toBe(403);
      const owner = await login(base, 'owner-pc08@example.com');
      expect((await fetch(base + '/ops-readiness', { headers: { cookie: owner } })).status).toBe(200);
    });
  });

  it('/ops-readiness 内容：kill switch / action guard 可见；transport = DISABLED；失败任务计数真实；无 secret', async () => {
    await prisma.importBatch.create({
      data: { organizationId: ORG, domain: 'LOGISTICS', channel: 'UPS', status: 'FAILED', rowsTotal: 5, rowsOk: 0, rowsFailed: 5 },
    });
    await prisma.importBatch.create({
      data: { organizationId: ORG, domain: 'LOGISTICS', channel: 'UPS', status: 'PARTIAL', rowsTotal: 5, rowsOk: 3, rowsFailed: 2 },
    });
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc08@example.com');
      const response = await fetch(base + '/ops-readiness', { headers: { cookie: owner } });
      const raw = await response.text();
      const body = JSON.parse(raw) as OpsReadinessBody;
      expect(body.liveness).toBe('UP');
      expect(body.readiness.ready).toBe(true);
      expect(body.readiness.checks.database).toBe('UP');
      expect(typeof body.killSwitch.resolverReachable).toBe('boolean');
      expect(['READ_ONLY_DEFAULT', 'CONFIGURED']).toContain(body.killSwitch.posture);
      expect(body.actionGuard.configured).toBe(true);
      expect(body.actionGuard.posture).toBe('ENFORCING');
      expect(body.failedJobs.importFailed).toBe(1);
      expect(body.failedJobs.importPartial).toBe(1);
      expect(body.rateLimit.enabled).toBe(true);
      expect(body.rateLimit.scope).toContain('/auth/login');
      // PC-08 硬边界：不打开 transport
      expect(body.transport).toBe('DISABLED');
      expect(body.runbookRef).toContain('PC-08-OPERATIONAL-RUNBOOK');
      // PC-08 CHANGE B/C/D/E/F：机器可判定 readiness facts
      expect(['CURRENT', 'MIGRATION_MISMATCH', 'UNKNOWN']).toContain(body.facts.migration.status);
      expect(['READY', 'BLOCKED']).toContain(body.facts.configuration.status);
      expect(['READY', 'BLOCKED', 'NOT_CONFIGURED']).toContain(body.facts.storage.status);
      expect(body.facts.integrations.amazon).toBe('EXTERNAL_GATE');
      expect(body.facts.integrations.tiktok).toBe('EXTERNAL_GATE');
      expect(body.facts.integrations.walmart).toBe('EXTERNAL_GATE');
      expect(body.facts.payment.billingModel).toBe('EXISTS');
      expect(body.facts.payment.activation).toBe('HOLD');
      expect(body.facts.payment.payment).toBe('ZERO');
      expect(body.facts.payment.collection).toBe('OFF');
      // 无 secret / 凭据泄漏
      for (const forbidden of ['passwordHash', 'credentialRef', 'token', 'secret', 'storageKey', 'SQLSTATE']) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  it('匿名入口 rate limit 基线：超过窗口上限 → 429（且不回应凭据细节）', async () => {
    process.env.RATE_LIMIT_MAX = '2';
    await withServer(async (base) => {
      const attempt = async () =>
        fetch(base + '/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-pass-1' }),
        });
      const first = await attempt();
      const second = await attempt();
      const third = await attempt();
      expect([first.status, second.status]).toEqual([401, 401]);
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toBeTruthy();
      const body = (await third.json()) as { error: string };
      expect(body.error).toBe('RATE_LIMITED');
    });
  });

  it('DB 不可用 → /health/ready 503（复用真实 readiness path；fail-closed；无原始错误）', async () => {
    const brokenPrisma = new Proxy(prisma, {
      get(target, prop) {
        if (prop === '$queryRaw') {
          return async () => {
            throw new Error('ECONNREFUSED 127.0.0.1:5432 secret=leak');
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const server = createServer({ prisma: brokenPrisma, log, audit, storage });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const ready = await fetch('http://127.0.0.1:' + port + '/health/ready');
      expect(ready.status).toBe(503);
      const raw = await ready.text();
      const body = JSON.parse(raw) as { ready: boolean; reasons: string[] };
      expect(body.ready).toBe(false);
      expect(body.reasons).toEqual(['DATABASE_UNAVAILABLE']);
      for (const leak of ['ECONNREFUSED', '5432', '127.0.0.1', 'SQLSTATE', 'secret=leak']) {
        expect(raw).not.toContain(leak);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('required config 缺失 → facts.configuration = BLOCKED（只回 key 名）；liveness 不受影响', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc08@example.com');
      const original = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'postgresql://placeholder-do-not-leak@db/app';
      try {
        const configured = await fetch(base + "/ops-readiness", { headers: { cookie: owner } });
        const configuredRaw = await configured.text();
        const configuredBody = JSON.parse(configuredRaw) as OpsReadinessBody;
        expect(configuredBody.facts.configuration.status).toBe('READY');
        expect(configuredRaw).not.toContain('placeholder-do-not-leak');

        process.env.DATABASE_URL = '';
        const live = await fetch(base + "/health/live");
        expect(live.status).toBe(200);
        const response = await fetch(base + "/ops-readiness", { headers: { cookie: owner } });
        const raw = await response.text();
        const body = JSON.parse(raw) as OpsReadinessBody;
        expect(body.facts.configuration.status).toBe('BLOCKED');
        expect(body.facts.configuration.missing).toContain('DATABASE_URL');
        expect(raw).not.toContain('postgresql://');
      } finally {
        if (original === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = original;
      }
    });
  });
});
