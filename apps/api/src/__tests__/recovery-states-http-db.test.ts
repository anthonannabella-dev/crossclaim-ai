/**
 * TRACK A / PC-04 —— ERROR / RECOVERY STATES 验收（真实 HTTP + PostgreSQL）
 * MSG-20261003-84 ⑤：connection / import / claim recovery states、稳定 code、
 * 安全摘要（无 raw internal error）、无 secret、跨租户不可见、401/403、
 * retry endpoint 不得被宣称为可执行。
 */

import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import {
  CLAIM_READINESS_TO_RECOVERY_CODE,
  deriveClaimReadiness,
  deriveClaimRecoveryCode,
} from '../services/workflow/claim-recovery-semantics';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'ee000000-0000-4000-8000-00000000000a';
const ORG_B = 'ee000000-0000-4000-8000-00000000000b';
const SALT = 'pc04-recovery-states-salt-012345';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'recovery-states-pass-1';
const RAW_ERROR = 'SQLSTATE 42P01 relation "secret_table" does not exist for partner X';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc04-'));
const storage = new LocalFileSystemStorage({
  rootDir: storageRoot,
  secret: SALT,
  publicBaseUrl: 'http://localhost:3000',
});

let accountA = '';
let accountB = '';

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

async function seedConnection(input: {
  organizationId?: string;
  status: 'NEEDS_AUTH' | 'ACTIVE' | 'ERROR' | 'REVOKED' | 'PAUSED';
  platformAccountId: string | null;
  label: string;
  lastError?: string | null;
}): Promise<string> {
  const created = await prisma.sourceConnection.create({
    data: {
      organizationId: input.organizationId ?? ORG,
      domain: 'LOGISTICS',
      channel: 'UPS',
      kind: 'FILE_UPLOAD',
      status: input.status,
      label: input.label,
      platformAccountId: input.platformAccountId,
      lastError: input.lastError ?? null,
      lastErrorAt: input.lastError ? new Date('2026-09-30T00:00:00.000Z') : null,
    },
    select: { id: true },
  });
  return created.id;
}

let seq = 0;
async function seedImport(input: {
  organizationId?: string;
  status: 'FAILED' | 'PARTIAL' | 'IMPORTED';
  rowsTotal: number;
  rowsOk: number;
  rowsFailed: number;
}): Promise<string> {
  seq += 1;
  const created = await prisma.importBatch.create({
    data: {
      organizationId: input.organizationId ?? ORG,
      domain: 'LOGISTICS',
      channel: 'UPS',
      status: input.status,
      rowsTotal: input.rowsTotal,
      rowsOk: input.rowsOk,
      rowsFailed: input.rowsFailed,
      finishedAt: new Date('2026-09-30T01:00:00.000Z'),
    },
    select: { id: true },
  });
  return created.id;
}

async function seedCaseWithClaimItem(input: {
  organizationId?: string;
  status: 'DISCOVERED' | 'REVIEW_REQUIRED' | 'READY_TO_APPEAL';
  closedReason?: 'REJECTED' | null;
}): Promise<string> {
  seq += 1;
  const organizationId = input.organizationId ?? ORG;
  const kase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'PC04-' + seq,
      title: 'PC04 case ' + seq,
      domain: 'LOGISTICS',
      status: 'OPEN',
      currency: 'USD',
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
      currency: 'USD',
      status: input.status,
      closedReason: input.closedReason ?? null,
      normalizerVersion: 'normalizer-1.0.0',
    },
  });
  return kase.id;
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
    'TRUNCATE TABLE "AuditLog", "ClaimItem", "CaseOpportunity", "Case", "RecoveryOpportunity", "ImportBatch", "SourceConnection", "PlatformAccount", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: 'PC04 租户', slug: 'pc04-org' },
      { id: ORG_B, name: '外部租户', slug: 'pc04-org-b' },
    ],
  });
  accountA = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG, platform: 'UPS', externalAccountId: 'PC04-A', displayName: '账户 A' },
      select: { id: true },
    })
  ).id;
  accountB = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG_B, platform: 'UPS', externalAccountId: 'PC04-B', displayName: '账户 B' },
      select: { id: true },
    })
  ).id;
  await seedUser('ops-pc04@example.com', 'OPS');
  await seedUser('finance-pc04@example.com', 'FINANCE');
  await seedUser('viewer-pc04@example.com', 'VIEWER');
});

describe('PC-04 — error / recovery states HTTP contract', () => {
  it('unauthorized → 401；FINANCE / VIEWER → 403', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/recovery-states')).status).toBe(401);
      const finance = await login(base, 'finance-pc04@example.com');
      expect((await fetch(base + '/recovery-states', { headers: { cookie: finance } })).status).toBe(403);
      const viewer = await login(base, 'viewer-pc04@example.com');
      expect((await fetch(base + '/recovery-states', { headers: { cookie: viewer } })).status).toBe(403);
    });
  });

  it('connection：NEEDS_AUTH / ERROR / REVOKED / legacy unbound 的稳定 code 与安全摘要', async () => {
    await seedConnection({ status: 'NEEDS_AUTH', platformAccountId: accountA, label: 'needs auth' });
    await seedConnection({
      status: 'ERROR',
      platformAccountId: accountA,
      label: 'error with raw text',
      lastError: RAW_ERROR,
    });
    await seedConnection({ status: 'REVOKED', platformAccountId: accountA, label: 'revoked' });
    await seedConnection({ status: 'NEEDS_AUTH', platformAccountId: null, label: 'legacy unbound' });
    await seedConnection({ status: 'PAUSED', platformAccountId: accountA, label: 'paused bound' });

    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc04@example.com');
      const response = await fetch(base + '/recovery-states', { headers: { cookie } });
      expect(response.status).toBe(200);
      const raw = await response.text();
      const body = JSON.parse(raw) as {
        items: Array<{ scope: string; title: string; code: string; safeSummary: string; retry: { actionable: boolean; reason: string } }>;
      };
      const byTitle = new Map(body.items.filter((item) => item.scope === 'CONNECTION').map((item) => [item.title, item]));
      expect(byTitle.get('needs auth')?.code).toBe('RECONNECT_REQUIRED');
      expect(byTitle.get('revoked')?.code).toBe('RECONNECT_REQUIRED');
      expect(byTitle.get('legacy unbound')?.code).toBe('MANUAL_ACTION_REQUIRED');
      expect(byTitle.get('paused bound')?.code).toBe('MANUAL_ACTION_REQUIRED');
      const errored = byTitle.get('error with raw text');
      expect(errored?.code).toBe('CONTACT_SUPPORT'); // 原始错误无法安全归类 → 人工排查
      // 9/10：不得泄漏 raw internal error / secret / credential / storageKey
      expect(raw).not.toContain('SQLSTATE');
      expect(raw).not.toContain('secret_table');
      expect(raw).not.toContain('abc123');
      expect(raw).not.toContain('partner X');
      expect(raw).not.toContain('credentialRef');
      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain('storageKey');
      // 14：没有安全 retry endpoint → 一律不可执行
      for (const item of body.items) {
        expect(item.retry.actionable).toBe(false);
        expect(item.retry.reason).toBe('NO_SAFE_RETRY_ENDPOINT');
      }
    });
  });

  it('connection ERROR 分类为可重试时给出 RETRY_AVAILABLE（仍不可一键执行）', async () => {
    await seedConnection({
      status: 'ERROR',
      platformAccountId: accountA,
      label: 'timeout connector',
      lastError: 'upstream timeout after 30s',
    });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc04@example.com');
      const body = (await (await fetch(base + '/recovery-states', { headers: { cookie } })).json()) as {
        items: Array<{ title: string; code: string; nextAction: string; retry: { actionable: boolean } }>;
      };
      const item = body.items.find((candidate) => candidate.title === 'timeout connector');
      expect(item?.code).toBe('RETRY_AVAILABLE');
      expect(item?.retry.actionable).toBe(false);
    });
  });

  it('import：FAILED → REUPLOAD_REQUIRED；PARTIAL → IMPORT_PARTIAL（含计数与安全错误报告链接）', async () => {
    const failed = await seedImport({ status: 'FAILED', rowsTotal: 10, rowsOk: 0, rowsFailed: 10 });
    const partial = await seedImport({ status: 'PARTIAL', rowsTotal: 10, rowsOk: 7, rowsFailed: 3 });
    await seedImport({ status: 'IMPORTED', rowsTotal: 5, rowsOk: 5, rowsFailed: 0 });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc04@example.com');
      const body = (await (await fetch(base + '/recovery-states', { headers: { cookie } })).json()) as {
        items: Array<{ scope: string; refId: string; code: string; details: Record<string, unknown>; safeSummary: string }>;
      };
      const imports = body.items.filter((item) => item.scope === 'IMPORT');
      expect(imports).toHaveLength(2); // COMPLETED 不上报
      const failedItem = imports.find((item) => item.refId === failed);
      const partialItem = imports.find((item) => item.refId === partial);
      expect(failedItem?.code).toBe('REUPLOAD_REQUIRED');
      expect(partialItem?.code).toBe('IMPORT_PARTIAL');
      expect(partialItem?.details.rowsOk).toBe(7);
      expect(partialItem?.details.rowsFailed).toBe(3);
      expect(partialItem?.details.errorReportRef).toBe('/imports/' + partial + '/error-report');
    });
  });

  it('claim / package：DISCOVERED → EVIDENCE_REQUIRED；REVIEW_REQUIRED → MANUAL_ACTION_REQUIRED；READY_TO_APPEAL → APPEAL_REQUIRED', async () => {
    const evidenceCase = await seedCaseWithClaimItem({ status: 'DISCOVERED' });
    const reviewCase = await seedCaseWithClaimItem({ status: 'REVIEW_REQUIRED' });
    const appealCase = await seedCaseWithClaimItem({ status: 'READY_TO_APPEAL' });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc04@example.com');
      const body = (await (await fetch(base + '/recovery-states', { headers: { cookie } })).json()) as {
        items: Array<{ scope: string; refId: string; code: string }>;
      };
      const cases = new Map(body.items.filter((item) => item.scope === 'CASE').map((item) => [item.refId, item.code]));
      expect(cases.get(evidenceCase)).toBe('EVIDENCE_REQUIRED');
      expect(cases.get(reviewCase)).toBe('MANUAL_ACTION_REQUIRED');
      expect(cases.get(appealCase)).toBe('APPEAL_REQUIRED');
    });
  });

  it('foreign tenant failure invisible', async () => {
    await seedConnection({
      organizationId: ORG_B,
      status: 'ERROR',
      platformAccountId: accountB,
      label: 'foreign failing connection',
      lastError: 'boom',
    });
    await seedImport({ organizationId: ORG_B, status: 'FAILED', rowsTotal: 1, rowsOk: 0, rowsFailed: 1 });
    await withServer(async (base) => {
      const cookie = await login(base, 'ops-pc04@example.com');
      const body = (await (await fetch(base + '/recovery-states', { headers: { cookie } })).json()) as {
        items: Array<{ title: string }>;
      };
      expect(body.items.some((item) => item.title.includes('foreign'))).toBe(false);
    });
  });
});

describe('PC-04 REVISE — claim 状态语义只有一份来源（MSG-20261003-85 ④）', () => {
  it('readiness ↔ recovery code 由同一映射派生，两个消费者结果一致', () => {
    const cases = [
      { items: [{ status: 'DISCOVERED', closedReason: null }], context: { hasActivePackage: true, missingItemsCount: 1 }, code: 'EVIDENCE_REQUIRED' },
      { items: [{ status: 'REVIEW_REQUIRED', closedReason: null }], context: { hasActivePackage: true }, code: 'MANUAL_ACTION_REQUIRED' },
      { items: [{ status: 'READY_TO_APPEAL', closedReason: null }], context: { hasActivePackage: true }, code: 'APPEAL_REQUIRED' },
      { items: [{ status: 'CLOSED', closedReason: 'REJECTED' }], context: { hasActivePackage: true }, code: 'APPEAL_REQUIRED' },
    ] as const;
    for (const item of cases) {
      const readiness = deriveClaimReadiness(item.items, item.context);
      // 两个消费者必须得到同一结论（readiness → code 的唯一映射）
      expect(CLAIM_READINESS_TO_RECOVERY_CODE[readiness]).toBe(item.code);
      expect(deriveClaimRecoveryCode(item.items)).toBe(item.code);
    }
    // 不需要客户提示的 readiness 不得产生 recovery code（避免重复打扰）
    expect(CLAIM_READINESS_TO_RECOVERY_CODE.READY_TO_SUBMIT).toBeNull();
    expect(CLAIM_READINESS_TO_RECOVERY_CODE.SUBMITTED).toBeNull();
    expect(CLAIM_READINESS_TO_RECOVERY_CODE.APPROVED).toBeNull();
    expect(deriveClaimRecoveryCode([{ status: 'VERIFIED', closedReason: null }])).toBeNull();
  });
});
