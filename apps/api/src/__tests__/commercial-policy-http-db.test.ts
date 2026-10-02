/**
 * TRACK A / PC-09 —— 商业/法律披露 + 显式接受事实（真实 HTTP + PostgreSQL）
 * MSG-20261003-96 ⑬：版本化文档 / 显式接受（禁止隐式）/ 未知名 fail-closed / superseded 不可接受但可历史寻址 /
 * 跨租户禁止 / append-only / 商业就绪投影（payment=ZERO、collection=OFF、integrations=EXTERNAL_GATE、transport=DISABLED）。
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
const ORG = 'cc444444-0000-4000-8000-00000000000b';
const ORG_B = 'cc444444-0000-4000-8000-00000000000c';
const SALT = 'pc09-commercial-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'commercial-pass-1';
const REQUIRED_KEYS = [
  'terms-of-service',
  'privacy-policy',
  'data-use-notice',
  'refund-and-fee-policy',
  'recovery-service-scope',
  'provider-authorization-disclosure',
  'customs-broker-limitation',
];

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc09-'));
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

async function seedUser(organizationId: string, email: string, role: string): Promise<string> {
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
  await prisma.membership.create({
    data: { organizationId, userId: user.id, role: role as never, isActive: true },
  });
  return user.id;
}

let ownerUserId = "";

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PolicyAcceptance", "AuditLog", "ImportBatch", "SourceConnection", "PlatformAccount", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'PC09 租户', slug: 'pc09-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'PC09 租户 B', slug: 'pc09-org-b' } });
  ownerUserId = await seedUser(ORG, 'owner-pc09@example.com', 'OWNER');
  await seedUser(ORG, 'viewer-pc09@example.com', 'VIEWER');
  await seedUser(ORG_B, 'foreign-pc09@example.com', 'OWNER');
});

describe('PC-09 — commercial / legal content layer', () => {
  it('未认证 401；CURRENT 文档可见且与 registry 一致', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/commercial/policies')).status).toBe(401);
      const owner = await login(base, 'owner-pc09@example.com');
      const response = await fetch(base + '/commercial/policies', { headers: { cookie: owner } });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { items: Array<{ key: string; version: string; status: string; requiresExplicitAcceptance: boolean }> };
      const keys = payload.items.map((item) => item.key).sort();
      expect(keys).toEqual([...REQUIRED_KEYS].sort());
      for (const item of payload.items) expect(item.status).toBe('CURRENT');
      expect(payload.items.every((item) => item.requiresExplicitAcceptance)).toBe(true);
    });
  });

  it('未知文档 → 404 POLICY_NOT_FOUND（fail-closed，不回退最新）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc09@example.com');
      const response = await fetch(base + '/commercial/policies/does-not-exist', { headers: { cookie: owner } });
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: string }).error).toBe('POLICY_NOT_FOUND');
    });
  });

  it('superseded 版本仍可历史寻址，但不允许被接受', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc09@example.com');
      const detail = await fetch(base + '/commercial/policies/terms-of-service?version=2026-09-01', { headers: { cookie: owner } });
      expect(detail.status).toBe(200);
      const payload = (await detail.json()) as { document: { version: string; status: string }; versions: Array<{ version: string; status: string }> };
      expect(payload.document.status).toBe('SUPERSEDED');
      expect(payload.versions.map((entry) => entry.version)).toContain('2026-10-01');

      const accept = await fetch(base + '/commercial/policies/terms-of-service/accept', {
        method: 'POST',
        headers: { cookie: owner, 'content-type': 'application/json' },
        body: JSON.stringify({ accept: true, documentVersion: '2026-09-01' }),
      });
      expect(accept.status).toBe(409);
      expect(((await accept.json()) as { error: string }).error).toBe('POLICY_VERSION_NOT_ACCEPTABLE');
    });
  });

  it('禁止隐式接受：缺少 accept:true → 400 且不落事实', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc09@example.com');
      const response = await fetch(base + '/commercial/policies/privacy-policy/accept', {
        method: 'POST',
        headers: { cookie: owner, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('EXPLICIT_ACCEPTANCE_REQUIRED');
      expect(await prisma.policyAcceptance.count()).toBe(0);
    });
  });

  it('显式接受写入精确版本事实，且重复接受幂等（不产生第二条）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc09@example.com');
      const first = await fetch(base + '/commercial/policies/privacy-policy/accept', {
        method: 'POST',
        headers: { cookie: owner, 'content-type': 'application/json' },
        body: JSON.stringify({ accept: true }),
      });
      expect(first.status).toBe(201);
      const created = (await first.json()) as { created: boolean; acceptance: { documentKey: string; documentVersion: string } };
      expect(created.created).toBe(true);
      expect(created.acceptance.documentKey).toBe('privacy-policy');
      expect(created.acceptance.documentVersion).toBe('2026-10-01');

      const second = await fetch(base + '/commercial/policies/privacy-policy/accept', {
        method: 'POST',
        headers: { cookie: owner, 'content-type': 'application/json' },
        body: JSON.stringify({ accept: true }),
      });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { created: boolean }).created).toBe(false);
      expect(await prisma.policyAcceptance.count()).toBe(1);

      const rows = await prisma.policyAcceptance.findMany();
      expect(rows[0]?.organizationId).toBe(ORG);
      expect(rows[0]?.userId).toBe(ownerUserId);
      expect(rows[0]?.source).toBe('API:/commercial/policies/:key/accept');
    });
  });

  it('跨租户 forbidden：非成员用户不得被写成接受者（DB 守卫）', async () => {
    const foreign = await prisma.user.findUniqueOrThrow({ where: { email: "foreign-pc09@example.com" } });
    await expect(
      prisma.policyAcceptance.create({
        data: {
          organizationId: ORG,
          userId: foreign.id,
          documentKey: 'privacy-policy',
          documentVersion: '2026-10-01',
          source: 'DB_DIRECT',
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.policyAcceptance.count()).toBe(0);
  });

  it('append-only：接受事实不可 UPDATE / DELETE', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc09@example.com');
      await fetch(base + '/commercial/policies/privacy-policy/accept', {
        method: 'POST',
        headers: { cookie: owner, 'content-type': 'application/json' },
        body: JSON.stringify({ accept: true }),
      });
    });
    const row = await prisma.policyAcceptance.findFirstOrThrow();
    await expect(
      prisma.policyAcceptance.update({ where: { id: row.id }, data: { source: 'TAMPERED' } }),
    ).rejects.toThrow();
    await expect(prisma.policyAcceptance.delete({ where: { id: row.id } })).rejects.toThrow();
  });

  it('commercial-readiness：payment=ZERO / collection=OFF / integrations=EXTERNAL_GATE / transport=DISABLED，且接受完成度可判定', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc09@example.com');
      const before = await fetch(base + '/commercial-readiness', { headers: { cookie: owner } });
      expect(before.status).toBe(200);
      const raw = await before.text();
      const payload = JSON.parse(raw) as {
        acceptance: { complete: boolean; outstanding: string[] };
        feeCollection: { payment: string; collection: string; activation: string; externalWrite: string };
        integrations: Record<string, string>;
        transport: string;
        policies: { current: unknown[]; supersededCount: number };
      };
      expect(payload.acceptance.complete).toBe(false);
      expect([...payload.acceptance.outstanding].sort()).toEqual([...REQUIRED_KEYS].sort());
      expect(payload.feeCollection.payment).toBe('ZERO');
      expect(payload.feeCollection.collection).toBe('OFF');
      expect(payload.feeCollection.activation).toBe('HOLD');
      expect(payload.feeCollection.externalWrite).toBe('OFF');
      expect(payload.integrations.amazon).toBe('EXTERNAL_GATE');
      expect(payload.transport).toBe('DISABLED');
      expect(payload.policies.supersededCount).toBeGreaterThanOrEqual(1);
      for (const forbidden of ['passwordHash', 'credentialRef', 'token', 'storageKey', 'SECRET']) {
        expect(raw).not.toContain(forbidden);
      }

      for (const key of REQUIRED_KEYS) {
        const response = await fetch(base + '/commercial/policies/' + key + '/accept', {
          method: 'POST',
          headers: { cookie: owner, 'content-type': 'application/json' },
          body: JSON.stringify({ accept: true }),
        });
        expect([200, 201]).toContain(response.status);
      }

      const after = await fetch(base + '/commercial-readiness', { headers: { cookie: owner } });
      const afterBody = (await after.json()) as { acceptance: { complete: boolean; outstanding: string[] } };
      expect(afterBody.acceptance.complete).toBe(true);
      expect(afterBody.acceptance.outstanding).toEqual([]);
    });
  });
});
