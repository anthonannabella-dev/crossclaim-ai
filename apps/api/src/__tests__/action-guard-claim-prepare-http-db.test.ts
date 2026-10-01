/**
 * Gate 7 / ② RUNTIME BUSINESS BLOCKING · claim.prepare（INTERNAL_WRITE 内部准备写入）
 * -----------------------------------------------------------------------------
 * 依据 MSG-20261001-07 §6（R23 = PASS，下一小批次 = `claim.prepare`）：
 *   - 入口接线 + 能力闸门（无人工审批）；
 *   - 保持租户隔离、动作权限、审计失败关闭、默认控制面限制；
 *   - 验收：拒绝零业务副作用 / 合法准备结果与审计一致 / 其他租户与无权限主体拒绝；
 *   - 不触发 claim.submit、平台外写或资金动作。
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
import { handleWorkflowRequest, type WorkflowRouteDeps } from '../services/workflow/http-routes';
import { SESSION_COOKIE } from '../services/auth/http-routes';

const prisma = new PrismaClient();
let ORG = '';
const SALT = 'claim-prepare-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'claim-prepare-pass-1';
let EMAIL = '';
const ACTION = 'claim.prepare';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-claim-prepare-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let ownerId = '';
let caseId = '';

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
  EMAIL = `claim-prepare-${suffix}@example.com`;
  await prisma.organization.create({
    data: { id: ORG, name: 'claim.prepare 租户', slug: `claim-prepare-${suffix}` },
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
      caseNo: `CP-${suffix}`,
      title: 'claim.prepare 用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
});

type GuardVariant = 'permissive' | 'defaultGuard' | 'killSwitchOff' | 'featureOff' | 'readOnly';

function guard(
  options: { killSwitch?: 'enabled' | 'disabled'; feature?: boolean; mode?: 'READ_ONLY' | 'MANUAL_REVIEW' | 'WRITE_ENABLED' } = {},
): RuntimeActionGuard {
  return createAppActionGuard({
    prisma,
    killSwitchResolver: {
      async resolve(scope: string) {
        return {
          scope,
          value: options.killSwitch ?? 'enabled',
          degraded: false,
          stale: false,
        } as { scope: string; value: 'enabled' | 'disabled'; degraded: boolean; stale: boolean };
      },
    },
    audit: { write: () => {} },
    config: staticControlPlaneConfig({
      globalDisabled: false,
      mode: options.mode ?? 'WRITE_ENABLED',
      productionGate: 'SATISFIED',
      platformEnabled: { [ACTION]: true },
      tenantFeatureEnabled: { [ACTION]: options.feature ?? true },
      hostApprovalGranted: true,
    }),
  });
}

const liveServers: Array<{ close: (cb: () => void) => void }> = [];
const baseByVariant = new Map<GuardVariant, string>();

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
  if (variant === 'killSwitchOff') return guard({ killSwitch: 'disabled' });
  if (variant === 'featureOff') return guard({ feature: false });
  if (variant === 'readOnly') return guard({ mode: 'READ_ONLY' });
  return guard();
}

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

async function withServer<T>(
  run: (base: string) => Promise<T>,
  options: { variant?: GuardVariant } = {},
): Promise<T> {
  return run(await baseFor(options.variant ?? 'permissive'));
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

/** 在默认租户内新增一名独立成员（用于无权限主体验收） */
async function createMember(role: 'FINANCE' | 'VIEWER' | 'OPS'): Promise<{ userId: string; email: string }> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const email = `claim-prepare-${role.toLowerCase()}-${suffix}@example.com`;
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

async function prepare(
  base: string,
  cookie: string,
  body: Record<string, unknown> = { target: 'CARRIER', draftText: 'prepare draft body' },
  targetCaseId: string = caseId,
) {
  const res = await fetch(`${base}/cases/${targetCaseId}/claim/prepare`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 业务副作用快照：准备写入只允许落 Claim 草稿与 claim.prepared 审计 */
async function sideEffects() {
  const claims = await prisma.claim.findMany({
    where: { organizationId: ORG },
    select: { id: true, status: true, target: true, aiDraftText: true, submittedAt: true, submittedBy: true },
  });
  return {
    claimRows: claims.length,
    claimStatuses: claims.map((row) => row.status),
    preparedAudits: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'claim.prepared' } }),
    submissionAudits: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'claim.submitted_by_human' } }),
    consumedAudits: await prisma.auditLog.count({ where: { organizationId: ORG, action: { contains: 'consumed' } } }),
    payouts: await prisma.recoveryPayout.count({ where: { organizationId: ORG } }),
  };
}

const ZERO = {
  claimRows: 0,
  preparedAudits: 0,
  submissionAudits: 0,
  consumedAudits: 0,
  payouts: 0,
};

/** 直接调用工作流处理器（不经 server 前缀门控），用于覆盖「缺 Action Guard 装配」路径 */
async function callWorkflowDirect(targetPath: string, body: Record<string, unknown>) {
  const token = 'claim-prepare-direct-session-token';
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  const reqAny = req as unknown as { url?: string; method?: string; headers?: Record<string, string> };
  reqAny.url = targetPath;
  reqAny.method = 'POST';
  reqAny.headers = {
    cookie: `${SESSION_COOKIE}=${token}`,
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
        create: async () => ({ id: 'claim-prepare-session' }),
        findByTokenHash: async () => ({
          id: 'claim-prepare-session',
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

describe('② RUNTIME BUSINESS BLOCKING — claim.prepare（真实 HTTP + PostgreSQL）', () => {
  it('01 未配置 control plane（默认 READ_ONLY）→ 拒绝且零业务副作用', async () => {
    await withServer(
      async (base) => {
        const cookie = await login(base);
        const res = await prepare(base, cookie);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
        expect(await sideEffects()).toMatchObject(ZERO);
      },
      { variant: 'defaultGuard' },
    );
  }, 60_000);

  it('02 缺 Action Guard 装配（直调 handleWorkflowRequest）→ 拒绝且零业务副作用', async () => {
    const res = await callWorkflowDirect(`/cases/${caseId}/claim/prepare`, {
      target: 'CARRIER',
      draftText: 'direct call',
    });
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('ACTION_GUARD_NOT_CONFIGURED');
    expect(await sideEffects()).toMatchObject(ZERO);
  }, 60_000);

  it('03 Kill Switch（workflow scope）关闭 → 拒绝且零业务副作用', async () => {
    await withServer(
      async (base) => {
        const cookie = await login(base);
        const res = await prepare(base, cookie);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
        expect(await sideEffects()).toMatchObject(ZERO);
      },
      { variant: 'killSwitchOff' },
    );
  }, 60_000);

  it('04 动作 feature 未开启 → 拒绝且零业务副作用', async () => {
    await withServer(
      async (base) => {
        const cookie = await login(base);
        const res = await prepare(base, cookie);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
        expect(await sideEffects()).toMatchObject(ZERO);
      },
      { variant: 'featureOff' },
    );
  }, 60_000);

  it('05 控制面 READ_ONLY（内部写入不允许）→ 拒绝且零业务副作用', async () => {
    await withServer(
      async (base) => {
        const cookie = await login(base);
        const res = await prepare(base, cookie);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
        expect(await sideEffects()).toMatchObject(ZERO);
      },
      { variant: 'readOnly' },
    );
  }, 60_000);

  it('06 合法准备（INTERNAL_WRITE 无需 approvalId）→ 草稿落库 + 审计恰一次 + 零平台外写/资金', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await prepare(base, cookie, { target: 'carrier', draftText: '  prepared body  ' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        caseId,
        round: 1,
        status: 'DRAFT',
        target: 'CARRIER',
        created: true,
        platformWriteExecuted: false,
        externalSubmission: 'NOT_ATTEMPTED',
      });
      const claimId = String(res.body.claimId);
      const claim = await prisma.claim.findUniqueOrThrow({ where: { id: claimId } });
      expect(claim.organizationId).toBe(ORG);
      expect(claim.caseId).toBe(caseId);
      expect(claim.round).toBe(1);
      expect(claim.status).toBe('DRAFT');
      expect(claim.target).toBe('CARRIER');
      expect(claim.aiDraftText).toBe('prepared body');
      // 准备写入不推进 Claim：提交/批准字段保持未写
      expect(claim.submittedAt).toBeNull();
      expect(claim.submittedBy).toBeNull();
      expect(claim.approvedByUserId).toBeNull();
      expect(claim.approvedAt).toBeNull();

      const preparedRows = await prisma.auditLog.findMany({
        where: { organizationId: ORG, action: 'claim.prepared' },
      });
      expect(preparedRows).toHaveLength(1);
      expect(preparedRows[0]?.actorUserId).toBe(ownerId);
      expect(preparedRows[0]?.entityType).toBe('Claim');
      expect(preparedRows[0]?.entityId).toBe(claimId);
      expect(preparedRows[0]?.changes as Record<string, unknown>).toMatchObject({
        caseId,
        claimId,
        round: 1,
        target: 'CARRIER',
        created: true,
      });
      expect((await sideEffects()).submissionAudits).toBe(0);
      expect((await sideEffects()).payouts).toBe(0);

      // 零平台外写探针：受保护入口文件不引用适配器写入面
      const routeSource = fs.readFileSync(path.resolve(__dirname, '..', 'services', 'workflow', 'http-routes.ts'), 'utf8');
      expect(routeSource).not.toMatch(/submitClaim\s*\(/);
      expect(routeSource).not.toMatch(/from '\.\.\/adapters/);
    });
  }, 60_000);

  it('07 同一案件再次准备（仍 DRAFT）→ 更新既有草稿（不新建）+ 审计累计', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const first = await prepare(base, cookie, { target: 'CARRIER', draftText: 'first' });
      expect(first.status).toBe(200);
      const second = await prepare(base, cookie, { target: 'INSURER', draftText: 'second' });
      expect(second.status).toBe(200);
      expect(second.body.claimId).toBe(first.body.claimId);
      expect(second.body).toMatchObject({ created: false, target: 'INSURER' });
      const after = await sideEffects();
      expect(after.claimRows).toBe(1);
      expect(after.preparedAudits).toBe(2);
      const claim = await prisma.claim.findUniqueOrThrow({ where: { id: String(first.body.claimId) } });
      expect(claim.aiDraftText).toBe('second');
      expect(claim.status).toBe('DRAFT');
    });
  }, 60_000);

  it('08 Claim 已离开 DRAFT → 拒绝（ILLEGAL_TRANSITION）且零业务副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const kase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      const claim = await prisma.claim.create({
        data: {
          organizationId: ORG,
          caseId: kase.id,
          round: 1,
          status: 'SUBMITTED',
          target: 'CARRIER',
          aiDraftText: 'already submitted',
        },
      });
      const res = await prepare(base, cookie, { target: 'INSURER', draftText: 'should not apply' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ILLEGAL_TRANSITION');
      const after = await prisma.claim.findUniqueOrThrow({ where: { id: claim.id } });
      expect(after.status).toBe('SUBMITTED');
      expect(after.aiDraftText).toBe('already submitted');
      expect((await sideEffects()).preparedAudits).toBe(0);
    });
  }, 60_000);

  it('09 其他租户的案件 → NOT_FOUND 且零业务副作用', async () => {
    const foreignOrg = await prisma.organization.create({
      data: { id: randomUUID(), name: '外部租户', slug: `claim-prepare-foreign-${randomUUID().slice(0, 8)}` },
    });
    const foreignCase = await prisma.case.create({
      data: {
        organizationId: foreignOrg.id,
        caseNo: `CP-FOREIGN-${randomUUID().slice(0, 6)}`,
        title: '外部案件',
        domain: 'LOGISTICS',
        status: 'WON',
        claimedAmount: new Prisma.Decimal('10.0000'),
        currency: 'USD',
      },
    });
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await prepare(base, cookie, { target: 'CARRIER', draftText: 'cross tenant' }, foreignCase.id);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
      expect(await prisma.claim.count({ where: { organizationId: foreignOrg.id } })).toBe(0);
      expect((await sideEffects()).claimRows).toBe(0);
      expect((await sideEffects()).preparedAudits).toBe(0);
    });
  }, 60_000);

  it('10 无权限主体（FINANCE）→ FORBIDDEN 且零业务副作用', async () => {
    await withServer(async (base) => {
      const finance = await createMember('FINANCE');
      const cookie = await login(base, finance.email);
      const res = await prepare(base, cookie);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('11 业务审计写入失败（claim.prepared 被库拒绝）→ 整笔准备事务回滚', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "AuditLog" ADD CONSTRAINT claim_prepare_block_audit CHECK (action <> 'claim.prepared') NOT VALID`,
      );
      try {
        const res = await prepare(base, cookie);
        // 审计写入被库拒绝 → 必须是失败响应（不得 2xx）
        expect(res.status).toBeGreaterThanOrEqual(400);
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS claim_prepare_block_audit',
        );
      }
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('12 非法输入（target/draftText）→ 400 且零业务副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const badTarget = await prepare(base, cookie, { target: 'NOT_A_TARGET', draftText: 'x' });
      expect(badTarget.status).toBe(400);
      expect(badTarget.body.error).toBe('INVALID_FIELD');
      const emptyDraft = await prepare(base, cookie, { target: 'CARRIER', draftText: '   ' });
      expect(emptyDraft.status).toBe(400);
      expect(emptyDraft.body.error).toBe('INVALID_FIELD');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);
});
