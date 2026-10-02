/**
 * TRACK A / PC-12A — GET /payment-activation-readiness（真实 HTTP + PostgreSQL）。
 * 断言：未认证 401；VIEWER 403；OWNER 200；默认全 HOLD/OFF 且 ready=false；无 secret 取值泄漏。
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
const ORG = 'cc777777-0000-4000-8000-000000000011';
const SALT = 'pc12a-readiness-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'payment-activation-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc12a-'));
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

async function seedUser(email: string, role: string): Promise<void> {
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
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PolicyAcceptance", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'PC12A 租户', slug: 'pc12a-org' } });
  await seedUser('owner-pc12a@example.com', 'OWNER');
  await seedUser('viewer-pc12a@example.com', 'VIEWER');
});

describe('PC-12A — /payment-activation-readiness', () => {
  it('未认证 401；VIEWER 403；OWNER 200 且默认全 HOLD/OFF、ready=false、无 secret', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/payment-activation-readiness')).status).toBe(401);
      const viewer = await login(base, 'viewer-pc12a@example.com');
      expect((await fetch(base + '/payment-activation-readiness', { headers: { cookie: viewer } })).status).toBe(403);

      const owner = await login(base, 'owner-pc12a@example.com');
      const response = await fetch(base + '/payment-activation-readiness', { headers: { cookie: owner } });
      expect(response.status).toBe(200);
      const raw = await response.text();
      const payload = JSON.parse(raw) as {
        ready: boolean;
        posture: string;
        status: { payment: string; collection: string; autopay: string; externalWrite: string; r13: string };
        blockers: string[];
        feeDueVsCollected: { separated: boolean };
      };
      expect(payload.ready).toBe(false);
      expect(payload.status.payment).toBe('ZERO');
      expect(payload.status.collection).toBe('OFF');
      expect(payload.status.autopay).toBe('OFF');
      expect(payload.status.externalWrite).toBe('OFF');
      expect(payload.status.r13).toBe('HOLD');
      expect(payload.blockers).toContain('EXTERNAL:R13_NOT_RELEASED');
      expect(payload.feeDueVsCollected.separated).toBe(true);
      for (const forbidden of ['sk_', 'whsec', 'client_secret', 'passwordHash', 'credentialRef']) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });
});
