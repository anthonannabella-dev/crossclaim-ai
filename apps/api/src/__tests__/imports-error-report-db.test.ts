/**
 * MSG-20260929-10 Q1 — 导入失败明细只读端点（真实 HTTP + PostgreSQL）
 * ---------------------------------------------------------------
 * 运营可用性闭环：运营看到 PARTIAL 却不知道哪行坏，只能让工程师查库。
 * 架构方裁定 GO（有限范围）：
 *   允许返回 rowNumber / errorCode / errorCategory / field / action；
 *   禁止返回原始业务值、PII、原始文件内容、敏感字段。
 *
 * 覆盖矩阵：
 *   · 未登录                      → 401
 *   · 跨租户批次 / 不存在的 id     → 404（不区分「不存在」与「无权」）
 *   · 本租户批次                  → 200，只回投影字段
 *   · 泄漏防线                    → 响应不得含 message 自由文本、provenance、原始值
 *   · 批次级失败                  → failureStage 给出阶段，issues 为空
 *   · 未知错误码                  → errorCategory=OTHER + manual_confirmation_required
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

const prisma = new PrismaClient();
const ORG = 'dd000000-0000-4000-8000-00000000000a';
const ORG_B = 'dd000000-0000-4000-8000-00000000000b';
const BATCH_PARTIAL = 'dd000000-0000-4000-8000-0000000000aa';
const BATCH_STAGE_FAILED = 'dd000000-0000-4000-8000-0000000000ab';
const BATCH_OTHER_ORG = 'dd000000-0000-4000-8000-0000000000ac';
const SALT = 'gate7-imports-error-report-salt-0';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'imports-report-1';
const NOW = new Date('2026-09-29T05:00:00Z');

/** 故意塞进 message 的「原始值」：用于证明它不会出现在响应里 */
const RAW_LEAK = '112-3456789-4821';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-imports-report-'));
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
    'TRUNCATE TABLE "AuditLog", "ImportBatch", "SourceTransaction", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '导入明细租户', slug: 'imports-report-org' },
      { id: ORG_B, name: '外部租户', slug: 'imports-report-org-b' },
    ],
  });
  const user = await prisma.user.create({
    data: {
      email: 'imports-report@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: '运营',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { organizationId: ORG, userId: user.id, role: 'OPS', isActive: true },
  });
});

async function seedBatch(input: {
  id: string;
  organizationId?: string;
  status?: 'IMPORTED' | 'PARTIAL' | 'FAILED';
  errorReport?: Prisma.InputJsonValue;
}) {
  return prisma.importBatch.create({
    data: {
      id: input.id,
      organizationId: input.organizationId ?? ORG,
      domain: 'LOGISTICS',
      channel: 'UPS',
      status: input.status ?? 'PARTIAL',
      rowsTotal: 2000,
      rowsOk: 1999,
      rowsFailed: 1,
      startedAt: NOW,
      finishedAt: NOW,
      columnMapping: { amount: 'Net Charge' },
      ...(input.errorReport === undefined ? {} : { errorReport: input.errorReport }),
    },
  });
}

const ROW_ISSUE_REPORT = {
  // provenance 是「平台来源信息」，按裁定不得外泄
  source: 'adapter:shopify-export',
  cursor: 'cursor-opaque-value',
  pullError: { code: 'RATE_LIMITED', message: 'upstream said: ' + RAW_LEAK },
  issues: [
    {
      row: 1500,
      field: 'amount',
      code: 'INVALID_AMOUNT',
      // message 是自由文本，可能夹带来源值 → 必须被投影掉
      message: '金额格式非法: ' + RAW_LEAK,
    },
    { row: 1501, field: 'currency', code: 'SOMETHING_NEW', message: 'unknown code' },
  ],
  issuesTruncated: 3,
  duplicates: 0,
  emptyRowsSkipped: 2,
} as unknown as Prisma.InputJsonValue;

const STAGE_FAILURE_REPORT = {
  stage: 'persist',
  message: '数据库写入失败: ' + RAW_LEAK,
  terminalized: 'best-effort',
} as unknown as Prisma.InputJsonValue;

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

async function login(base: string): Promise<string> {
  const res = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'imports-report@example.com', password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

function getReport(base: string, batchId: string, cookie?: string) {
  return fetch(base + '/imports/' + batchId + '/error-report', {
    headers: cookie ? { cookie } : {},
  });
}

describe('MSG-20260929-10 Q1 — 导入失败明细端点（真实 HTTP + PostgreSQL）', () => {
  it('未登录 → 401，且不返回任何批次内容', async () => {
    await seedBatch({ id: BATCH_PARTIAL, errorReport: ROW_ISSUE_REPORT });
    await withServer(async (base) => {
      const response = await getReport(base, BATCH_PARTIAL);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'UNAUTHENTICATED' });
    });
  });

  it('跨租户批次与不存在的 id 一律 404（不泄漏存在性）', async () => {
    await seedBatch({ id: BATCH_OTHER_ORG, organizationId: ORG_B, errorReport: ROW_ISSUE_REPORT });
    await withServer(async (base) => {
      const cookie = await login(base);

      const foreign = await getReport(base, BATCH_OTHER_ORG, cookie);
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toMatchObject({ error: 'NOT_FOUND' });

      const missing = await getReport(base, 'dd000000-0000-4000-8000-00000000ffff', cookie);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: 'NOT_FOUND' });
    });
  });

  it('本租户批次 → 200，只回投影字段（无 message / provenance / 原始值）', async () => {
    await seedBatch({ id: BATCH_PARTIAL, errorReport: ROW_ISSUE_REPORT });
    await withServer(async (base) => {
      const cookie = await login(base);
      const response = await getReport(base, BATCH_PARTIAL, cookie);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        batchId: string;
        status: string;
        rowsTotal: number;
        rowsOk: number;
        rowsFailed: number;
        failureStage: string | null;
        issues: Array<Record<string, unknown>>;
        issuesTruncated: number | null;
        duplicates: number | null;
        emptyRowsSkipped: number | null;
      };

      expect(body.batchId).toBe(BATCH_PARTIAL);
      expect(body.status).toBe('PARTIAL');
      expect(body.rowsTotal).toBe(2000);
      expect(body.rowsOk).toBe(1999);
      expect(body.rowsFailed).toBe(1);
      expect(body.failureStage).toBeNull();
      expect(body.issuesTruncated).toBe(3);
      expect(body.duplicates).toBe(0);
      expect(body.emptyRowsSkipped).toBe(2);

      expect(body.issues).toHaveLength(2);
      expect(body.issues[0]).toEqual({
        rowNumber: 1500,
        errorCode: 'INVALID_AMOUNT',
        errorCategory: 'INVALID_VALUE',
        field: 'amount',
        action: 'fix_source_row_then_reimport',
      });
      // 未知错误码不扩散自由文本，只归类为 OTHER + 人工确认
      expect(body.issues[1]).toEqual({
        rowNumber: 1501,
        errorCode: 'SOMETHING_NEW',
        errorCategory: 'OTHER',
        field: 'currency',
        action: 'manual_confirmation_required',
      });

      // 泄漏防线：整段响应不得出现 message 文本、provenance 键或原始值
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(RAW_LEAK);
      expect(serialized).not.toContain('金额格式非法');
      expect(serialized).not.toContain('adapter:shopify-export');
      expect(serialized).not.toContain('cursor-opaque-value');
      expect(serialized).not.toContain('RATE_LIMITED');
      expect(serialized).not.toContain('message');
      expect(serialized).not.toContain('provenance');
    });
  });

  it('批次级失败 → failureStage 给出阶段，issues 为空（仍不泄漏 message）', async () => {
    await seedBatch({
      id: BATCH_STAGE_FAILED,
      status: 'FAILED',
      errorReport: STAGE_FAILURE_REPORT,
    });
    await withServer(async (base) => {
      const cookie = await login(base);
      const response = await getReport(base, BATCH_STAGE_FAILED, cookie);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        status: string;
        failureStage: string | null;
        issues: unknown[];
      };
      expect(body.status).toBe('FAILED');
      expect(body.failureStage).toBe('persist');
      expect(body.issues).toEqual([]);
      expect(JSON.stringify(body)).not.toContain(RAW_LEAK);
    });
  });

  it('没有 errorReport 的批次 → 200 且 issues 为空（不是错误）', async () => {
    await seedBatch({ id: BATCH_PARTIAL, status: 'IMPORTED' });
    await withServer(async (base) => {
      const cookie = await login(base);
      const response = await getReport(base, BATCH_PARTIAL, cookie);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { issues: unknown[]; failureStage: string | null };
      expect(body.issues).toEqual([]);
      expect(body.failureStage).toBeNull();
    });
  });
});
