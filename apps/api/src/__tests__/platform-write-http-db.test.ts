/**
 * R37 P1/P2 —— platform.write HTTP 入口（真实 HTTP + PostgreSQL）
 * ---------------------------------------------------------------------------
 * 依据 docs/releases/INTEGRATION-BOUNDARY-REVIEW-PLAN.md §8（H1–H4 / H7 子集）：
 *   H1 未认证 → 401；跨租户 → 404（fail-closed，零副作用）
 *   H2/H3 角色不足 / Action Guard 未装配 / 能力未满足 → 拒绝（零投递零账本零消费）
 *   H4 客户端自证 snapshotDigest / basisReference / payload / organizationId → 拒绝；
 *      幂等键与服务端派生不一致 → 409
 *   H7 transport 关闭 → 200 且 platformWriteExecuted=false / NEEDS_MANUAL / sinkCalls=0
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
import type { RuntimeActionGuard } from '../services/action-guard/runtime-guard';
import { APPROVAL_REASON_CODES } from '../services/action-guard/approval-verifier';
import { handleWorkflowRequest, type WorkflowRouteDeps } from '../services/workflow/http-routes';
import { SESSION_COOKIE } from '../services/auth/http-routes';
import { submitRecoveryReview } from '../services/workflow/recovery-review';
import {
  buildServerSidePlatformWriteSnapshot,
  PLATFORM_WRITE_CLIENT_ASSERTION_FIELDS,
} from '../services/platform-write/http-request';
import { PLATFORM_WRITE_ACTION } from '../services/action-guard/approval-verifier';

const prisma = new PrismaClient();
const SALT = 'platform-write-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'platform-write-pass-1';
const NOW = new Date(Date.now() - 60_000);
const PLATFORM = 'amazon-sp';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-platform-write-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let ORG = '';
let EMAIL = '';
let ownerId = '';
let caseId = '';
let claimId = '';
let foreignOrg = '';
let foreignEmail = '';

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
      'TRUNCATE TABLE ' + tables.map((row) => '"' + row.tablename + '"').join(', ') + ' CASCADE;',
    );
  }
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  ORG = randomUUID();
  EMAIL = 'platform-write-' + suffix + '@example.com';
  await prisma.organization.create({
    data: { id: ORG, name: 'platform.write 租户', slug: 'platform-write-' + suffix },
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
      caseNo: 'CS-' + suffix,
      title: 'platform.write 用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  const claim = await prisma.claim.create({
    data: { organizationId: ORG, caseId, round: 1, status: 'DRAFT', target: 'CARRIER', aiDraftText: 'draft' },
  });
  claimId = claim.id;

  // 跨租户对照：另一个组织与案件（不得被同一会话读写）
  const foreignSuffix = randomUUID().replace(/-/g, '').slice(0, 10);
  foreignOrg = randomUUID();
  foreignEmail = 'platform-write-foreign-' + foreignSuffix + '@example.com';
  await prisma.organization.create({
    data: { id: foreignOrg, name: '外租户', slug: 'platform-write-foreign-' + foreignSuffix },
  });
  const foreignUser = await prisma.user.create({
    data: {
      email: foreignEmail,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'FOREIGN OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { organizationId: foreignOrg, userId: foreignUser.id, role: 'OWNER', isActive: true },
  });
  await prisma.case.create({
    data: {
      organizationId: foreignOrg,
      caseNo: 'CS-F-' + foreignSuffix,
      title: '外租户案件',
      domain: 'LOGISTICS',
      status: 'WON',
      currency: 'USD',
    },
  });
});

type GuardVariant = 'permissive' | 'defaultGuard' | 'platformOff' | 'tenantOff' | 'gateOff';

function guard(
  options: { platform?: boolean; tenant?: boolean; gate?: 'SATISFIED' | 'NOT_SATISFIED' } = {},
): RuntimeActionGuard {
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
      mode: 'WRITE_ENABLED',
      productionGate: options.gate ?? 'SATISFIED',
      platformEnabled: { [PLATFORM_WRITE_ACTION]: options.platform ?? true },
      tenantFeatureEnabled: { [PLATFORM_WRITE_ACTION]: options.tenant ?? true },
      hostApprovalGranted: true,
    }),
  });
}

function guardForVariant(variant: GuardVariant): RuntimeActionGuard {
  if (variant === 'defaultGuard') {
    // 未注入 control plane 配置 → 控制面回落 READ_ONLY（fail closed）
    return createAppActionGuard({
      prisma,
      killSwitchResolver: {
        async resolve(scope: string) {
          return { scope, value: 'enabled' as const, degraded: false, stale: false };
        },
      },
      audit: { write: () => {} },
    });
  }
  if (variant === 'platformOff') return guard({ platform: false });
  if (variant === 'tenantOff') return guard({ tenant: false });
  if (variant === 'gateOff') return guard({ gate: 'NOT_SATISFIED' });
  return guard();
}

const liveServers: Array<{ close: (cb: () => void) => void }> = [];
const baseByVariant = new Map<GuardVariant, string>();

async function baseFor(variant: GuardVariant): Promise<string> {
  const cached = baseByVariant.get(variant);
  if (cached) return cached;
  const server = createServer({ prisma, log, audit, storage, actionGuard: guardForVariant(variant) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = 'http://127.0.0.1:' + port;
  liveServers.push(server);
  baseByVariant.set(variant, base);
  return base;
}

async function withServer<T>(
  run: (base: string) => Promise<T>,
  options: { variant?: GuardVariant } = {},
): Promise<T> {
  return run(await baseFor(options.variant ?? 'permissive'));
}

async function login(base: string, email: string = EMAIL): Promise<string> {
  const res = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function write(
  base: string,
  cookie: string,
  body: Record<string, unknown> = {},
  targetCaseId: string = caseId,
) {
  const res = await fetch(base + '/cases/' + targetCaseId + '/platform/write', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ platform: PLATFORM, ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 服务端快照摘要（审批绑定与执行核验共用同一算法） */
async function snapshotDigestFor(
  overrides: { organizationId?: string; caseId?: string; platform?: string; targetKind?: 'CLAIM' | 'APPEAL' } = {},
): Promise<string> {
  const bundle = await buildServerSidePlatformWriteSnapshot(prisma, {
    organizationId: overrides.organizationId ?? ORG,
    caseId: overrides.caseId ?? caseId,
    targetKind: overrides.targetKind ?? 'CLAIM',
    platform: overrides.platform ?? PLATFORM,
  });
  return bundle.digest;
}

async function seedApproval(boundBasis?: string): Promise<string> {
  const basis = boundBasis ?? (await snapshotDigestFor());
  await submitRecoveryReview(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId,
      decision: 'REQUEST',
      recoveredAmount: null,
      currency: null,
    } as never,
    () => NOW,
  );
  const approved = (await submitRecoveryReview(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId,
      decision: 'APPROVE',
      boundAction: PLATFORM_WRITE_ACTION,
      boundPayload: { basisReference: basis },
    } as never,
    () => new Date(NOW.getTime() + 1000),
  )) as { approvalId?: string };
  if (!approved.approvalId) throw new Error('APPROVAL_NOT_CREATED');
  return approved.approvalId;
}

async function sideEffects() {
  return {
    attempts: await prisma.platformWriteAttempt.count({ where: { organizationId: ORG } }),
    consumedAudits: await prisma.auditLog.count({
      where: { organizationId: ORG, action: 'recovery.approval_consumed' },
    }),
    platformWriteAudits: await prisma.auditLog.count({
      where: { organizationId: ORG, action: { startsWith: 'platform.write' } },
    }),
    claimStatus: (await prisma.claim.findUniqueOrThrow({ where: { id: claimId } })).status,
  };
}

const ZERO = { attempts: 0, consumedAudits: 0, platformWriteAudits: 0, claimStatus: 'DRAFT' };

const REJECTION_CODES: readonly string[] = [
  'ACTION_GUARD_NOT_CONFIGURED',
  'ACTION_GUARD_REQUIREMENTS_NOT_MET',
  'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED',
  'ACTION_GUARD_APPROVAL_NOT_VERIFIED',
  'ACTION_GUARD_STATE_UNAVAILABLE',
  'FORBIDDEN',
  ...APPROVAL_REASON_CODES,
];

function rejectionReason(body: Record<string, unknown>): string {
  const code = [body.reason, body.error, body.code]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((value) => value !== '');
  return code ?? '';
}

/** 直接调用工作流处理器（不经 server 前缀门控），覆盖「缺 Action Guard 装配」路径 */
async function callWorkflowDirect(body: Record<string, unknown>) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  const reqAny = req as unknown as { url?: string; method?: string; headers?: Record<string, string> };
  reqAny.url = '/cases/' + caseId + '/platform/write';
  reqAny.method = 'POST';
  reqAny.headers = {
    cookie: SESSION_COOKIE + '=r37-direct-session-token',
    'content-type': 'application/json',
    origin: 'http://127.0.0.1',
  };

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
        create: async () => ({ id: 'r37-session' }),
        findByTokenHash: async () => ({
          id: 'r37-session',
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
    // 缺省（不传 actionGuard）即「装配缺失」路径
  };

  await handleWorkflowRequest(req, res, deps);
  return { status, body: payload as Record<string, unknown> | null };
}

describe('R37 P1/P2 — platform.write HTTP 入口（真实 HTTP + PostgreSQL）', () => {
  it('H1a 未认证 → 401 且零副作用', async () => {
    await withServer(async (base) => {
      const res = await write(base, '', {});
      expect(res.status).toBe(401);
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('H1b 跨租户案件 → 404（不泄露存在性）且零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base, foreignEmail);
      const res = await write(base, cookie, {});
      expect(res.status).toBe(404);
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('H2 缺 Action Guard 装配 → 403 ACTION_GUARD_NOT_CONFIGURED 且零副作用', async () => {
    const res = await callWorkflowDirect({ platform: PLATFORM });
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('ACTION_GUARD_NOT_CONFIGURED');
    expect(await sideEffects()).toMatchObject(ZERO);
  }, 60_000);

  it('H3a 缺 approvalId → 拒绝且零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await write(base, cookie, {});
      expect([403, 409]).toContain(res.status);
      expect(REJECTION_CODES).toContain(rejectionReason(res.body));
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('H3b 能力未满足（platform / tenant / Production Gate）→ 拒绝且零副作用', async () => {
    for (const variant of ['platformOff', 'tenantOff', 'gateOff', 'defaultGuard'] as const) {
      await withServer(
        async (base) => {
          const cookie = await login(base);
          const approvalId = await seedApproval();
          const res = await write(base, cookie, { approvalId });
          expect([403, 409]).toContain(res.status);
          expect(REJECTION_CODES).toContain(rejectionReason(res.body));
          expect(await sideEffects()).toMatchObject(ZERO);
        },
        { variant },
      );
    }
  }, 120_000);

  it('H4a 客户端自证服务端事实字段 → 400 CLIENT_ASSERTION_REJECTED（无需审批也拒绝）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      for (const field of PLATFORM_WRITE_CLIENT_ASSERTION_FIELDS) {
        const res = await write(base, cookie, { [field]: 'deadbeef' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('PLATFORM_WRITE_CLIENT_ASSERTION_REJECTED');
      }
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('H4b 客户端声明的幂等键与服务端不一致 → 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await write(base, cookie, { idempotencyKey: 'pw1-client-forged' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('PLATFORM_WRITE_IDEMPOTENCY_KEY_MISMATCH');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('H4c 客户端回抄服务端派生幂等键 → 接受（服务端派生值一致）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const bundle = await buildServerSidePlatformWriteSnapshot(prisma, {
        organizationId: ORG,
        caseId,
        targetKind: 'CLAIM',
        platform: PLATFORM,
      });
      const approvalId = await seedApproval();
      const res = await write(base, cookie, { approvalId, idempotencyKey: bundle.idempotencyKey });
      expect(res.status).toBe(200);
      expect(res.body.platformWriteExecuted).toBe(false);
    });
  }, 60_000);

  it('H3c 目标不存在（targetKind=APPEAL 无 Appeal）→ 404 且零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await write(base, cookie, { targetKind: 'APPEAL' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('PLATFORM_WRITE_TARGET_NOT_FOUND');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('H3d 非法 targetKind → 400 且零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await write(base, cookie, { targetKind: 'INVOICE' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('PLATFORM_WRITE_INVALID_BODY');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('H7 合法审批 + transport 关闭 → 200 NEEDS_MANUAL / platformWriteExecuted=false / 零投递零账本零消费', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval();
      const res = await write(base, cookie, { approvalId });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'NEEDS_MANUAL',
        attemptId: null,
        platformWriteExecuted: false,
        executionDisposition: 'NEEDS_MANUAL',
      });
      for (const leaked of ['providerRef', 'providerStatus', 'externalRef', 'sinkCalls', 'providerSuccess']) {
        expect(Object.keys(res.body)).not.toContain(leaked);
      }
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('H7b 审批绑定到其他快照摘要 → 403 且零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await seedApproval('forged-basis-reference');
      const res = await write(base, cookie, { approvalId });
      expect(res.status).toBe(403);
      expect(rejectionReason(res.body)).toBe('APPROVAL_PAYLOAD_MISMATCH');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);
});
