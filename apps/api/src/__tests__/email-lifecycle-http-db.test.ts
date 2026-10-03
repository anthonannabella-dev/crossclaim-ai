/**
 * PC-01B / P0 — EMAIL VERIFICATION + PASSWORD RECOVERY（真实 HTTP + PostgreSQL）
 * 端到端证据：注册（未验证）→ 登录被 403 EMAIL_NOT_VERIFIED → resend（签发 token）→ verify（200）
 *          → 登录成功；forgot → reset（200，撤销全部 session）→ 新密码登录成功 / 旧密码失败。
 */

import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer, type ServerDeps } from '../server';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import {
  createPrismaAuthTokenAccountPort,
  createPrismaAuthUserPort,
  createPrismaEmailVerificationPort,
  createPrismaMembershipLookup,
  createPrismaPasswordResetPort,
  createPrismaSessionPort,
} from '../services/auth/auth-prisma';
import { createFakeEmailDelivery } from '../services/auth/email-verification';
import { bootstrapSelfServiceAccount } from '../services/auth/self-signup';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const SALT = 'pc01b-lifecycle-http-salt-0123456789';
const PASSWORD = 'lifecycle-http-pass-1';
const NEW_PASSWORD = 'lifecycle-http-pass-2';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc01b-http-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});
const delivery = createFakeEmailDelivery();

type AuthDeps = NonNullable<ServerDeps['auth']>;

function authDeps(): AuthDeps {
  return {
    users: createPrismaAuthUserPort(prisma),
    session: {
      sessions: createPrismaSessionPort(prisma),
      memberships: createPrismaMembershipLookup(prisma),
      audit,
      ipSalt: SALT,
    },
    audit,
    signupEnabled: true,
    selfSignup: (input) => bootstrapSelfServiceAccount(prisma, input, { enabled: true }),
    lifecycle: {
      accounts: createPrismaAuthTokenAccountPort(prisma),
      emailVerification: createPrismaEmailVerificationPort(prisma),
      passwordReset: createPrismaPasswordResetPort(prisma),
      delivery,
      audit,
      ipSalt: SALT,
    },
  };
}

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage, auth: authDeps() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run('http://127.0.0.1:' + port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (base: string, url: string, body: unknown) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const lastToken = (kind: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET'): string => {
  const row = [...delivery.outbox].reverse().find((entry) => entry.kind === kind);
  if (!row) throw new Error('NO_TOKEN_FOR_' + kind);
  return row.token;
};

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  delivery.outbox.length = 0;
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Session", "EmailVerificationToken", "PasswordResetToken", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
});

describe('PC-01B — email lifecycle HTTP contract（真实 HTTP + PostgreSQL）', () => {
  it('未验证 → 403 EMAIL_NOT_VERIFIED；verify 后可登录', async () => {
    await withServer(async (base) => {
      const created = await post(base, '/auth/signup', {
        email: 'verify-' + Date.now() + '@example.com',
        password: PASSWORD,
        organizationName: 'Verify Org',
      });
      expect(created.status).toBe(201);
      const { userId } = (await created.json()) as { userId: string };

      // 未验证邮箱不得登录（P0-1 登录闸门）
      const blocked = await post(base, '/auth/login', { email: (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email, password: PASSWORD });
      expect(blocked.status).toBe(403);
      expect(((await blocked.json()) as { error: string }).error).toBe('EMAIL_NOT_VERIFIED');
      expect(blocked.headers.get('set-cookie')).toBeNull();

      // resend → 202（统一口径），只有 digest 落库
      const resend = await post(base, '/auth/resend-verification', {
        email: (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email,
      });
      expect(resend.status).toBe(202);
      expect(await resend.json()).toEqual({ accepted: true });
      const token = lastToken('EMAIL_VERIFICATION');
      expect(JSON.stringify(await prisma.emailVerificationToken.findMany())).not.toContain(token);

      // verify → 200；重复使用 → 400 ALREADY_CONSUMED
      const verified = await post(base, '/auth/verify-email', { token });
      expect(verified.status).toBe(200);
      expect(await verified.json()).toEqual({ verified: true });
      const replay = await post(base, '/auth/verify-email', { token });
      expect(replay.status).toBe(400);
      expect(((await replay.json()) as { error: string }).error).toBe('ALREADY_CONSUMED');
      const bogus = await post(base, '/auth/verify-email', { token: 'not-a-token' });
      expect(bogus.status).toBe(400);

      // 验证后可以登录
      const login = await post(base, '/auth/login', {
        email: (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email,
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
      expect(login.headers.get('set-cookie')).not.toBeNull();
      expect(login.headers.get('set-cookie') ?? '').toContain('HttpOnly');
    });
  });

  it('forgot → reset：撤销全部 session，旧密码失效、新密码可登录；未知邮箱同形', async () => {
    const seeded = await bootstrapSelfServiceAccount(
      prisma,
      {
        email: 'reset-' + Date.now() + '@example.com',
        password: PASSWORD,
        organizationName: 'Reset Org',
      },
      { enabled: true },
    );
    await prisma.user.update({ where: { id: seeded.userId }, data: { emailVerified: true } });
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: seeded.userId } })).email;

    await withServer(async (base) => {
      const first = await post(base, '/auth/login', { email, password: PASSWORD });
      expect(first.status).toBe(200);
      const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;

      const forgot = await post(base, '/auth/forgot-password', { email });
      expect(forgot.status).toBe(202);
      expect(await forgot.json()).toEqual({ accepted: true });
      const unknown = await post(base, '/auth/forgot-password', { email: 'nobody@example.com' });
      expect(unknown.status).toBe(202);
      expect(await unknown.json()).toEqual({ accepted: true });

      const policy = await post(base, '/auth/reset-password', { token: lastToken('PASSWORD_RESET'), password: 'short' });
      expect(policy.status).toBe(400);
      expect(((await policy.json()) as { error: string }).error).toBe('PASSWORD_POLICY');

      const reset = await post(base, '/auth/reset-password', {
        token: lastToken('PASSWORD_RESET'),
        password: NEW_PASSWORD,
      });
      expect(reset.status).toBe(200);
      expect((await reset.json()) as { reset: boolean; revokedSessions: number }).toMatchObject({ reset: true, revokedSessions: 1 });

      // 旧 session 已被撤销
      const me = await fetch(base + '/auth/me', { headers: { cookie } });
      expect(me.status).toBe(401);

      const oldPassword = await post(base, '/auth/login', { email, password: PASSWORD });
      expect(oldPassword.status).toBe(401);
      const newPassword = await post(base, '/auth/login', { email, password: NEW_PASSWORD });
      expect(newPassword.status).toBe(200);
    });
  });

  it('lifecycle 未装配时 fail-closed（503），不静默放行', async () => {
    const server = createServer({
      prisma,
      log,
      audit,
      storage,
      auth: { ...authDeps(), lifecycle: undefined },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const base = 'http://127.0.0.1:' + port;
      expect((await post(base, '/auth/verify-email', { token: 'x' })).status).toBe(503);
      expect((await post(base, '/auth/forgot-password', { email: 'x@example.com' })).status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
