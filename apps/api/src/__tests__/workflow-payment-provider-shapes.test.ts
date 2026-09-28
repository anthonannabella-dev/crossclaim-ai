/**
 * C-0010-C1 — provider event **shape** validation over real HTTP + real PostgreSQL.
 * ------------------------------------------------------------------------------
 * MSG-20260928-100：C1 只做「形状级」验证 —— 用真实 Stripe 事件的字段形状做去敏 fixture，
 * 跑通验签 → 幂等 → PaymentEvent → attempt → Payment → BillingInvoice(PAID)。
 *
 * 每个 fixture 都带来源声明（REVISE-1）：
 *   _fixture: { source: 'stripe_test_event_shape', verified: false, contains_real_secret: false }
 * 含义：**不是**与真实 Stripe 联调的结果，也不含任何真实密钥；C2（真实 test-mode）另行验收。
 *
 * 边界（与计划一致）：不使用真实 Stripe secret、不使用 Stripe CLI / SDK、不创建 PaymentIntent、
 * 不暴露公网端点。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'a3000000-0000-4000-8000-000000000001';
const INVOICE = 'a3000000-0000-4000-8000-0000000000aa';
const SALT = 'c0010c1-provider-shape-salt-012345';
const SECRET = 'whsec_shape_proof_not_a_real_secret';
const NOW = new Date('2026-09-28T18:00:00Z');

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
/** C-0010-C2 REVISE-1：捕获结构化日志，用于断言版本不一致告警确实被写出 */
const capturedLogs: Array<Record<string, unknown>> = [];
const log = createLogger({
  level: 'warn',
  sink: (line) => capturedLogs.push(JSON.parse(line) as Record<string, unknown>),
});
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-provider-shape-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

/** REVISE-1：夹具来源声明（随每个夹具一起发送，生产解析会忽略未知字段）。 */
export const FIXTURE_DECLARATION = {
  source: 'stripe_test_event_shape',
  verified: false,
  contains_real_secret: false,
} as const;

interface StripeShapeOverrides {
  id?: string;
  type?: string;
  created?: number;
  livemode?: boolean;
  object?: Record<string, unknown>;
  apiVersion?: string;
}

/** 真实 Stripe Event 的信封形状（去敏），data.object 由用例给出。 */
function stripeEvent(overrides: StripeShapeOverrides = {}) {
  return {
    id: overrides.id ?? 'evt_shape_1',
    object: 'event',
    api_version: overrides.apiVersion ?? '2024-06-20',
    created: overrides.created ?? Math.floor(NOW.getTime() / 1000),
    data: { object: overrides.object ?? {} },
    livemode: overrides.livemode ?? false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: overrides.type ?? 'payment_intent.succeeded',
    _fixture: { ...FIXTURE_DECLARATION },
  };
}

/** payment_intent.succeeded 的 data.object 形状。 */
function paymentIntentSucceeded(amount = 90000, currency = 'usd') {
  return {
    id: 'pi_shape_1',
    object: 'payment_intent',
    amount,
    amount_received: amount,
    currency,
    status: 'succeeded',
    customer: 'cus_shape_1',
    latest_charge: 'ch_shape_1',
    metadata: { invoiceId: INVOICE },
  };
}

/** 服务端用真实时钟校验时间戳容差，因此签名默认取真实当前时间（事件的 created 字段另算）。 */
function sign(rawBody: string, timestamp = Math.floor(Date.now() / 1000), secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function deliver(base: string, body: object, signatureHeader?: string) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${base}/payments/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signatureHeader ?? sign(raw),
    },
    body: raw,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const previousEnv = {
  secret: process.env.PAYMENT_WEBHOOK_SECRET,
  enabled: process.env.PAYMENTS_ENABLED,
  threshold: process.env.PAYMENT_REVIEW_THRESHOLD,
};

beforeAll(async () => {
  await prisma.$connect();
  process.env.PAYMENT_WEBHOOK_SECRET = SECRET;
  process.env.PAYMENTS_ENABLED = 'true';
  process.env.PAYMENT_REVIEW_THRESHOLD = '1000.0000';
});

afterAll(async () => {
  if (previousEnv.secret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
  else process.env.PAYMENT_WEBHOOK_SECRET = previousEnv.secret;
  if (previousEnv.enabled === undefined) delete process.env.PAYMENTS_ENABLED;
  else process.env.PAYMENTS_ENABLED = previousEnv.enabled;
  if (previousEnv.threshold === undefined) delete process.env.PAYMENT_REVIEW_THRESHOLD;
  else process.env.PAYMENT_REVIEW_THRESHOLD = previousEnv.threshold;
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '形状验证租户', slug: 'shape-org' } });
  await prisma.billingInvoice.create({
    data: {
      id: INVOICE,
      organizationId: ORG,
      invoiceNo: 'BILL-SHAPE-1',
      status: 'ISSUED',
      subtotal: new Prisma.Decimal('900.0000'),
      total: new Prisma.Decimal('900.0000'),
      currency: 'USD',
      issuedAt: NOW,
    },
  });
});

const invoiceRow = () => prisma.billingInvoice.findUniqueOrThrow({ where: { id: INVOICE } });

describe('C-0010-C1 — provider 事件形状验证（真实 HTTP + PostgreSQL）', () => {
  it('夹具本身带来源声明：不是真实联调、不含真实密钥', () => {
    const fixture = stripeEvent();
    expect(fixture._fixture).toEqual({
      source: 'stripe_test_event_shape',
      verified: false,
      contains_real_secret: false,
    });
    expect(JSON.stringify(fixture)).not.toContain('sk_');
    expect(SECRET.startsWith('whsec_')).toBe(true);
  });

  it('payment_intent.succeeded（真实形状）→ 三链一致且账单 PAID', async () => {
    await withServer(async (base) => {
      const res = await deliver(base, stripeEvent({ object: paymentIntentSucceeded() }));
      expect(res.status).toBe(200);
      expect(res.json.processingResult).toBe('PROCESSED');
    });

    const invoice = await invoiceRow();
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAmount.toFixed(4)).toBe('900.0000');
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(1);
    const attempt = await prisma.paymentProcessingAttempt.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(attempt).toMatchObject({ attemptNo: 1, status: 'SUCCEEDED', resultStatus: 'PAID' });
    expect(attempt.paymentId).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(1);
  });

  it('验签容差边界：容差内通过；超差（-305s）拒绝且零写入', async () => {
    // 边界本身有时间抖动，这里取 ±295s / -305s：验证的是容差逻辑本身
    const nowSeconds = Math.floor(Date.now() / 1000);
    await withServer(async (base) => {
      const inside = JSON.stringify(stripeEvent({ id: 'evt_edge_in', object: paymentIntentSucceeded() }));
      const ok = await fetch(`${base}/payments/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(inside, nowSeconds - 295) },
        body: inside,
      });
      expect(ok.status).toBe(200);

      const outside = JSON.stringify(stripeEvent({ id: 'evt_edge_out', object: paymentIntentSucceeded() }));
      const expired = await fetch(`${base}/payments/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(outside, nowSeconds - 305) },
        body: outside,
      });
      expect(expired.status).toBe(400);
      expect(((await expired.json()) as { reason: string }).reason).toBe('EXPIRED');
    });
    // 容差内的事件已处理；超差事件没有落库
    expect(await prisma.paymentEvent.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('重复投递 → DUPLICATE；并发投递 → 一个 PROCESSED、一个 DUPLICATE，资金只动一次', async () => {
    await withServer(async (base) => {
      const body = stripeEvent({ id: 'evt_dup_1', object: paymentIntentSucceeded() });
      const first = await deliver(base, body);
      const second = await deliver(base, body);
      expect(first.json.processingResult).toBe('PROCESSED');
      expect(second.json.processingResult).toBe('DUPLICATE');

      const raceBody = stripeEvent({ id: 'evt_race_shape_1', object: paymentIntentSucceeded() });
      const raw = JSON.stringify(raceBody);
      const [a, b] = await Promise.all([
        fetch(`${base}/payments/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) },
          body: raw,
        }).then((res) => res.json()),
        fetch(`${base}/payments/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) },
          body: raw,
        }).then((res) => res.json()),
      ]);
      const results = [a, b].map((row) => (row as { processingResult: string }).processingResult).sort();
      expect(results).toEqual(['DUPLICATE', 'PROCESSED']);
    });

    expect(await prisma.paymentEvent.count({ where: { organizationId: ORG } })).toBe(2);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.succeeded' } })).toBe(1);
  });

  it('payment_intent.payment_failed（真实形状）→ 只记事件，账单不动', async () => {
    await withServer(async (base) => {
      const res = await deliver(
        base,
        stripeEvent({
          id: 'evt_failed_shape_1',
          type: 'payment_intent.payment_failed',
          object: {
            id: 'pi_shape_failed',
            object: 'payment_intent',
            amount: 90000,
            currency: 'usd',
            status: 'requires_payment_method',
            last_payment_error: { code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' },
            metadata: { invoiceId: INVOICE },
          },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.json.processingResult).toBe('PROCESSED');
    });
    expect(await prisma.paymentEvent.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(0);
    expect((await invoiceRow()).status).toBe('ISSUED');
  });

  it('charge.refunded（真实形状）→ 只记事件，不改账单状态', async () => {
    await withServer(async (base) => {
      const res = await deliver(
        base,
        stripeEvent({
          id: 'evt_refund_shape_1',
          type: 'charge.refunded',
          object: {
            id: 'ch_shape_refunded',
            object: 'charge',
            amount: 90000,
            amount_refunded: 90000,
            currency: 'usd',
            refunded: true,
            payment_intent: 'pi_shape_1',
            metadata: { invoiceId: INVOICE },
          },
        }),
      );
      expect(res.status).toBe(200);
    });
    expect(await prisma.paymentEvent.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.paymentProcessingAttempt.count({ where: { organizationId: ORG } })).toBe(0);
    expect((await invoiceRow()).status).toBe('ISSUED');
  });

  it('未知事件类型 / 缺 invoiceId / 签名错误：分别 IGNORED、IGNORED、400，均不改资金', async () => {
    await withServer(async (base) => {
      const unknown = await deliver(
        base,
        stripeEvent({ id: 'evt_unknown_1', type: 'customer.created', object: { id: 'cus_1', metadata: { invoiceId: INVOICE } } }),
      );
      expect(unknown.json.processingResult).toBe('PROCESSED'); // 白名单外：只留事件，不处理

      const unattributed = await deliver(
        base,
        stripeEvent({ id: 'evt_unattributed_1', object: { id: 'pi_x', object: 'payment_intent', amount: 1, currency: 'usd', metadata: {} } }),
      );
      expect(unattributed.json.processingResult).toBe('IGNORED');
      expect(unattributed.json.reason).toBe('unattributed_event');

      const forged = await deliver(base, stripeEvent({ id: 'evt_forged_1', object: paymentIntentSucceeded() }), 't=1,v1=deadbeef');
      expect(forged.status).toBe(400);
      expect(forged.json.processingResult).toBe('REJECTED');
    });
    // 只有可归属的未知类型事件落库；无归属与验签失败都不落库
    expect(await prisma.paymentEvent.count({ where: { organizationId: ORG } })).toBe(1);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.paymentProcessingAttempt.count({ where: { organizationId: ORG } })).toBe(0);
    expect((await invoiceRow()).status).toBe('ISSUED');
  });

  it('MSG-104 REVISE-1：api_version 不一致 → 结构化告警但继续处理（fail-soft）', async () => {
    capturedLogs.length = 0;
    await withServer(async (base) => {
      const mismatch = await deliver(
        base,
        stripeEvent({ id: 'evt_version_mismatch', apiVersion: '2019-01-01', object: paymentIntentSucceeded() }),
      );
      expect(mismatch.status).toBe(200);
      expect(mismatch.json.processingResult).toBe('PROCESSED');
    });

    // 版本不匹配不阻断：字段齐全就照常推进
    expect((await invoiceRow()).status).toBe('PAID');

    const warnings = capturedLogs.filter((row) => row.msg === 'payment.provider_version_mismatch');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      provider: 'STRIPE',
      providerEventId: 'evt_version_mismatch',
      expectedApiVersion: '2024-06-20',
      receivedApiVersion: '2019-01-01',
      action: 'CONTINUE',
    });
    // 告警字段白名单：不得带出 payload / 客户 / 支付方式 / 密钥 / 卡信息
    const serialized = JSON.stringify(warnings[0]);
    for (const forbidden of ['metadata', INVOICE, 'card', 'secret', 'customer', 'last_payment_error']) {
      expect(serialized).not.toContain(forbidden);
    }

    // 版本匹配时不产生该告警
    capturedLogs.length = 0;
    await withServer(async (base) => {
      const ok = await deliver(base, stripeEvent({ id: 'evt_version_ok', object: paymentIntentSucceeded(90000) }));
      expect(ok.status).toBe(200);
    });
    expect(capturedLogs.filter((row) => row.msg === 'payment.provider_version_mismatch')).toHaveLength(0);
  });

  it('金额不符与人工卡口：形状合法也不推进 PAID', async () => {
    // 卡口需要「金额与账单相等但高于阈值」，所以另开一张 1500 的账单
    const bigInvoice = await prisma.billingInvoice.create({
      data: {
        organizationId: ORG,
        invoiceNo: 'BILL-SHAPE-2',
        status: 'ISSUED',
        subtotal: new Prisma.Decimal('1500.0000'),
        total: new Prisma.Decimal('1500.0000'),
        currency: 'USD',
        issuedAt: NOW,
      },
    });
    await withServer(async (base) => {
      const mismatch = await deliver(base, stripeEvent({ id: 'evt_shape_mismatch', object: paymentIntentSucceeded(50000) }));
      expect(mismatch.status).toBe(200);
      const blocked = await deliver(
        base,
        stripeEvent({
          id: 'evt_shape_hitl',
          object: {
            ...paymentIntentSucceeded(150000),
            id: 'pi_shape_hitl',
            metadata: { invoiceId: bigInvoice.id },
          },
        }),
      );
      expect(blocked.status).toBe(200);
    });
    expect((await invoiceRow()).status).toBe('ISSUED');
    expect(
      (await prisma.billingInvoice.findUniqueOrThrow({ where: { id: bigInvoice.id } })).status,
    ).toBe('ISSUED');
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.reconciliation_failed' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'payment.review_required' } })).toBe(1);
  });
});
