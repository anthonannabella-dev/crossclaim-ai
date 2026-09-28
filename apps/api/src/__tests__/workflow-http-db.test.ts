/**
 * C-0008-B1 — opportunity review endpoints over real HTTP + real PostgreSQL.
 * -----------------------------------------------------------------------
 * Proves the web-facing contract of the human review gate:
 *   · no session            → 401, nothing changes
 *   · VIEWER / FINANCE      → 403 FORBIDDEN, nothing changes
 *   · REJECT without reason → 400 REASON_REQUIRED (+ allowed reason list)
 *   · QUALIFY               → 200, DETECTED → QUALIFIED, AuditLog actorUserId
 *   · repeated review       → 409 ILLEGAL_TRANSITION
 *   · another tenant's row  → 404 NOT_FOUND
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'bb000000-0000-4000-8000-00000000000a';
const ORG_B = 'bb000000-0000-4000-8000-00000000000b';
const SALT = 'gate6-workflow-http-salt-012345';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
// Must satisfy assertPasswordPolicy (12+ chars, letters + digits).
const PASSWORD = 'workflow-pass-1';
const NOW = new Date('2026-09-28T18:00:00Z');

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-workflow-http-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let opsUserId = '';
let adminUserId = '';

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "RecoveryOpportunity", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '工作流 HTTP 租户', slug: 'workflow-http-org' },
      { id: ORG_B, name: '外部租户', slug: 'workflow-http-org-b' },
    ],
  });
  const ops = await prisma.user.create({
    data: {
      email: 'ops-http@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: '运营',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  opsUserId = ops.id;
  const viewer = await prisma.user.create({
    data: {
      email: 'viewer-http@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: '只读',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  const admin = await prisma.user.create({
    data: {
      email: 'admin-http@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: '管理员',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  adminUserId = admin.id;
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: ops.id, role: 'OPS', isActive: true },
      { organizationId: ORG, userId: viewer.id, role: 'VIEWER', isActive: true },
      { organizationId: ORG, userId: admin.id, role: 'ADMIN', isActive: true },
    ],
  });
});

async function seedOpportunity(organizationId = ORG) {
  return prisma.recoveryOpportunity.create({
    data: {
      organizationId,
      domain: 'LOGISTICS',
      channel: 'UPS',
      status: 'DETECTED',
      opportunityType: 'FREIGHT_RATE_VARIANCE',
      title: 'HTTP 复核用例',
      amountExpected: new Prisma.Decimal('100.0000'),
      recoverableAmount: new Prisma.Decimal('17.7500'),
      detectedAt: NOW,
    },
  });
}

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

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

describe('C-0008-B1 — 机会复核端点（真实 HTTP + PostgreSQL）', () => {
  it('未登录 → 401；无权限角色 → 403；机会保持不变', async () => {
    const opportunity = await seedOpportunity();
    await withServer(async (base) => {
      const anonymous = await fetch(`${base}/opportunities/${opportunity.id}/qualify`, {
        method: 'POST',
      });
      expect(anonymous.status).toBe(401);

      const viewerCookie = await login(base, 'viewer-http@example.com');
      const forbidden = await fetch(`${base}/opportunities/${opportunity.id}/qualify`, {
        method: 'POST',
        headers: { cookie: viewerCookie },
      });
      expect(forbidden.status).toBe(403);
      expect(((await forbidden.json()) as { error: string }).error).toBe('FORBIDDEN');
    });

    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('DETECTED');
    expect(await prisma.auditLog.count({ where: { entityId: opportunity.id } })).toBe(0);
  });

  it('REJECT 缺原因 → 400 REASON_REQUIRED 并返回批准词表；补上原因 → 200 REJECTED', async () => {
    const opportunity = await seedOpportunity();
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-http@example.com');

      const missing = await fetch(`${base}/opportunities/${opportunity.id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
      const missingBody = (await missing.json()) as { error: string; allowedReasons: string[] };
      expect(missingBody.error).toBe('REASON_REQUIRED');
      expect(missingBody.allowedReasons).toEqual([
        'wrong_amount',
        'duplicate',
        'not_recoverable',
        'other',
      ]);

      const invalid = await fetch(`${base}/opportunities/${opportunity.id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reason: 'because' }),
      });
      expect(invalid.status).toBe(400);
      expect(((await invalid.json()) as { error: string }).error).toBe('INVALID_REASON');

      const malformed = await fetch(`${base}/opportunities/${opportunity.id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: '{"reason":',
      });
      expect(malformed.status).toBe(400);

      const rejected = await fetch(`${base}/opportunities/${opportunity.id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reason: 'duplicate' }),
      });
      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toEqual({
        opportunityId: opportunity.id,
        from: 'DETECTED',
        to: 'REJECTED',
        reason: 'duplicate',
      });
    });

    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('REJECTED');
    expect(row.rejectedReason).toBe('duplicate');
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'RecoveryOpportunity', entityId: opportunity.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'USER', actorUserId: opsUserId, action: 'opportunity.status_changed' });
  });

  it('QUALIFY → 200；重复复核 → 409；跨租户 → 404', async () => {
    const opportunity = await seedOpportunity();
    const foreign = await seedOpportunity(ORG_B);
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-http@example.com');

      const qualified = await fetch(`${base}/opportunities/${opportunity.id}/qualify`, {
        method: 'POST',
        headers: { cookie },
      });
      expect(qualified.status).toBe(200);
      expect(await qualified.json()).toEqual({
        opportunityId: opportunity.id,
        from: 'DETECTED',
        to: 'QUALIFIED',
        reason: null,
      });

      const again = await fetch(`${base}/opportunities/${opportunity.id}/qualify`, {
        method: 'POST',
        headers: { cookie },
      });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe('ILLEGAL_TRANSITION');

      const crossTenant = await fetch(`${base}/opportunities/${foreign.id}/qualify`, {
        method: 'POST',
        headers: { cookie },
      });
      expect(crossTenant.status).toBe(404);
      expect(((await crossTenant.json()) as { error: string }).error).toBe('NOT_FOUND');

      const wrongMethod = await fetch(`${base}/opportunities/${opportunity.id}/qualify`, {
        method: 'GET',
        headers: { cookie },
      });
      expect(wrongMethod.status).toBe(405);
    });

    const row = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(row.status).toBe('QUALIFIED');
    expect(row.qualifiedAt).not.toBeNull();
    const foreignRow = await prisma.recoveryOpportunity.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(foreignRow.status).toBe('DETECTED');
  });

  it('连接管理端点：ADMIN 创建/列表/暂停/轮换；OPS 无权限；真实密钥被拒', async () => {
    await withServer(async (base) => {
      const anonymous = await fetch(`${base}/connections`);
      expect(anonymous.status).toBe(401);

      const opsCookie = await login(base, 'ops-http@example.com');
      expect((await fetch(`${base}/connections`, { headers: { cookie: opsCookie } })).status).toBe(403);

      const adminCookie = await login(base, 'admin-http@example.com');
      const empty = await fetch(`${base}/connections`, { headers: { cookie: adminCookie } });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ items: [] });

      const created = await fetch(`${base}/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          label: 'UPS 月度账单',
          kind: 'FILE_UPLOAD',
          domain: 'LOGISTICS',
          channel: 'UPS',
        }),
      });
      expect(created.status).toBe(201);
      const connection = (await created.json()) as { id: string; status: string };
      expect(connection.status).toBe('ACTIVE');

      const withSecret = await fetch(`${base}/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          label: '带密钥的连接',
          kind: 'FILE_UPLOAD',
          domain: 'LOGISTICS',
          channel: 'FEDEX',
          credentialRef: 'AKIAIOSFODNN7EXAMPLE',
        }),
      });
      expect(withSecret.status).toBe(400);
      expect(((await withSecret.json()) as { error: string }).error).toBe('SECRET_NOT_ACCEPTED');

      const malformed = await fetch(`${base}/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: 'not-json',
      });
      expect(malformed.status).toBe(400);
      expect(((await malformed.json()) as { error: string }).error).toBe('INVALID_BODY');

      const badChannel = await fetch(`${base}/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          label: '错误渠道',
          kind: 'FILE_UPLOAD',
          domain: 'LOGISTICS',
          channel: 'NOT_A_CHANNEL',
        }),
      });
      expect(badChannel.status).toBe(400);
      expect(((await badChannel.json()) as { error: string }).error).toBe('INVALID_INPUT');

      const badStatus = await fetch(`${base}/connections/${connection.id}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ to: 'DELETED' }),
      });
      expect(badStatus.status).toBe(400);

      const paused = await fetch(`${base}/connections/${connection.id}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ to: 'PAUSED', reason: '维护中' }),
      });
      expect(paused.status).toBe(200);
      expect(await paused.json()).toEqual({ from: 'ACTIVE', to: 'PAUSED' });

      const rotated = await fetch(`${base}/connections/${connection.id}/credential-ref`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ credentialRef: 'vault:ups-2026' }),
      });
      expect(rotated.status).toBe(200);
      expect(await rotated.json()).toEqual({ hasCredentialRef: true, status: 'PAUSED' });

      const listed = await fetch(`${base}/connections`, { headers: { cookie: adminCookie } });
      const items = ((await listed.json()) as { items: Array<Record<string, unknown>> }).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ status: 'PAUSED', hasCredentialRef: true, platform: null });
      expect(JSON.stringify(items)).not.toContain('vault:ups-2026');
    });

    // 用户触发：写入与审计同事务，actor 就是登录用户
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'SourceConnection' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((row) => row.action).sort()).toEqual(
      [
        'source_connection.created',
        'source_connection.status_changed',
        'source_connection.credential_rotated',
      ].sort(),
    );
    expect(audits.every((row) => row.actorUserId === adminUserId)).toBe(true);
  });
});
