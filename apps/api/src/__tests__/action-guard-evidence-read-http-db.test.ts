/**
 * Gate 7 / ② RUNTIME BUSINESS BLOCKING · evidence.read（READ_ONLY 证据读取）
 * -------------------------------------------------------------------------
 * 依据 MSG-20261001-13 §5：核对真实证据读取入口并接入既有 Action Guard 只读契约。
 * 验收：缺 guard、能力拒绝、跨租户、无权限、合法读取；不推进业务状态、不触发平台或资金动作；
 *       拒绝响应不得包含证据内容、下载地址或存储引用。
 */

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';
import { createAppActionGuard, staticControlPlaneConfig } from '../services/action-guard/runtime-guard-composition';
import { createRuntimeActionGuard, type RuntimeActionGuard } from '../services/action-guard/runtime-guard';
import { handleWorkflowRequest, type WorkflowRouteDeps } from '../services/workflow/http-routes';
import { SESSION_COOKIE } from '../services/auth/http-routes';

const prisma = new PrismaClient();
let ORG = '';
const SALT = 'evidence-read-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'evidence-read-pass-1';
let EMAIL = '';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-evidence-read-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let ownerId = '';
let caseId = '';
let evidenceId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  for (const server of liveServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((row) => '"' + row.tablename + '"').join(', ')} CASCADE;`,
    );
  }
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  ORG = randomUUID();
  EMAIL = `evidence-read-${suffix}@example.com`;
  await prisma.organization.create({
    data: { id: ORG, name: 'evidence.read 租户', slug: `evidence-read-${suffix}` },
  });
  const owner = await prisma.user.create({
    data: {
      email: EMAIL,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  await prisma.membership.create({
    data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true },
  });
  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: `ER-${suffix}`,
      title: 'evidence.read 用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('1000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  const artifact = await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      kind: 'INVOICE',
      title: '运费发票扫描件',
      description: '证据读取用例',
      reliability: 0.9,
      capturedAt: new Date('2026-09-30T00:00:00Z'),
    },
  });
  evidenceId = artifact.id;
  await prisma.caseEvidence.create({
    data: { organizationId: ORG, caseId, evidenceId: artifact.id, role: 'SUPPORTING', addedAt: new Date() },
  });
});

type GuardVariant = 'readOnlyPlane' | 'stateUnavailable';

function guardForVariant(variant: GuardVariant): RuntimeActionGuard {
  if (variant === 'stateUnavailable') {
    // 只读动作没有 Kill Switch scope，故用「能力端口不可用」直接模拟控制面状态不可用：
    // Action Guard 必须 fail closed（ACTION_GUARD_STATE_UNAVAILABLE），不得放行。
    return createRuntimeActionGuard({
      capabilities: {
        async resolve() {
          throw new Error('CONTROL_PLANE_UNAVAILABLE');
        },
      },
      audit: { write: () => {} },
    });
  }
  // READ_ONLY 控制面 + tenant/feature 皆未开启：只读动作不应因此被拒
  return createAppActionGuard({
    prisma,
    killSwitchResolver: {
      async resolve(scope: string) {
        return { scope, value: 'enabled' as const, degraded: false, stale: false };
      },
    },
    audit: { write: () => {} },
    config: staticControlPlaneConfig({
      globalDisabled: false,
      mode: 'READ_ONLY',
      productionGate: 'NOT_SATISFIED',
      platformEnabled: {},
      tenantFeatureEnabled: {},
      hostApprovalGranted: false,
    }),
  });
}

const liveServers: Array<{ close: (cb: () => void) => void }> = [];
const baseByVariant = new Map<GuardVariant, string>();

async function baseFor(variant: GuardVariant): Promise<string> {
  const cached = baseByVariant.get(variant);
  if (cached) return cached;
  const server = createServer({ prisma, log, audit, storage, actionGuard: guardForVariant(variant) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  liveServers.push(server);
  baseByVariant.set(variant, base);
  return base;
}

async function login(base: string, email: string = EMAIL): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function createMember(role: 'OPS' | 'FINANCE' | 'VIEWER'): Promise<{ userId: string; email: string }> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const email = `evidence-read-${role.toLowerCase()}-${suffix}@example.com`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: role,
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { organizationId: ORG, userId: user.id, role, isActive: true },
  });
  return { userId: user.id, email };
}

async function readEvidence(base: string, cookie: string, targetCaseId: string = caseId) {
  const res = await fetch(`${base}/cases/${targetCaseId}/evidence`, {
    method: 'GET',
    headers: { cookie, origin: base },
  });
  const raw = await res.text();
  return { status: res.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
}

async function callWorkflowDirect(targetPath: string) {
  const token = 'evidence-read-direct-session-token';
  const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
  const reqAny = req as unknown as { url?: string; method?: string; headers?: Record<string, string> };
  reqAny.url = targetPath;
  reqAny.method = 'GET';
  reqAny.headers = { cookie: `${SESSION_COOKIE}=${token}`, origin: 'http://127.0.0.1' };

  let status = 0;
  let payload: Record<string, unknown> | null = null;
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(data?: string) {
      payload = data ? (JSON.parse(data) as Record<string, unknown>) : null;
    },
  } as unknown as ServerResponse;

  const deps: WorkflowRouteDeps = {
    prisma,
    session: {
      sessions: {
        create: async () => ({ id: 'evidence-read-session' }),
        findByTokenHash: async () => ({
          id: 'evidence-read-session',
          organizationId: ORG,
          userId: ownerId,
          createdAt: new Date(),
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedAt: null,
        }),
        touch: async () => undefined,
        revoke: async () => undefined,
        revokeAllForUser: async () => 0,
      },
      memberships: {
        findActive: async () => ({ organizationId: ORG, userId: ownerId, role: 'OWNER' }),
        listActiveForUser: async () => [{ organizationId: ORG, userId: ownerId, role: 'OWNER' }],
      },
      audit,
      ipSalt: SALT,
    },
  };

  await handleWorkflowRequest(req, res, deps);
  return { status, body: payload as Record<string, unknown> | null };
}

describe('② RUNTIME BUSINESS BLOCKING — evidence.read（真实 HTTP + PostgreSQL）', () => {
  it('01 缺 Action Guard 装配 → 403 ACTION_GUARD_NOT_CONFIGURED，不泄露证据内容/存储引用', async () => {
    const res = await callWorkflowDirect(`/cases/${caseId}/evidence`);
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('ACTION_GUARD_NOT_CONFIGURED');
    const serialized = JSON.stringify(res.body ?? {});
    expect(serialized).not.toContain('运费发票扫描件');
    expect(serialized).not.toContain(evidenceId);
    expect(serialized).not.toContain('fileAssetId');
    expect(serialized).not.toContain('storage');
  }, 60_000);

  it('02 能力状态不可用（Kill Switch 解析异常）→ 失败关闭且无证据内容', async () => {
    const base = await baseFor('stateUnavailable');
    const cookie = await login(base);
    const res = await readEvidence(base, cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ACTION_GUARD_STATE_UNAVAILABLE');
    expect(res.raw).not.toContain('运费发票扫描件');
    expect(res.raw).not.toContain(evidenceId);
  }, 60_000);

  it('03 合法读取（READ_ONLY 控制面、tenant/feature 未开启）→ 200 且仅返回脱敏投影', async () => {
    const base = await baseFor('readOnlyPlane');
    const cookie = await login(base);
    const res = await readEvidence(base, cookie);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      evidenceId,
      kind: 'INVOICE',
      title: '运费发票扫描件',
      hasFile: false,
    });
    // 只读投影不得包含下载地址 / 存储引用
    expect(res.raw).not.toContain('fileAssetId');
    expect(res.raw).not.toContain('storageUrl');
    expect(res.raw).not.toContain('downloadUrl');
    expect(res.raw).not.toContain('http://');
  }, 60_000);

  it('04 跨租户案件 → 404 NOT_FOUND 且不返回任何证据条目', async () => {
    const base = await baseFor('readOnlyPlane');
    const cookie = await login(base);
    const foreignOrg = await prisma.organization.create({
      data: { id: randomUUID(), name: '外部租户', slug: `evidence-read-foreign-${randomUUID().slice(0, 8)}` },
    });
    const foreignCase = await prisma.case.create({
      data: {
        organizationId: foreignOrg.id,
        caseNo: `ER-FOREIGN-${randomUUID().slice(0, 6)}`,
        title: '外部案件',
        domain: 'LOGISTICS',
        status: 'WON',
        claimedAmount: new Prisma.Decimal('1.0000'),
        currency: 'USD',
      },
    });
    const res = await readEvidence(base, cookie, foreignCase.id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.items).toBeUndefined();
    expect(res.raw).not.toContain('运费发票扫描件');
  }, 60_000);

  it('05 无权限主体（FINANCE / VIEWER）→ 403 FORBIDDEN 且无证据内容', async () => {
    const base = await baseFor('readOnlyPlane');
    for (const role of ['FINANCE', 'VIEWER'] as const) {
      const member = await createMember(role);
      const cookie = await login(base, member.email);
      const res = await readEvidence(base, cookie);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
      expect(res.raw).not.toContain('运费发票扫描件');
      expect(res.body.items).toBeUndefined();
    }
  }, 60_000);

  it('06 合法读取不推进任何业务状态（读前后 Case/Claim/账单/资金事实不变）', async () => {
    const base = await baseFor('readOnlyPlane');
    const cookie = await login(base);
    const before = {
      caseStatus: (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).status,
      claims: await prisma.claim.count({ where: { organizationId: ORG } }),
      invoices: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
      settlements: await prisma.settlement.count({ where: { organizationId: ORG } }),
      evidenceLinks: await prisma.caseEvidence.count({ where: { organizationId: ORG, caseId } }),
    };
    expect((await readEvidence(base, cookie)).status).toBe(200);
    const after = {
      caseStatus: (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).status,
      claims: await prisma.claim.count({ where: { organizationId: ORG } }),
      invoices: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
      settlements: await prisma.settlement.count({ where: { organizationId: ORG } }),
      evidenceLinks: await prisma.caseEvidence.count({ where: { organizationId: ORG, caseId } }),
    };
    expect(after).toEqual(before);
  }, 60_000);
});
