/**
 * TRACK A / PC-01A —— 自助注册 HTTP 契约（真实 HTTP + PostgreSQL）
 * MSG-20261002-81 ⑥⑦：feature gate 关闭 → 不可用；开启（测试内）→ 201 且不发 session。
 */

import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const SALT = 'pc01a-signup-http-salt-0123456789';
const PASSWORD = 'self-signup-http-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc01a-http-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
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

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  delete process.env.PUBLIC_SIGNUP_ENABLED;
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env.PUBLIC_SIGNUP_ENABLED;
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
});

describe('PC-01A — self-signup HTTP contract', () => {
  it('feature gate OFF（默认）→ 403 SIGNUP_DISABLED 且零写入', async () => {
    await withServer(async (base) => {
      const response = await fetch(base + '/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'gate-off@example.com',
          password: PASSWORD,
          organizationName: 'Gate Off Org',
        }),
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe('SIGNUP_DISABLED');
      expect(response.headers.get('set-cookie')).toBeNull();
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.organization.count()).toBe(0);
  });

  it('feature gate ON（测试内）→ 201；不发 session；明确下一步是邮箱验证', async () => {
    process.env.PUBLIC_SIGNUP_ENABLED = 'true';
    await withServer(async (base) => {
      const response = await fetch(base + '/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'gate-on@example.com',
          password: PASSWORD,
          organizationName: 'Gate On Org',
          displayName: 'Owner',
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        userId: string;
        organizationId: string;
        role: string;
        emailVerified: boolean;
        sessionIssued: boolean;
        nextStep: string;
      };
      expect(body.role).toBe('OWNER');
      expect(body.emailVerified).toBe(false);
      expect(body.sessionIssued).toBe(false);
      expect(body.nextStep).toBe('EMAIL_VERIFICATION_REQUIRED');
      // G：不得设置 session cookie
      expect(response.headers.get('set-cookie')).toBeNull();

      const membership = await prisma.membership.findFirstOrThrow({
        where: { organizationId: body.organizationId, userId: body.userId },
      });
      expect(membership.role).toBe('OWNER');
      expect(await prisma.session.count({ where: { userId: body.userId } })).toBe(0);
    });
  });

  it('feature gate ON：重复邮箱 → 409 EMAIL_ALREADY_REGISTERED', async () => {
    process.env.PUBLIC_SIGNUP_ENABLED = 'true';
    await withServer(async (base) => {
      const payload = JSON.stringify({
        email: 'dup@example.com',
        password: PASSWORD,
        organizationName: 'Dup Org',
      });
      const first = await fetch(base + '/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      expect(first.status).toBe(201);
      const second = await fetch(base + '/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: string }).error).toBe('EMAIL_ALREADY_REGISTERED');
    });
  });
});
