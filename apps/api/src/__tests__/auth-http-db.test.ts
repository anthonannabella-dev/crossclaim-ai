/**
 * C-0008-A — internal auth endpoints over real HTTP + real PostgreSQL.
 * ------------------------------------------------------------------
 * Proves the web-facing contract: login sets an HttpOnly session cookie,
 * /auth/me resolves the tenant, logout revokes it, and a revoked cookie is
 * rejected afterwards.
 */

import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';

const prisma = new PrismaClient();
const ORG = 'aa000000-0000-4000-8000-00000000000a';
const SALT = 'gate6-auth-http-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const EMAIL = 'http-owner@example.com';
const PASSWORD = 'http-owner-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'HTTP 租户', slug: 'auth-http-org' } });
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
  const server = createServer({ prisma, log, audit });
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
});
