/**
 * Wave 1 · 运行时装配与下载出口（C-0003 Checkpoint 1 · CHANGE #17/#18/#19/#20）
 * ---------------------------------------------------------------
 * 断言"真实启动路径"而不是"测试注入路径"：
 *   env → createRuntime → storage 装配 → /files 可用 → 成功下载写 AuditLog
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { createRuntime, type Runtime } from '../server';
import { createLogger } from '../config/logger';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ASSET = '33333333-3333-4333-8333-333333333333';
const SECRET = 'runtime-storage-secret-0123456789';
const SALT = 'runtime-audit-salt-0123456789';

interface CapturedAuditRow {
  organizationId?: string | null;
  actorType?: string;
  actorRef?: string | null;
  actorUserId?: string | null;
  action?: string;
  entityType?: string | null;
  entityId?: string | null;
  changes?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

function makeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    STORAGE_DRIVER: 'local',
    STORAGE_PUBLIC_BASE_URL: 'http://localhost:3000',
    STORAGE_URL_SECRET: SECRET,
    AUDIT_IP_SALT: SALT,
    ...extra,
  };
}

function stubPrisma(rows: CapturedAuditRow[]): PrismaClient {
  return {
    auditLog: {
      create: async (args: { data: CapturedAuditRow & { createdAt?: Date } }) => {
        rows.push(args.data);
        return { id: `audit-${rows.length}`, createdAt: args.data.createdAt ?? new Date() };
      },
      findMany: async () => [],
    },
  } as unknown as PrismaClient;
}

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crossclaim-runtime-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ============================================================
describe('运行时装配（CHANGE #18）', () => {
  it('local 驱动可以真实启动，并拿到 storage + audit', async () => {
    const rows: CapturedAuditRow[] = [];
    const runtime: Runtime = createRuntime({
      env: makeEnv({ STORAGE_LOCAL_ROOT: tmpRoot }),
      prisma: stubPrisma(rows),
      log: createLogger({ level: 'error', sink: () => undefined }),
    });

    expect(runtime.storage.driver).toBe('local');
    expect(runtime.audit).not.toBeNull();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
  });

  it('选择 S3 但没有凭据解析器 → fail fast（不静默回退 local）', () => {
    expect(() =>
      createRuntime({
        env: makeEnv({
          STORAGE_DRIVER: 's3',
          S3_ENDPOINT: 'http://localhost:8333',
          S3_BUCKET: 'crossclaim',
        }),
        prisma: stubPrisma([]),
        log: createLogger({ level: 'error', sink: () => undefined }),
      }),
    ).toThrow(/凭据/);
  });

  it('审计盐值过短 → 启动即失败', () => {
    expect(() =>
      createRuntime({
        env: makeEnv({ AUDIT_IP_SALT: 'short', STORAGE_URL_SECRET: 'short' }),
        prisma: stubPrisma([]),
        log: createLogger({ level: 'error', sink: () => undefined }),
      }),
    ).toThrow(/盐值过短/);
  });
});

// ============================================================
describe('真实运行时下载与审计（CHANGE #17）', () => {
  let runtime: Runtime;
  let base: string;
  const rows: CapturedAuditRow[] = [];

  beforeAll(async () => {
    rows.length = 0;
    runtime = createRuntime({
      env: makeEnv({ STORAGE_LOCAL_ROOT: tmpRoot }),
      prisma: stubPrisma(rows),
      log: createLogger({ level: 'error', sink: () => undefined }),
    });
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const address = runtime.server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
  });

  it('成功下载：返回字节 + 写入 AuditLog，且审计里没有裸 key / token / IP', async () => {
    const body = Buffer.from('承运商账单 PDF 占位', 'utf8');
    const stored = await runtime.storage.put({
      organizationId: ORG_A,
      fileAssetId: ASSET,
      body,
      contentType: 'application/pdf',
    });
    const signed = await runtime.storage.createSignedUrl(stored.storageKey, ORG_A, {
      ttlSeconds: 60,
      disposition: 'attachment',
      filename: '账单.pdf',
    });

    const response = await fetch(signed.url.replace('http://localhost:3000', base), {
      headers: { 'user-agent': 'vitest-agent' },
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''");

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.action).toBe('file.downloaded');
    expect(row.organizationId).toBe(ORG_A);
    expect(row.entityType).toBe('FileAsset');
    expect(row.entityId).toBe(ASSET);
    expect(row.actorType).toBe('EXTERNAL');
    expect(row.actorRef).toBe('signed-url');
    expect(row.actorUserId).toBeNull();
    expect(row.userAgent).toBe('vitest-agent');

    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(stored.storageKey);
    expect(serialized).not.toContain(signed.token);
    expect(row.ip).toMatch(/^[0-9a-f]{32}$/);
    expect(serialized).not.toContain('127.0.0.1:');
  });

  it('失败/畸形令牌不写审计、不崩溃', async () => {
    const before = rows.length;
    for (const suffix of ['%', '%ZZ', 'AAAA.BBBB', '']) {
      const response = await fetch(`${base}/files/${suffix}`);
      expect([400, 403], suffix).toContain(response.status);
    }
    expect(rows.length).toBe(before);
  });
});
