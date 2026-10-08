// P2-1（MSG-20260929-70）— /readyz 语义：DB / migration / resolver，且不泄漏内部信息

import type { AddressInfo } from 'node:net';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import {
  checkReadiness,
  countLocalMigrations,
  migrationDirCandidates,
  readinessHttpStatus,
  resolveMigrationsDir,
} from '../services/readiness';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

function deps(overrides: Partial<Parameters<typeof checkReadiness>[0]> = {}) {
  return {
    databaseProbe: async () => undefined,
    appliedMigrations: async () => 19,
    expectedMigrations: 19,
    resolverProbe: async () => true,
    version: '0.1.0',
    ...overrides,
  };
}

describe('checkReadiness（P2-1）', () => {
  it('01 DB 可用 + 迁移一致 + resolver 可解析 → ready，且 HTTP 200', async () => {
    const result = await checkReadiness(deps());
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(readinessHttpStatus(result)).toBe(200);
  });

  it('02 DB 不可用 → DATABASE_UNAVAILABLE，且不继续判定迁移/resolver', async () => {
    let migrationChecked = false;
    const result = await checkReadiness(
      deps({
        databaseProbe: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:5432 postgresql://user:pass@host/db');
        },
        appliedMigrations: async () => {
          migrationChecked = true;
          return 19;
        },
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(['DATABASE_UNAVAILABLE']);
    expect(migrationChecked).toBe(false);
    expect(readinessHttpStatus(result)).toBe(503);
  });

  it('03 迁移数不一致 → MIGRATION_MISMATCH（含迁移查询抛错）', async () => {
    const mismatch = await checkReadiness(deps({ appliedMigrations: async () => 18 }));
    expect(mismatch.reasons).toEqual(['MIGRATION_MISMATCH']);

    const broken = await checkReadiness(
      deps({
        appliedMigrations: async () => {
          throw new Error('relation "_prisma_migrations" does not exist');
        },
      }),
    );
    expect(broken.reasons).toEqual(['MIGRATION_MISMATCH']);

    const unknownExpected = await checkReadiness(deps({ expectedMigrations: -1 }));
    expect(unknownExpected.reasons).toEqual(['MIGRATION_MISMATCH']);
  });

  it('04 resolver 不可用/抛错 → KILL_SWITCH_RESOLVER_FAIL_CLOSED', async () => {
    const degraded = await checkReadiness(deps({ resolverProbe: async () => false }));
    expect(degraded.reasons).toEqual(['KILL_SWITCH_RESOLVER_FAIL_CLOSED']);
    const thrown = await checkReadiness(
      deps({
        resolverProbe: async () => {
          throw new Error('resolver boom');
        },
      }),
    );
    expect(thrown.reasons).toEqual(['KILL_SWITCH_RESOLVER_FAIL_CLOSED']);
  });

  it('05 结果里不含 SQL 错误 / 连接串 / 堆栈 / secret', async () => {
    const result = await checkReadiness(
      deps({
        databaseProbe: async () => {
          throw new Error('password=supersecret host=db.internal stack: at Object.<anonymous>');
        },
        resolverProbe: async () => {
          throw new Error('token=abcd1234');
        },
      }),
    );
    const text = JSON.stringify(result);
    for (const forbidden of ['supersecret', 'db.internal', 'stack', 'token', 'password', 'postgresql://']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

describe('HTTP /readyz（P2-1）', () => {
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

  it('06 真实库 + 迁移完整 → 200 { ready: true, reasons: [] }', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/readyz`);
      const body = (await res.json()) as { ready: boolean; reasons: string[]; checkedAt: string };
      expect(res.status).toBe(200);
      expect(body.ready).toBe(true);
      expect(body.reasons).toEqual([]);
      expect(typeof body.checkedAt).toBe('string');
    });
  });

  it('07 /readyz 与 /health 语义分离：/health 仍只报 liveness', async () => {
    await withServer(async (base) => {
      const health = await fetch(`${base}/health`);
      const ready = await fetch(`${base}/readyz`);
      expect(health.status).toBe(200);
      expect(ready.status).toBe(200);
      const healthBody = (await health.json()) as { status: string };
      const readyBody = (await ready.json()) as { ready: boolean };
      expect(healthBody.status).toBe('ok');
      expect(readyBody.ready).toBe(true);
    });
  });

  it('08 /readyz 响应不含连接串/凭据/堆栈', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/readyz`);
      const text = await res.text();
      for (const forbidden of ['postgresql://', 'password', 'stack', 'prisma']) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    });
  });
});

/**
 * RC-20261008-LINUX-DEPLOY-PREP 修复回归：
 * 之前 `countLocalMigrations()` 只按「源码布局」拼路径（`__dirname/../../prisma/migrations`）。
 * 编译产物运行在 `dist/src/services/`，该路径解析为 `dist/prisma/migrations`（不存在）→ 返回 -1
 * → `/readyz` 在**编译产物**下恒判 MIGRATION_MISMATCH 并返回 503（源码测试却全绿）。
 * 这两条断言锁定两种布局的路径推导，防止再次回归。
 */
describe('countLocalMigrations 布局解析（RC-20261008 修复）', () => {
  const apiRoot = join(__dirname, '..', '..');
  const srcServices = join(apiRoot, 'src', 'services');
  const distServices = join(apiRoot, 'dist', 'src', 'services');
  const repoMigrations = join(apiRoot, 'prisma', 'migrations');
  const distMigrations = join(apiRoot, 'dist', 'prisma', 'migrations');

  it('09 源码布局：候选首位命中 prisma/migrations，计数 > 0', () => {
    const candidates = migrationDirCandidates(srcServices);
    expect(candidates[0]).toBe(repoMigrations);
    expect(resolveMigrationsDir(srcServices)).toBe(repoMigrations);
    expect(countLocalMigrations(resolveMigrationsDir(srcServices) ?? '')).toBeGreaterThan(0);
  });

  it('10 编译布局：首位（dist/prisma/migrations）不存在，第二候选命中仓库 prisma/migrations', () => {
    const candidates = migrationDirCandidates(distServices);
    expect(candidates[0]).toBe(distMigrations);
    expect(candidates[1]).toBe(repoMigrations);
    expect(resolveMigrationsDir(distServices)).toBe(repoMigrations);
    expect(countLocalMigrations(resolveMigrationsDir(distServices) ?? '')).toBeGreaterThan(0);
  });

  it('11 编译布局下不会再退化成 -1（防止 /readyz 恒判 MIGRATION_MISMATCH）', () => {
    const resolved = resolveMigrationsDir(distServices);
    expect(resolved).not.toBeNull();
    expect(countLocalMigrations()).toBeGreaterThan(0);
    expect(countLocalMigrations()).toBe(migrationCountOf(resolved ?? ''));
  });
});

function migrationCountOf(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}
