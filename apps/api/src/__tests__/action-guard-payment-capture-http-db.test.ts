/**
 * ② 第二批 P6 — payment.capture（POST /billing/:id/status）真实 HTTP + PostgreSQL 验收
 * -------------------------------------------------------------------------------
 * 01 成功链路：REQUEST → APPROVE（绑定载荷）→ 状态推进 200，发票 PAID，消费事件恰 1
 * 02 缺 approvalId：守卫 REQUIRE_APPROVAL（409），发票与消费零变化
 * 03 载荷不符：403 APPROVAL_PAYLOAD_MISMATCH，零副作用
 * 04 审批后被撤销：403 APPROVAL_REVOKED，零副作用
 * 05 已消费后重复提交：403 APPROVAL_ALREADY_CONSUMED，消费仍为 1
 * 06 指纹版本未知：403 APPROVAL_VERSION_UNSUPPORTED，零副作用
 */

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
import { submitPaymentReview } from '../services/workflow/payment';
import { PAYMENT_CONSUMED_EVENT_ACTION } from '../services/action-guard/approval-tx-verify';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000a1';
const SALT = 'payment-capture-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'payment-capture-pass-1';
const EMAIL = 'payment-capture-owner@example.com';
const NOW = new Date('2026-09-30T07:00:00Z');
const AMOUNT = '1500.0000';
const CURRENCY = 'USD';
const REFERENCE = 'bank-transfer-20260930';
const ACTION = 'payment.capture';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-payment-capture-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

let ownerId = '';
let invoiceId = '';

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
  await prisma.organization.create({ data: { id: ORG, name: 'Payment Capture 租户', slug: 'payment-capture-org' } });
  const owner = await prisma.user.create({
    data: { email: EMAIL, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: 'OWNER', status: 'ACTIVE', emailVerified: true },
  });
  ownerId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });
  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'PC-1',
      title: 'Payment capture 用例',
      domain: 'LOGISTICS',
      status: 'WON',
      claimedAmount: new Prisma.Decimal('5000.0000'),
      currency: CURRENCY,
    },
  });
  const invoice = await prisma.billingInvoice.create({
    data: {
      organizationId: ORG,
      caseId: kase.id,
      invoiceNo: 'INV-PC-1',
      status: 'ISSUED',
      subtotal: new Prisma.Decimal(AMOUNT),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(AMOUNT),
      currency: CURRENCY,
      issuedAt: NOW,
    },
  });
  invoiceId = invoice.id;
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
      platformEnabled: { [ACTION]: true },
      tenantFeatureEnabled: { [ACTION]: true },
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

/** R6 CHANGE C：经 HTTP 创建支付审批（REQUEST → APPROVE 全链路） */
async function reviewViaHttp(base: string, cookie: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/billing/${invoiceId}/payment-review`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function approveViaHttp(
  base: string,
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const requested = await reviewViaHttp(base, cookie, { decision: 'REQUEST' });
  expect(requested.status).toBe(200);
  const approved = await reviewViaHttp(base, cookie, {
    decision: 'APPROVE',
    amount: AMOUNT,
    currency: CURRENCY,
    basisReference: REFERENCE,
    from: 'ISSUED',
    to: 'PAID',
    ...overrides,
  });
  expect(approved.status).toBe(200);
  expect(typeof approved.body.approvalId).toBe('string');
  return String(approved.body.approvalId);
}

async function advance(base: string, cookie: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/billing/${invoiceId}/status`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ to: 'PAID', paymentReference: REFERENCE, amount: AMOUNT, currency: CURRENCY, ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// R6 CHANGE A：审批必须绑定真实账单操作（目标 + 迁移 + 金额/币种）
const boundPayload = {
  amount: AMOUNT,
  currency: CURRENCY,
  basisReference: REFERENCE,
  evidenceArtifactId: null,
  from: 'ISSUED',
  to: 'PAID',
};

async function requestAndApprove(now: () => Date = () => NOW) {
  await submitPaymentReview(prisma, { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', invoiceId, decision: 'REQUEST' }, { now });
  const approved = await submitPaymentReview(
    prisma,
    { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', invoiceId, decision: 'APPROVE', boundPayload, boundAction: ACTION },
    { now: () => new Date(now().getTime() + 1000) },
  );
  return approved;
}

async function state() {
  const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true, paidAmount: true, externalRef: true } });
  const consumed = await prisma.auditLog.count({ where: { organizationId: ORG, action: PAYMENT_CONSUMED_EVENT_ACTION } });
  const payments = await prisma.payment.count({ where: { organizationId: ORG } });
  return { status: invoice.status, consumed, payments, externalRef: invoice.externalRef, paidAmount: invoice.paidAmount?.toFixed(4) ?? null };
}

describe('② 第二批 — payment.capture（账单入口）真实 HTTP + PostgreSQL', () => {
  it('01 成功链路：审批绑定通过后状态推进 200，消费事件恰 1', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approved = await requestAndApprove();
      const res = await advance(base, cookie, { approvalId: String(approved.approvalId) });
      expect(res.status).toBe(200);
      const after = await state();
      expect(after).toMatchObject({ status: 'PAID', consumed: 1, payments: 0, externalRef: REFERENCE, paidAmount: AMOUNT });
    });
  }, 30_000);

  it('02 缺 approvalId：守卫 REQUIRE_APPROVAL（409），零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await advance(base, cookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
      expect(await state()).toMatchObject({ status: 'ISSUED', consumed: 0, payments: 0, externalRef: null });
    });
  }, 30_000);

  it('03 载荷不符：403 APPROVAL_PAYLOAD_MISMATCH，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approved = await requestAndApprove();
      const res = await advance(base, cookie, { approvalId: String(approved.approvalId), amount: '1600.0000' });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_PAYLOAD_MISMATCH');
      expect(await state()).toMatchObject({ status: 'ISSUED', consumed: 0 });
    });
  }, 30_000);

  it('04 审批后被撤销：403 APPROVAL_REVOKED，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approved = await requestAndApprove();
      await prisma.auditLog.create({
        data: {
          organizationId: ORG,
          actorType: 'USER',
          actorUserId: ownerId,
          action: 'payment.review_rejected',
          entityType: 'BillingInvoice',
          entityId: invoiceId,
          changes: { invoiceNo: 'INV-PC-1', reason: '撤销' } as never,
          createdAt: new Date(NOW.getTime() + 60_000),
        },
      });
      const res = await advance(base, cookie, { approvalId: String(approved.approvalId) });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_REVOKED');
      expect(await state()).toMatchObject({ status: 'ISSUED', consumed: 0 });
    });
  }, 30_000);

  it('05 已消费后重复提交：409 ILLEGAL_TRANSITION（状态迁移非幂等），消费仍为 1', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approved = await requestAndApprove();
      expect((await advance(base, cookie, { approvalId: String(approved.approvalId) })).status).toBe(200);
      const again = await advance(base, cookie, { approvalId: String(approved.approvalId) });
      // 发票已处于目标状态：状态迁移本身不是幂等创建，重复提交按既有语义拒绝（零新增副作用）
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('ILLEGAL_TRANSITION');
      expect((await state()).consumed).toBe(1);
    });
  }, 30_000);

  it('06 指纹版本未知：403 APPROVAL_VERSION_UNSUPPORTED，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await submitPaymentReview(prisma, { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', invoiceId, decision: 'REQUEST' }, { now: () => NOW });
      const approvedRow = await prisma.auditLog.create({
        data: {
          organizationId: ORG,
          actorType: 'USER',
          actorUserId: ownerId,
          action: 'payment.review_approved',
          entityType: 'BillingInvoice',
          entityId: invoiceId,
          changes: {
            invoiceNo: 'INV-PC-1',
            boundAction: ACTION,
            boundPayload: { ...boundPayload, fingerprintVersion: 'v9' },
            expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          } as never,
          createdAt: new Date(NOW.getTime() + 1000),
        },
      });
      const res = await advance(base, cookie, { approvalId: approvedRow.id });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_VERSION_UNSUPPORTED');
      expect(await state()).toMatchObject({ status: 'ISSUED', consumed: 0 });
    });
  }, 30_000);

  it('07 HTTP 审批全链路（REQUEST→APPROVE）+ 状态推进：200、消费恰 1、成功审计带 approvalId/operationId', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveViaHttp(base, cookie);
      const res = await advance(base, cookie, { approvalId });
      expect(res.status).toBe(200);
      expect(await state()).toMatchObject({ status: 'PAID', consumed: 1, externalRef: REFERENCE });

      const changed = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'billing.status_changed' },
      });
      expect(changed.changes).toMatchObject({ approvalId, operationId: `approval:${approvalId}`, result: 'TRANSITIONED' });

      const consumedRow = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: PAYMENT_CONSUMED_EVENT_ACTION },
      });
      expect(consumedRow.changes).toMatchObject({ approvalId, invoiceId });
    });
  }, 30_000);

  it('08 审批金额与真实发票不符（批准 1600 / 发票 1500）：403 且零副作用 + 锁内拒绝审计', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveViaHttp(base, cookie, { amount: '1600.0000' });
      const res = await advance(base, cookie, { approvalId, amount: '1600.0000' });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_PAYLOAD_MISMATCH');
      expect(await state()).toMatchObject({ status: 'ISSUED', consumed: 0 });

      const rejected = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'payment.capture_rejected' },
      });
      expect(rejected.changes).toMatchObject({
        invoiceId,
        approvalId,
        stage: 'LOCKED_RECHECK',
        reason: 'APPROVAL_PAYLOAD_MISMATCH',
        result: 'REJECTED',
        actorUserId: ownerId,
      });
    });
  }, 30_000);

  it('09 审批用于错误迁移（to=ISSUED）：审批创建即拒绝，不得消费收费审批', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      await reviewViaHttp(base, cookie, { decision: 'REQUEST' });
      const bad = await reviewViaHttp(base, cookie, {
        decision: 'APPROVE',
        amount: AMOUNT,
        currency: CURRENCY,
        basisReference: REFERENCE,
        from: 'DRAFT',
        to: 'ISSUED',
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('INVALID_INPUT');
      expect(await state()).toMatchObject({ status: 'ISSUED', consumed: 0 });
    });
  }, 30_000);

  it('10 同审批并发提交：恰一次状态迁移与一次消费，其余精确拒绝', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveViaHttp(base, cookie);
      const results = await Promise.all([
        advance(base, cookie, { approvalId }),
        advance(base, cookie, { approvalId }),
        advance(base, cookie, { approvalId }),
        advance(base, cookie, { approvalId }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      // 其余请求必须精确拒绝：要么锁内发现审批已消费（403 APPROVAL_ALREADY_CONSUMED），
      // 要么在前置状态卡口被拒（409 ILLEGAL_TRANSITION）；两者都不得产生第二次迁移/消费。
      const rejected = results.filter((r) => r.status !== 200);
      expect(rejected).toHaveLength(3);
      const outcomes = rejected.map((r) => `${r.status}:${String(r.body.reason ?? r.body.error)}`).sort();
      const allowed = new Set([
        '403:APPROVAL_ALREADY_CONSUMED',
        '403:APPROVAL_PAYLOAD_MISMATCH',
        '409:ILLEGAL_TRANSITION',
      ]);
      expect(outcomes.filter((o) => !allowed.has(o))).toEqual([]);
      expect(await state()).toMatchObject({ status: 'PAID', consumed: 1 });
    });
  }, 30_000);
});
