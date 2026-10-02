/**
 * ② 第二批 R8 — replay（POST /payments/events/:id/replay）真实 HTTP + PostgreSQL 验收
 * ----------------------------------------------------------------------------------
 * 01 HTTP 全链路：REQUEST → APPROVE（服务端指纹）→ replay 200；attempt 恰一次、消费恰一次
 * 02 缺 approvalId → 409 ACTION_GUARD_HUMAN_APPROVAL_REQUIRED，零副作用
 * 03 事件关键关联在审批后被改写（payloadHash 变化）→ 403（**提交侧**指纹比对），零副作用
 * 04 等锁期间事件事实变化（显式控制点 = pg_locks 中事件 advisory lock 等待行）→ 403，零副作用
 * 05/12 跨域冒用（双向均已执行）：payment.capture 审批不能用于 replay；replay 审批不能用于账单确认
 * 06 同审批并发 → 恰一次重放 + 一次消费，其余精确拒绝（APPROVAL_ALREADY_CONSUMED）
 * 07 等锁期间审批过期 → 403 APPROVAL_EXPIRED；08 撤销 → 403 APPROVAL_REVOKED；09 主体成员停用 → 403 APPROVAL_ACTOR_MISMATCH
 *
 * 说明：本文件验证的是**恢复收口（replay）**；不接入真实支付渠道、不发起任何真实扣款。
 * 口径：attempt.status = SUCCEEDED 表示「一次获批的恢复**尝试**已执行」；资金结论看 resultStatus
 *   （PAID = 收口成功；AMOUNT_MISMATCH / PENDING_REVIEW / ILLEGAL_TRANSITION = 已执行但未收口成功，同样会消费该审批）。
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
import { PAYMENT_REPLAY_CONSUMED_EVENT_ACTION } from '../services/action-guard/approval-tx-verify';
import { applyPaymentSucceeded } from '../services/workflow';
import { replayPaymentEvent, submitPaymentReplayReview } from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'cf100000-0000-4000-8000-0000000000a2';
const SALT = 'payment-replay-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'payment-replay-pass-1';
const EMAIL = 'payment-replay-owner@example.com';
/** CI 修复：审批有效期按真实时钟判定；固定 NOW 会在 NOW + TTL 之后必然失败，故以真实时钟（-60s）为基准，断言语义不变。 */
const NOW = new Date(Date.now() - 60_000);
const AMOUNT = '900.0000';
const CURRENCY = 'USD';
const REASON = 'MANUAL_RECOVERY';
const ACTION = 'payment.replay';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-payment-replay-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let ownerId = '';
let invoiceId = '';
let eventId = 'cf100000-0000-4000-8000-0000000000bb';

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
  await prisma.organization.create({ data: { id: ORG, name: 'Replay 租户', slug: 'payment-replay-org' } });
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
      invoiceNo: 'INV-RP-1',
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
      providerEventId: 'evt_replay_1',
      eventType: 'payment_intent.succeeded',
      payloadHash: 'hash-replay-1',
      receivedAt: NOW,
      processingResult: 'PROCESSED',
    },
  });
  const payment = await prisma.payment.create({
    data: {
      organizationId: ORG,
      invoiceId,
      provider: 'STRIPE',
      externalPaymentId: 'pi_replay_1',
      amount: new Prisma.Decimal(AMOUNT),
      currency: CURRENCY,
      status: 'SUCCEEDED',
      idempotencyKey: 'pi_replay_1',
    },
  });
  await prisma.paymentProcessingAttempt.create({
    data: {
      organizationId: ORG,
      paymentEventId: eventId,
      attemptNo: 1,
      status: 'RETRYABLE_FAILED',
      errorCode: 'CAS_CONFLICT',
      errorSummary: 'simulated transient failure',
      startedAt: NOW,
      finishedAt: NOW,
      nextRetryAt: new Date(NOW.getTime() - 60_000),
      actorType: 'EXTERNAL',
      actorRef: 'STRIPE',
      paymentId: payment.id,
    },
  });
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
      platformEnabled: { [ACTION]: true, 'payment.capture': true },
      tenantFeatureEnabled: { [ACTION]: true, 'payment.capture': true },
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

async function review(base: string, cookie: string, body: Record<string, unknown>) {
  const res = await post(base, `/payments/events/${eventId}/replay-review`, cookie, body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function approveReplay(
  base: string,
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const requested = await review(base, cookie, { decision: 'REQUEST' });
  expect(requested.status).toBe(200);
  const approved = await review(base, cookie, { decision: 'APPROVE', ...overrides });
  expect(approved.status).toBe(200);
  expect(typeof approved.body.approvalId).toBe('string');
  return String(approved.body.approvalId);
}

async function replay(base: string, cookie: string, body: Record<string, unknown> = {}) {
  const res = await post(base, `/payments/events/${eventId}/replay`, cookie, {
    reason: REASON,
    ...body,
  });
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
    payments: await prisma.payment.count({ where: { organizationId: ORG } }),
    attempts: await prisma.paymentProcessingAttempt.count({ where: { organizationId: ORG } }),
    consumed: await prisma.auditLog.count({
      where: { organizationId: ORG, action: PAYMENT_REPLAY_CONSUMED_EVENT_ACTION },
    }),
    replayed: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.processing_replayed' } }),
    rejected: await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.replay_rejected' } }),
  };
}

// ── 控制点：事件 advisory lock（与执行侧/审批创建同一把锁） ─────────────────────────
const advisoryKey = () => `cc-payment-event:${eventId}`;

async function advisoryLockCount(granted: boolean): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n
       FROM pg_locks l
      WHERE l.locktype = 'advisory'
        AND l.granted = ${granted ? 'true' : 'false'}
        AND (l.objid::text = ((hashtext($1)::bigint & 4294967295))::text
             OR l.classid::text = ((hashtext($1)::bigint & 4294967295))::text)`,
    advisoryKey(),
  );
  return Number(rows[0]?.n ?? 0n);
}

/** 有界轮询：等待某条审计落库（避免写入可见性竞态） */
async function waitForCount<T>(check: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (ok(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`CONTROL_POINT_TIMEOUT:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function holdEventLock(): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  void prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', advisoryKey());
        await gate;
      },
      { timeout: 30_000, maxWait: 30_000 },
    )
    .catch(() => undefined);
  await waitFor(async () => (await advisoryLockCount(true)) >= 1, 10_000, 'HOLDER_LOCK_NOT_GRANTED');
  return release;
}

describe('② 第二批 — replay（payment.replay）真实 HTTP + PostgreSQL', () => {
  it('01 HTTP 全链路（REQUEST→APPROVE→replay）：200、attempt 恰一次、消费恰一次、审计带审批关联', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      const res = await replay(base, cookie, { approvalId, note: '运维手工恢复' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        paymentEventId: eventId,
        attemptNo: 2,
        status: 'SUCCEEDED',
        resultStatus: 'PAID',
      });
      const after = await state();
      expect(after).toMatchObject({
        invoiceStatus: 'PAID',
        paidAmount: AMOUNT,
        payments: 1,
        attempts: 2,
        consumed: 1,
        replayed: 1,
      });

      const replayed = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'payment.processing_replayed' },
      });
      expect(replayed.changes).toMatchObject({ approvalId, operationId: `approval:${approvalId}` });

      const consumed = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: PAYMENT_REPLAY_CONSUMED_EVENT_ACTION },
      });
      expect(consumed.changes).toMatchObject({
        approvalId,
        paymentEventId: eventId,
        invoiceId,
        amount: AMOUNT,
        currency: CURRENCY,
        recoveryAction: 'recoverPaymentSucceeded',
        processingVersion: 'v1',
      });

      // R9 CHANGE B：真实落库一致性 —— Payment / 发票 paidAmount / 成功资金审计 / 消费记录同额同币种
      const storedPayment = await prisma.payment.findFirstOrThrow({ where: { organizationId: ORG } });
      const storedInvoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
      const succeeded = await prisma.auditLog.findFirstOrThrow({
        where: { organizationId: ORG, action: 'payment.succeeded' },
      });
      const succeededChanges = succeeded.changes as Record<string, unknown>;
      expect([
        storedPayment.amount.toFixed(4),
        storedInvoice.paidAmount?.toFixed(4) ?? null,
        succeededChanges.amount,
        (consumed.changes as Record<string, unknown>).amount,
      ]).toEqual([AMOUNT, AMOUNT, AMOUNT, AMOUNT]);
      expect([
        storedPayment.currency,
        storedInvoice.currency,
        succeededChanges.currency,
        (consumed.changes as Record<string, unknown>).currency,
      ]).toEqual([CURRENCY, CURRENCY, CURRENCY, CURRENCY]);
    });
  }, 40_000);

  it('02 缺 approvalId → 409 ACTION_GUARD_HUMAN_APPROVAL_REQUIRED，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const res = await replay(base, cookie);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', paidAmount: '0.0000', attempts: 1, consumed: 0 });
    });
  }, 40_000);

  it('03 审批后事件关键关联被改写（payloadHash 变化）→ 403（提交侧指纹比对），零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      // 直接写库改变事件事实：该请求由**提交侧**指纹比对拒绝（不产生服务层锁内拒绝审计；锁内拒绝见用例 04）
      await prisma.paymentEvent.update({ where: { id: eventId }, data: { payloadHash: 'hash-replay-2' } });
      const res = await replay(base, cookie, { approvalId });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_PAYLOAD_MISMATCH');
      expect(await state()).toMatchObject({
        invoiceStatus: 'ISSUED',
        paidAmount: '0.0000',
        attempts: 1,
        consumed: 0,
      });
    });
  }, 40_000);

  it('04 等锁期间事件事实变化（控制点 = pg_locks 等待行）→ 403，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      const release = await holdEventLock();
      const pending = replay(base, cookie, { approvalId });
      try {
        await waitFor(async () => (await advisoryLockCount(false)) >= 1, 10_000, 'REPLAY_WAITING_ON_EVENT_LOCK');
        await prisma.payment.updateMany({ where: { organizationId: ORG }, data: { amount: new Prisma.Decimal('950.0000') } });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_PAYLOAD_MISMATCH');
      expect(await state()).toMatchObject({
        invoiceStatus: 'ISSUED',
        paidAmount: '0.0000',
        attempts: 1,
        consumed: 0,
      });
      expect(await waitForCount(
        async () => (await state()).rejected,
        (n) => n >= 1,
      )).toBeGreaterThanOrEqual(1);
    });
  }, 40_000);

  it('05 跨域冒用：账单确认审批不能用于 replay（且 replay 审批不能用于账单确认）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      // 账单域审批（payment.capture，目标 BillingInvoice）
      const captureRequest = await post(base, `/billing/${invoiceId}/payment-review`, cookie, { decision: 'REQUEST' });
      expect(captureRequest.status).toBe(200);
      const captureApprove = await post(base, `/billing/${invoiceId}/payment-review`, cookie, {
        decision: 'APPROVE',
        amount: AMOUNT,
        currency: CURRENCY,
        basisReference: 'bank-transfer',
        from: 'ISSUED',
        to: 'PAID',
      });
      expect(captureApprove.status).toBe(200);
      const captureApprovalId = String(((await captureApprove.json()) as { approvalId: string }).approvalId);

      const misuse = await replay(base, cookie, { approvalId: captureApprovalId });
      expect(misuse.status).toBe(403);
      expect(['APPROVAL_TARGET_MISMATCH', 'APPROVAL_ACTION_MISMATCH']).toContain(String(misuse.body.reason));
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', consumed: 0, replayed: 0 });
    });
  }, 40_000);

  it('06 同审批并发 → 恰一次重放 + 一次消费，其余精确拒绝', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      const results = await Promise.all([
        replay(base, cookie, { approvalId }),
        replay(base, cookie, { approvalId }),
        replay(base, cookie, { approvalId }),
      ]);
      const ok = results.filter((r) => r.status === 200);
      expect(ok).toHaveLength(1);
      const outcomes = results
        .filter((r) => r.status !== 200)
        .map((r) => `${r.status}:${String(r.body.reason ?? r.body.error)}`)
        .sort();
      expect(outcomes).toEqual(['403:APPROVAL_ALREADY_CONSUMED', '403:APPROVAL_ALREADY_CONSUMED']);
      expect(await state()).toMatchObject({
        invoiceStatus: 'PAID',
        payments: 1,
        attempts: 2,
        consumed: 1,
        replayed: 1,
      });
    });
  }, 40_000);

  it('07 等锁期间审批过期 → 403 APPROVAL_EXPIRED，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie, { approvalTtlMs: 2_000 });
      const release = await holdEventLock();
      const pending = replay(base, cookie, { approvalId });
      try {
        await waitFor(async () => (await advisoryLockCount(false)) >= 1, 10_000, 'REPLAY_WAITING_ON_EVENT_LOCK');
        await new Promise((resolve) => setTimeout(resolve, 2_200));
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_EXPIRED');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, consumed: 0 });
    });
  }, 40_000);

  it('08 等锁期间审批被撤销 → 403 APPROVAL_REVOKED，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      const release = await holdEventLock();
      const pending = replay(base, cookie, { approvalId });
      try {
        await waitFor(async () => (await advisoryLockCount(false)) >= 1, 10_000, 'REPLAY_WAITING_ON_EVENT_LOCK');
        await prisma.auditLog.create({
          data: {
            organizationId: ORG,
            actorType: 'USER',
            actorUserId: ownerId,
            action: 'payment.review_rejected',
            entityType: 'PaymentEvent',
            entityId: eventId,
            changes: { reason: '等待期间撤销' } as never,
            createdAt: new Date(),
          },
        });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_REVOKED');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, consumed: 0 });
    });
  }, 40_000);

  it('09 等锁期间执行主体成员停用 → 403 APPROVAL_ACTOR_MISMATCH，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      const release = await holdEventLock();
      const pending = replay(base, cookie, { approvalId });
      try {
        await waitFor(async () => (await advisoryLockCount(false)) >= 1, 10_000, 'REPLAY_WAITING_ON_EVENT_LOCK');
        await prisma.membership.updateMany({ where: { organizationId: ORG, userId: ownerId }, data: { isActive: false } });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_ACTOR_MISMATCH');
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, consumed: 0 });
    });
  }, 40_000);
  // ── R8 修订 CHANGE B/C：跨对象竞争、跨域双向、失败关闭与回滚 ─────────────────────
  const INVOICE_KEY = () => `cc-payment-invoice:${invoiceId}`;

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

  it('10 等发票锁期间发票事实变化 → 重读后拒绝推进（AMOUNT_MISMATCH），绝不写旧 paidAmount', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      const release = await holdLockFor(INVOICE_KEY());
      const pending = replay(base, cookie, { approvalId });
      try {
        // 控制点：请求已取得事件锁、读取快照，正阻塞在发票锁上（即"已到达发票事实核验→更新阶段"）
        await waitFor(
          async () => (await advisoryLockCountFor(INVOICE_KEY(), false)) >= 1,
          10_000,
          'REPLAY_WAITING_ON_INVOICE_LOCK',
        );
        // R46 S5-A：模拟锁协议之外的直接 DB 写入者（临时停用 ISSUED 内容守卫）
        await prisma.$executeRawUnsafe('ALTER TABLE "BillingInvoice" DISABLE TRIGGER cc_billinginvoice_issue_guard');
        try {
          await prisma.billingInvoice.update({
            where: { id: invoiceId },
            data: { total: new Prisma.Decimal('950.0000') },
          });
        } finally {
          await prisma.$executeRawUnsafe('ALTER TABLE "BillingInvoice" ENABLE TRIGGER cc_billinginvoice_issue_guard');
        }
      } finally {
        release();
      }
      const res = await pending;
      // 结果只能是「重读/事实 CAS 拒绝」：attempt 会记为已执行，但账单不得推进
      expect(res.status).toBe(200);
      expect(res.body.resultStatus).toBe('AMOUNT_MISMATCH');
      const invoice = await prisma.billingInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select: { status: true, paidAmount: true, total: true },
      });
      expect(invoice.status).toBe('ISSUED');
      expect(invoice.paidAmount.toFixed(4)).toBe('0.0000');
      expect(invoice.total.toFixed(4)).toBe('950.0000');
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
      // 消费记录表示「一次获批恢复尝试已执行」，不是收口成功
      expect((await state()).consumed).toBe(1);
    });
  }, 40_000);

  it('11 事实 CAS：锁协议之外的写入者在核验与更新之间改事实 → CAS 未命中，零部分提交', async () => {
    let injected = false;
    const result = await prisma.$transaction(async (tx) => {
      const proxy = new Proxy(tx as unknown as Record<string, unknown>, {
        get(target, prop) {
          if (prop === 'billingInvoice') {
            const delegate = target.billingInvoice as Record<string, unknown>;
            return new Proxy(delegate, {
              get(d, p) {
                if (p === 'updateMany') {
                  return async (args: unknown) => {
                    if (!injected) {
                      injected = true;
                      // 模拟"不遵守发票锁协议"的写入者：在 CAS 之前提交新的发票事实
                      // R46 S5-A：模拟锁协议之外的直接 DB 写入者（临时停用 ISSUED 内容守卫）
                      await prisma.$executeRawUnsafe('ALTER TABLE "BillingInvoice" DISABLE TRIGGER cc_billinginvoice_issue_guard');
                      try {
                        await prisma.billingInvoice.update({
                          where: { id: invoiceId },
                          data: { total: new Prisma.Decimal('950.0000') },
                        });
                      } finally {
                        await prisma.$executeRawUnsafe('ALTER TABLE "BillingInvoice" ENABLE TRIGGER cc_billinginvoice_issue_guard');
                      }
                    }
                    return (d.updateMany as (a: unknown) => Promise<unknown>)(args);
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
      }) as unknown as typeof tx;
      return applyPaymentSucceeded(
        prisma,
        {
          organizationId: ORG,
          provider: 'STRIPE',
          externalPaymentId: 'pi_replay_1',
          invoiceId,
          amount: AMOUNT,
          currency: CURRENCY,
          mode: 'RECOVERY',
        },
        { client: proxy, now: () => NOW },
      );
    });

    expect(injected).toBe(true);
    expect(result.status).toBe('ILLEGAL_TRANSITION');
    const invoice = await prisma.billingInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { status: true, paidAmount: true, total: true },
    });
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.paidAmount.toFixed(4)).toBe('0.0000');
    expect(invoice.total.toFixed(4)).toBe('950.0000');
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.reconciliation_failed' } })).toBe(1);
  }, 40_000);

  it('12 反向冒用：replay 审批用于账单确认 → 403，两类消费均不新增', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const replayApprovalId = await approveReplay(base, cookie);
      const res = await post(base, `/billing/${invoiceId}/status`, cookie, {
        to: 'PAID',
        paymentReference: 'bank-transfer',
        amount: AMOUNT,
        currency: CURRENCY,
        approvalId: replayApprovalId,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(['APPROVAL_TARGET_MISMATCH', 'APPROVAL_ACTION_MISMATCH']).toContain(String(body.reason));
      const invoice = await prisma.billingInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select: { status: true, paidAmount: true },
      });
      expect(invoice.status).toBe('ISSUED');
      expect(invoice.paidAmount.toFixed(4)).toBe('0.0000');
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'billing.status_changed' } })).toBe(0);
      expect(
        await prisma.auditLog.count({
          where: { organizationId: ORG, action: { in: [PAYMENT_REPLAY_CONSUMED_EVENT_ACTION, 'payment.capture_consumed'] } },
        }),
      ).toBe(0);
    });
  }, 40_000);

  it('13 服务层直调缺 approvalId → 拒绝且零 attempt / 零资金 / 零消费', async () => {
    const before = await state();
    await expect(
      replayPaymentEvent(
        prisma,
        { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', paymentEventId: eventId, reason: REASON },
        { now: () => NOW },
      ),
    ).rejects.toMatchObject({ reason: 'APPROVAL_NOT_FOUND' });
    const after = await state();
    expect(after).toMatchObject({
      invoiceStatus: before.invoiceStatus,
      attempts: before.attempts,
      consumed: before.consumed,
      payments: before.payments,
    });
  }, 40_000);

  it('14 审批决策审计失败 → 放行前关闭，零副作用', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "AuditLog" ADD CONSTRAINT r8_block_approval_decision CHECK (action <> 'action_guard.approval_decision') NOT VALID`,
      );
      let status = 0;
      try {
        const res = await replay(base, cookie, { approvalId });
        status = res.status;
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS r8_block_approval_decision');
      }
      expect(status).toBeGreaterThanOrEqual(400);
      expect(await state()).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, consumed: 0, replayed: 0 });
    });
  }, 40_000);

  it('15 消费审计失败 → 整个事务回滚（attempt / 发票推进 / 成功审计不得部分提交）', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "AuditLog" ADD CONSTRAINT r8_block_replay_consumed CHECK (action <> '${PAYMENT_REPLAY_CONSUMED_EVENT_ACTION}') NOT VALID`,
      );
      let status = 0;
      try {
        const res = await replay(base, cookie, { approvalId });
        status = res.status;
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS r8_block_replay_consumed');
      }
      expect(status).toBeGreaterThanOrEqual(400);
      const after = await state();
      expect(after).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, consumed: 0, replayed: 0 });
      expect(after.paidAmount).toBe('0.0000');
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.processing_recovered' } })).toBe(0);
    });
  }, 40_000);

  it('16 等发票锁期间 Payment 事实变化 → 403 APPROVAL_PAYLOAD_MISMATCH，零新增 attempt / 成功审计 / 消费', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      const release = await holdLockFor(INVOICE_KEY());
      const pending = replay(base, cookie, { approvalId });
      try {
        await waitFor(
          async () => (await advisoryLockCountFor(INVOICE_KEY(), false)) >= 1,
          10_000,
          'REPLAY_WAITING_ON_INVOICE_LOCK',
        );
        // 等发票锁期间改变关联 Payment 事实（定位快照之后、最终快照之前）
        await prisma.payment.updateMany({
          where: { organizationId: ORG },
          data: { amount: new Prisma.Decimal('950.0000') },
        });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_PAYLOAD_MISMATCH');
      const after = await state();
      expect(after).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, consumed: 0, replayed: 0 });
      expect(after.paidAmount).toBe('0.0000');
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
    });
  }, 40_000);

  it('17 等发票锁期间审批过期 → 403 APPROVAL_EXPIRED，零新增 attempt / 资金推进 / 消费', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie, { approvalTtlMs: 2_000 });
      const release = await holdLockFor(INVOICE_KEY());
      const pending = replay(base, cookie, { approvalId });
      try {
        await waitFor(
          async () => (await advisoryLockCountFor(INVOICE_KEY(), false)) >= 1,
          10_000,
          'REPLAY_WAITING_ON_INVOICE_LOCK',
        );
        // 控制点在**发票锁**：跨过有效期后再释放，最终重验必须拒绝
        await new Promise((resolve) => setTimeout(resolve, 2_200));
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('APPROVAL_EXPIRED');
      const after = await state();
      expect(after).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, consumed: 0, replayed: 0 });
      expect(after.paidAmount).toBe('0.0000');
    });
  }, 40_000);

  it('18 等发票锁期间 Payment.provider 被改写 → 403（身份/事实不一致），无新增 Payment / attempt / PAID / 成功审计 / 消费', async () => {
    await withServer(async (base) => {
      const cookie = await login(base);
      const approvalId = await approveReplay(base, cookie);
      const release = await holdLockFor(INVOICE_KEY());
      const pending = replay(base, cookie, { approvalId });
      try {
        await waitFor(
          async () => (await advisoryLockCountFor(INVOICE_KEY(), false)) >= 1,
          10_000,
          'REPLAY_WAITING_ON_INVOICE_LOCK',
        );
        // 等发票锁期间改写关联 Payment 的 provider（金额与 externalPaymentId 不变）
        await prisma.payment.updateMany({ where: { organizationId: ORG }, data: { provider: 'OTHER_PSP' } });
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(403);
      expect(['APPROVAL_PAYLOAD_MISMATCH', 'APPROVAL_TARGET_MISMATCH']).toContain(String(res.body.reason));
      const after = await state();
      expect(after).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, payments: 1, consumed: 0, replayed: 0 });
      expect(after.paidAmount).toBe('0.0000');
      expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
    });
  }, 40_000);

  it('19 行锁查询零行 → 失败关闭（不执行资金处理，零新增）', async () => {
    await submitPaymentReplayReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', paymentEventId: eventId, decision: 'REQUEST' },
      { now: () => NOW },
    );
    const approved = await submitPaymentReplayReview(
      prisma,
      { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', paymentEventId: eventId, decision: 'APPROVE' },
      { now: () => new Date(NOW.getTime() + 1000) },
    );
    const approvalId = String(approved.approvalId);

    // 最小客户端包装：让 Payment 的 FOR UPDATE 查询返回零行（模拟锁不到目标行）
    const wrappedTx = (tx: unknown) =>
      new Proxy(tx as Record<string, unknown>, {
        get(target, prop) {
          if (prop === '$queryRawUnsafe') {
            return async (sql: string, ...args: unknown[]) =>
              String(sql).includes('"Payment"') && String(sql).includes('FOR UPDATE')
                ? []
                : (target.$queryRawUnsafe as (...a: unknown[]) => Promise<unknown>)(sql, ...args);
          }
          const value = target[prop as string];
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
    const wrappedClient = {
      paymentEvent: prisma.paymentEvent,
      auditLog: prisma.auditLog,
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        prisma.$transaction((tx) => fn(wrappedTx(tx))),
    } as unknown as typeof prisma;
    await expect(
      replayPaymentEvent(
        wrappedClient,
        { organizationId: ORG, actorUserId: ownerId, role: 'OWNER', paymentEventId: eventId, reason: REASON, approvalId },
        { now: () => NOW },
      ),
    ).rejects.toMatchObject({ reason: 'APPROVAL_TARGET_MISMATCH' });
    const after = await state();
    expect(after).toMatchObject({ invoiceStatus: 'ISSUED', attempts: 1, payments: 1, consumed: 0, replayed: 0 });
    expect(after.paidAmount).toBe('0.0000');
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(0);
  }, 40_000);
});
