/**
 * MSG-20260929-40 硬化：Admin Console / Operations 只读端点的最小 HTTP smoke（真实 HTTP + 真实 PostgreSQL）。
 * ------------------------------------------------------------------
 * 架构方要求 A2 至少覆盖 auth / role / 405 / 404，并说明不需要新增整套 HTTP 集成测试。
 * 本文件同时验证服务端接线：此前 server 的 WORKFLOW_PATH 只覆盖老工作流路径，
 * /admin/* 与 /operations/* 在真实服务器上根本不可达（落到默认 404），
 * 这条 smoke 就是「纸面可用」与「真实可用」的判据。
 */

import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
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
const ORG = 'ce000000-0000-4000-8000-0000000000a1';
const ORG_B = 'ce000000-0000-4000-8000-0000000000b1';
const SALT = 'gate7-admin-http-smoke-salt-0';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'admin-smoke-1';
const NOW = new Date('2026-09-29T09:00:00Z');
const UNKNOWN_USER_ID = 'ce000000-0000-4000-8000-0000000000ff';

const OWNER_EMAIL = 'smoke-owner@example.com';
const OPS_EMAIL = 'smoke-ops@example.com';
const VIEWER_EMAIL = 'smoke-viewer@example.com';
const OUTSIDER_EMAIL = 'smoke-outsider@example.com';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-admin-http-smoke-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let outsiderId = '';

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'Admin smoke 租户', slug: 'admin-http-smoke-org' },
      { id: ORG_B, name: '外部租户', slug: 'admin-http-smoke-org-b' },
    ],
  });

  for (const [email, role, displayName] of [
    [OWNER_EMAIL, 'OWNER', '负责人'],
    [OPS_EMAIL, 'OPS', '运营'],
    [VIEWER_EMAIL, 'VIEWER', '只读'],
  ] as const) {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
        displayName,
        status: 'ACTIVE',
        emailVerified: true,
        lastLoginAt: NOW,
      },
    });
    await prisma.membership.create({
      data: { organizationId: ORG, userId: user.id, role, isActive: true, joinedAt: NOW },
    });
  }

  const outsider = await prisma.user.create({
    data: {
      email: OUTSIDER_EMAIL,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: '外部负责人',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  outsiderId = outsider.id;
  await prisma.membership.create({
    data: { organizationId: ORG_B, userId: outsider.id, role: 'OWNER', isActive: true, joinedAt: NOW },
  });
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

function call(base: string, pathname: string, method = 'GET', cookie?: string) {
  return fetch(base + pathname, {
    method,
    headers: { ...(cookie ? { cookie } : {}) },
  });
}

const snapshot = async () => ({
  users: await prisma.user.count(),
  memberships: await prisma.membership.count(),
  sessions: await prisma.session.count(),
  invitations: await prisma.userInvitation.count(),
  audits: await prisma.auditLog.count(),
});

describe('MSG-40 硬化 — Admin / Operations 只读端点 HTTP smoke（真实服务器）', () => {
  it('01 未登录访问 A2 三端点 → 401，且不产生任何写入', async () => {
    await withServer(async (base) => {
      const before = await snapshot();
      for (const pathname of ['/admin/members', `/admin/members/${outsiderId}`, '/admin/permission-matrix']) {
        const res = await call(base, pathname);
        expect(res.status, pathname).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'UNAUTHENTICATED' });
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  it('02 OPS / VIEWER 访问 A2 → 403 FORBIDDEN（OPS 仍可访问 A4 只读）', async () => {
    await withServer(async (base) => {
      const ops = await login(base, OPS_EMAIL);
      for (const pathname of ['/admin/members', `/admin/members/${outsiderId}`, '/admin/permission-matrix']) {
        const res = await call(base, pathname, 'GET', ops);
        expect(res.status, pathname).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'FORBIDDEN' });
      }
      const imports = await call(base, '/admin/imports', 'GET', ops);
      expect(imports.status).toBe(200);

      const viewer = await login(base, VIEWER_EMAIL);
      const viewerRes = await call(base, '/admin/members', 'GET', viewer);
      expect(viewerRes.status).toBe(403);
    });
  });

  it('03 OWNER 三端点可达：列表掩码、跨租户 404、矩阵只读', async () => {
    await withServer(async (base) => {
      const owner = await login(base, OWNER_EMAIL);

      const list = await call(base, '/admin/members', 'GET', owner);
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as { items: Array<{ userId: string; emailMasked: string | null }> };
      expect(listBody.items.length).toBe(3);
      expect(listBody.items.map((row) => row.userId)).not.toContain(outsiderId);
      for (const row of listBody.items) expect(row.emailMasked).toMatch(/^[^*]\*\*\*@example\.com$/);
      expect(JSON.stringify(listBody)).not.toContain(OWNER_EMAIL);
      expect(JSON.stringify(listBody)).not.toContain('smoke-owner@');

      const crossTenant = await call(base, `/admin/members/${outsiderId}`, 'GET', owner);
      expect(crossTenant.status).toBe(404);
      expect(await crossTenant.json()).toMatchObject({ error: 'NOT_FOUND' });

      const unknown = await call(base, `/admin/members/${UNKNOWN_USER_ID}`, 'GET', owner);
      expect(unknown.status).toBe(404);

      const matrix = await call(base, '/admin/permission-matrix', 'GET', owner);
      expect(matrix.status).toBe(200);
      expect(await matrix.json()).toMatchObject({ readonly: true });
    });
  });

  it('04 非 GET 请求 → 405 METHOD_NOT_ALLOWED，且不产生任何写入', async () => {
    await withServer(async (base) => {
      const owner = await login(base, OWNER_EMAIL);
      const before = await snapshot();
      for (const [pathname, method] of [
        ['/admin/members', 'POST'],
        ['/admin/permission-matrix', 'POST'],
        [`/admin/members/${outsiderId}`, 'DELETE'],
        ['/admin/tenant-overview', 'PUT'],
        ['/admin/imports', 'POST'],
        ['/admin/recovery-review', 'POST'],
        ['/operations/dashboard', 'POST'],
      ] as const) {
        const res = await call(base, pathname, method, owner);
        expect(res.status, `${method} ${pathname}`).toBe(405);
        expect(await res.json()).toMatchObject({ error: 'METHOD_NOT_ALLOWED' });
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  it('05 Admin 六模块 + Operations 只读端点经真实服务器可达（200）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, OWNER_EMAIL);
      for (const pathname of [
        '/admin/tenant-overview',
        '/admin/audit',
        '/admin/system-health',
        '/admin/imports',
        '/admin/imports/quality-summary',
        '/admin/recovery-review',
        '/admin/members',
        '/admin/permission-matrix',
        '/operations/dashboard',
        '/operations/claims?bucket=approved',
        '/operations/recovery',
      ]) {
        const res = await call(base, pathname, 'GET', owner);
        expect(res.status, pathname).toBe(200);
      }
    });
  });

  it('06 只读快照：全部 GET 调用后事实不变（含 AuditLog 不被写入）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, OWNER_EMAIL);
      const before = await snapshot();
      for (const pathname of [
        '/admin/tenant-overview',
        '/admin/audit',
        '/admin/system-health',
        '/admin/imports',
        '/admin/recovery-review',
        '/admin/members',
        `/admin/members/${outsiderId}`,
        '/admin/permission-matrix',
        '/operations/dashboard',
      ]) {
        await call(base, pathname, 'GET', owner);
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  it('07 未知 admin 路径仍为 404（接线不放宽默认闭集）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, OWNER_EMAIL);
      const res = await call(base, '/admin/does-not-exist', 'GET', owner);
      expect(res.status).toBe(404);
    });
  });
});
