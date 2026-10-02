/**
 * C-0008-A — internal auth endpoints over real HTTP + real PostgreSQL.
 * ------------------------------------------------------------------
 * Proves the web-facing contract: login sets an HttpOnly session cookie,
 * /auth/me resolves the tenant, logout revokes it, and a revoked cookie is
 * rejected afterwards.
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
const ORG = 'aa000000-0000-4000-8000-00000000000a';
const SALT = 'gate6-auth-http-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const EMAIL = 'http-owner@example.com';
const PASSWORD = 'http-owner-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-auth-http-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "PlatformAccount", "SourceConnection", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'HTTP 租户', slug: 'auth-http-org' } });
  // TRACK B BATCH 1：上传端点复用本租户已绑定的 FILE_UPLOAD 连接（account 由服务端派生）。
  const uploadAccount = await prisma.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: 'UPS',
      externalAccountId: 'fixture-' + ORG,
      displayName: 'fixture account',
    },
  });
  await prisma.sourceConnection.create({
    data: {
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      status: 'ACTIVE',
      label: 'bound upload connection',
      platformAccountId: uploadAccount.id,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'HTTP 管理员',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { organizationId: ORG, userId: user.id, role: 'OWNER', isActive: true },
  });
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

describe('C-0008-A — auth HTTP endpoints（真实 PostgreSQL）', () => {
  it('登录设置 HttpOnly 会话 Cookie，/auth/me 返回租户，登出后失效', async () => {
    await withServer(async (base) => {
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('cc_session=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      const sessionCookie = cookie.split(';')[0];

      const body = (await login.json()) as { organizationId: string; role: string };
      expect(body.organizationId).toBe(ORG);
      expect(body.role).toBe('OWNER');

      const me = await fetch(`${base}/auth/me`, { headers: { cookie: sessionCookie } });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { organizationId: string }).organizationId).toBe(ORG);

      const noCookie = await fetch(`${base}/auth/me`);
      expect(noCookie.status).toBe(401);

      const logout = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { cookie: sessionCookie },
      });
      expect(logout.status).toBe(204);
      expect(logout.headers.get('set-cookie') ?? '').toContain('Max-Age=0');

      const afterLogout = await fetch(`${base}/auth/me`, { headers: { cookie: sessionCookie } });
      expect(afterLogout.status).toBe(401);

      const session = await prisma.session.findFirstOrThrow({ where: { organizationId: ORG } });
      expect(session.revokedAt).not.toBeNull();
      expect(session.tokenHash).not.toContain('cc_session');
    });
  });

  it('密码错误返回 401 且不泄露账号是否存在', async () => {
    await withServer(async (base) => {
      const wrongPassword = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: 'wrong-password-1' }),
      });
      expect(wrongPassword.status).toBe(401);

      const unknownEmail = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-1' }),
      });
      expect(unknownEmail.status).toBe(401);
      const body = (await unknownEmail.json()) as { message: string };
      expect(body.message).toBe('邮箱或密码不正确');
    });
  });

  it('上传端点：会话保护、正常 CSV 导入、MIME 伪造被拒绝', async () => {
    await withServer(async (base) => {
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      });
      const sessionCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

      const unauth = await fetch(`${base}/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'text/csv', 'x-file-name': 'invoices.csv' },
        body: 'Invoice No,Invoice Date,Net Charge,Currency\nINV-1,2026-09-01,100.0000,USD\n',
      });
      expect(unauth.status).toBe(401);

      const csv = 'Invoice No,Invoice Date,Net Charge,Currency\nINV-1,2026-09-01,100.0000,USD\n';
      const uploaded = await fetch(`${base}/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'text/csv', 'x-file-name': 'invoices.csv', cookie: sessionCookie },
        body: csv,
      });
      expect(uploaded.status).toBe(201);
      const body = (await uploaded.json()) as {
        status: string;
        scan: { detectedMime: string };
        import: { status: string; rowsOk: number } | null;
      };
      expect(body.scan.detectedMime).toBe('text/csv');
      expect(body.import?.status).toBe('IMPORTED');
      expect(body.import?.rowsOk).toBe(1);
      expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(1);
      expect(await prisma.canonicalFact.count({ where: { organizationId: ORG } })).toBe(1);

      const spoofed = await fetch(`${base}/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'text/csv', 'x-file-name': 'evil.csv', cookie: sessionCookie },
        body: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x41)]),
      });
      expect(spoofed.status).toBe(422);
      expect(await prisma.sourceTransaction.count({ where: { organizationId: ORG } })).toBe(1);
    });
  });
});
