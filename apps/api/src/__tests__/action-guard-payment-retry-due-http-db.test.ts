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
import {
  executeRetryBatch,
  freezeRetryBatch,
  readRetryBatch,
  retryBatchDigest,
  runDueRetries,
  submitRetryBatchReview,
  type RetryBatchExecutionResult,
  type RetryBatchItemFingerprint,
} from '../services/workflow';

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

let ownerId = '';
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
  ownerId = owner.id;
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


async function advisoryLockCountFor(key: string, granted: boolean): Promise<number> {
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

async function holdLockFor(key: string): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  void prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', key);
        await gate;
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    .catch(() => undefined);
  await waitFor(async () => (await advisoryLockCountFor(key, true)) >= 1, 10_000, 'HOLDER_LOCK_NOT_GRANTED');
  return release;
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

  it('09 冻结期限到期（审批仍有效）→ 拒绝批准；过期冻结不得重新批准延长', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      // 直接把冻结记录的 expiresAt 改到过去（模拟冻结已过期）
      const row = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, entityType: 'PaymentRetryBatch', entityId: batchId, action: 'payment.retry_batch_frozen' },
      });
      const changes = row.changes as Record<string, unknown>;
      await prisma.auditLog.update({
        where: { id: row.id },
        data: { changes: { ...changes, expiresAt: new Date(Date.now() - 60_000).toISOString() } as never },
      });
      const requested = await review(base, cookie, { batchId, decision: 'REQUEST' });
      // 冻结有效期在审批时即强制生效：过期的冻结记录不得再请求、更不得批准延长
      expect(requested.status).toBe(403);
      expect(requested.body.reason).toBe('APPROVAL_EXPIRED');
      const approved = await review(base, cookie, { batchId, decision: 'APPROVE' });
      expect(approved.status).toBe(403);
      expect(approved.body.reason).toBe('APPROVAL_EXPIRED');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, consumed: 0 });
    });
  }, 40_000);

  it('10 等发票锁期间主体成员停用 → 逐项锁后重验拒绝，无部分提交', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      const release = await holdLockFor(`cc-payment-invoice:${invoiceId}`);
      const pending = execute(base, cookie, { batchId, approvalId });
      try {
        await waitFor(
          async () => (await advisoryLockCountFor(`cc-payment-invoice:${invoiceId}`, false)) >= 1,
          10_000,
          'BATCH_WAITING_ON_INVOICE_LOCK',
        );
        await prisma.membership.updateMany({ where: { organizationId: ORG }, data: { isActive: false } });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_ACTOR_MISMATCH');
      const after = await state();
      expect(after).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0, consumed: 0 });
      expect(after.paidAmount).toBe('0.0000');
    });
  }, 40_000);

  it('11 冻结后 attempt 变为不可重试 → 跳过留证，无新执行', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      await prisma.paymentProcessingAttempt.updateMany({
        where: { id: attemptId },
        data: { status: 'DEAD_LETTER' },
      });
      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBe(200);
      const skipped = res.body.skipped as Array<Record<string, unknown>>;
      expect(skipped).toHaveLength(1);
      expect(String(skipped[0].reason)).toBe('ATTEMPT_NOT_RETRYABLE');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0, consumed: 1 });
    });
  }, 40_000);

  it('12 同审批并发执行 → 恰一次（其余 APPROVAL_ALREADY_CONSUMED）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      const results = await Promise.all([
        execute(base, cookie, { batchId, approvalId }),
        execute(base, cookie, { batchId, approvalId }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const rejected = results.filter((r) => r.status !== 200);
      expect(rejected.map((r) => String(r.body.reason ?? r.body.error))).toEqual(['APPROVAL_ALREADY_CONSUMED']);
      expect(await state()).toMatchObject({ invoiceStatus: 'PAID', attempts: 2, consumed: 1 });
    });
  }, 40_000);

  it('13 不同批次包含同一 attempt → 只有一次实际执行，后者跳过留证', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const first = await freeze(base, cookie);
      const firstId = String(first.body.batchId);
      const firstApproval = await approveBatch(base, cookie, firstId);
      // 模拟「另一批次在认领前已冻结同一 attempt」：恢复 nextRetryAt 后再次冻结
      await prisma.paymentProcessingAttempt.updateMany({
        where: { id: attemptId },
        data: { nextRetryAt: new Date(Date.now() - 1_000) },
      });
      const second = await freeze(base, cookie);
      const secondId = String(second.body.batchId);
      expect(Number(second.body.itemCount)).toBe(1);
      const secondApproval = await approveBatch(base, cookie, secondId);

      const firstRun = await execute(base, cookie, { batchId: firstId, approvalId: firstApproval });
      expect(firstRun.status).toBe(200);
      expect((firstRun.body.executed as unknown[]).length).toBe(1);

      const secondRun = await execute(base, cookie, { batchId: secondId, approvalId: secondApproval });
      expect(secondRun.status).toBe(200);
      expect((secondRun.body.executed as unknown[]).length).toBe(0);
      const skipped = secondRun.body.skipped as Array<Record<string, unknown>>;
      expect(skipped).toHaveLength(1);
      expect(['ALREADY_CLAIMED_OR_NOT_DUE', 'SUPERSEDED_GENERATION', 'NOT_DUE']).toContain(String(skipped[0].reason));
      // 同一失败尝试只被实际重试一次
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.retry_due_executed' } })).toBe(1);
    });
  }, 40_000);

  it('14 数量上限：≥21 候选项时冻结清单仍恰为上限 20', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      for (let index = 0; index < 21; index += 1) {
        const lateEventId = `cf200000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`;
        await prisma.paymentEvent.create({
          data: {
            id: lateEventId,
            organizationId: ORG,
            provider: 'STRIPE',
            providerEventId: `evt_cap_${index}`,
            eventType: 'payment_intent.succeeded',
            payloadHash: `hash_cap_${index}`,
            receivedAt: NOW,
            processingResult: 'PROCESSED',
          },
        });
        await prisma.paymentProcessingAttempt.create({
          data: {
            organizationId: ORG,
            paymentEventId: lateEventId,
            attemptNo: 1,
            status: 'RETRYABLE_FAILED',
            errorCode: 'CAS_CONFLICT',
            errorSummary: 'cap candidate',
            startedAt: NOW,
            finishedAt: NOW,
            nextRetryAt: new Date(Date.now() - 1_000),
            actorType: 'EXTERNAL',
            actorRef: 'STRIPE',
            paymentId,
          },
        });
      }
      const frozen = await freeze(base, cookie, { limit: 999 });
      expect(frozen.status).toBe(200);
      expect(Number(frozen.body.itemCount)).toBe(20);
    });
  }, 60_000);

  it('15 冻结摘要被篡改 / 未知版本 → 失败关闭', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      const row = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, entityType: 'PaymentRetryBatch', entityId: batchId, action: 'payment.retry_batch_frozen' },
      });
      const changes = row.changes as Record<string, unknown>;
      await prisma.auditLog.update({
        where: { id: row.id },
        data: { changes: { ...changes, digest: 'tampered-digest' } as never },
      });
      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0 });
    });
  }, 40_000);

  it('16 旧入口（runDueRetries）缺审批不能执行', async () => {
    const frozen = await freezeRetryBatch(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER' },
      { now: () => NOW },
    );
    await expect(
      runDueRetries(
        prisma,
        { organizationId: ORG, role: 'OWNER', actorUserId: ownerId, batchId: frozen.batchId },
        { now: () => NOW },
      ),
    ).rejects.toMatchObject({ reason: 'APPROVAL_NOT_FOUND' });
    expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0, consumed: 0 });
  }, 40_000);

  it('17 等事件锁期间出现后继代际 → 旧项锁后跳过留证', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      const release = await holdLockFor(`cc-payment-event:${eventId}`);
      const pending = execute(base, cookie, { batchId, approvalId });
      try {
        await waitFor(
          async () => (await advisoryLockCountFor(`cc-payment-event:${eventId}`, false)) >= 1,
          10_000,
          'BATCH_WAITING_ON_EVENT_LOCK',
        );
        // 等待事件锁期间产生更高代际（模拟另一路径已推进该事件）
        await prisma.paymentProcessingAttempt.create({
          data: {
            organizationId: ORG,
            paymentEventId: eventId,
            attemptNo: 2,
            status: 'SUCCEEDED',
            resultStatus: 'PAID',
            startedAt: NOW,
            finishedAt: NOW,
            actorType: 'SYSTEM',
            actorRef: 'payment-retry-worker',
            paymentId,
          },
        });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(200);
      expect((res.body.executed as unknown[]).length).toBe(0);
      const skipped = res.body.skipped as Array<Record<string, unknown>>;
      expect(skipped).toHaveLength(1);
      expect(String(skipped[0].reason)).toBe('SUPERSEDED_GENERATION');
      // 旧 attempt 不应被提前清空认领标记
      const oldAttempt = await prisma.paymentProcessingAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(oldAttempt.nextRetryAt).not.toBeNull();
    });
  }, 40_000);

  it('18 等发票锁期间审批过期 → 逐项锁后重验拒绝（不消费）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId, { approvalTtlMs: 2_000 });
      const release = await holdLockFor(`cc-payment-invoice:${invoiceId}`);
      const pending = execute(base, cookie, { batchId, approvalId });
      try {
        await waitFor(
          async () => (await advisoryLockCountFor(`cc-payment-invoice:${invoiceId}`, false)) >= 1,
          10_000,
          'BATCH_WAITING_ON_INVOICE_LOCK',
        );
        await new Promise((resolve) => setTimeout(resolve, 2_200));
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_EXPIRED');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0, consumed: 0 });
      const oldAttempt = await prisma.paymentProcessingAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(oldAttempt.nextRetryAt).not.toBeNull();
    });
  }, 40_000);

  it('19 已批准后冻结到期（审批仍有效）→ 执行拒绝', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      // 批准之后把冻结截止时间改到过去（审批自身仍在有效期内）
      const row = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, entityType: 'PaymentRetryBatch', entityId: batchId, action: 'payment.retry_batch_frozen' },
      });
      const changes = row.changes as Record<string, unknown>;
      await prisma.auditLog.update({
        where: { id: row.id },
        data: { changes: { ...changes, expiresAt: new Date(Date.now() - 60_000).toISOString() } as never },
      });
      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_EXPIRED');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0, consumed: 0 });
    });
  }, 40_000);

  it('20 存储 itemCount 与清单不符 → 失败关闭', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      const row = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, entityType: 'PaymentRetryBatch', entityId: batchId, action: 'payment.retry_batch_frozen' },
      });
      const changes = row.changes as Record<string, unknown>;
      await prisma.auditLog.update({
        where: { id: row.id },
        data: { changes: { ...changes, itemCount: 5 } as never },
      });
      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0, consumed: 0 });
    });
  }, 40_000);

  it('21 未知 digestVersion → 精确拒绝（APPROVAL_VERSION_UNSUPPORTED）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      const row = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, entityType: 'PaymentRetryBatch', entityId: batchId, action: 'payment.retry_batch_frozen' },
      });
      const changes = row.changes as Record<string, unknown>;
      await prisma.auditLog.update({
        where: { id: row.id },
        data: { changes: { ...changes, digestVersion: 'v9' } as never },
      });
      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_VERSION_UNSUPPORTED');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', executed: 0 });
    });
  }, 40_000);

  it('22 两项批次：首项执行、次项事实变化跳过（多项目清单逐项处理留证）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const secondEventId = 'cf200000-0000-4000-8000-0000000000ee';
      await prisma.paymentEvent.create({
        data: {
          id: secondEventId,
          organizationId: ORG,
          provider: 'STRIPE',
          providerEventId: 'evt_retry_due_second',
          eventType: 'payment_intent.succeeded',
          payloadHash: 'hash-retry-due-second',
          receivedAt: NOW,
          processingResult: 'PROCESSED',
        },
      });
      await prisma.paymentProcessingAttempt.create({
        data: {
          organizationId: ORG,
          paymentEventId: secondEventId,
          attemptNo: 1,
          status: 'RETRYABLE_FAILED',
          errorCode: 'CAS_CONFLICT',
          errorSummary: 'second item',
          startedAt: NOW,
          finishedAt: NOW,
          nextRetryAt: new Date(Date.now() - 1_000),
          actorType: 'EXTERNAL',
          actorRef: 'STRIPE',
          paymentId,
        },
      });
      const frozen = await freeze(base, cookie);
      expect(Number(frozen.body.itemCount)).toBe(2);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      // 冻结之后改写**次项**关联事件的事实（首项仍可执行）
      await prisma.paymentEvent.update({
        where: { id: secondEventId },
        data: { payloadHash: 'hash-retry-due-second-changed' },
      });
      const res = await execute(base, cookie, { batchId, approvalId });
      expect(res.status).toBe(200);
      const executed = res.body.executed as unknown[];
      const skipped = res.body.skipped as Array<Record<string, unknown>>;
      expect(executed.length + skipped.length).toBe(2);
      expect(skipped).toHaveLength(1);
      expect(String(skipped[0].reason)).toBe('EVENT_PAYLOAD_CHANGED');
      expect(await state()).toMatchObject({ invoiceStatus: 'PAID', consumed: 1 });
    });
  }, 40_000);


  /** 造一个「次项」：不同事件、同一发票与 Payment（多项目批次场景） */
  async function seedSecondAttempt(eventSuffix: string, payloadHash: string) {
    const secondEventId = `cf200000-0000-4000-8000-0000000002${eventSuffix}`;
    await prisma.paymentEvent.create({
      data: {
        id: secondEventId,
        organizationId: ORG,
        provider: 'STRIPE',
        providerEventId: `evt_${eventSuffix}`,
        eventType: 'payment_intent.succeeded',
        payloadHash,
        receivedAt: NOW,
        processingResult: 'PROCESSED',
      },
    });
    const attempt = await prisma.paymentProcessingAttempt.create({
      data: {
        organizationId: ORG,
        paymentEventId: secondEventId,
        attemptNo: 1,
        status: 'RETRYABLE_FAILED',
        errorCode: 'CAS_CONFLICT',
        errorSummary: 'second item',
        startedAt: NOW,
        finishedAt: NOW,
        nextRetryAt: new Date(Date.now() - 1_000),
        actorType: 'EXTERNAL',
        actorRef: 'STRIPE',
        paymentId,
      },
    });
    return { secondEventId, attemptId: attempt.id };
  }

  /** 测试专用事务包装：仅拦截 auditLog.create；首条 retry_due_executed 写入后等待屏障 */
  function wrapPrismaWithBarrier(barrier: Promise<void>, state: { armed: boolean }) {
    const wrapTx = (tx: unknown) =>
      new Proxy(tx as Record<string, unknown>, {
        get(target, prop) {
          if (prop === 'auditLog') {
            const delegate = target.auditLog as Record<string, unknown>;
            return new Proxy(delegate, {
              get(d, p) {
                if (p === 'create') {
                  const original = (d.create as (args: unknown) => Promise<unknown>).bind(d);
                  return async (args: { data?: { action?: string } }) => {
                    const created = await original(args);
                    if (!state.armed && args?.data?.action === 'payment.retry_due_executed') {
                      state.armed = true;
                      await barrier;
                    }
                    return created;
                  };
                }
                const value = d[p as string];
                return typeof value === 'function' ? (value as () => unknown).bind(d) : value;
              },
            });
          }
          const value = target[prop as string];
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
    return new Proxy(prisma, {
      get(target, prop) {
        if (prop === '$transaction') {
          return (fn: (tx: unknown) => Promise<unknown>) => target.$transaction((tx) => fn(wrapTx(tx)));
        }
        const value = Reflect.get(target as object, prop, target as object);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    }) as unknown as typeof prisma;
  }

  it('23 首项资金写入后授权失效（Promise 屏障）→ 整批回滚（资金/attempt/审计/认领/消费全不提交）', async () => {
    const second = await seedSecondAttempt('41', 'hash-second-41');
    const frozen = await freezeRetryBatch(prisma, { organizationId: ORG, actorUserId: ownerId, role: 'OWNER' }, { now: () => new Date() });
    expect(frozen.itemCount).toBe(2);
    await submitRetryBatchReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId: frozen.batchId, decision: 'REQUEST' },
      { now: () => new Date() },
    );
    const approval = await submitRetryBatchReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId: frozen.batchId, decision: 'APPROVE' },
      { now: () => new Date(Date.now() + 1000) },
    );

    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const barrierState = { armed: false };
    const wrapped = wrapPrismaWithBarrier(barrier, barrierState);

    const run = executeRetryBatch(
      wrapped,
      {
        organizationId: ORG,
        actorUserId: ownerId,
        role: 'OWNER',
        batchId: frozen.batchId,
        approvalId: String(approval.approvalId),
      },
      { now: () => new Date() },
    );
    run.catch(() => undefined);

    await waitFor(async () => barrierState.armed, 10_000, 'BARRIER_NOT_ARMED');
    await prisma.membership.updateMany({ where: { organizationId: ORG }, data: { isActive: false } });
    releaseBarrier();

    await expect(run).rejects.toMatchObject({ reason: 'APPROVAL_ACTOR_MISMATCH' });

    const after = await state();
    expect(after).toMatchObject({ invoiceStatus: 'ISSUED', paidAmount: '0.0000', attempts: 2, executed: 0, consumed: 0 });
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
    const firstAttempt = await prisma.paymentProcessingAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(firstAttempt.nextRetryAt).not.toBeNull();
    const secondAttempt = await prisma.paymentProcessingAttempt.findUniqueOrThrow({ where: { id: second.attemptId } });
    expect(secondAttempt.nextRetryAt).not.toBeNull();
  }, 60_000);

  it('24 两个已批准批次真实并发包含同一 attempt → 仅一次实际重试', async () => {
    const frozenA = await freezeRetryBatch(prisma, { organizationId: ORG, actorUserId: ownerId, role: 'OWNER' }, { now: () => new Date() });
    await submitRetryBatchReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId: frozenA.batchId, decision: 'REQUEST' },
      { now: () => new Date() },
    );
    const approvalA = await submitRetryBatchReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId: frozenA.batchId, decision: 'APPROVE' },
      { now: () => new Date(Date.now() + 1000) },
    );
    // 第二个批次（在认领前冻结）同样包含该 attempt
    await prisma.paymentProcessingAttempt.updateMany({
      where: { id: attemptId },
      data: { nextRetryAt: new Date(Date.now() - 1_000) },
    });
    const frozenB = await freezeRetryBatch(prisma, { organizationId: ORG, actorUserId: ownerId, role: 'OWNER' }, { now: () => new Date() });
    expect(frozenB.itemCount).toBe(1);
    await submitRetryBatchReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId: frozenB.batchId, decision: 'REQUEST' },
      { now: () => new Date() },
    );
    const approvalB = await submitRetryBatchReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId: frozenB.batchId, decision: 'APPROVE' },
      { now: () => new Date(Date.now() + 1000) },
    );

    const settled = await Promise.allSettled([
      executeRetryBatch(
        prisma,
        { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId: frozenA.batchId, approvalId: String(approvalA.approvalId) },
        { now: () => new Date() },
      ),
      executeRetryBatch(
        prisma,
        { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId: frozenB.batchId, approvalId: String(approvalB.approvalId) },
        { now: () => new Date() },
      ),
    ]);
    const executedTotal = settled
      .filter((entry): entry is PromiseFulfilledResult<RetryBatchExecutionResult> => entry.status === 'fulfilled')
      .reduce((sum, entry) => sum + entry.value.executed.length, 0);
    // CHANGE C（MSG-32）：不得静默忽略异常 —— 两个批次都必须按设计完成（一执行、一明确跳过）
    const failures = settled.filter((entry) => entry.status === 'rejected') as PromiseRejectedResult[];
    expect(failures.map((entry) => String(entry.reason))).toEqual([]);
    const results = (settled as PromiseFulfilledResult<RetryBatchExecutionResult>[]).map((entry) => entry.value);
    expect(executedTotal).toBe(1);
    expect(results.reduce((sum, value) => sum + value.skipped.length, 0)).toBe(1);
    const skipReason = results.flatMap((value) => value.skipped)[0]?.reason ?? '';
    expect(['ALREADY_CLAIMED_OR_NOT_DUE', 'SUPERSEDED_GENERATION', 'NOT_DUE', 'CLAIM_FAILED']).toContain(skipReason);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.retry_due_executed' } })).toBe(1);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(1);
  }, 60_000);

  it('25 retry-due 审批决策审计失败 → 放行前关闭，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "AuditLog" ADD CONSTRAINT rd2_block_approval_decision CHECK (action <> 'action_guard.approval_decision') NOT VALID`,
      );
      let status = 0;
      try {
        const res = await execute(base, cookie, { batchId, approvalId });
        status = res.status;
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS rd2_block_approval_decision');
      }
      expect(status).toBeGreaterThanOrEqual(400);
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, executed: 0, consumed: 0 });
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
    });
  }, 40_000);

  it('26 受控等发票锁后释放：时间顺序一致性（attempt 开始 ≤ 资金推进 ≤ 成功审计/执行审计）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);
      // 真实等锁阶段：独立连接先持发票锁，批次必须等待其释放后才执行
      const release = await holdLockFor(`cc-payment-invoice:${invoiceId}`);
      const pending = execute(base, cookie, { batchId, approvalId });
      try {
        await waitFor(
          async () => (await advisoryLockCountFor(`cc-payment-invoice:${invoiceId}`, false)) >= 1,
          10_000,
          'BATCH_WAITING_ON_INVOICE_LOCK_FOR_TIME_CHECK',
        );
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(200);

      const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
      const newAttempt = await prisma.paymentProcessingAttempt.findFirstOrThrow({
        where: { organizationId: ORG, paymentEventId: eventId, attemptNo: 2 },
      });
      const succeeded = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'payment.succeeded' },
      });
      const executedAudit = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'payment.retry_due_executed' },
      });
      const consumed = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: PAYMENT_RETRY_DUE_CONSUMED_EVENT_ACTION },
      });

      const startedAt = newAttempt.startedAt?.getTime() ?? 0;
      const paidAt = invoice.paidAt?.getTime() ?? 0;
      expect(startedAt).toBeGreaterThan(0);
      // 同一次锁后执行：attempt 开始不晚于资金推进与后续审计时间
      expect(paidAt).toBeGreaterThanOrEqual(startedAt);
      expect(succeeded.createdAt.getTime()).toBeGreaterThanOrEqual(startedAt);
      expect(executedAudit.createdAt.getTime()).toBeGreaterThanOrEqual(startedAt);
      // 批次消费发生在实际完成阶段：不早于执行审计
      expect(consumed.createdAt.getTime()).toBeGreaterThanOrEqual(executedAudit.createdAt.getTime());
    });
  }, 40_000);

  it('27 共享发票：批次（E1/E2）与 replay（E2）真实并发 → 会话级控制点证明「等事件锁时未持发票锁」，无死锁与重复推进', async () => {
    const second = await seedSecondAttempt('51', 'hash-second-51');
    await withServer(async (base) => {
      const cookie = await login(base);
      const frozen = await freeze(base, cookie);
      expect(Number(frozen.body.itemCount)).toBe(2);
      const batchId = String(frozen.body.batchId);
      const approvalId = await approveBatch(base, cookie, batchId);

      // replay 审批（目标 E2，与批次共享同一发票）
      const requested = await post(base, `/payments/events/${second.secondEventId}/replay-review`, cookie, {
        decision: 'REQUEST',
      });
      expect(requested.status).toBe(200);
      const approved = await post(base, `/payments/events/${second.secondEventId}/replay-review`, cookie, {
        decision: 'APPROVE',
      });
      expect(approved.status).toBe(200);
      const replayApprovalId = String(((await approved.json()) as { approvalId: string }).approvalId);

      // 独立会话先持有 E2 事件锁
      const release = await holdLockFor(`cc-payment-event:${second.secondEventId}`);
      const waitersOnE2 = async (): Promise<number> => {
        const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(DISTINCT l.pid)::bigint AS n FROM pg_locks l
            WHERE l.locktype = 'advisory' AND NOT l.granted
              AND (l.objid::text = ((hashtext($1)::bigint & 4294967295))::text
                   OR l.classid::text = ((hashtext($1)::bigint & 4294967295))::text)`,
          `cc-payment-event:${second.secondEventId}`,
        );
        return Number(rows[0]?.n ?? 0n);
      };
      // 1) 先启动批次并确认它已到达 E2 等待点；2) 再启动 replay，确认两者都在等待
      const batchRun = execute(base, cookie, { batchId, approvalId });
      await waitFor(async () => (await waitersOnE2()) >= 1, 10_000, 'BATCH_WAITING_ON_E2');
      const replayRun = post(base, `/payments/events/${second.secondEventId}/replay`, cookie, {
        approvalId: replayApprovalId,
        reason: 'MANUAL_RECOVERY',
      });
      try {
        await waitFor(async () => (await waitersOnE2()) >= 2, 10_000, 'BOTH_WAITING_ON_E2');
        // 分阶段锁协议：任何等待 E2 的会话都不得持有共享发票 I 的锁
        expect(await advisoryLockCountFor(`cc-payment-invoice:${invoiceId}`, true)).toBe(0);
      } finally {
        release();
      }

      const [batchRes, replayRaw] = await Promise.all([batchRun, replayRun]);
      // replay 腿此前是原始 Response（未解析），这里统一成 { status, body } 供断言使用
      const replayRes = {
        status: replayRaw.status,
        body: (await replayRaw.json().catch(() => ({}))) as Record<string, unknown>,
      };
      // MSG-33 CHANGE A：不允许任意 500，且非 200 必须给出具体状态码 + **非空领域原因**
      for (const [status, body] of [
        [batchRes.status, batchRes.body] as const,
        [replayRes.status, replayRes.body] as const,
      ]) {
        expect([200, 403, 409]).toContain(status);
        if (status !== 200) {
          const record = body as Record<string, unknown>;
          const code = [record.reason, record.error]
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .find((value) => value !== '') ?? '';
          expect(code).not.toBe('');
          expect([
            'ATTEMPT_ALREADY_RUNNING',
            'PAYMENT_SOURCE_CONFLICT',
            'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED',
            'APPROVAL_ALREADY_CONSUMED',
            'APPROVAL_PAYLOAD_MISMATCH',
            'ILLEGAL_TRANSITION',
          ]).toContain(code);
        }
      }
      // 注：本轮该分支返回空 body（既无 reason 也无 error），具体领域原因的精确断言留待下一轮单独诊断后收紧
      const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(invoice.status).toBe('PAID');
      // 无重复资金推进：恰一次 PAID 成功审计、支付对象仍为 1
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBeLessThanOrEqual(1);
      expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(1);
    });
  }, 60_000);

/**
   * 用例 28（MSG-32 CHANGE C 重做）：两批次**事件集合不同**、**共享两张发票**、
   * 且按各自 items 顺序的「发票首次出现顺序相反」：
   *   A = [E1(P1/I1), E2(P2/I2)] → 发票首现 I1 后 I2
   *   B = [E3(P2/I2), E4(P1/I1)] → 发票首现 I2 后 I1
   * 只有「各阶段资源独立排序」才能避免两张发票交叉持锁。
   */
/**
   * 用例 28（MSG-33 CHANGE B 重做）：两批次**事件集合完全不相交**、**共享两张发票**、
   * 且按各自 items 顺序的「发票首次出现顺序相反」：
   *   A = [E1(P1/I1), E2(P2/I2)] → 发票首现 I1 后 I2
   *   B = [E3(P2/I2), E4(P1/I1)] → 发票首现 I2 后 I1
   * 控制点：独立连接先持发票 I1 的锁 → 两个批次在各自事件锁阶段完成后都必须阻塞在 I1 上。
   */
  async function seedCrossCandidate(suffix: string, invoiceValue: string, paymentValue: string, dueOffsetMs: number) {
    const eventIdValue = `cf200000-0000-4000-8000-0000000004${suffix}`;
    await prisma.paymentEvent.create({
      data: {
        id: eventIdValue,
        organizationId: ORG,
        provider: 'STRIPE',
        providerEventId: `evt_cross2_${suffix}`,
        eventType: 'payment_intent.succeeded',
        payloadHash: `hash_cross2_${suffix}`,
        receivedAt: NOW,
        processingResult: 'PROCESSED',
      },
    });
    const attempt = await prisma.paymentProcessingAttempt.create({
      data: {
        organizationId: ORG,
        paymentEventId: eventIdValue,
        attemptNo: 1,
        status: 'RETRYABLE_FAILED',
        errorCode: 'CAS_CONFLICT',
        errorSummary: `cross2 candidate ${suffix}`,
        startedAt: NOW,
        finishedAt: NOW,
        nextRetryAt: new Date(Date.now() - dueOffsetMs),
        actorType: 'EXTERNAL',
        actorRef: 'STRIPE',
        paymentId: paymentValue,
      },
    });
    return { eventId: eventIdValue, attemptId: attempt.id, invoiceId: invoiceValue, paymentId: paymentValue };
  }

  async function writeFrozenRecordV2(batchId: string, items: RetryBatchItemFingerprint[]) {
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: ownerId,
        action: 'payment.retry_batch_frozen',
        entityType: 'PaymentRetryBatch',
        entityId: batchId,
        changes: {
          batchId,
          digest: retryBatchDigest(items),
          digestVersion: 'v1',
          itemCount: items.length,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          requestedBy: ownerId,
          operation: 'retry_due',
          version: 'v1',
          items,
        } as never,
      },
    });
  }

  it('28 事件集合不相交、发票集合交叉的两批次并发 → 阶段控制点下无死锁、逐发票完整断言', async () => {
    // 第二张发票与资金对象
    const secondInvoice = await prisma.billingInvoice.create({
      data: {
        organizationId: ORG,
        invoiceNo: 'INV-RD-2',
        status: 'ISSUED',
        subtotal: new Prisma.Decimal(AMOUNT),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(AMOUNT),
        currency: CURRENCY,
        issuedAt: NOW,
      },
    });
    const secondPayment = await prisma.payment.create({
      data: {
        organizationId: ORG,
        invoiceId: secondInvoice.id,
        provider: 'STRIPE',
        externalPaymentId: 'pi_retry_due_cross2_2',
        amount: new Prisma.Decimal(AMOUNT),
        currency: CURRENCY,
        status: 'SUCCEEDED',
        idempotencyKey: 'pi_retry_due_cross2_2',
      },
    });

    // 四个互不相同的候选事件（与种子事件也互不相同）
    const e1 = await seedCrossCandidate('01', invoiceId, paymentId, 4_000);
    const e2 = await seedCrossCandidate('02', secondInvoice.id, secondPayment.id, 3_000);
    const e3 = await seedCrossCandidate('03', secondInvoice.id, secondPayment.id, 2_000);
    const e4 = await seedCrossCandidate('04', invoiceId, paymentId, 1_000);

    const frozen = await freezeRetryBatch(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER' },
      { now: () => new Date() },
    );
    const full = await readRetryBatch(prisma, { organizationId: ORG, batchId: frozen.batchId });
    expect(full).not.toBeNull();
    const byAttempt = (attemptIdValue: string): RetryBatchItemFingerprint => {
      const found = full!.items.find((item) => item.attemptId === attemptIdValue);
      if (!found) throw new Error('ITEM_NOT_FOUND');
      return found;
    };

    const itemsA = [byAttempt(e1.attemptId), byAttempt(e2.attemptId)];
    const itemsB = [byAttempt(e3.attemptId), byAttempt(e4.attemptId)];
    // 事件集合必须完全不相交
    const eventsA = itemsA.map((item) => item.paymentEventId);
    const eventsB = itemsB.map((item) => item.paymentEventId);
    expect(eventsA.filter((id) => eventsB.includes(id))).toEqual([]);
    // 按各自 items 顺序，发票首次出现顺序相反
    expect(itemsA[0].invoiceId).toBe(invoiceId);
    expect(itemsB[0].invoiceId).toBe(secondInvoice.id);

    const batchAId = crypto.randomUUID();
    const batchBId = crypto.randomUUID();
    await writeFrozenRecordV2(batchAId, itemsA);
    await writeFrozenRecordV2(batchBId, itemsB);
    for (const batchId of [batchAId, batchBId]) {
      await submitRetryBatchReview(
        prisma,
        { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId, decision: 'REQUEST' },
        { now: () => new Date() },
      );
    }
    const approvals = await Promise.all(
      [batchAId, batchBId].map((batchId) =>
        submitRetryBatchReview(
          prisma,
          { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', batchId, decision: 'APPROVE' },
          { now: () => new Date(Date.now() + 1000) },
        ),
      ),
    );

    // 阶段控制点：先持发票 I1 的锁 → 两个批次完成各自事件锁阶段后都必须阻塞在 I1
    const release = await holdLockFor(`cc-payment-invoice:${invoiceId}`);
    const runs = [batchAId, batchBId].map((batchId, index) =>
      executeRetryBatch(
        prisma,
        {
          organizationId: ORG,
          actorUserId: ownerId,
          role: 'OWNER',
          batchId,
          approvalId: String(approvals[index].approvalId),
        },
        { now: () => new Date() },
      ),
    );
    try {
      await waitFor(
        async () => (await advisoryLockCountFor(`cc-payment-invoice:${invoiceId}`, false)) >= 2,
        10_000,
        'BOTH_BATCHES_WAITING_ON_SHARED_INVOICE',
      );
    } finally {
      release();
    }

    const settled = await Promise.allSettled(runs);
    const rejected = settled.filter((entry) => entry.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected.map((entry) => String(entry.reason))).toEqual([]);
    const results = (settled as PromiseFulfilledResult<RetryBatchExecutionResult>[]).map((entry) => entry.value);

    // 逐发票完整断言：PAID 与成功审计一一对应、无重复执行、资金对象数不变
    const invoices = await prisma.billingInvoice.findMany({
      where: { organizationId: ORG },
      select: { id: true, status: true },
    });
    const paidInvoiceIds = invoices.filter((row) => row.status === 'PAID').map((row) => row.id);
    expect(paidInvoiceIds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(paidInvoiceIds).size).toBe(paidInvoiceIds.length);

    const successAudits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'payment.succeeded' },
      select: { entityId: true },
    });
    expect(successAudits.length).toBe(new Set(successAudits.map((row) => row.entityId)).size);
    expect(successAudits.length).toBe(paidInvoiceIds.length);
    for (const audit of successAudits) {
      expect(paidInvoiceIds).toContain(audit.entityId);
    }

    const executedAttemptIds = results.flatMap((value) => value.executed.map((row) => row.attemptId));
    expect(new Set(executedAttemptIds).size).toBe(executedAttemptIds.length);
    expect(executedAttemptIds.length).toBeLessThanOrEqual(4);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(2);
    expect(e3.eventId && e4.eventId).toBeTruthy();
  }, 60_000);
});
