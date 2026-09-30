/**
 * ② 第二批 — retry-due（冻结清单批次审批）真实 HTTP + PostgreSQL 验收
 * ---------------------------------------------------------------------
 * 01 全链路：freeze → REQUEST → APPROVE → execute 200；attempt 恰新增一次、批次消费恰一次、resultStatus=PAID
 * 02 缺 approvalId → 409 ACTION_GUARD_HUMAN_APPROVAL_REQUIRED，零副作用
 * 03 批准后新增的 due 项绝不执行（只处理冻结清单）
 * 04 冻结后清单内事实变化 → 该项跳过并留证（payment.retry_due_skipped），无资金推进
 * 05 跨域冒用：replay 审批用于 retry-due → 精确拒绝，三类消费均不新增
 * 06 有效期过期 → 403 APPROVAL_EXPIRED，零新增
 * 07 数量上限：limit 越界被夹取到服务端上限
 * 08 批次消费审计失败 → 整个事务回滚（attempt/资金/执行审计不部分提交）
 *
 * 说明：本文件验证**恢复收口（retry-due）**；不接入真实支付渠道、不发起真实扣款。
 * 口径：attempt.status=SUCCEEDED 表示「一次获批的恢复尝试已执行」，资金结论看 resultStatus。
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
import {
  PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION,
  PAYMENT_REPLAY_CONSUMED_EVENT_ACTION,
} from '../services/action-guard/approval-tx-verify';

const prisma = new PrismaClient();
const ORG = 'cf200000-0000-4000-8000-0000000000a3';
const SALT = 'payment-retry-due-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'payment-retry-due-pass-1';
const EMAIL = 'payment-retry-due-owner@example.com';
const NOW = new Date('2026-09-30T09:30:00Z');
const AMOUNT = '700.0000';
const CURRENCY = 'USD';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-retry-due-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let invoiceId = '';
let eventId = 'cf200000-0000-4000-8000-0000000000bb';
let paymentId = '';
let attemptId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Session", "UserInvitation", "Membership", "User", "Organization", "KillSwitchRequest" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'RetryDue 租户', slug: 'payment-retry-due-org' } });
  const owner = await prisma.user.create({
    data: {
      email: EMAIL,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });
  const invoice = await prisma.billingInvoice.create({
    data: {
      organizationId: ORG,
      invoiceNo: 'INV-RD-1',
      status: 'ISSUED',
      subtotal: new Prisma.Decimal(AMOUNT),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(AMOUNT),
      currency: CURRENCY,
      issuedAt: NOW,
    },
  });
  invoiceId = invoice.id;
  await prisma.paymentEvent.create({
    data: {
      id: eventId,
      organizationId: ORG,
      provider: 'STRIPE',
      providerEventId: 'evt_retry_due_1',
      eventType: 'payment_intent.succeeded',
      payloadHash: 'hash-retry-due-1',
      receivedAt: NOW,
      processingResult: 'PROCESSED',
    },
  });
  const payment = await prisma.payment.create({
    data: {
      organizationId: ORG,
      invoiceId,
      provider: 'STRIPE',
      externalPaymentId: 'pi_retry_due_1',
      amount: new Prisma.Decimal(AMOUNT),
      currency: CURRENCY,
      status: 'SUCCEEDED',
      idempotencyKey: 'pi_retry_due_1',
    },
  });
  paymentId = payment.id;
  const attempt = await prisma.paymentProcessingAttempt.create({
    data: {
      organizationId: ORG,
      paymentEventId: eventId,
      attemptNo: 1,
      status: 'RETRYABLE_FAILED',
      errorCode: 'CAS_CONFLICT',
      errorSummary: 'simulated transient failure',
      startedAt: NOW,
      finishedAt: NOW,
      nextRetryAt: new Date(Date.now() - 60_000),
      actorType: 'EXTERNAL',
      actorRef: 'STRIPE',
      paymentId,
    },
  });
  attemptId = attempt.id;
});

const permissiveGuard = (): RuntimeActionGuard =>
  createAppActionGuard({
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
      platformEnabled: { 'payment.retry_due': true, 'payment.replay': true },
      tenantFeatureEnabled: { 'payment.retry_due': true, 'payment.replay': true },
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

function post(base: string, pathname: string, cookie: string, body: Record<string, unknown>) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
}

async function freeze(base: string, cookie: string, body: Record<string, unknown> = {}) {
  const res = await post(base, '/payments/processing/retry-due/freeze', cookie, body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function review(base: string, cookie: string, body: Record<string, unknown>) {
  const res = await post(base, '/payments/processing/retry-due/review', cookie, body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function approveBatch(base: string, cookie: string, batchId: string, overrides: Record<string, unknown> = {}) {
  const requested = await review(base, cookie, { batchId, decision: 'REQUEST' });
  expect(requested.status).toBe(200);
  const approved = await review(base, cookie, { batchId, decision: 'APPROVE', ...overrides });
  expect(approved.status).toBe(200);
  return String(approved.body.approvalId);
}

async function execute(base: string, cookie: string, body: Record<string, unknown>) {
  const res = await post(base, '/payments/processing/retry-due', cookie, body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function state() {
  const invoice = await prisma.billingInvoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { status: true, paidAmount: true },
  });
  return {
    invoiceStatus: invoice.status,
    paidAmount: invoice.paidAmount?.toFixed(4) ?? null,
    attempts: await prisma.paymentProcessingAttempt.count({ where: { organizationId: ORG } }),
    payments: await prisma.payment.count({ where: { organizationId: ORG } }),
    executed: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.retry_due_executed' } }),
    skipped: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.retry_due_skipped' } }),
    consumed: await prisma.auditLog.count({
      where: { organizationId: ORG, action: PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION },
    }),
  };
}

describe('② 第二批 — retry-due（冻结清单批次审批）真实 HTTP + PostgreSQL', () => {
  it('01 全链路：freeze → REQUEST/APPROVE → execute 200，恰一次新增 attempt 与一次批次消费', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      expect(frozen.status).toBe(200);
      const batchId = String(frozen.body.batchId);
      expect(frozen.body.itemCount).toBe(1);
      expect(typeof frozen.body.digest).toBe('string');

      const approvalId = await approveBatch(base, cookie, batchId);
      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ batchId, itemCount: 1 });
      const executed = res.body.executed as Array<Record<string, unknown>>;
      expect(executed).toHaveLength(1);
      expect(executed[0]).toMatchObject({ attemptId, paymentEventId: eventId, attemptNo: 2, resultStatus: 'PAID' });

      const after = await state();
      expect(after).toMatchObject({
        invoiceStatus: 'PAID',
        paidAmount: AMOUNT,
        attempts: 2,
        payments: 1,
        executed: 1,
        consumed: 1,
      });

      const consumed = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION },
      });
      // 预先授权范围由「批次审批 + 冻结摘要 + batchId + SYSTEM 执行身份」共同表达
      expect(consumed.changes).toMatchObject({ approvalId, batchId });
      const executedAudit = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'payment.retry_due_executed' },
      });
      expect(executedAudit.changes).toMatchObject({ approvalId, batchId, resultStatus: 'PAID' });
      // SYSTEM 执行身份（非 USER）：actorUserId 必须为空、actorRef 为后台重试身份
      expect(consumed.actorType).toBe('SYSTEM');
      expect(consumed.actorUserId ?? null).toBeNull();
      expect(consumed.actorRef).toBe('payment-retry-worker');
    });
  }, 40_000);

  it('02 缺 approvalId → 409 ACTION_GUARD_HUMAN_APPROVAL_REQUIRED，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const res = await execute(base, cookie, { batchId });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0, consumed: 0 });
    });
  }, 40_000);

  it('03 批准后新增的 due 项绝不执行（只处理冻结清单）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);

      // 批准后才出现的第二个到期项（**不同事件**，避免与冻结项构成同一代际取代关系）
      const lateEventId = 'cf200000-0000-4000-8000-0000000000cc';
      await prisma.paymentEvent.create({
        data: {
          id: lateEventId,
          organizationId: ORG,
          provider: 'STRIPE',
          providerEventId: 'evt_retry_due_late',
          eventType: 'payment_intent.succeeded',
          payloadHash: 'hash-retry-due-late',
          receivedAt: NOW,
          processingResult: 'PROCESSED',
        },
      });
      const second = await prisma.paymentProcessingAttempt.create({
        data: {
          organizationId: ORG,
          paymentEventId: lateEventId,
          attemptNo: 1,
          status: 'RETRYABLE_FAILED',
          errorCode: 'CAS_CONFLICT',
          errorSummary: 'added after freeze',
          startedAt: NOW,
          finishedAt: NOW,
          nextRetryAt: new Date(Date.now() - 1_000),
          actorType: 'EXTERNAL',
          actorRef: 'STRIPE',
          paymentId,
        },
      });

      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBe(200);
      expect((res.body.executed as unknown[]).length).toBe(1);

      const secondRow = await prisma.paymentProcessingAttempt.findUniqueOrThrow({ where: { id: second.id } });
      expect(secondRow.status).toBe('RETRYABLE_FAILED');
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.retry_due_executed' } })).toBe(1);
    });
  }, 40_000);

  it('04 冻结后清单内事实变化 → 该项跳过并留证，无资金推进', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);

      // 冻结之后改变 Payment 金额（清单内外事实不一致）
      await prisma.payment.updateMany({
        where: { organizationId: ORG },
        data: { amount: new Prisma.Decimal('999.0000') },
      });

      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBe(200);
      expect((res.body.executed as unknown[]).length).toBe(0);
      const skipped = res.body.skipped as Array<Record<string, unknown>>;
      expect(skipped).toHaveLength(1);
      expect(String(skipped[0].reason)).toBe('AMOUNT_CHANGED');

      const after = await state();
      expect(after).toMatchObject({ invoiceStatus: 'ISSUED', paidAmount: '0.0000', attempts: 1, executed: 0, skipped: 1 });
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
    });
  }, 40_000);

  it('05 跨域冒用：replay 审批用于 retry-due → 精确拒绝，三类消费均不新增', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);

      // 造一个 replay 审批（目标为 PaymentEvent）
      const req = await post(base, `/payments/events/${eventId}/replay-review`, cookie, { decision: 'REQUEST' });
      expect(req.status).toBe(200);
      const appr = await post(base, `/payments/events/${eventId}/replay-review`, cookie, { decision: 'APPROVE' });
      expect(appr.status).toBe(200);
      const replayApprovalId = String(((await appr.json()) as { approvalId: string }).approvalId);

      const res = await execute(base, cookie, { batchId, approvalId: replayApprovalId });
      expect(res.status).toBe(403);
      expect(['APPROVAL_TARGET_MISMATCH', 'APPROVAL_ACTION_MISMATCH']).toContain(String(res.body.reason));
      expect(
        await prisma.auditLog.count({
          where: {
            organizationId: ORG,
            action: {
              in: [
                PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION,
                PAYMENT_REPLAY_CONSUMED_EVENT_ACTION,
                'payment.capture_consumed',
              ],
            },
          },
        }),
      ).toBe(0);
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0 });
    });
  }, 40_000);

  it('06 有效期过期 → 403 APPROVAL_EXPIRED，零新增', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId, { approvalTtlMs: 1_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_EXPIRED');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0, consumed: 0 });
    });
  }, 40_000);

  it('07 数量上限：limit 越界被夹取到服务端上限，且执行只处理清单', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie, { limit: 999 });
      expect(frozen.status).toBe(200);
      expect(Number(frozen.body.itemCount)).toBeLessThanOrEqual(20);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      const res = await execute(base, cookie, { batchId, approvalId, limit: 999 });
      expect(res.status).toBe(200);
      expect((res.body.executed as unknown[]).length).toBe(Number(frozen.body.itemCount));
    });
  }, 40_000);

  it('08 批次消费审计失败 → 整个事务回滚（不留部分执行）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "AuditLog" ADD CONSTRAINT rd_block_consumed CHECK (action <> '${PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION}') NOT VALID`,
      );
      let status = 0;
      try {
        const res = await execute(base, cookie, { batchId, approvalId });
        status = res.status;
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS rd_block_consumed');
      }
      expect(status).toBeGreaterThanOrEqual(400);
      const after = await state();
      expect(after).toMatchObject({ invoiceStatus: 'ISSUED', paidAmount: '0.0000', attempts: 1, executed: 0 });
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
    });
  }, 40_000);
});
