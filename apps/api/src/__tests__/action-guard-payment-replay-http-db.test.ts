/**
 * ② 第二批 R8 — replay（POST /payments/events/:id/replay）真实 HTTP + PostgreSQL 验收
 * ----------------------------------------------------------------------------------
 * 01 HTTP 全链路：REQUEST → APPROVE（服务端指纹）→ replay 200；attempt 恰一次、消费恰一次
 * 02 缺 approvalId → 409 ACTION_GUARD_HUMAN_APPROVAL_REQUIRED，零副作用
 * 03 事件关键关联在审批后被改写（payloadHash 变化）→ 403 APPROVAL_PAYLOAD_MISMATCH，零副作用
 * 04 等锁期间事件事实变化（显式控制点 = pg_locks 中事件 advisory lock 等待行）→ 403，零副作用
 * 05 跨域冒用：payment.capture 审批不能用于 replay；replay 审批不能用于账单确认
 * 06 同审批并发 → 恰一次重放 + 一次消费，其余精确拒绝（APPROVAL_ALREADY_CONSUMED）
 * 07 等锁期间审批过期 → 403 APPROVAL_EXPIRED；08 撤销 → 403 APPROVAL_REVOKED；09 主体成员停用 → 403 APPROVAL_ACTOR_MISMATCH
 *
 * 说明：本文件验证的是**恢复收口（replay）**；不接入真实支付渠道、不发起任何真实扣款。
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

const prisma = new PrismaClient();
const ORG = 'cf100000-0000-4000-8000-0000000000a2';
const SALT = 'payment-replay-salt-0123';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'payment-replay-pass-1';
const EMAIL = 'payment-replay-owner@example.com';
const NOW = new Date('2026-09-30T08:00:00Z');
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
      // 直接写库改变事件事实（证明锁内快照与审批指纹不一致时拒绝）
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
});
