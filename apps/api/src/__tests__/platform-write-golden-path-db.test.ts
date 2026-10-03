/**
 * MSG-20261001-23 CHANGE B + CHANGE D
 * ---------------------------------------------------------------------------
 * CHANGE B —— HTTP → orchestrator 唯一执行入口（架构契约 + 真实 HTTP 集成）：
 *   入口模块只能经编排器触达 T1/T2/T3；handler 本身不得持有 write sink、
 *   不得直接调用 ledger T1、不得直接消费 approval、不得自造可信 digest、
 *   不存在绕过 orchestrator 的 alternate execution path。
 * CHANGE D —— 最小 Golden Path E2E（真实 HTTP + PostgreSQL，安全终点）：
 *   HTTP → authn → membership/role → Action Guard → server snapshot → approval binding
 *        → orchestrator → transport=false → NEEDS_MANUAL
 *   断言：platformWriteExecuted=false / executionDisposition=NEEDS_MANUAL / attempt=0 /
 *        approval_consumed=0 / sinkCalls=0 / Payment·Settlement·Billing·Claim 不变，
 *        并含跨租户与缺审批的 fail-closed 对照。
 */

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
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
import { PLATFORM_WRITE_ACTION } from '../services/action-guard/approval-verifier';
import { submitRecoveryReview } from '../services/workflow/recovery-review';
import { buildServerSidePlatformWriteSnapshot } from '../services/platform-write/http-request';

const prisma = new PrismaClient();
const SALT = 'platform-write-golden-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'platform-write-golden-pass-1';
const NOW = new Date(Date.now() - 60_000);
const PLATFORM = 'amazon-sp';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pw-golden-'));
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
let foreignCaseId = '';

const liveServers: Array<{ close: (cb: () => void) => void }> = [];
let base = '';

beforeAll(async () => {
  await prisma.$connect();
  const guard = createAppActionGuard({
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
      productionGate: 'SATISFIED',
      platformEnabled: { [PLATFORM_WRITE_ACTION]: true },
      tenantFeatureEnabled: { [PLATFORM_WRITE_ACTION]: true },
      hostApprovalGranted: true,
    }),
  });
  const server = createServer({ prisma, log, audit, storage, actionGuard: guard });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = 'http://127.0.0.1:' + port;
  liveServers.push(server);
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
  EMAIL = 'pw-golden-' + suffix + '@example.com';
  await prisma.organization.create({ data: { id: ORG, name: 'golden path 租户', slug: 'pw-golden-' + suffix } });
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
      title: 'golden path 用例',
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

  const foreignSuffix = randomUUID().replace(/-/g, '').slice(0, 10);
  foreignOrg = randomUUID();
  foreignEmail = 'pw-golden-foreign-' + foreignSuffix + '@example.com';
  await prisma.organization.create({
    data: { id: foreignOrg, name: '外租户', slug: 'pw-golden-foreign-' + foreignSuffix },
  });
  const foreignUser = await prisma.user.create({
    data: {
      email: foreignEmail,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'FOREIGN',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { organizationId: foreignOrg, userId: foreignUser.id, role: 'OWNER', isActive: true },
  });
  const foreignCase = await prisma.case.create({
    data: {
      organizationId: foreignOrg,
      caseNo: 'CS-F-' + foreignSuffix,
      title: '外租户案件',
      domain: 'LOGISTICS',
      status: 'WON',
      currency: 'USD',
    },
  });
  foreignCaseId = foreignCase.id;
});

async function login(email: string = EMAIL): Promise<string> {
  const res = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function write(cookie: string, body: Record<string, unknown> = {}, targetCaseId: string = caseId) {
  const res = await fetch(base + '/cases/' + targetCaseId + '/platform/write', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ platform: PLATFORM, ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function digestFor(): Promise<string> {
  const bundle = await buildServerSidePlatformWriteSnapshot(prisma, {
    organizationId: ORG,
    caseId,
    targetKind: 'CLAIM',
    platform: PLATFORM,
  });
  return bundle.digest;
}

async function seedApproval(): Promise<string> {
  const basis = await digestFor();
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

/** Golden Path 的完整安全事实快照：任一并发副作用都会在这里暴露 */
async function safeFacts() {
  return {
    attempts: await prisma.platformWriteAttempt.count({ where: { organizationId: ORG } }),
    approvalConsumed: await prisma.auditLog.count({
      where: { organizationId: ORG, action: 'recovery.approval_consumed' },
    }),
    platformWriteAudits: await prisma.auditLog.count({
      where: { organizationId: ORG, action: { startsWith: 'platform.write' } },
    }),
    payments: await prisma.payment.count({ where: { organizationId: ORG } }),
    settlements: await prisma.settlement.count({ where: { organizationId: ORG } }),
    ledgerEntries: await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } }),
    feeCalculations: await prisma.feeCalculation.count({ where: { organizationId: ORG } }),
    billingInvoices: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
    claimStatus: (await prisma.claim.findUniqueOrThrow({ where: { id: claimId } })).status,
  };
}

const SAFE_ZERO = {
  attempts: 0,
  approvalConsumed: 0,
  platformWriteAudits: 0,
  payments: 0,
  settlements: 0,
  ledgerEntries: 0,
  feeCalculations: 0,
  billingInvoices: 0,
  claimStatus: 'DRAFT',
};

describe('MSG-20261001-23 CHANGE B — HTTP → orchestrator 唯一执行入口（架构契约）', () => {
  it('B1 入口模块只经编排器触达执行链；handler 不持有 sink / 不直调 T1 / 不消费 approval', async () => {
    const root = process.cwd();
    const read = (rel: string) =>
      fs.readFileSync(path.join(root, 'src', rel), 'utf8').replace(/\r\n/g, '\n');
    const httpRequest = read('services/platform-write/http-request.ts');
    const httpRoutes = read('services/workflow/http-routes.ts');
    const orchestrator = read('services/platform-write/orchestrator.ts');

    // 入口 → 编排器（唯一执行入口）
    expect(httpRequest).toContain("from './orchestrator'");
    expect(httpRequest).toContain('runPlatformWriteAttempt(');

    // 入口不得直接触达 ledger T1 / 审批消费 / 投递端口
    for (const source of [httpRequest, httpRoutes]) {
      expect(source).not.toContain('acquireExecutionRight');
      expect(source).not.toContain('settleAttempt');
      expect(source).not.toContain('consumeInTransaction');
      expect(source).not.toContain('PlatformWritePort');
      expect(source).not.toContain('createSimulatedPlatformWritePort');
    }
    // 路由层不得越过入口模块直接引用编排/投递实现
    expect(httpRoutes).not.toContain('platform-write/orchestrator');
    expect(httpRoutes).not.toContain('platform-write/approval-tx-port');

    // 唯一执行入口：T1/T2/T3 只允许出现在编排器内
    expect(orchestrator).toContain('acquireExecutionRight(');
    expect(orchestrator).toContain('settleAttempt(');
    expect(orchestrator).toContain('sink');
  }, 30_000);
});

describe('MSG-20261001-23 CHANGE D — 最小 Golden Path E2E（真实 HTTP + PostgreSQL）', () => {
  it('D1 合法租户/角色/审批 → 安全终点 NEEDS_MANUAL，零账本零消费零投递，资金对象不变', async () => {
    const cookie = await login();
    const approvalId = await seedApproval();
    const res = await write(cookie, { approvalId });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'NEEDS_MANUAL',
      attemptId: null,
      platformWriteExecuted: false,
      executionDisposition: 'NEEDS_MANUAL',
    });
    // 编排器的门控结论必须到达客户端（证明执行链经 orchestrator 收敛）
    expect(res.body.code).toBe('GLOBAL_GATE_DISABLED');
    for (const leaked of ['providerRef', 'providerStatus', 'externalRef', 'sinkCalls', 'providerSuccess']) {
      expect(Object.keys(res.body)).not.toContain(leaked);
    }
    expect(await safeFacts()).toEqual(SAFE_ZERO);
  }, 90_000);

  it('D2 Golden Path 跨租户版本 → fail-closed，零副作用', async () => {
    const cookie = await login(foreignEmail);
    const res = await write(cookie, {});
    expect(res.status).toBe(404);
    expect(await safeFacts()).toEqual(SAFE_ZERO);
    expect(foreignCaseId).toBeTruthy();
  }, 60_000);

  it('D3 Golden Path 缺审批版本 → fail-closed，零副作用', async () => {
    const cookie = await login();
    const res = await write(cookie, {});
    expect([403, 409]).toContain(res.status);
    expect(String(res.body.error ?? res.body.reason ?? res.body.code ?? '')).not.toBe('');
    expect(await safeFacts()).toEqual(SAFE_ZERO);
  }, 60_000);

  it('D4 Golden Path 重复提交（同负载）→ 仍为同一安全终点，无第二条执行链', async () => {
    const cookie = await login();
    const approvalId = await seedApproval();
    const first = await write(cookie, { approvalId });
    const second = await write(cookie, { approvalId });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      status: 'NEEDS_MANUAL',
      attemptId: null,
      platformWriteExecuted: false,
    });
    expect(await safeFacts()).toEqual(SAFE_ZERO);
  }, 90_000);
});
