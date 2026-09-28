/**
 * Wave 0 · 健康检查与 HTTP 入口
 * ---------------------------------------------------------------
 * 健康检查必须对**真实数据库**验证（不能只 mock），
 * 同时用桩验证「依赖挂了要降级」的分支。
 */

import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../config/logger';
import { checkHealth, healthHttpStatus, type DbLike } from '../services/health';
import { createServer } from '../server';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('checkHealth', () => {
  it('数据库可用时 status=ok', async () => {
    const result = await checkHealth({ db: prisma, version: '0.1.0' });
    expect(result.status).toBe('ok');
    expect(result.checks.database.ok).toBe(true);
    expect(result.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(healthHttpStatus(result)).toBe(200);
  });

  it('数据库不可用时 status=degraded 且 HTTP 503', async () => {
    const broken: DbLike = {
      $queryRaw: () => Promise.reject(new Error('connection refused')),
    };
    const result = await checkHealth({ db: broken, version: '0.1.0' });
    expect(result.status).toBe('degraded');
    expect(result.checks.database.ok).toBe(false);
    expect(result.checks.database.detail).toContain('connection refused');
    expect(healthHttpStatus(result)).toBe(503);
  });

  it('健康结果里不含连接串或密钥', async () => {
    const result = await checkHealth({ db: prisma, version: '0.1.0' });
    const text = JSON.stringify(result);
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('password');
  });
});

describe('HTTP 入口', () => {
  async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const log = createLogger({ level: 'error', sink: () => undefined });
    const server = createServer({ prisma, log });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('GET /health 返回 200 与结构化结果', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        version: string;
        checks: { database: { ok: boolean } };
      };
      expect(body.status).toBe('ok');
      expect(body.version).toBeDefined();
      expect(body.checks.database.ok).toBe(true);
    });
  });

  it('GET /healthz 同样可用（兼容探针命名）', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
    });
  });

  it('未知路径返回 404', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/nope`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('not_found');
    });
  });

  it('POST /health 不被接受（只读端点）', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/health`, { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });
});
