// AGENT EXPERIENCE LAYER / P7 —— Standing Authorization 客户管理面（真实 HTTP + PostgreSQL）
// ---------------------------------------------------------------------------
// 覆盖：列表只回本租户 · 撤销成功且留痕 · 重复撤销幂等 · 缺 reason → 400 ·
// 跨租户读取为空、撤销 404（不泄漏存在性）· 未认证 401 · 集合不接受写方法 ·
// 客户端自报 scope / 权限字段被忽略 · 响应如实声明不授予外写、SA ≠ Broker POA。

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
import { persistStandingAuthorization } from '../services/standing-authorization/standing-authorization-store';

const prisma = new PrismaClient();
const ORG = 'ac111111-0000-4000-8000-00000000000a';
const ORG_B = 'ac111111-0000-4000-8000-00000000000b';
const SALT = 'p7-standing-auth-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 32 };
const PASSWORD = 'standing-auth-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-p7-sa-'));
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

async function seedOrganization(organizationId: string, name: string): Promise<void> {
  await prisma.organization.deleteMany({ where: { OR: [{ slug: name }, { id: organizationId }] } });
  await prisma.organization.create({ data: { id: organizationId, name, slug: name } });
}

async function seedUser(email: string, organizationId = ORG): Promise<void> {
  await prisma.user.deleteMany({ where: { email } });
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'owner', status: 'ACTIVE', emailVerified: true },
    select: { id: true },
  });
  await prisma.membership.create({ data: { organizationId, userId: user.id, role: 'OWNER' as never, isActive: true } });
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

async function seedAuthorization(organizationId = ORG): Promise<string> {
  const result = await persistStandingAuthorization(prisma, {
    serverDerived: true,
    authorizationId: 'sa-p7-' + organizationId.slice(-2),
    organizationId,
    platformAccountId: 'acct-p7-1',
    provider: 'AMAZON',
    allowedActionTypes: ['recovery.manual_submit', 'claim.prepare'],
    monetaryLimitUsd: 1_000,
    currency: 'USD',
    domain: 'PLATFORM',
    jurisdiction: 'US',
    effectiveAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2027-10-01T00:00:00.000Z',
    authorizationVersion: 1,
    termsPolicyVersion: 'terms/v1',
    consentEvidenceRef: 'consent:p7',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  return result.authorizationId;
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "StandingAuthorization" RESTART IDENTITY CASCADE');
  await seedOrganization(ORG, 'p7-org-a');
  await seedOrganization(ORG_B, 'p7-org-b');
  await seedUser('p7-owner@example.com');
  await seedUser('p7-owner-b@example.com', ORG_B);
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "StandingAuthorization" RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "StandingAuthorization" RESTART IDENTITY CASCADE');
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

describe('P7 · /standing-authorizations（只读 + 撤销）', () => {
  it('PG-SA7-1 列表：只回本租户，字段齐全，并如实声明边界（不授予外写 / SA ≠ Broker POA）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'p7-owner@example.com');
      const authorizationId = await seedAuthorization();

      const response = await fetch(base + '/standing-authorizations', { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<{ authorizationId: string; allowedActionTypes: string[]; monetaryLimitUsd: number; revocationState: string; scopeDigest: string }>;
        standings: { grantsExternalWrite: boolean; satisfiesOnly: string[]; highValueHitl: string; standingAuthorizationIsBrokerPoa: boolean };
        executionPerformed: boolean;
      };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].authorizationId).toBe(authorizationId);
      expect(body.items[0].allowedActionTypes).toEqual(['claim.prepare', 'recovery.manual_submit']);
      expect(body.items[0].monetaryLimitUsd).toBe(1_000);
      expect(body.items[0].revocationState).toBe('ACTIVE');
      expect(body.items[0].scopeDigest).toHaveLength(64);
      expect(body.standings.grantsExternalWrite).toBe(false);
      expect(body.standings.satisfiesOnly).toEqual(['humanApproval']);
      expect(body.standings.highValueHitl).toBe('KEEP');
      expect(body.standings.standingAuthorizationIsBrokerPoa).toBe(false);
      expect(body.executionPerformed).toBe(false);
    });
  });

  it('PG-SA7-2 撤销：留痕 + 列表转为 REVOKED；重复撤销幂等；缺 reason → 400', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'p7-owner@example.com');
      const authorizationId = await seedAuthorization();

      const revoked = await fetch(base + `/standing-authorizations/${authorizationId}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reason: 'customer revoked' }),
      });
      expect(revoked.status).toBe(200);
      const revokedBody = (await revoked.json()) as {
        revoked: number;
        authorization: { revocationState: string; revokedBy: string; revocationReason: string };
        externalActionPerformed: boolean;
      };
      expect(revokedBody.revoked).toBe(1);
      expect(revokedBody.authorization.revocationState).toBe('REVOKED');
      expect(revokedBody.authorization.revocationReason).toBe('customer revoked');
      expect(revokedBody.authorization.revokedBy.length).toBeGreaterThan(0);
      expect(revokedBody.externalActionPerformed).toBe(false);

      const replay = await fetch(base + `/standing-authorizations/${authorizationId}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reason: 'customer revoked' }),
      });
      expect(((await replay.json()) as { revoked: number }).revoked).toBe(0);

      const missingReason = await fetch(base + `/standing-authorizations/${authorizationId}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({}),
      });
      expect(missingReason.status).toBe(400);
      expect(((await missingReason.json()) as { error: string }).error).toBe('REASON_REQUIRED');
    });
  });

  it('PG-SA7-3 客户端自报 scope / 权限字段一律被忽略（撤销仍作用于服务端解析的 scope）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, 'p7-owner@example.com');
      const authorizationId = await seedAuthorization();

      const response = await fetch(base + `/standing-authorizations/${authorizationId}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          reason: 'revoke with forged scope',
          organizationId: ORG_B,
          scopeDigest: 'a'.repeat(64),
          allowedActionTypes: ['claim.submit'],
          monetaryLimitUsd: 999999,
        }),
      });
      expect(response.status).toBe(200);
      const rows = await prisma.standingAuthorization.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].organizationId).toBe(ORG); // 未被自报 tenant 改写
      expect(Number(rows[0].monetaryLimitUsd)).toBe(1_000); // 未被自报额度改写
      expect(rows[0].scopeDigest).not.toBe('a'.repeat(64));
    });
  });

  it('PG-SA7-4 租户隔离与认证：跨租户列表为空、跨租户撤销 404、未认证 401、集合不接受写方法', async () => {
    await withServer(async (base) => {
      const cookieA = await login(base, 'p7-owner@example.com');
      const authorizationId = await seedAuthorization();
      const cookieB = await login(base, 'p7-owner-b@example.com');

      const listB = await fetch(base + '/standing-authorizations', { headers: { cookie: cookieB } });
      expect(((await listB.json()) as { items: unknown[] }).items).toEqual([]);

      const crossRevoke = await fetch(base + `/standing-authorizations/${authorizationId}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieB },
        body: JSON.stringify({ reason: 'nope' }),
      });
      expect(crossRevoke.status).toBe(404);

      const anonymous = await fetch(base + '/standing-authorizations');
      expect([401, 403]).toContain(anonymous.status);

      const collectionWrite = await fetch(base + '/standing-authorizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieA },
        body: JSON.stringify({ reason: 'create?' }),
      });
      expect(collectionWrite.status).toBe(405);
    });
  });
});
