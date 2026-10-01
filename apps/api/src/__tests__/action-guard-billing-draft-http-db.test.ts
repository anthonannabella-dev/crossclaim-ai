/**
 * Gate 7 / ② RUNTIME BUSINESS BLOCKING · billing.draft（INTERNAL_WRITE 账单草稿写入）
 * ---------------------------------------------------------------------------------
 * 依据 MSG-20261001-10 §5：真实入口接入 Action Guard（缺装配/能力不足失败关闭）、租户与当前主体权限、
 * 锁后重读执行事实、草稿与业务审计同事务（失败回滚）、并发不重复生成；不推进收款/到账/扣划/平台外写。
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
const SALT = 'billing-draft-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'billing-draft-pass-1';
let EMAIL = '';
const ACTION = 'billing.draft';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-billing-draft-'));
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
  EMAIL = `billing-draft-${suffix}@example.com`;
  await prisma.organization.create({
    data: { id: ORG, name: 'billing.draft 租户', slug: `billing-draft-${suffix}` },
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
      caseNo: `BD-${suffix}`,
      title: 'billing.draft 用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      recoveredAmount: new Prisma.Decimal('3000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
});

/** 已确认的费用依据（账单业务前置条件） */
async function seedFee(amount = '450.0000'): Promise<string> {
  const fee = await prisma.feeCalculation.create({
    data: {
      organizationId: ORG,
      caseId,
      basis: 'RECOVERED_AMOUNT_PCT',
      rate: new Prisma.Decimal('0.150000'),
      baseAmount: new Prisma.Decimal('3000.0000'),
      feeAmount: new Prisma.Decimal(amount),
      currency: 'USD',
      computation: { source: 'test-fixture' } as never,
    },
  });
  return fee.id;
}

type GuardVariant = 'permissive' | 'defaultGuard' | 'killSwitchOff' | 'featureOff' | 'readOnly';

function guard(
  options: {
    killSwitch?: 'enabled' | 'disabled';
    feature?: boolean;
    mode?: 'READ_ONLY' | 'MANUAL_REVIEW' | 'WRITE_ENABLED';
  } = {},
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

async function createMember(role: 'OPS' | 'FINANCE' | 'VIEWER'): Promise<{ userId: string; email: string }> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const email = `billing-draft-${role.toLowerCase()}-${suffix}@example.com`;
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

async function draft(base: string, cookie: string, targetCaseId: string = caseId) {
  const res = await fetch(`${base}/cases/${targetCaseId}/billing/draft`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify({}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 业务副作用快照：本批次只允许新增 BillingInvoice(DRAFT) 与 billing.drafted 审计 */
async function sideEffects() {
  const invoices = await prisma.billingInvoice.findMany({
    where: { organizationId: ORG },
    select: { id: true, status: true, total: true, currency: true, paidAt: true },
  });
  return {
    invoiceRows: invoices.length,
    invoiceStatuses: invoices.map((row) => row.status),
    draftedAudits: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'billing.drafted' } }),
    payments: await prisma.payment.count({ where: { organizationId: ORG } }),
    settlements: await prisma.settlement.count({ where: { organizationId: ORG } }),
    ledgerEntries: await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } }),
    issuedAudits: await prisma.auditLog.count({ where: { organizationId: ORG, action: { contains: 'billing.' } } }),
  };
}

const ZERO = { invoiceRows: 0, draftedAudits: 0, payments: 0, settlements: 0, ledgerEntries: 0 };

const caseLockKey = () => `cc-recovery-case:${caseId}`;

async function advisoryLockCount(key: string, granted: boolean): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n
       FROM pg_locks l
      WHERE l.locktype = 'advisory'
        AND l.granted = ${granted ? 'true' : 'false'}
        AND (l.objid::text = ((hashtext($1)::bigint & 4294967295))::text
             OR l.classid::text = ((hashtext($1)::bigint & 4294967295))::text)`,
    key,
  );
  return Number(rows[0]?.n ?? 0n);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`CONTROL_POINT_TIMEOUT:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function holdCaseLock(): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  void prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', caseLockKey());
        await gate;
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    .catch(() => undefined);
  await waitFor(async () => (await advisoryLockCount(caseLockKey(), true)) >= 1, 10_000, 'CASE_LOCK_NOT_GRANTED');
  return release;
}

async function withAuditActionBlocked<T>(action: string, run: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "AuditLog" ADD CONSTRAINT billing_draft_block_audit CHECK (action <> '${action}') NOT VALID`,
  );
  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS billing_draft_block_audit');
  }
}

async function callWorkflowDirect(targetPath: string, body: Record<string, unknown>) {
  const token = 'billing-draft-direct-session-token';
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
        create: async () => ({ id: 'billing-draft-session' }),
        findByTokenHash: async () => ({
          id: 'billing-draft-session',
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

describe('② RUNTIME BUSINESS BLOCKING — billing.draft（真实 HTTP + PostgreSQL）', () => {
  it('01 未配置 control plane（默认 READ_ONLY）→ 拒绝且零业务副作用', async () => {
    await withServer(
      async (base) => {
        const cookie = await login(base);
        await seedFee();
        const res = await draft(base, cookie);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
        expect(await sideEffects()).toMatchObject(ZERO);
      },
      { variant: 'defaultGuard' },
    );
  }, 60_000);

  it('02 缺 Action Guard 装配（直调 handleWorkflowRequest）→ 拒绝且零业务副作用', async () => {
    await seedFee();
    const res = await callWorkflowDirect(`/cases/${caseId}/billing/draft`, {});
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('ACTION_GUARD_NOT_CONFIGURED');
    expect(await sideEffects()).toMatchObject(ZERO);
  }, 60_000);

  it('03 Kill Switch（billing scope）关闭 → 拒绝且零业务副作用', async () => {
    await withServer(
      async (base) => {
        const cookie = await login(base);
        await seedFee();
        const res = await draft(base, cookie);
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
        await seedFee();
        const res = await draft(base, cookie);
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
        await seedFee();
        const res = await draft(base, cookie);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
        expect(await sideEffects()).toMatchObject(ZERO);
      },
      { variant: 'readOnly' },
    );
  }, 60_000);

  it('06 合法草稿（INTERNAL_WRITE 无需 approvalId）→ DRAFT 账单 + 审计恰一次 + 不推进收款/到账', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const feeId = await seedFee('450.0000');
      const res = await draft(base, cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        caseId,
        status: 'DRAFT',
        subtotal: '450.0000',
        total: '450.0000',
        currency: 'USD',
        basisFeeCalculationId: feeId,
        created: true,
        paymentCollected: false,
        platformWriteExecuted: false,
      });
      const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: String(res.body.invoiceId) } });
      expect(invoice.organizationId).toBe(ORG);
      expect(invoice.caseId).toBe(caseId);
      expect(invoice.status).toBe('DRAFT');
      expect(invoice.total.toFixed(4)).toBe('450.0000');
      expect(invoice.issuedAt).toBeNull();
      expect(invoice.paidAt).toBeNull();
      const drafted = await prisma.auditLog.findMany({ where: { organizationId: ORG, action: 'billing.drafted' } });
      expect(drafted).toHaveLength(1);
      expect(drafted[0]?.entityType).toBe('BillingInvoice');
      expect(drafted[0]?.entityId).toBe(invoice.id);
      expect(drafted[0]?.actorUserId).toBe(ownerId);
      expect(await sideEffects()).toMatchObject({ invoiceRows: 1, draftedAudits: 1, payments: 0, settlements: 0, ledgerEntries: 0 });
    });
  }, 60_000);

  it('07 重复调用 → 幂等返回既有账单，不重复生成、不重复审计', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await seedFee();
      const first = await draft(base, cookie);
      const second = await draft(base, cookie);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.invoiceId).toBe(first.body.invoiceId);
      expect(second.body).toMatchObject({ created: false });
      const after = await sideEffects();
      expect(after.invoiceRows).toBe(1);
      expect(after.draftedAudits).toBe(1);
    });
  }, 60_000);

  it('08 并发起草 → 仅生成一张账单', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await seedFee();
      const [a, b] = await Promise.all([draft(base, cookie), draft(base, cookie)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.invoiceId).toBe(b.body.invoiceId);
      const after = await sideEffects();
      expect(after.invoiceRows).toBe(1);
      expect(after.draftedAudits).toBe(1);
    });
  }, 60_000);

  it('09 缺少费用依据（FeeCalculation）→ 409 BILLING_BASIS_REQUIRED 且零业务副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await draft(base, cookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('BILLING_BASIS_REQUIRED');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('10 其他租户的案件 → NOT_FOUND 且零业务副作用', async () => {
    const foreignOrg = await prisma.organization.create({
      data: { id: randomUUID(), name: '外部租户', slug: `billing-draft-foreign-${randomUUID().slice(0, 8)}` },
    });
    const foreignCase = await prisma.case.create({
      data: {
        organizationId: foreignOrg.id,
        caseNo: `BD-FOREIGN-${randomUUID().slice(0, 6)}`,
        title: '外部案件',
        domain: 'LOGISTICS',
        status: 'WON',
        claimedAmount: new Prisma.Decimal('10.0000'),
        currency: 'USD',
      },
    });
    await withServer(async (base) => {
      const cookie = await login(base);
      await seedFee();
      const res = await draft(base, cookie, foreignCase.id);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
      expect(await prisma.billingInvoice.count({ where: { organizationId: foreignOrg.id } })).toBe(0);
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('11 无权限主体（OPS / VIEWER）→ FORBIDDEN 且零业务副作用', async () => {
    await withServer(async (base) => {
      await seedFee();
      for (const role of ['OPS', 'VIEWER'] as const) {
        const member = await createMember(role);
        const cookie = await login(base, member.email);
        const res = await draft(base, cookie);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('FORBIDDEN');
      }
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('12 等案件锁期间执行人降为 OPS → 锁后 403 FORBIDDEN，零业务写入', async () => {
    await withServer(async (base) => {
      await seedFee();
      const executor = await createMember('OPS');
      await prisma.membership.updateMany({
        where: { organizationId: ORG, userId: executor.userId },
        data: { role: 'FINANCE' },
      });
      const cookie = await login(base, executor.email);
      const release = await holdCaseLock();
      const pending = draft(base, cookie);
      try {
        await waitFor(
          async () => (await advisoryLockCount(caseLockKey(), false)) >= 1,
          10_000,
          'DRAFT_WAITING_ON_CASE_LOCK',
        );
        await prisma.membership.updateMany({
          where: { organizationId: ORG, userId: executor.userId },
          data: { role: 'OPS' },
        });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);

  it('13 业务审计写入失败（billing.drafted 被库拒绝）→ 整笔草稿事务回滚', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await seedFee();
      const res = await withAuditActionBlocked('billing.drafted', async () => draft(base, cookie));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await sideEffects()).toMatchObject(ZERO);
    });
  }, 60_000);
});
