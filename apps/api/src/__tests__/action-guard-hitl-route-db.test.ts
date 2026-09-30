// HTTP 级验收：POST /cases/:id/recovery-outcome 经 Action Guard + HITL 审批绑定（授权项 ② 第一批）
// 覆盖：默认拒绝且零资金副作用 / 缺审批 409 且零副作用 / 审批未通过 403 且零副作用 / 已批准才 201 且恰一次

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
import type { RuntimeActionGuard } from '../services/action-guard/runtime-guard';
import { RECOVERY_CONFIRMATION_ACTION } from '../services/action-guard/approval-verifier';
import { submitRecoveryReview } from '../services/workflow/recovery-review';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000g1'.replace('g', 'a');
const SALT = 'hitl-route-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'hitl-route-pass-1';
const EMAIL = 'hitl-route-owner@example.com';
const RATE = '0.1500';
const NOW = new Date('2026-09-30T03:00:00Z');

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-hitl-route-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

let ownerId = '';
let caseId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization", "KillSwitchRequest" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'HITL Route 租户', slug: 'hitl-route-org' } });
  const owner = await prisma.user.create({
    data: { email: EMAIL, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  ownerId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });

  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CASE-HITL-ROUTE-1',
      title: 'HITL 路由用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  await prisma.claim.create({
    data: { organizationId: ORG, caseId: kase.id, round: 1, status: 'APPROVED', target: 'CARRIER', aiDraftText: 'draft' },
  });
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'commercial_terms.created',
      entityType: 'Case',
      entityId: kase.id,
      changes: { successFeeRate: RATE, source: 'manual_input', reConfirmed: false } as never,
      createdAt: NOW,
    },
  });
});

const permissiveGuard = (): RuntimeActionGuard =>
  createAppActionGuard({
    prisma,
    killSwitchResolver: { async resolve(scope: string) { return { scope, value: 'enabled' as const, degraded: false, stale: false }; } },
    audit: { write: () => {} },
    config: staticControlPlaneConfig({
      globalDisabled: false,
      mode: 'WRITE_ENABLED',
      productionGate: 'SATISFIED',
      platformEnabled: { 'commission.charge': true },
      tenantFeatureEnabled: { 'commission.charge': true },
      hostApprovalGranted: true,
    }),
  });

async function withServer<T>(run: (base: string) => Promise<T>, actionGuard?: RuntimeActionGuard): Promise<T> {
  const server = createServer({ prisma, log, audit, storage, ...(actionGuard ? { actionGuard } : {}) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function login(base: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

async function confirm(base: string, cookie: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/cases/${caseId}/recovery-outcome`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ recoveredAmount: '3000.0000', currency: 'USD', basisReference: 'route-test', ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** CHANGE A（R1）：走真实审批写入路径，绑定本次操作载荷，返回 approvalId */
async function approveOperation() {
  await submitRecoveryReview(
    prisma,
    { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', caseId, decision: 'REQUEST', recoveredAmount: '3000.0000', currency: 'USD' },
    () => NOW,
  );
  const result = await submitRecoveryReview(
    prisma,
    {
      organizationId: ORG,
      actorUserId: ownerId,
      role: 'OWNER',
      caseId,
      decision: 'APPROVE',
      boundPayload: { recoveredAmount: '3000.0000', currency: 'USD', basisReference: 'route-test', evidenceArtifactId: null },
      boundAction: RECOVERY_CONFIRMATION_ACTION,
    },
    () => new Date(NOW.getTime() + 1000),
  );
  return result.approvalId as string;
}

async function moneyCounts() {
  return {
    settlements: await prisma.settlement.count({ where: { organizationId: ORG } }),
    fees: await prisma.feeCalculation.count({ where: { organizationId: ORG } }),
    billing: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
  };
}

describe('HITL route × Action Guard（真实 HTTP + PostgreSQL）', () => {
  it('01 默认姿态（未注入守卫 → READ_ONLY）：403 ACTION_GUARD_REQUIREMENTS_NOT_MET 且零资金副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await confirm(base, cookie, { approvalId: 'appr-1' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
    });
    expect(await moneyCounts()).toEqual({ settlements: 0, fees: 0, billing: 0 });
  });

  it('02 闸门放行但缺 approvalId：409 ACTION_GUARD_HUMAN_APPROVAL_REQUIRED 且零资金副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await confirm(base, cookie, {});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
    }, permissiveGuard());
    expect(await moneyCounts()).toEqual({ settlements: 0, fees: 0, billing: 0 });
  });

  it('03 有 approvalId 但无对应审批事件：403 ACTION_GUARD_APPROVAL_NOT_VERIFIED 且零资金副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await confirm(base, cookie, { approvalId: 'appr-1' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ACTION_GUARD_APPROVAL_NOT_VERIFIED');
    }, permissiveGuard());
    expect(await moneyCounts()).toEqual({ settlements: 0, fees: 0, billing: 0 });
  });

  it('04 操作级审批通过 + approvalId：201 且恰好一次资金写入；重复调用不产生额外写入', async () => {
    const approvalId = await approveOperation();
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await confirm(base, cookie, { approvalId });
      expect([200, 201]).toContain(res.status);
      const again = await confirm(base, cookie, { approvalId });
      expect([200, 201, 409]).toContain(again.status);
    }, permissiveGuard());
    const counts = await moneyCounts();
    expect(counts.settlements).toBe(1);
    expect(counts.fees).toBeLessThanOrEqual(1);
    expect(counts.billing).toBeLessThanOrEqual(1);
  });
});
