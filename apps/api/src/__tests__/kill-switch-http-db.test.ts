// MSG-20260929-53 — Kill Switch 只读端点 HTTP 验证（真实 HTTP + 真实 PostgreSQL）

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
const ORG = 'cf000000-0000-4000-8000-0000000000a1';
const SALT = 'gate7-killswitch-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'kill-switch-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-killswitch-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;');
  await prisma.organization.create({ data: { id: ORG, name: 'KS 租户', slug: 'killswitch-org' } });
  for (const [email, role] of [
    ['ks-owner@example.com', 'OWNER'],
    ['ks-admin@example.com', 'ADMIN'],
    ['ks-ops@example.com', 'OPS'],
    ['ks-finance@example.com', 'FINANCE'],
    ['ks-viewer@example.com', 'VIEWER'],
  ] as const) {
    const user = await prisma.user.create({
      data: { email, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: role, status: 'ACTIVE', emailVerified: true },
    });
    await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role, isActive: true } });
  }
});

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
  const res = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

const call = (base: string, pathname: string, method = 'GET', cookie?: string) =>
  fetch(base + pathname, { method, headers: cookie ? { cookie } : {} });

const snapshot = async () => ({
  audits: await prisma.auditLog.count(),
  users: await prisma.user.count(),
  memberships: await prisma.membership.count(),
  killSwitchRequests: await prisma.killSwitchRequest.count(),
});

describe('Kill Switch — 只读端点（真实 HTTP + PostgreSQL）', () => {
  it('01 未登录 → 401', async () => {
    await withServer(async (base) => {
      const res = await call(base, '/admin/kill-switch');
      expect(res.status).toBe(401);
    });
  });

  it('02 OWNER/ADMIN 全量；OPS 仅开关取值（无操作者字段）；FINANCE/VIEWER 403', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ks-owner@example.com');
      const ownerRes = await call(base, '/admin/kill-switch', 'GET', owner);
      expect(ownerRes.status).toBe(200);
      const ownerBody = (await ownerRes.json()) as { visibility: string; switches: Array<Record<string, unknown>> };
      expect(ownerBody.visibility).toBe('full');
      expect(ownerBody.switches).toHaveLength(6);

      const ops = await login(base, 'ks-ops@example.com');
      const opsBody = (await (await call(base, '/admin/kill-switch', 'GET', ops)).json()) as {
        visibility: string;
        switches: Array<Record<string, unknown>>;
      };
      expect(opsBody.visibility).toBe('summary');
      for (const item of opsBody.switches) {
        expect(Object.keys(item).sort()).toEqual(['scope', 'source', 'value']);
      }

      for (const [email, role] of [
        ['ks-finance@example.com', 'FINANCE'],
        ['ks-viewer@example.com', 'VIEWER'],
      ] as const) {
        const cookie = await login(base, email);
        const res = await call(base, '/admin/kill-switch', 'GET', cookie);
        expect(res.status, role).toBe(403);
      }
    });
  });

  it('03 fail-closed 默认：五项 disabled、observability enabled', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ks-owner@example.com');
      const body = (await (await call(base, '/admin/kill-switch', 'GET', owner)).json()) as {
        switches: Array<{ scope: string; value: string; source: string }>;
      };
      const byScope = Object.fromEntries(body.switches.map((item) => [item.scope, item]));
      for (const scope of ['submission', 'billing', 'integration', 'platform_connector', 'workflow']) {
        expect(byScope[scope].value, scope).toBe('disabled');
      }
      expect(byScope.observability.value).toBe('enabled');
      // MSG-20260929-65：读层改由 EffectiveKillSwitchResolver 提供 source（六值枚举）
      for (const item of body.switches) expect(item.source).toBe('environment-default');
    });
  });

  it('04 方法闸门：PUT/DELETE → 405；POST 无 CSRF → 403（MSG-20260929-60 起 POST 是变更入口）；均无写入', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ks-owner@example.com');
      const before = await snapshot();
      for (const method of ['PUT', 'DELETE']) {
        const res = await call(base, '/admin/kill-switch', method, owner);
        expect(res.status, method).toBe(405);
      }
      const postRes = await call(base, '/admin/kill-switch', 'POST', owner);
      expect(postRes.status).toBe(403);
      expect(((await postRes.json()) as { error: string }).error).toBe('CSRF_REJECTED');
      expect(await snapshot()).toEqual(before);
    });
  });

  it('05 只读快照：读取不写审计', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ks-owner@example.com');
      const before = await snapshot();
      await call(base, '/admin/kill-switch', 'GET', owner);
      expect(await snapshot()).toEqual(before);
    });
  });
});
