// MSG-20260929-68 — READ-ONLY 消费点验收（Display-only 不阻断 / 审计边界 / 泄露 / 静态扫描）

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
import { __resetKillSwitchRateLimit } from '../services/operations/kill-switch';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000e1';
const SALT = 'gate7-ks-consumption-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'kill-switch-consumption-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-ks-consumption-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const uuid = (n: number) => `5f1a7f2e-1111-4222-8333-44445555${String(n).padStart(4, '0')}`;

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  __resetKillSwitchRateLimit();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "KillSwitchRequest", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'KS 消费租户', slug: 'ks-consumption-org' } });
  for (const [email, role] of [
    ['ksc2-owner@example.com', 'OWNER'],
    ['ksc2-admin@example.com', 'ADMIN'],
    ['ksc2-ops@example.com', 'OPS'],
    ['ksc2-finance@example.com', 'FINANCE'],
    ['ksc2-viewer@example.com', 'VIEWER'],
  ] as const) {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
        displayName: role,
        status: 'ACTIVE',
        emailVerified: true,
      },
    });
    await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role, isActive: true } });
  }
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

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function getJson(base: string, pathname: string, cookie: string) {
  const res = await fetch(`${base}${pathname}`, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
}

/** 业务请求（读写各一）——用于 S4「Display-only 不阻断」回归 */
function normalizeVolatile(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  if (copy.generatedAt !== undefined) copy.generatedAt = '<ts>';
  const window = copy.window as Record<string, unknown> | undefined;
  if (window && typeof window === 'object') {
    if (window.to !== undefined) window.to = '<ts>';
    if (window.horizonEnd !== undefined) window.horizonEnd = '<ts>';
  }
  return copy;
}

async function businessCalls(base: string, cookie: string) {
  const dashboard = await getJson(base, '/operations/dashboard?window=7d', cookie);
  const cases = await getJson(base, '/cases', cookie);
  const connections = await fetch(`${base}/connections`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      label: `s4-conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'FILE_UPLOAD',
      domain: 'LOGISTICS',
      channel: 'UPS',
    }),
  });
  return {
    dashboardStatus: dashboard.status,
    // 时间窗口字段属时间戳，比较时归一化
    dashboard: normalizeVolatile(dashboard.body),
    casesStatus: cases.status,
    cases: cases.body,
    connectionsStatus: connections.status,
    connections: Object.keys((await connections.json()) as Record<string, unknown>).sort(),
  };
}

async function applyEnableViaDoubleConfirm(base: string, cookieOwner: string, cookieAdmin: string, scope: string) {
  const requested = await fetch(`${base}/admin/kill-switch`, {
    method: 'POST',
    headers: {
      cookie: cookieOwner,
      'content-type': 'application/json',
      origin: base,
      referer: `${base}/operations`,
      'x-crossclaim-csrf': '1',
    },
    body: JSON.stringify({
      scope,
      target: 'enabled',
      phase: 'request',
      reasonCode: 'MAINTENANCE',
      idempotencyKey: uuid(1),
    }),
  });
  const requestedBody = (await requested.json()) as { requestId?: string };
  expect(requested.status).toBe(200);
  const confirmed = await fetch(`${base}/admin/kill-switch`, {
    method: 'POST',
    headers: {
      cookie: cookieAdmin,
      'content-type': 'application/json',
      origin: base,
      referer: `${base}/operations`,
      'x-crossclaim-csrf': '1',
    },
    body: JSON.stringify({
      scope,
      target: 'enabled',
      phase: 'confirm',
      reasonCode: 'MAINTENANCE',
      requestId: requestedBody.requestId,
      idempotencyKey: uuid(2),
    }),
  });
  expect(confirmed.status).toBe(200);
}

describe('S4 Display-only 不影响业务（真实 HTTP + PostgreSQL）', () => {
  it('01 disabled 与 enabled 下，业务请求结果逐字段一致', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc2-owner@example.com');
      const admin = await login(base, 'ksc2-admin@example.com');

      // 基线：submission 处于 disabled（默认）
      const beforeDisplay = await getJson(base, '/admin/kill-switch', owner);
      const beforeScope = (beforeDisplay.body as { switches: Array<Record<string, unknown>> }).switches.find(
        (item) => item.scope === 'submission',
      );
      expect(beforeScope?.value).toBe('disabled');
      const beforeBusiness = await businessCalls(base, owner);

      // 双人确认开启 submission（控制面 APPLIED）
      await applyEnableViaDoubleConfirm(base, owner, admin, 'submission');

      const afterDisplay = await getJson(base, '/admin/kill-switch', owner);
      const afterScope = (afterDisplay.body as { switches: Array<Record<string, unknown>> }).switches.find(
        (item) => item.scope === 'submission',
      );
      expect(afterScope?.value).toBe('enabled');
      expect(afterScope?.source).toBe('tenant-control');

      const afterBusiness = await businessCalls(base, owner);
      // 展示变化 + 业务行为完全一致
      expect(afterBusiness).toEqual(beforeBusiness);
    });
  });

  it('02 展示与读取均不写审计（AuditLog 计数不变；无 killswitch.blocked）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc2-owner@example.com');
      const before = await prisma.auditLog.count();
      await getJson(base, '/admin/kill-switch', owner);
      await getJson(base, '/admin/kill-switch', owner);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
      const blocked = await prisma.auditLog.count({ where: { action: 'killswitch.blocked' } });
      expect(blocked).toBe(0);
    });
  });

  it('03 权限：OWNER/ADMIN 全量、OPS 最小暴露、FINANCE/VIEWER 403', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc2-owner@example.com');
      const admin = await login(base, 'ksc2-admin@example.com');
      const ops = await login(base, 'ksc2-ops@example.com');

      for (const cookie of [owner, admin]) {
        const body = (await getJson(base, '/admin/kill-switch', cookie)).body as { visibility: string };
        expect(body.visibility).toBe('full');
      }
      const opsBody = (await getJson(base, '/admin/kill-switch', ops)).body as {
        visibility: string;
        switches: Array<Record<string, unknown>>;
      };
      expect(opsBody.visibility).toBe('summary');
      for (const item of opsBody.switches) {
        expect(Object.keys(item).sort()).toEqual(['scope', 'source', 'value']);
      }
      for (const email of ['ksc2-finance@example.com', 'ksc2-viewer@example.com']) {
        const cookie = await login(base, email);
        expect((await getJson(base, '/admin/kill-switch', cookie)).status).toBe(403);
      }
    });
  });

  it('04 泄露：展示响应不含 token/secret/凭据字段与 PII', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc2-owner@example.com');
      const res = await fetch(`${base}/admin/kill-switch`, { headers: { cookie: owner } });
      const text = await res.text();
      for (const forbidden of [
        'tokenHash',
        'passwordHash',
        'credentialRef',
        'secret',
        'apiKey',
        'owner@example.com',
      ]) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    });
  });
});

describe('READ_ONLY 静态约束（MSG-20260929-68 验收清单 1）', () => {
  const apiRoot = path.join(__dirname, '..');
  const repoRoot = path.join(apiRoot, '..', '..');

  function filesUnder(dir: string, matcher: RegExp): string[] {
    const found: string[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (['node_modules', '.next', 'dist'].includes(entry.name)) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (matcher.test(entry.name)) found.push(full);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return found;
  }

  it('05 Web 只读消费点不得包含任何判定/阻断/控制面读取逻辑', () => {
    const webFiles = filesUnder(path.join(repoRoot, 'web', 'app'), /\.(ts|tsx)$/);
    expect(webFiles.length).toBeGreaterThan(0);
    for (const file of webFiles) {
      const source = fs.readFileSync(file, 'utf8');
      const rel = path.relative(repoRoot, file);
      expect(source, rel).not.toMatch(/resolveKillSwitch\(/);
      expect(source, rel).not.toMatch(/assertActionAllowed\(/);
      expect(source, rel).not.toMatch(/killSwitchRequest\b/);
      expect(source, rel).not.toMatch(/killSwitch\.disabled/);
      expect(source, rel).not.toMatch(/throw new Error\('KILL_SWITCH/);
    }
  });

  it('06 业务服务不得直接引用 resolver / 控制面表（禁止隐式接入）', () => {
    const workflowDir = path.join(apiRoot, 'services', 'workflow');
    for (const file of filesUnder(workflowDir, /\.ts$/)) {
      if (path.basename(file) === 'http-routes.ts') continue; // 路由层是唯一允许的接线点（GET 展示 + POST 变更入口）
      const source = fs.readFileSync(file, 'utf8');
      const rel = path.relative(apiRoot, file);
      expect(source, rel).not.toMatch(/kill-switch-resolver/);
      expect(source, rel).not.toMatch(/operations\/kill-switch'/);
      expect(source, rel).not.toMatch(/killSwitchRequest/);
    }
  });

  it('07 Action Guard 尚未实现（任何地方都不得出现 assertActionAllowed）', () => {
    const apiFiles = filesUnder(apiRoot, /\.ts$/);
    const offenders = apiFiles.filter((file) =>
      fs.readFileSync(file, 'utf8').includes('assertActionAllowed'),
    );
    // 允许出现的位置：仅本测试文件自身（作为反例断言）
    const unexpected = offenders.filter((file) => !file.endsWith('kill-switch-consumption-db.test.ts'));
    expect(unexpected.map((file) => path.relative(apiRoot, file))).toEqual([]);
  });
});
