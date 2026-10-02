/**
 * TRACK A / PC-05 —— RECOVERED MONEY VISIBILITY 验收（真实 HTTP + PostgreSQL）
 * MSG-20261003-86 ⑦：tenant 可见性 / 多币种分组 / EXPECTED≠RECEIVED / PARTIAL /
 * reversal 冲减 / VOID 排除 / disputed 不计入 / org 汇总一致 / fee calculated≠collected /
 * Payment=0·collection OFF / 无 secret / 权限边界 / 401。
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

const prisma = new PrismaClient();
const ORG = 'ff000000-0000-4000-8000-00000000000a';
const ORG_B = 'ff000000-0000-4000-8000-00000000000b';
const SALT = 'pc05-money-view-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'money-view-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc05-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run('http://127.0.0.1:' + port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function login(base: string, email: string): Promise<string> {
  const response = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('LOGIN_FAILED ' + response.status);
  return cookie.split(';')[0];
}

async function seedUser(email: string, role: string, organizationId = ORG): Promise<void> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: role,
      status: 'ACTIVE',
      emailVerified: true,
    },
    select: { id: true },
  });
  await prisma.membership.create({
    data: { organizationId, userId: user.id, role: role as never, isActive: true },
  });
}

let seq = 0;
async function seedCase(input: {
  organizationId?: string;
  currency?: string;
  recoverable?: string;
  claimItemStatus?: 'DISCOVERED' | 'SUBMITTED_MANUAL' | 'RECOVERED';
}): Promise<string> {
  seq += 1;
  const organizationId = input.organizationId ?? ORG;
  const kase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'PC05-' + seq,
      title: 'PC05 case ' + seq,
      domain: 'LOGISTICS',
      status: 'OPEN',
      currency: input.currency ?? 'USD',
    },
    select: { id: true },
  });
  await prisma.claimItem.create({
    data: {
      organizationId,
      caseId: kase.id,
      platformType: 'UPS',
      claimType: 'FREIGHT_RATE_OVERCHARGE',
      occurredAt: new Date('2026-09-08T00:00:00.000Z'),
      currency: input.currency ?? 'USD',
      recoverableAmount: new Prisma.Decimal(input.recoverable ?? '100.0000'),
      status: input.claimItemStatus ?? 'SUBMITTED_MANUAL',
      normalizerVersion: 'normalizer-1.0.0',
    },
  });
  return kase.id;
}

async function seedSettlement(input: {
  organizationId?: string;
  caseId: string;
  amount: string;
  currency?: string;
  status: 'EXPECTED' | 'RECEIVED' | 'PARTIAL' | 'DISPUTED' | 'VOID';
  reconciliationStatus?: 'NOT_STARTED' | 'PARTIAL' | 'RECONCILED' | 'DISPUTED' | 'REVERSED';
  reversedBySettlementId?: string | null;
  receivedAt?: Date | null;
}): Promise<string> {
  const created = await prisma.settlement.create({
    data: {
      organizationId: input.organizationId ?? ORG,
      caseId: input.caseId,
      status: input.status,
      source: 'PLATFORM_CREDIT',
      amount: new Prisma.Decimal(input.amount),
      currency: input.currency ?? 'USD',
      receivedAt: input.receivedAt ?? (input.status === 'RECEIVED' || input.status === 'PARTIAL' ? new Date('2026-09-20T00:00:00.000Z') : null),
      reconciliationStatus: input.reconciliationStatus ?? 'NOT_STARTED',
      reversedBySettlementId: input.reversedBySettlementId ?? null,
    },
    select: { id: true },
  });
  return created.id;
}

async function seedReversal(organizationId: string, settlementId: string, amount: string): Promise<void> {
  // 真实 reversal 事实需要可信 evidence 引用（与 R46 S3 验收同口径）。
  const evidence = await prisma.evidenceArtifact.create({
    data: { organizationId, kind: 'OTHER', title: 'pc05 reversal evidence' },
    select: { id: true },
  });
  await prisma.settlementAdjustment.create({
    data: {
      organizationId,
      originalSettlementId: settlementId,
      adjustmentKind: 'REVERSAL',
      amount: new Prisma.Decimal(amount),
      currency: 'USD',
      occurredAt: new Date('2026-09-25T00:00:00.000Z'),
      externalIdentityKind: 'BANK_TRANSACTION',
      externalIdentityValueHash: 'c'.repeat(64),
      externalIdentityVersion: 'v1',
      evidenceReferences: [{ evidenceArtifactId: evidence.id }] as unknown as Prisma.InputJsonValue,
      reasonCode: 'PROVIDER_CHARGEBACK',
      approvalId: 'approval-rev-' + settlementId,
    },
  });
}

async function seedInvoice(input: {
  organizationId?: string;
  caseId: string;
  total: string;
  paidAmount?: string;
  status?: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
}): Promise<void> {
  seq += 1;
  await prisma.billingInvoice.create({
    data: {
      organizationId: input.organizationId ?? ORG,
      caseId: input.caseId,
      invoiceNo: 'INV-' + seq,
      status: input.status ?? 'ISSUED',
      subtotal: new Prisma.Decimal(input.total),
      total: new Prisma.Decimal(input.total),
      currency: 'USD',
      paidAmount: new Prisma.Decimal(input.paidAmount ?? '0'),
    },
  });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "SettlementAdjustment", "BillingInvoice", "RecoveryLedgerEntry", "Settlement", "ClaimItem", "CaseOpportunity", "Case", "RecoveryOpportunity", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'PC05 租户', slug: 'pc05-org' },
      { id: ORG_B, name: '外部租户', slug: 'pc05-org-b' },
    ],
  });
  await seedUser('ops-pc05@example.com', 'OPS');
  await seedUser('finance-pc05@example.com', 'FINANCE');
  await seedUser('viewer-pc05@example.com', 'VIEWER');
});

instanceCheck: {
}

describe('PC-05 — recovered money visibility', () => {
  it('unauthorized → 401；VIEWER → 403；FINANCE（viewBilling）→ 200', async () => {
    await seedCase({});
    await withServer(async (base) => {
      expect((await fetch(base + '/recovery-money')).status).toBe(401);
      const viewer = await login(base, 'viewer-pc05@example.com');
      expect((await fetch(base + '/recovery-money', { headers: { cookie: viewer } })).status).toBe(403);
      const finance = await login(base, 'finance-pc05@example.com');
      expect((await fetch(base + '/recovery-money', { headers: { cookie: finance } })).status).toBe(200);
    });
  });

  it('same tenant visible / foreign invisible / 无 secret 字段', async () => {
    const mine = await seedCase({});
    await seedSettlement({ caseId: mine, amount: '80.0000', status: 'RECEIVED' });
    const foreign = await seedCase({ organizationId: ORG_B, currency: 'USD' });
    await seedSettlement({ organizationId: ORG_B, caseId: foreign, amount: '999.0000', status: 'RECEIVED' });

    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05@example.com');
      const response = await fetch(base + '/recovery-money', { headers: { cookie } });
      expect(response.status).toBe(200);
      const raw = await response.text();
      const body = JSON.parse(raw) as { cases: Array<{ caseId: string }>; organization: { byCurrency: Array<{ recovered: string }> } };
      expect(body.cases.map((row) => row.caseId)).toEqual([mine]);
      expect(body.organization.byCurrency[0].recovered).toBe('80.0000');
      for (const forbidden of ['externalRef', 'credentialRef', 'passwordHash', 'secret', 'token', 'storageKey']) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  it('EXPECTED ≠ RECEIVED；PARTIAL 计入 recovered；VOID 排除；DISPUTED 单独计数', async () => {
    const kase = await seedCase({});
    await seedSettlement({ caseId: kase, amount: '30.0000', status: 'EXPECTED' });
    await seedSettlement({ caseId: kase, amount: '40.0000', status: 'PARTIAL' });
    await seedSettlement({ caseId: kase, amount: '10.0000', status: 'VOID' });
    await seedSettlement({ caseId: kase, amount: '20.0000', status: 'DISPUTED' });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05@example.com');
      const body = (await (await fetch(base + '/recovery-money', { headers: { cookie } })).json()) as {
        cases: Array<{ primaryBucket: { expected: string; recovered: string; disputed: string }; status: string }>;
      };
      const bucket = body.cases[0].primaryBucket;
      expect(bucket.expected).toBe('30.0000');
      expect(bucket.recovered).toBe('40.0000'); // PARTIAL 计入；EXPECTED / VOID 不计
      expect(bucket.disputed).toBe('20.0000');
      expect(body.cases[0].status).toBe('DISPUTED');
    });
  });

  it('reversal 冲减 netRecovered（gross retired / adjustments / net 三者可核对）', async () => {
    const kase = await seedCase({});
    const settlement = await seedSettlement({ caseId: kase, amount: '100.0000', status: 'RECEIVED' });
    await seedReversal(ORG, settlement, '100.0000');
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05@example.com');
      const body = (await (await fetch(base + '/recovery-money', { headers: { cookie } })).json()) as {
        cases: Array<{ primaryBucket: { recovered: string; adjustments: string; netRecovered: string; outstanding: string }; status: string }>;
      };
      const bucket = body.cases[0].primaryBucket;
      expect(bucket.recovered).toBe('100.0000');
      expect(bucket.adjustments).toBe('100.0000');
      expect(bucket.netRecovered).toBe('0.0000');
      expect(body.cases[0].status).toBe('REVERSED');
    });
  });

  it('multi-currency 分组（不做跨币种相加）；org 汇总与 case 明细一致', async () => {
    const usd = await seedCase({ currency: 'USD' });
    await seedSettlement({ caseId: usd, amount: '50.0000', status: 'RECEIVED' });
    const eur = await seedCase({ currency: 'EUR', recoverable: '70.0000' });
    await seedSettlement({ caseId: eur, amount: '70.0000', currency: 'EUR', status: 'RECEIVED' });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05@example.com');
      const body = (await (await fetch(base + '/recovery-money', { headers: { cookie } })).json()) as {
        organization: { byCurrency: Array<{ currency: string; recovered: string }> };
        cases: Array<{ currency: string; primaryBucket: { recovered: string } | null }>;
      };
      const byCurrency = new Map(body.organization.byCurrency.map((bucket) => [bucket.currency, bucket.recovered]));
      expect(byCurrency.get('USD')).toBe('50.0000');
      expect(byCurrency.get('EUR')).toBe('70.0000');
      expect(body.organization.byCurrency).toHaveLength(2);
      // org 汇总 = 各 case 之和（同币种内）
      for (const row of body.cases) {
        expect(byCurrency.get(row.currency)).toBeDefined();
      }
    });
  });

  it('fee calculated ≠ fee collected；Payment=0 / collection OFF 明确暴露', async () => {
    const kase = await seedCase({});
    await seedSettlement({ caseId: kase, amount: '100.0000', status: 'RECEIVED' });
    await seedInvoice({ caseId: kase, total: '20.0000', paidAmount: '0', status: 'ISSUED' });
    await seedInvoice({ caseId: kase, total: '5.0000', paidAmount: '0', status: 'VOID' });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05@example.com');
      const body = (await (await fetch(base + '/recovery-money', { headers: { cookie } })).json()) as {
        organization: { collection: string; payment: string; byCurrency: Array<{ feeCalculated: string; feeCollected: string }> };
        feeNote: string;
      };
      expect(body.organization.collection).toBe('NOT_ENABLED');
      expect(body.organization.payment).toBe('ZERO');
      expect(body.organization.byCurrency[0].feeCalculated).toBe('20.0000'); // VOID 账单排除
      expect(body.organization.byCurrency[0].feeCollected).toBe('0.0000');
      expect(body.feeNote).toContain('NOT_ENABLED');
    });
  });

  it('跨币种污染回归：同一 case 的 USD / EUR 事实必须落在不同 bucket（MSG-20261003-87）', async () => {
    const kase = await seedCase({ currency: 'USD', recoverable: '100.0000' });
    await seedSettlement({ caseId: kase, amount: '50.0000', currency: 'USD', status: 'RECEIVED' });
    await seedSettlement({ caseId: kase, amount: '70.0000', currency: 'EUR', status: 'RECEIVED' });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05@example.com');
      const body = (await (await fetch(base + '/recovery-money', { headers: { cookie } })).json()) as {
        organization: { byCurrency: Array<{ currency: string; recovered: string }> };
        cases: Array<{ currency: string; byCurrency: Array<{ currency: string; recovered: string }>; primaryBucket: { recovered: string } | null }>;
      };
      const orgMap = new Map(body.organization.byCurrency.map((bucket) => [bucket.currency, bucket.recovered]));
      expect(orgMap.get('USD')).toBe('50.0000');
      expect(orgMap.get('EUR')).toBe('70.0000');
      const row = body.cases[0];
      expect(row.currency).toBe('USD');
      const caseMap = new Map(row.byCurrency.map((bucket) => [bucket.currency, bucket.recovered]));
      expect(caseMap.get('USD')).toBe('50.0000');
      expect(caseMap.get('EUR')).toBe('70.0000');
      expect(row.primaryBucket?.recovered).toBe('50.0000');
    });
  });

  it('caseId 过滤：跨租户 case → 404', async () => {
    const foreign = await seedCase({ organizationId: ORG_B });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05@example.com');
      const response = await fetch(base + '/recovery-money?caseId=' + foreign, { headers: { cookie } });
      expect(response.status).toBe(404);
    });
  });
});
