// R2 CHANGE C：真实 HTTP 全链路（REQUEST → APPROVE → recovery-outcome）+ HTTP 并发 + 交错（真实 PostgreSQL）

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

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000d1';
const SALT = 'hitl-chain-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'hitl-chain-pass-1';
const EMAIL = 'hitl-chain-owner@example.com';
const RATE = '0.1500';
const NOW = new Date('2026-09-30T05:00:00Z');
const AMOUNT = '3000.0000';
const BASIS = 'chain-basis';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-hitl-chain-'));
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
  await prisma.organization.create({ data: { id: ORG, name: 'HITL 链 租户', slug: 'hitl-chain-org' } });
  const owner = await prisma.user.create({
    data: { email: EMAIL, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  ownerId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });

  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'CHAIN-1',
      title: 'HTTP 全链路用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
    },
  });
  caseId = kase.id;
  await prisma.claim.create({ data: { organizationId: ORG, caseId, round: 1, status: 'APPROVED', target: 'CARRIER', aiDraftText: 'draft' } });
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'commercial_terms.created',
      entityType: 'Case',
      entityId: caseId,
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

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage, actionGuard: permissiveGuard() });
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

async function review(base: string, cookie: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/cases/${caseId}/recovery-review`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function confirm(base: string, cookie: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/cases/${caseId}/recovery-outcome`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ recoveredAmount: AMOUNT, currency: 'USD', basisReference: BASIS, ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const payload = { recoveredAmount: AMOUNT, currency: 'USD', basisReference: BASIS, evidenceArtifactId: null };

async function counts() {
  return {
    settlement: await prisma.settlement.count({ where: { organizationId: ORG } }),
    ledger: await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } }),
    fee: await prisma.feeCalculation.count({ where: { organizationId: ORG } }),
    billing: await prisma.billingInvoice.count({ where: { organizationId: ORG } }),
    consumed: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.approval_consumed' } }),
  };
}

describe('② R2 — 真实 HTTP 全链路（REQUEST → APPROVE → recovery-outcome）', () => {
  it('01 全链路成功：HTTP 审批返回 approvalId；确认 201 且四类资金对象各 1', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const requested = await review(base, cookie, { decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' });
      expect(requested.status).toBe(200);
      const approved = await review(base, cookie, { decision: 'APPROVE', ...payload });
      expect(approved.status).toBe(200);
      const approvalId = approved.body.approvalId as string;
      expect(typeof approvalId).toBe('string');
      expect(approvalId.length).toBeGreaterThan(0);

      const confirmed = await confirm(base, cookie, { approvalId });
      expect(confirmed.status).toBe(201);
      expect(await counts()).toEqual({ settlement: 1, ledger: 1, fee: 1, billing: 1, consumed: 1 });
    });
  });

  it('02 HTTP 重复确认：精确 200（幂等），资金对象不增加', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await review(base, cookie, { decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' });
      const approved = await review(base, cookie, { decision: 'APPROVE', ...payload });
      const approvalId = approved.body.approvalId as string;
      expect((await confirm(base, cookie, { approvalId })).status).toBe(201);
      expect((await confirm(base, cookie, { approvalId })).status).toBe(200);
      expect(await counts()).toEqual({ settlement: 1, ledger: 1, fee: 1, billing: 1, consumed: 1 });
    });
  });

  it('03 HTTP 撤销后确认：403 APPROVAL_REVOKED，零资金对象', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await review(base, cookie, { decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' });
      const approved = await review(base, cookie, { decision: 'APPROVE', ...payload });
      const approvalId = approved.body.approvalId as string;
      // 撤销路径：新一轮 REQUEST（使旧审批待定）→ REJECT（晚于审批的拒绝事件）
      expect((await review(base, cookie, { decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' })).status).toBe(200);
      const rejected = await review(base, cookie, { decision: 'REJECT', reason: '金额存疑' });
      expect(rejected.status).toBe(200);
      const confirmed = await confirm(base, cookie, { approvalId });
      expect(confirmed.status).toBe(403);
      expect(confirmed.body.error).toBe('ACTION_GUARD_APPROVAL_NOT_VERIFIED');
      expect(confirmed.body.reason).toBe('APPROVAL_REVOKED');
      expect(await counts()).toEqual({ settlement: 0, ledger: 0, fee: 0, billing: 0, consumed: 0 });
    });
  });

  it('03b 重新 REQUEST（新一轮）后旧审批提交：403 且原因为 APPROVAL_NOT_APPROVED，零资金对象', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await review(base, cookie, { decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' });
      const approved = await review(base, cookie, { decision: 'APPROVE', ...payload });
      const approvalId = approved.body.approvalId as string;
      expect((await review(base, cookie, { decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' })).status).toBe(200);
      const confirmed = await confirm(base, cookie, { approvalId });
      expect(confirmed.status).toBe(403);
      expect(confirmed.body.reason).toBe('APPROVAL_NOT_APPROVED');
      expect(await counts()).toEqual({ settlement: 0, ledger: 0, fee: 0, billing: 0, consumed: 0 });
    });
  });

  it('04 HTTP 载荷变更：403 APPROVAL_PAYLOAD_MISMATCH，零资金对象', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await review(base, cookie, { decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' });
      const approved = await review(base, cookie, { decision: 'APPROVE', ...payload });
      const approvalId = approved.body.approvalId as string;
      const confirmed = await confirm(base, cookie, { approvalId, recoveredAmount: '3100.0000' });
      expect(confirmed.status).toBe(403);
      expect(confirmed.body.error).toBe('ACTION_GUARD_APPROVAL_NOT_VERIFIED');
      expect(confirmed.body.reason).toBe('APPROVAL_PAYLOAD_MISMATCH');
      expect(await counts()).toEqual({ settlement: 0, ledger: 0, fee: 0, billing: 0, consumed: 0 });
    });
  });

  it('05 HTTP 并发确认（同一审批）：仅一次 201，其余 200；四类资金对象各 1', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await review(base, cookie, { decision: 'REQUEST', recoveredAmount: AMOUNT, currency: 'USD' });
      const approved = await review(base, cookie, { decision: 'APPROVE', ...payload });
      const approvalId = approved.body.approvalId as string;
      const results = await Promise.all([
        confirm(base, cookie, { approvalId }),
        confirm(base, cookie, { approvalId }),
        confirm(base, cookie, { approvalId }),
        confirm(base, cookie, { approvalId }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(3);
      expect(await counts()).toEqual({ settlement: 1, ledger: 1, fee: 1, billing: 1, consumed: 1 });
    });
  });
});
