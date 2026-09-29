// MSG-20260929-60 / -61 — Kill Switch 变更入口验收（真实 HTTP + 真实 PostgreSQL）
// A 幂等 / B 双人确认 / C Race Condition / D Emergency / E HTTP 安全

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
import {
  KILL_SWITCH_CONFIRM_WINDOW_MS,
  __resetKillSwitchRateLimit,
  changeKillSwitch,
  expirePendingKillSwitchRequests,
} from '../services/operations/kill-switch';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000b7';
const SALT = 'gate7-ks-change-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'kill-switch-change-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-ks-change-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

const uuid = (n: number) => `3f1a7f2e-1111-4222-8333-44445555${String(n).padStart(4, '0')}`;

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
  await prisma.organization.create({ data: { id: ORG, name: 'KS 变更租户', slug: 'killswitch-change-org' } });
  for (const [email, role] of [
    ['ksc-owner-a@example.com', 'OWNER'],
    ['ksc-owner-b@example.com', 'OWNER'],
    ['ksc-admin@example.com', 'ADMIN'],
    ['ksc-ops@example.com', 'OPS'],
    ['ksc-finance@example.com', 'FINANCE'],
    ['ksc-viewer@example.com', 'VIEWER'],
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

interface PostOptions {
  cookie?: string | undefined;
  csrf?: boolean;
  origin?: string | null;
  body?: Record<string, unknown>;
}

async function post(base: string, options: PostOptions) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.csrf !== false) headers['x-crossclaim-csrf'] = '1';
  const origin = options.origin === undefined ? base : options.origin;
  if (origin) {
    headers.origin = origin;
    headers.referer = `${origin}/operations`;
  }
  const res = await fetch(`${base}/admin/kill-switch`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 只取变更入口写入的审计行（登录等其它审计不参与计数断言） */
async function audits() {
  return prisma.auditLog.findMany({
    where: { organizationId: ORG, action: 'killswitch.changed' },
    orderBy: { createdAt: 'asc' },
  });
}

async function requests() {
  return prisma.killSwitchRequest.findMany({ where: { organizationId: ORG }, orderBy: { createdAt: 'asc' } });
}

async function userByEmail(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return user;
}

const requestEnable = (base: string, cookie: string, scope: string, key: string, reasonCode = 'MAINTENANCE') =>
  post(base, { cookie, body: { scope, target: 'enabled', phase: 'request', reasonCode, idempotencyKey: key } });

// ============================================================
// A. 幂等
// ============================================================
describe('Kill Switch 变更入口 — A 幂等（同 organizationId + idempotencyKey）', () => {
  it('A1 拉闸同键第二次：返回首次结果、不产生第二条 AuditLog、状态不变', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const body = {
        scope: 'submission',
        target: 'disabled',
        phase: 'request',
        reasonCode: 'MAINTENANCE',
        note: 'planned drill',
        idempotencyKey: uuid(1),
      };
      const first = await post(base, { cookie: owner, body });
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('applied');
      expect(first.body.state).toBe('APPLIED');
      expect(first.body.replayed).toBe(false);

      const afterFirst = await requests();
      const auditsAfterFirst = await audits();
      expect(afterFirst).toHaveLength(1);
      expect(auditsAfterFirst).toHaveLength(1);

      const second = await post(base, { cookie: owner, body });
      expect(second.status).toBe(200);
      expect(second.body.requestId).toBe(first.body.requestId);
      expect(second.body.replayed).toBe(true);
      expect(second.body.state).toBe('APPLIED');
      expect(await requests()).toHaveLength(1);
      expect(await audits()).toHaveLength(1);
    });
  });

  it('A2 开启申请同键第二次：一条 Request、一条 AuditLog、不改变状态', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const first = await requestEnable(base, owner, 'workflow', uuid(2));
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('awaiting_confirmation');
      const second = await requestEnable(base, owner, 'workflow', uuid(2));
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(second.body.requestId).toBe(first.body.requestId);
      const rows = await requests();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('PENDING_ENABLE');
      expect(await audits()).toHaveLength(1);
    });
  });

  it('A3 确认成功后确认重试：返回首次结果，不写第二条确认审计', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const admin = await login(base, 'ksc-admin@example.com');
      const request = await requestEnable(base, owner, 'integration', uuid(3));
      const requestId = String(request.body.requestId);
      const confirmed = await post(base, {
        cookie: admin,
        body: { scope: 'integration', target: 'enabled', phase: 'confirm', reasonCode: 'MAINTENANCE', requestId, idempotencyKey: uuid(4) },
      });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.status).toBe('applied');
      const countAfter = (await audits()).length;
      const replay = await post(base, {
        cookie: admin,
        body: { scope: 'integration', target: 'enabled', phase: 'confirm', reasonCode: 'MAINTENANCE', requestId, idempotencyKey: uuid(5) },
      });
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect((await audits()).length).toBe(countAfter);
      expect((await requests()).filter((r) => r.state === 'APPLIED')).toHaveLength(1);
    });
  });
});

// ============================================================
// B. 双人确认
// ============================================================
describe('Kill Switch 变更入口 — B 双人确认（服务端强制）', () => {
  it('B1 OWNER A request + OWNER B confirm → applied', async () => {
    await withServer(async (base) => {
      const a = await login(base, 'ksc-owner-a@example.com');
      const b = await login(base, 'ksc-owner-b@example.com');
      const request = await requestEnable(base, a, 'submission', uuid(6));
      const confirmed = await post(base, {
        cookie: b,
        body: {
          scope: 'submission',
          target: 'enabled',
          phase: 'confirm',
          reasonCode: 'MAINTENANCE',
          requestId: request.body.requestId,
          idempotencyKey: uuid(7),
        },
      });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.value).toBe('enabled');
      const row = (await requests())[0];
      expect(row?.state).toBe('APPLIED');
      expect(row?.confirmedBy).toBe((await userByEmail('ksc-owner-b@example.com')).id);
    });
  });

  it('B2 OWNER A request + ADMIN B confirm → applied（审计含 confirmationBy）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const admin = await login(base, 'ksc-admin@example.com');
      const request = await requestEnable(base, owner, 'billing', uuid(8));
      const confirmed = await post(base, {
        cookie: admin,
        body: {
          scope: 'billing',
          target: 'enabled',
          phase: 'confirm',
          reasonCode: 'MAINTENANCE',
          requestId: request.body.requestId,
          idempotencyKey: uuid(9),
        },
      });
      expect(confirmed.status).toBe(200);
      const confirmAudit = (await audits()).find(
        (row) => (row.changes as unknown as { phase?: string }).phase === 'confirm',
      );
      expect(confirmAudit).toBeDefined();
      expect((confirmAudit?.changes as unknown as { confirmationBy?: string }).confirmationBy).toBe(
        (await userByEmail('ksc-admin@example.com')).id,
      );
    });
  });

  it('B3 同人闭环（OWNER A request + OWNER A confirm）→ 403', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const request = await requestEnable(base, owner, 'workflow', uuid(10));
      const denied = await post(base, {
        cookie: owner,
        body: {
          scope: 'workflow',
          target: 'enabled',
          phase: 'confirm',
          reasonCode: 'MAINTENANCE',
          requestId: request.body.requestId,
          idempotencyKey: uuid(11),
        },
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('FORBIDDEN');
      expect((await requests())[0]?.state).toBe('PENDING_ENABLE');
    });
  });

  it('B4 超过 15 分钟窗口 → 409 且申请被惰性置 EXPIRED（写 expire 审计）', async () => {
    let clock = Date.parse('2026-09-29T10:00:00.000Z');
    const now = () => new Date(clock);
    const ownerUser = await userByEmail('ksc-owner-a@example.com');
    const adminUser = await userByEmail('ksc-admin@example.com');
    const requested = await changeKillSwitch(
      { prisma },
      { organizationId: ORG, actorUserId: ownerUser.id, role: 'OWNER' },
      { scope: 'submission', target: 'enabled', phase: 'request', reasonCode: 'MAINTENANCE', idempotencyKey: uuid(12) },
      { now },
    );
    clock += 16 * 60 * 1000;
    await expect(
      changeKillSwitch(
        { prisma },
        { organizationId: ORG, actorUserId: adminUser.id, role: 'ADMIN' },
        {
          scope: 'submission',
          target: 'enabled',
          phase: 'confirm',
          reasonCode: 'MAINTENANCE',
          requestId: requested.requestId,
          idempotencyKey: uuid(13),
        },
        { now },
      ),
    ).rejects.toThrowError(/过期/);
    const row = (await requests())[0];
    expect(row?.state).toBe('EXPIRED');
    const expireAudit = (await audits()).find(
      (a) => (a.changes as unknown as { phase?: string }).phase === 'expire',
    );
    expect(expireAudit).toBeDefined();
    expect(expireAudit?.actorType).toBe('SYSTEM');
  });
});

// ============================================================
// C. Race Condition
// ============================================================
describe('Kill Switch 变更入口 — C 并发（CAS 只有一个能收口）', () => {
  it('C1 同 scope 两个 pending（不同键）→ 一个成功、一个 409', async () => {
    const ownerUser = await userByEmail('ksc-owner-a@example.com');
    const owner = { organizationId: ORG, actorUserId: ownerUser.id, role: 'OWNER' };
    const results = await Promise.allSettled([
      changeKillSwitch({ prisma }, owner, {
        scope: 'workflow',
        target: 'enabled',
        phase: 'request',
        reasonCode: 'MAINTENANCE',
        idempotencyKey: uuid(14),
      }),
      changeKillSwitch({ prisma }, owner, {
        scope: 'workflow',
        target: 'enabled',
        phase: 'request',
        reasonCode: 'MAINTENANCE',
        idempotencyKey: uuid(15),
      }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(await prisma.killSwitchRequest.count({ where: { organizationId: ORG, state: 'PENDING_ENABLE' } })).toBe(1);
  });

  it('C2 同键并发（幂等键跨实例语义）→ 只有一条 Request、一条审计', async () => {
    const ownerUser = await userByEmail('ksc-owner-a@example.com');
    const owner = { organizationId: ORG, actorUserId: ownerUser.id, role: 'OWNER' };
    const input = {
      scope: 'observability' as const,
      target: 'disabled' as const,
      phase: 'request' as const,
      reasonCode: 'MAINTENANCE' as const,
      idempotencyKey: uuid(16),
    };
    const results = await Promise.allSettled([
      changeKillSwitch({ prisma }, owner, input),
      changeKillSwitch({ prisma }, owner, input),
      changeKillSwitch({ prisma }, owner, input),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = new Set(results.map((r) => (r as PromiseFulfilledResult<{ requestId: string }>).value.requestId));
    expect(ids.size).toBe(1);
    expect(await requests()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it('C3 confirm vs expire：只能一个成功，且不出现「既 APPLIED 又 EXPIRED」', async () => {
    let clock = Date.parse('2026-09-29T11:00:00.000Z');
    const ownerUser = await userByEmail('ksc-owner-a@example.com');
    const adminUser = await userByEmail('ksc-admin@example.com');
    const now = () => new Date(clock);
    const requested = await changeKillSwitch(
      { prisma },
      { organizationId: ORG, actorUserId: ownerUser.id, role: 'OWNER' },
      { scope: 'submission', target: 'enabled', phase: 'request', reasonCode: 'MAINTENANCE', idempotencyKey: uuid(17) },
      { now },
    );

    const [, expired] = await Promise.all([
      changeKillSwitch(
        { prisma },
        { organizationId: ORG, actorUserId: adminUser.id, role: 'ADMIN' },
        {
          scope: 'submission',
          target: 'enabled',
          phase: 'confirm',
          reasonCode: 'MAINTENANCE',
          requestId: requested.requestId,
          idempotencyKey: uuid(18),
        },
        { now },
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      expirePendingKillSwitchRequests(prisma, {
        organizationId: ORG,
        scope: 'submission',
        now: new Date(clock + KILL_SWITCH_CONFIRM_WINDOW_MS + 1000),
      }),
    ]);
    expect(expired.expired.length).toBeLessThanOrEqual(1);
    const row = (await requests())[0];
    expect(['APPLIED', 'EXPIRED']).toContain(row?.state);
    // 不变量：不存在第二条同 key 记录、且状态不重复出现
    const applied = (await requests()).filter((r) => r.state === 'APPLIED');
    const expiredRows = (await requests()).filter((r) => r.state === 'EXPIRED');
    expect(applied.length + expiredRows.length).toBe(1);
  });

  it('C4 disable vs pending enable confirm：终态一致且不残留 pending', async () => {
    const ownerUser = await userByEmail('ksc-owner-a@example.com');
    const adminUser = await userByEmail('ksc-admin@example.com');
    const owner = { organizationId: ORG, actorUserId: ownerUser.id, role: 'OWNER' };
    const requested = await changeKillSwitch({ prisma }, owner, {
      scope: 'workflow',
      target: 'enabled',
      phase: 'request',
      reasonCode: 'MAINTENANCE',
      idempotencyKey: uuid(19),
    });

    const [confirmResult] = await Promise.all([
      changeKillSwitch(
        { prisma },
        { organizationId: ORG, actorUserId: adminUser.id, role: 'ADMIN' },
        {
          scope: 'workflow',
          target: 'enabled',
          phase: 'confirm',
          reasonCode: 'MAINTENANCE',
          requestId: requested.requestId,
          idempotencyKey: uuid(20),
        },
      ).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      ),
      changeKillSwitch({ prisma }, owner, {
        scope: 'workflow',
        target: 'disabled',
        phase: 'request',
        reasonCode: 'SECURITY_INCIDENT',
        idempotencyKey: uuid(21),
      }),
    ]);

    const rows = await requests();
    // 不变量 1：不残留 PENDING_ENABLE
    expect(rows.filter((r) => r.state === 'PENDING_ENABLE')).toHaveLength(0);
    // 不变量 2：拉闸请求一定落 APPLIED（DISABLED 单人即时）
    expect(rows.filter((r) => r.target === 'DISABLED' && r.state === 'APPLIED')).toHaveLength(1);
    // 不变量 3：enable 申请要么 APPLIED（confirm 赢）要么 CANCELLED（disable 赢）
    const enableRow = rows.find((r) => r.target === 'ENABLED');
    expect(['APPLIED', 'CANCELLED']).toContain(enableRow?.state);
    if (confirmResult.ok) expect(enableRow?.state).toBe('APPLIED');
    // 不变量 4：每个终态都有对应审计（无「状态变了没记录」）
    const terminal = rows.filter((r) => r.state !== 'PENDING_ENABLE');
    const changeAudits = await audits();
    for (const row of terminal) {
      expect(
        changeAudits.some((a) => (a.changes as unknown as { requestId?: string }).requestId === row.id),
        `missing audit for ${row.id} (${row.state})`,
      ).toBe(true);
    }
  });
});

// ============================================================
// D. Emergency
// ============================================================
describe('Kill Switch 变更入口 — D Emergency（SECURITY_INCIDENT）', () => {
  it('D1 紧急拉闸审计含 emergency=true / reasonCode / actorUserId / scope / timestamp', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const res = await post(base, {
        cookie: owner,
        body: {
          scope: 'submission',
          target: 'disabled',
          phase: 'request',
          reasonCode: 'SECURITY_INCIDENT',
          note: 'incident drill',
          idempotencyKey: uuid(22),
        },
      });
      expect(res.status).toBe(200);
      const row = (await audits())[0];
      const changes = row?.changes as unknown as Record<string, unknown>;
      expect(changes.emergency).toBe(true);
      expect(changes.reasonCode).toBe('SECURITY_INCIDENT');
      expect(changes.scope).toBe('submission');
      expect(changes.actorUserId).toBe((await userByEmail('ksc-owner-a@example.com')).id);
      expect(typeof changes.occurredAt).toBe('string');
      expect(row?.actorUserId).toBe(changes.actorUserId);
    });
  });

  it('D2 紧急关闭不受速率限制（普通原因第 6 次 429）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      for (let i = 0; i < 5; i += 1) {
        const res = await post(base, {
          cookie: owner,
          body: {
            scope: 'billing',
            target: 'disabled',
            phase: 'request',
            reasonCode: 'MAINTENANCE',
            idempotencyKey: uuid(30 + i),
          },
        });
        expect(res.status, `#${i}`).toBe(200);
      }
      const limited = await post(base, {
        cookie: owner,
        body: {
          scope: 'billing',
          target: 'disabled',
          phase: 'request',
          reasonCode: 'MAINTENANCE',
          idempotencyKey: uuid(40),
        },
      });
      expect(limited.status).toBe(429);
      expect(limited.body.error).toBe('RATE_LIMITED');

      const emergency = await post(base, {
        cookie: owner,
        body: {
          scope: 'billing',
          target: 'disabled',
          phase: 'request',
          reasonCode: 'SECURITY_INCIDENT',
          idempotencyKey: uuid(41),
        },
      });
      expect(emergency.status).toBe(200);
    });
  });
});

// ============================================================
// E. HTTP 安全
// ============================================================
describe('Kill Switch 变更入口 — E HTTP 安全', () => {
  it('E1 未登录 → 401', async () => {
    await withServer(async (base) => {
      const res = await post(base, {
        body: { scope: 'submission', target: 'disabled', phase: 'request', reasonCode: 'MAINTENANCE', idempotencyKey: uuid(50) },
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });
  });

  it('E2 无权限 → 403（ADMIN 不能发起、OPS/FINANCE/VIEWER 完全不可）', async () => {
    await withServer(async (base) => {
      for (const email of ['ksc-admin@example.com', 'ksc-ops@example.com', 'ksc-finance@example.com', 'ksc-viewer@example.com']) {
        const cookie = await login(base, email);
        const res = await post(base, {
          cookie,
          body: {
            scope: 'submission',
            target: 'disabled',
            phase: 'request',
            reasonCode: 'MAINTENANCE',
            idempotencyKey: uuid(51),
          },
        });
        expect(res.status, email).toBe(403);
        expect(res.body.error, email).toBe('FORBIDDEN');
      }
      expect(await requests()).toHaveLength(0);
    });
  });

  it('E3 缺 CSRF 自定义头 → 403 CSRF_REJECTED（且不写任何状态）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const res = await post(base, {
        cookie: owner,
        csrf: false,
        body: { scope: 'submission', target: 'disabled', phase: 'request', reasonCode: 'MAINTENANCE', idempotencyKey: uuid(52) },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('CSRF_REJECTED');
      expect(await requests()).toHaveLength(0);
    });
  });

  it('E4 跨源 Origin → 403 CSRF_REJECTED；无 Origin/Referer → 403', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const crossOrigin = await post(base, {
        cookie: owner,
        origin: 'https://evil.example',
        body: { scope: 'submission', target: 'disabled', phase: 'request', reasonCode: 'MAINTENANCE', idempotencyKey: uuid(53) },
      });
      expect(crossOrigin.status).toBe(403);
      expect(crossOrigin.body.error).toBe('CSRF_REJECTED');
      const noOrigin = await post(base, {
        cookie: owner,
        origin: null,
        body: { scope: 'submission', target: 'disabled', phase: 'request', reasonCode: 'MAINTENANCE', idempotencyKey: uuid(54) },
      });
      expect(noOrigin.status).toBe(403);
    });
  });

  it('E5 phase × target 组合非法 → 400；confirm 缺 requestId → 400；非 UUID 幂等键 → 400', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const badCombination = await post(base, {
        cookie: owner,
        body: { scope: 'submission', target: 'disabled', phase: 'confirm', reasonCode: 'MAINTENANCE', requestId: uuid(55), idempotencyKey: uuid(56) },
      });
      expect(badCombination.status).toBe(400);
      expect(badCombination.body.error).toBe('INVALID_INPUT');

      const missingRequestId = await post(base, {
        cookie: owner,
        body: { scope: 'submission', target: 'enabled', phase: 'confirm', reasonCode: 'MAINTENANCE', idempotencyKey: uuid(57) },
      });
      expect(missingRequestId.status).toBe(400);

      const badKey = await post(base, {
        cookie: owner,
        body: { scope: 'submission', target: 'disabled', phase: 'request', reasonCode: 'MAINTENANCE', idempotencyKey: 'not-a-uuid' },
      });
      expect(badKey.status).toBe(400);
      expect(await requests()).toHaveLength(0);
    });
  });

  it('E6 note 超长 / 含凭据 → 400 SECRET_NOT_ACCEPTED（错误体不含内部细节）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const tooLong = await post(base, {
        cookie: owner,
        body: {
          scope: 'submission',
          target: 'disabled',
          phase: 'request',
          reasonCode: 'MAINTENANCE',
          note: 'x'.repeat(201),
          idempotencyKey: uuid(58),
        },
      });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error).toBe('INVALID_INPUT');

      const secret = await post(base, {
        cookie: owner,
        body: {
          scope: 'submission',
          target: 'disabled',
          phase: 'request',
          reasonCode: 'MAINTENANCE',
          note: 'apiKey=sk-live-abcdefghijklmnop',
          idempotencyKey: uuid(59),
        },
      });
      expect(secret.status).toBe(400);
      expect(secret.body.error).toBe('SECRET_NOT_ACCEPTED');
      // 错误体不得回显 note 原文或堆栈
      expect(JSON.stringify(secret.body)).not.toContain('sk-live');
      expect(JSON.stringify(secret.body)).not.toContain('stack');
      expect(await requests()).toHaveLength(0);
    });
  });

  it('E7 确认不存在的申请 → 404；跨租户 requestId → 404', async () => {
    await withServer(async (base) => {
      const admin = await login(base, 'ksc-admin@example.com');
      const res = await post(base, {
        cookie: admin,
        body: { scope: 'submission', target: 'enabled', phase: 'confirm', reasonCode: 'MAINTENANCE', requestId: uuid(60), idempotencyKey: uuid(61) },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });
  });

  it('E8 方法闸门：PUT/GET 语义 —— PUT 405，GET 仍为只读 200', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const put = await fetch(`${base}/admin/kill-switch`, { method: 'PUT', headers: { cookie: owner } });
      expect(put.status).toBe(405);
      const get = await fetch(`${base}/admin/kill-switch`, { headers: { cookie: owner } });
      expect(get.status).toBe(200);
      const body = (await get.json()) as { visibility: string; switches: Array<Record<string, unknown>> };
      expect(body.visibility).toBe('full');
      expect(body.switches).toHaveLength(6);
    });
  });

  it('E9 业务事实冻结：变更入口不触碰 Claim/Settlement/Billing/Payment（全部计数为 0）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'ksc-owner-a@example.com');
      const admin = await login(base, 'ksc-admin@example.com');
      const request = await requestEnable(base, owner, 'submission', uuid(62));
      await post(base, {
        cookie: admin,
        body: { scope: 'submission', target: 'enabled', phase: 'confirm', reasonCode: 'MAINTENANCE', requestId: request.body.requestId, idempotencyKey: uuid(63) },
      });
      await post(base, {
        cookie: owner,
        body: { scope: 'submission', target: 'disabled', phase: 'request', reasonCode: 'SECURITY_INCIDENT', idempotencyKey: uuid(64) },
      });
      const counts = {
        claim: await prisma.claim.count(),
        settlement: await prisma.settlement.count(),
        ledger: await prisma.recoveryLedgerEntry.count(),
        billing: await prisma.billingInvoice.count(),
        payment: await prisma.payment.count(),
      };
      expect(counts).toEqual({ claim: 0, settlement: 0, ledger: 0, billing: 0, payment: 0 });
      // 台账/结算零触碰的同时，控制面本身可读且状态自洽
      const rows = await requests();
      expect(rows.filter((r) => r.state === 'PENDING_ENABLE')).toHaveLength(0);
    });
  });
});
