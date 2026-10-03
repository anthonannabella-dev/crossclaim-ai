/**
 * TRACK A / PC-05 FINAL-2 —— RECOVERED MONEY VISIBILITY（财务真实语义窄修后）
 * MSG-20261003-88：CHANGE B（submitted ≠ approved）/ C（approvedAt 只来自真实 outcome 时间）/
 * D（recovered 只来自 RecoveryPayout）/ E（reversal 单一来源、禁止 double subtract）。
 * CHANGE A（currency integrity）保持 PASS，回归一并保留。
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
const SALT = 'pc05f2-money-salt-0123456789a';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'money-final2-pass-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc05f2-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

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

async function seedUser(email: string, role: string): Promise<void> {
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: role, status: 'ACTIVE', emailVerified: true },
    select: { id: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role: role as never, isActive: true } });
}

let seq = 0;
async function seedCase(input: {
  currency?: string;
  recoverable?: string;
  claimItemStatus?: 'DISCOVERED' | 'SUBMITTED_MANUAL' | 'RECOVERED' | 'CLOSED';
  closedReason?: 'RECOVERED' | 'REJECTED' | 'NOT_WORTH_PURSUING' | 'CUSTOMER_DECLINED' | null;
  closedAt?: Date | null;
}): Promise<{ caseId: string; claimItemId: string }> {
  seq += 1;
  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'PC05F2-' + seq,
      title: 'PC05F2 case ' + seq,
      domain: 'LOGISTICS',
      status: 'OPEN',
      currency: input.currency ?? 'USD',
    },
    select: { id: true },
  });
  const claimItem = await prisma.claimItem.create({
    data: {
      organizationId: ORG,
      caseId: kase.id,
      platformType: 'UPS',
      claimType: 'FREIGHT_RATE_OVERCHARGE',
      occurredAt: new Date('2026-09-08T00:00:00.000Z'),
      currency: input.currency ?? 'USD',
      recoverableAmount: new Prisma.Decimal(input.recoverable ?? '100.0000'),
      status: input.claimItemStatus ?? 'SUBMITTED_MANUAL',
      closedReason: input.closedReason ?? null,
      closedAt: input.closedAt ?? null,
      normalizerVersion: 'normalizer-1.0.0',
    },
    select: { id: true },
  });
  return { caseId: kase.id, claimItemId: claimItem.id };
}

async function seedSettlement(input: {
  caseId: string;
  amount: string;
  currency?: string;
  status: 'EXPECTED' | 'RECEIVED' | 'PARTIAL' | 'DISPUTED' | 'VOID';
  reconciliationStatus?: 'NOT_STARTED' | 'RECONCILED' | 'DISPUTED' | 'REVERSED';
}): Promise<string> {
  const created = await prisma.settlement.create({
    data: {
      organizationId: ORG,
      caseId: input.caseId,
      status: input.status,
      source: 'PLATFORM_CREDIT',
      amount: new Prisma.Decimal(input.amount),
      currency: input.currency ?? 'USD',
      receivedAt: input.status === 'RECEIVED' || input.status === 'PARTIAL' ? new Date('2026-09-20T00:00:00.000Z') : null,
      reconciliationStatus: input.reconciliationStatus ?? 'NOT_STARTED',
    },
    select: { id: true },
  });
  return created.id;
}

async function seedPayout(settlementId: string, amount: string, currency = 'USD', receivedAt = new Date('2026-09-21T00:00:00.000Z')): Promise<void> {
  seq += 1;
  await prisma.recoveryPayout.create({
    data: {
      organizationId: ORG,
      settlementId,
      payoutRef: 'payout-' + seq,
      amount: new Prisma.Decimal(amount),
      currency,
      receivedAt,
      sourceType: 'PLATFORM_SETTLEMENT',
    },
  });
}

async function seedReversal(settlementId: string, amount: string, currency = 'USD'): Promise<void> {
  const evidence = await prisma.evidenceArtifact.create({
    data: { organizationId: ORG, kind: 'OTHER', title: 'pc05f2 reversal evidence' },
    select: { id: true },
  });
  await prisma.settlementAdjustment.create({
    data: {
      organizationId: ORG,
      originalSettlementId: settlementId,
      adjustmentKind: 'REVERSAL',
      amount: new Prisma.Decimal(amount),
      currency,
      occurredAt: new Date('2026-09-25T00:00:00.000Z'),
      externalIdentityKind: 'BANK_TRANSACTION',
      externalIdentityValueHash: 'd'.repeat(64),
      externalIdentityVersion: 'v1',
      evidenceReferences: [{ evidenceArtifactId: evidence.id }] as unknown as Prisma.InputJsonValue,
      reasonCode: 'PROVIDER_CHARGEBACK',
      approvalId: 'approval-pc05f2-' + settlementId,
    },
  });
}

interface MoneyResponse {
  organization: { byCurrency: Array<{ currency: string; recovered: string; adjustments: string; netRecovered: string; expected: string; approved: string }>; collection: string; payment: string };
  cases: Array<{
    caseId: string;
    currency: string;
    primaryBucket: { recovered: string; adjustments: string; netRecovered: string; approved: string; expected: string } | null;
    byCurrency: Array<{ currency: string; recovered: string }>;
    timeline: { approvedAt: string | null; receivedAt: string | null; submittedAt: string | null };
    status: string;
  }>;
}

async function fetchMoney(base: string, cookie: string): Promise<MoneyResponse> {
  const response = await fetch(base + '/recovery-money', { headers: { cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as MoneyResponse;
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
    'TRUNCATE TABLE "AuditLog", "SettlementAdjustment", "BillingInvoice", "RecoveryPayout", "RecoveryLedgerEntry", "Settlement", "ClaimItem", "CaseOpportunity", "Case", "RecoveryOpportunity", "EvidenceArtifact", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'PC05F2 租户', slug: 'pc05f2-org' } });
  await seedUser('ops-pc05f2@example.com', 'OPS');
});

describe('PC-05 FINAL-2 — financial truth narrow fix', () => {
  it('CHANGE B：SUBMITTED_MANUAL / CLOSED(REJECTED) → approved = 0；CLOSED(RECOVERED) → approved 正确', async () => {
    const submitted = await seedCase({ claimItemStatus: 'SUBMITTED_MANUAL' });
    const rejected = await seedCase({ claimItemStatus: 'CLOSED', closedReason: 'REJECTED' });
    const recovered = await seedCase({ claimItemStatus: 'CLOSED', closedReason: 'RECOVERED', closedAt: new Date('2026-09-22T00:00:00.000Z') });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05f2@example.com');
      const body = await fetchMoney(base, cookie);
      const byId = new Map(body.cases.map((row) => [row.caseId, row]));
      expect(byId.get(submitted.caseId)?.primaryBucket?.approved).toBe('0.0000');
      expect(byId.get(rejected.caseId)?.primaryBucket?.approved).toBe('0.0000');
      expect(byId.get(recovered.caseId)?.primaryBucket?.approved).toBe('100.0000');
    });
  });

  it('CHANGE C：无真实 outcome 时间 → approvedAt = null；有 closedAt 才填', async () => {
    const noOutcome = await seedCase({ claimItemStatus: 'SUBMITTED_MANUAL' });
    const withOutcome = await seedCase({ claimItemStatus: 'CLOSED', closedReason: 'RECOVERED', closedAt: new Date('2026-09-22T00:00:00.000Z') });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05f2@example.com');
      const body = await fetchMoney(base, cookie);
      const byId = new Map(body.cases.map((row) => [row.caseId, row]));
      expect(byId.get(noOutcome.caseId)?.timeline.approvedAt).toBeNull();
      expect(byId.get(withOutcome.caseId)?.timeline.approvedAt).toContain('2026-09-22');
    });
  });

  it('CHANGE D：recovered 只来自 RecoveryPayout（Settlement=100 + payout=40 → recovered=40；RECEIVED 但无 payout → 0）', async () => {
    const partial = await seedCase({});
    const settlementA = await seedSettlement({ caseId: partial.caseId, amount: '100.0000', status: 'RECEIVED' });
    await seedPayout(settlementA, '40.0000');

    const noPayout = await seedCase({});
    await seedSettlement({ caseId: noPayout.caseId, amount: '100.0000', status: 'RECEIVED' });

    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05f2@example.com');
      const body = await fetchMoney(base, cookie);
      const byId = new Map(body.cases.map((row) => [row.caseId, row]));
      expect(byId.get(partial.caseId)?.primaryBucket?.recovered).toBe('40.0000');
      expect(byId.get(noPayout.caseId)?.primaryBucket?.recovered).toBe('0.0000');
    });
  });

  it('CHANGE E：payout=100 + REVERSAL=100 → gross=100 / adjustments=100 / net=0，且 reconciliationStatus=REVERSED 不重复冲减', async () => {
    const kase = await seedCase({});
    const settlement = await seedSettlement({ caseId: kase.caseId, amount: '100.0000', status: 'RECEIVED', reconciliationStatus: 'REVERSED' });
    await seedPayout(settlement, '100.0000');
    await seedReversal(settlement, '100.0000');
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05f2@example.com');
      const body = await fetchMoney(base, cookie);
      const bucket = body.cases[0].primaryBucket;
      expect(bucket?.recovered).toBe('100.0000'); // gross 历史不被抹掉
      expect(bucket?.adjustments).toBe('100.0000');
      expect(bucket?.netRecovered).toBe('0.0000');
      expect(body.cases[0].status).toBe('REVERSED');
    });
  });

  it('EXPECTED 仍只进 expected；DISPUTED 仍单独计数（不被当作已追回）', async () => {
    const kase = await seedCase({});
    const expected = await seedSettlement({ caseId: kase.caseId, amount: '30.0000', status: 'EXPECTED' });
    await seedPayout(expected, '0.0000'); // 计划中：尚无真实到账
    await seedSettlement({ caseId: kase.caseId, amount: '20.0000', status: 'DISPUTED' });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05f2@example.com');
      const body = await fetchMoney(base, cookie);
      expect(body.cases[0].primaryBucket?.expected).toBe('30.0000');
      expect(body.cases[0].primaryBucket?.recovered).toBe('0.0000');
      expect(body.cases[0].status).toBe('DISPUTED');
    });
  });

  it('CHANGE A 回归：payout 币种落各自的 currency bucket（USD / EUR 不相加）', async () => {
    const kase = await seedCase({ currency: 'USD' });
    const usd = await seedSettlement({ caseId: kase.caseId, amount: '50.0000', status: 'RECEIVED' });
    await seedPayout(usd, '50.0000', 'USD');
    const eur = await seedSettlement({ caseId: kase.caseId, amount: '70.0000', currency: 'EUR', status: 'RECEIVED' });
    await seedPayout(eur, '70.0000', 'EUR');
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05f2@example.com');
      const body = await fetchMoney(base, cookie);
      const orgMap = new Map(body.organization.byCurrency.map((bucket) => [bucket.currency, bucket.recovered]));
      expect(orgMap.get('USD')).toBe('50.0000');
      expect(orgMap.get('EUR')).toBe('70.0000');
      const caseMap = new Map(body.cases[0].byCurrency.map((bucket) => [bucket.currency, bucket.recovered]));
      expect(caseMap.get('USD')).toBe('50.0000');
      expect(caseMap.get('EUR')).toBe('70.0000');
      expect(body.cases[0].primaryBucket?.recovered).toBe('50.0000');
    });
  });

  it('Payment=0 / collection=NOT_ENABLED 仍准确暴露；无 secret 字段', async () => {
    await seedCase({});
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc05f2@example.com');
      const response = await fetch(base + '/recovery-money', { headers: { cookie } });
      const raw = await response.text();
      const body = JSON.parse(raw) as MoneyResponse;
      expect(body.organization.payment).toBe('ZERO');
      expect(body.organization.collection).toBe('NOT_ENABLED');
      for (const forbidden of ['credentialRef', 'passwordHash', 'secret', 'token', 'storageKey', 'payoutRef']) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  it('unauthorized → 401；VIEWER → 403（权限边界保持）', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/recovery-money')).status).toBe(401);
    });
  });
});
