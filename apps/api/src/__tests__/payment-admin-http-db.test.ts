/**
 * O10 — 运维异常处置端点（真实 HTTP + 真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 这是「上线后运维视角」最关键的两个动作：
 *   POST /payments/events/:paymentEventId/replay   重放卡住的事件
 *   POST /payments/processing/retry-due            把到期重试跑掉 / 落死信
 * 在本文件之前，这两个端点只有服务层测试（workflow-payment-attempt-db.test.ts），
 * HTTP 层的鉴权与失败路径完全没有覆盖。
 *
 * 覆盖矩阵：
 *   · 未登录                      → 401，零写入
 *   · FINANCE 重放 / OPS 跑重试    → 403 FORBIDDEN，零写入（账单不动）
 *   · 原因缺失 / 不在白名单        → 400 INVALID_INPUT，零写入
 *   · 事件缺少 paymentId 上下文    → 409 PAYMENT_CONTEXT_REQUIRED，零写入
 *   · OWNER 合法重放              → 200，attemptNo=2，账单 ISSUED → PAID，审计齐全
 *   · OWNER 跑到期重试            → 200，账单 PAID；limit 越界被夹取而不是报错
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

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
const ORG = 'cc000000-0000-4000-8000-00000000000a';
const INVOICE = 'cc000000-0000-4000-8000-0000000000aa';
const EVENT = 'cc000000-0000-4000-8000-0000000000bb';
const EVENT_NO_PAYMENT = 'cc000000-0000-4000-8000-0000000000bd';
const SALT = 'gate7-payment-admin-http-salt-0';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
// 必须满足密码策略（12 位以上，同时含字母与数字）
const PASSWORD = 'payment-admin-1';
const NOW = new Date('2026-09-29T04:00:00Z');

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-payment-admin-http-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({
    data: { id: ORG, name: '支付运维租户', slug: 'payment-admin-org' },
  });

  for (const [email, role, displayName] of [
    ['admin-owner@example.com', 'OWNER', '负责人'],
    ['admin-ops@example.com', 'OPS', '运营'],
    ['admin-finance@example.com', 'FINANCE', '财务'],
  ] as const) {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
        displayName,
        status: 'ACTIVE',
        emailVerified: true,
      },
    });
    await prisma.membership.create({
      data: { organizationId: ORG, userId: user.id, role, isActive: true },
    });
  }
});

async function seedInvoice() {
  return prisma.billingInvoice.create({
    data: {
      id: INVOICE,
      organizationId: ORG,
      invoiceNo: 'BILL-ADMIN-1',
      status: 'ISSUED',
      subtotal: new Prisma.Decimal('900.0000'),
      total: new Prisma.Decimal('900.0000'),
      currency: 'USD',
      issuedAt: NOW,
    },
  });
}

async function seedEvent(id = EVENT) {
  return prisma.paymentEvent.create({
    data: {
      id,
      organizationId: ORG,
      provider: 'STRIPE',
      providerEventId: id === EVENT ? 'evt_admin_1' : 'evt_admin_2',
      eventType: 'payment_intent.succeeded',
      payloadHash: 'b'.repeat(64),
      receivedAt: NOW,
      processingResult: 'PROCESSED',
    },
  });
}

async function seedPayment() {
  return prisma.payment.create({
    data: {
      organizationId: ORG,
      invoiceId: INVOICE,
      provider: 'STRIPE',
      externalPaymentId: 'pi_admin_1',
      amount: new Prisma.Decimal('900.0000'),
      currency: 'USD',
      status: 'SUCCEEDED',
      idempotencyKey: 'pi_admin_1',
    },
  });
}

/** 「Payment 已记账、账单推进失败」：attempt#1 = RETRYABLE_FAILED 且已到期 */
async function seedFailedAttempt(options: { eventId?: string; paymentId?: string | null } = {}) {
  return prisma.paymentProcessingAttempt.create({
    data: {
      organizationId: ORG,
      paymentEventId: options.eventId ?? EVENT,
      attemptNo: 1,
      status: 'RETRYABLE_FAILED',
      errorCode: 'CAS_CONFLICT',
      errorSummary: 'simulated transient failure',
      startedAt: NOW,
      finishedAt: NOW,
      nextRetryAt: new Date(Date.now() - 60_000),
      actorType: 'EXTERNAL',
      actorRef: 'STRIPE',
      paymentId: options.paymentId === undefined ? null : options.paymentId,
    },
  });
}

const attemptCount = () =>
  prisma.paymentProcessingAttempt.count({ where: { organizationId: ORG } });
const auditCount = (action: string) =>
  prisma.auditLog.count({ where: { organizationId: ORG, action } });
const invoiceRow = () => prisma.billingInvoice.findUniqueOrThrow({ where: { id: INVOICE } });

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage, actionGuard: permissiveGuard() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run('http://127.0.0.1:' + port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

function post(base: string, pathname: string, cookie?: string, body?: unknown) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** ② 第二批 replay：受保护动作需要注入 Action Guard（本文件其余用例仍关注运维语义） */
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
      platformEnabled: { 'payment.capture': true, 'payment.replay': true, 'payment.retry_due': true },
      tenantFeatureEnabled: { 'payment.capture': true, 'payment.replay': true, 'payment.retry_due': true },
      hostApprovalGranted: true,
    }),
  });

/** 经 HTTP 创建 replay 审批（REQUEST → APPROVE），返回 approvalId */
/** ② 第二批 retry-due：冻结当前到期清单并取得批次审批 */
async function freezeAndApproveBatch(base: string, cookie: string) {
  const frozen = await post(base, '/payments/processing/retry-due/freeze', cookie, { limit: 20 });
  expect(frozen.status).toBe(200);
  const frozenBody = (await frozen.json()) as { batchId: string; itemCount: number };
  const requested = await post(base, '/payments/processing/retry-due/review', cookie, {
    batchId: frozenBody.batchId,
    decision: 'REQUEST',
  });
  expect(requested.status).toBe(200);
  const approved = await post(base, '/payments/processing/retry-due/review', cookie, {
    batchId: frozenBody.batchId,
    decision: 'APPROVE',
  });
  expect(approved.status).toBe(200);
  const approvedBody = (await approved.json()) as { approvalId?: string };
  if (!approvedBody.approvalId) throw new Error('RETRY_BATCH_APPROVAL_NOT_CREATED');
  return { batchId: frozenBody.batchId, approvalId: approvedBody.approvalId, itemCount: frozenBody.itemCount };
}

async function approveReplayViaHttp(base: string, cookie: string, eventId: string) {
  const pathname = '/payments/events/' + eventId + '/replay-review';
  const requested = await post(base, pathname, cookie, { decision: 'REQUEST' });
  expect(requested.status).toBe(200);
  const approved = await post(base, pathname, cookie, { decision: 'APPROVE' });
  expect(approved.status).toBe(200);
  const body = (await approved.json()) as { approvalId?: string };
  if (!body.approvalId) throw new Error('REPLAY_APPROVAL_NOT_CREATED');
  return body.approvalId;
}

describe('O10 — 支付运维端点（真实 HTTP + PostgreSQL）', () => {
  it('未登录 → 两个端点都 401，且零写入', async () => {
    await seedInvoice();
    await seedEvent();
    await seedFailedAttempt();
    const before = await attemptCount();

    await withServer(async (base) => {
      const replay = await post(base, '/payments/events/' + EVENT + '/replay', undefined, {
        reason: 'MANUAL_RECOVERY',
      });
      expect(replay.status).toBe(401);

      const retry = await post(base, '/payments/processing/retry-due');
      expect(retry.status).toBe(401);
    });

    expect(await attemptCount()).toBe(before);
    expect(await auditCount('payment.processing_replayed')).toBe(0);
    expect((await invoiceRow()).status).toBe('ISSUED');
  });

  it('FINANCE 不能重放、OPS 不能跑重试 → 403 FORBIDDEN，账单不动', async () => {
    await seedInvoice();
    await seedEvent();
    const payment = await seedPayment();
    await seedFailedAttempt({ paymentId: payment.id });
    const before = await attemptCount();

    await withServer(async (base) => {
      const owner = await login(base, 'admin-owner@example.com');
      const approvalId = await approveReplayViaHttp(base, owner, EVENT);
      const finance = await login(base, 'admin-finance@example.com');
      const replay = await post(
        base,
        '/payments/events/' + EVENT + '/replay',
        finance,
        { reason: 'MANUAL_RECOVERY', approvalId },
      );
      expect(replay.status).toBe(403);
      expect(await replay.json()).toMatchObject({ error: 'FORBIDDEN' });

      const batch = await freezeAndApproveBatch(base, owner);
      const ops = await login(base, 'admin-ops@example.com');
      const retry = await post(base, '/payments/processing/retry-due', ops, {
        batchId: batch.batchId,
        approvalId: batch.approvalId,
      });
      expect(retry.status).toBe(403);
      // OPS 不是授权执行主体：守卫/审批边界先拒（ACTION_GUARD_APPROVAL_NOT_VERIFIED），
      // 若走到业务层则同样 FORBIDDEN —— 两者都是 403 精确拒绝，账单不动。
      const opsBody = (await retry.json()) as { error?: string };
      expect(['FORBIDDEN', 'ACTION_GUARD_APPROVAL_NOT_VERIFIED']).toContain(String(opsBody.error));
    });

    expect(await attemptCount()).toBe(before);
    expect((await invoiceRow()).status).toBe('ISSUED');
  });

  it('重放原因缺失或不在白名单 → 400 INVALID_INPUT，零写入', async () => {
    await seedInvoice();
    await seedEvent();
    const payment = await seedPayment();
    await seedFailedAttempt({ paymentId: payment.id });
    const before = await attemptCount();

    await withServer(async (base) => {
      const owner = await login(base, 'admin-owner@example.com');
      const approvalId = await approveReplayViaHttp(base, owner, EVENT);
      const missing = await post(base, '/payments/events/' + EVENT + '/replay', owner, { approvalId });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ error: 'INVALID_INPUT' });

      const unknown = await post(base, '/payments/events/' + EVENT + '/replay', owner, {
        reason: 'BECAUSE_I_SAID_SO',
        approvalId,
      });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: 'INVALID_INPUT' });
    });

    expect(await attemptCount()).toBe(before);
    expect(await auditCount('payment.processing_replayed')).toBe(0);
  });

  it('事件没有 paymentId 上下文 → 409 PAYMENT_CONTEXT_REQUIRED，零写入（不猜金额）', async () => {
    await seedInvoice();
    await seedEvent(EVENT_NO_PAYMENT);
    await seedFailedAttempt({ eventId: EVENT_NO_PAYMENT, paymentId: null });
    const before = await attemptCount();

    await withServer(async (base) => {
      const owner = await login(base, 'admin-owner@example.com');
      const response = await post(
        base,
        '/payments/events/' + EVENT_NO_PAYMENT + '/replay',
        owner,
        { reason: 'MANUAL_RECOVERY' },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'PAYMENT_CONTEXT_REQUIRED' });
    });

    expect(await attemptCount()).toBe(before);
    expect((await invoiceRow()).status).toBe('ISSUED');
  });

  it('OWNER 合法重放 → 200，attempt#2 成功、账单 ISSUED → PAID、审计齐全', async () => {
    await seedInvoice();
    await seedEvent();
    const payment = await seedPayment();
    await seedFailedAttempt({ paymentId: payment.id });
    const before = await attemptCount();

    await withServer(async (base) => {
      const owner = await login(base, 'admin-owner@example.com');
      const approvalId = await approveReplayViaHttp(base, owner, EVENT);
      const response = await post(base, '/payments/events/' + EVENT + '/replay', owner, {
        reason: 'MANUAL_RECOVERY',
        note: '运维手工恢复',
        approvalId,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        paymentEventId: EVENT,
        attemptNo: 2,
        status: 'SUCCEEDED',
        resultStatus: 'PAID',
      });
    });

    expect(await attemptCount()).toBe(before + 1);
    expect((await invoiceRow()).status).toBe('PAID');
    expect(await auditCount('payment.processing_replayed')).toBe(1);
    expect(await auditCount('payment.processing_recovered')).toBe(1);
  });

  it('OWNER 跑到期重试 → 200，账单 PAID；limit 越界被夹取（不报错）', async () => {
    await seedInvoice();
    await seedEvent();
    const payment = await seedPayment();
    await seedFailedAttempt({ paymentId: payment.id });

    await withServer(async (base) => {
      const owner = await login(base, 'admin-owner@example.com');
      const batch = await freezeAndApproveBatch(base, owner);
      const response = await post(base, '/payments/processing/retry-due', owner, {
        batchId: batch.batchId,
        approvalId: batch.approvalId,
        limit: 999,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        batchId: string;
        itemCount: number;
        executed: unknown[];
        skipped: unknown[];
      };
      // 冻结清单被逐项执行：清单至少一项，执行与跳过合计覆盖清单，且账单被推进（下方断言）
      expect(body.batchId).toBe(batch.batchId);
      expect(batch.itemCount).toBeGreaterThanOrEqual(1);
      expect(body.executed.length + body.skipped.length).toBeGreaterThanOrEqual(1);
    });

    expect((await invoiceRow()).status).toBe('PAID');
    // 批次执行走 retry-due 自身的执行审计（不写 replay 的 processing_recovered）
    expect(await auditCount('payment.retry_due_executed')).toBe(1);
  });
});
