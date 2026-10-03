/**
 * TRACK A / PC-08 FINAL —— readiness truth 单元回归（MSG-20261003-94 ⑯/⑰）。
 * ---------------------------------------------------------------
 * 覆盖：真实 readiness path 的失败模式（DB 不可用 / migration 不匹配 / resolver fail-closed）、
 * required config readiness、storage 探针三态、integration gate 不得为 READY、payment gate 可见。
 * 纯内存：不依赖 PostgreSQL；只断言稳定 reason code / 枚举，绝不出现原始错误文本或 secret 取值。
 */

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PAYMENT_STATE } from '../services/entitlements/plan-entitlements';
import {
  EXTERNAL_INTEGRATION_GATES,
  projectConfiguration,
  projectReadinessFacts,
  REQUIRED_CONFIG_KEYS,
} from '../services/ops/readiness-facts';
import { getOpsReadiness } from '../services/ops/ops-readiness';
import { checkReadiness, readinessHttpStatus } from '../services/readiness';

const VERSION = 'pc08-final-test';

interface FakePrismaInput {
  select1?: 'ok' | 'throw';
  count?: number | 'throw';
}

/** 最小假 prisma：按 SQL 文本区分 SELECT 1 与 _prisma_migrations 计数；错误文本故意含敏感串以校验不透出。 */
function fakePrisma(input: FakePrismaInput): PrismaClient {
  const queryRaw = async (strings: readonly string[] | string): Promise<Array<Record<string, unknown>>> => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    if (/COUNT/i.test(sql)) {
      if (input.count === 'throw') throw new Error('relation _prisma_migrations does not exist');
      return [{ count: typeof input.count === "number" ? input.count : 0 }];
    }
    if (input.select1 === 'throw') throw new Error('ECONNREFUSED 127.0.0.1:5432 secret=leak');
    return [{ ok: 1 }];
  };
  return { $queryRaw: queryRaw } as unknown as PrismaClient;
}

describe('PC-08 FINAL — real readiness path (checkReadiness)', () => {
  it('DB 不可用 → ready=false / 仅 DATABASE_UNAVAILABLE / 503，不透出原始错误', async () => {
    const result = await checkReadiness({
      databaseProbe: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:5432 secret=leak');
      },
      appliedMigrations: async () => 46,
      expectedMigrations: 46,
      resolverProbe: async () => true,
      version: VERSION,
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(['DATABASE_UNAVAILABLE']);
    expect(readinessHttpStatus(result)).toBe(503);
    const raw = JSON.stringify(result);
    for (const leak of ['ECONNREFUSED', '5432', '127.0.0.1', 'secret=leak']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('migration mismatch → MIGRATION_MISMATCH / 503；migration current → ready / 200', async () => {
    const mismatch = await checkReadiness({
      databaseProbe: async () => undefined,
      appliedMigrations: async () => 45,
      expectedMigrations: 46,
      resolverProbe: async () => true,
      version: VERSION,
    });
    expect(mismatch.ready).toBe(false);
    expect(mismatch.reasons).toEqual(['MIGRATION_MISMATCH']);
    expect(readinessHttpStatus(mismatch)).toBe(503);

    const current = await checkReadiness({
      databaseProbe: async () => undefined,
      appliedMigrations: async () => 46,
      expectedMigrations: 46,
      version: VERSION,
    });
    expect(current.ready).toBe(true);
    expect(current.reasons).toEqual([]);
    expect(readinessHttpStatus(current)).toBe(200);
  });

  it('unknown / 不可读 migration 状态 → fail-closed（expected<0 或抛错 → MIGRATION_MISMATCH）', async () => {
    const unreadable = await checkReadiness({
      databaseProbe: async () => undefined,
      appliedMigrations: async () => {
        throw new Error('permission denied for table _prisma_migrations');
      },
      expectedMigrations: 46,
      version: VERSION,
    });
    expect(unreadable.ready).toBe(false);
    expect(unreadable.reasons).toEqual(['MIGRATION_MISMATCH']);

    const unknown = await checkReadiness({
      databaseProbe: async () => undefined,
      appliedMigrations: async () => 3,
      expectedMigrations: -1,
      version: VERSION,
    });
    expect(unknown.ready).toBe(false);
    expect(unknown.reasons).toEqual(['MIGRATION_MISMATCH']);
  });

  it('kill switch resolver fail-closed → KILL_SWITCH_RESOLVER_FAIL_CLOSED / 503（false 与抛错一致）', async () => {
    const denied = await checkReadiness({
      databaseProbe: async () => undefined,
      appliedMigrations: async () => 46,
      expectedMigrations: 46,
      resolverProbe: async () => false,
      version: VERSION,
    });
    expect(denied.ready).toBe(false);
    expect(denied.reasons).toEqual(['KILL_SWITCH_RESOLVER_FAIL_CLOSED']);
    expect(readinessHttpStatus(denied)).toBe(503);

    const threw = await checkReadiness({
      databaseProbe: async () => undefined,
      appliedMigrations: async () => 46,
      expectedMigrations: 46,
      resolverProbe: async () => {
        throw new Error('resolver unavailable');
      },
      version: VERSION,
    });
    expect(threw.ready).toBe(false);
    expect(threw.reasons).toEqual(['KILL_SWITCH_RESOLVER_FAIL_CLOSED']);
  });
});

describe('PC-08 FINAL — required config readiness', () => {
  it('缺少必需 key → BLOCKED，只回 key 名，不回取值', () => {
    const blocked = projectConfiguration({ DATABASE_URL: '' });
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.missing).toEqual(['DATABASE_URL']);
    for (const key of blocked.missing) expect(REQUIRED_CONFIG_KEYS).toContain(key);

    const ready = projectConfiguration({ DATABASE_URL: 'postgresql://user:placeholder-do-not-leak@db/app' });
    expect(ready).toEqual({ status: 'READY', missing: [] });
    expect(JSON.stringify(ready)).not.toContain('placeholder-do-not-leak');
  });
});

describe('PC-08 FINAL — readiness facts projection', () => {
  it('storage 三态：未注入 NOT_CONFIGURED；ok READY；false / 抛错 BLOCKED（不暴露 key/path）', async () => {
    const notConfigured = await projectReadinessFacts({
      prisma: fakePrisma({ count: 46 }),
      expectedMigrations: 46,
      env: { DATABASE_URL: 'postgresql://x' },
    });
    expect(notConfigured.storage.status).toBe('NOT_CONFIGURED');

    const ok = await projectReadinessFacts({
      prisma: fakePrisma({ count: 46 }),
      expectedMigrations: 46,
      env: { DATABASE_URL: 'postgresql://x' },
      storageProbe: async () => true,
    });
    expect(ok.storage.status).toBe('READY');

    const denied = await projectReadinessFacts({
      prisma: fakePrisma({ count: 46 }),
      expectedMigrations: 46,
      env: { DATABASE_URL: 'postgresql://x' },
      storageProbe: async () => false,
    });
    expect(denied.storage.status).toBe('BLOCKED');

    const threw = await projectReadinessFacts({
      prisma: fakePrisma({ count: 46 }),
      expectedMigrations: 46,
      env: { DATABASE_URL: 'postgresql://x' },
      storageProbe: async () => {
        throw new Error('EACCES /srv/secretpath');
      },
    });
    expect(threw.storage.status).toBe('BLOCKED');
    expect(JSON.stringify(threw.storage)).not.toContain('/srv/secretpath');
  });

  it('migration 投影：CURRENT / MIGRATION_MISMATCH / UNKNOWN（不可读或未知期望值）', async () => {
    const current = await projectReadinessFacts({
      prisma: fakePrisma({ count: 46 }),
      expectedMigrations: 46,
      env: { DATABASE_URL: 'postgresql://x' },
    });
    expect(current.migration).toEqual({ status: 'CURRENT', applied: 46, expected: 46 });

    const mismatch = await projectReadinessFacts({
      prisma: fakePrisma({ count: 45 }),
      expectedMigrations: 46,
      env: { DATABASE_URL: 'postgresql://x' },
    });
    expect(mismatch.migration.status).toBe('MIGRATION_MISMATCH');

    const unreadable = await projectReadinessFacts({
      prisma: fakePrisma({ count: 'throw' }),
      expectedMigrations: 46,
      env: { DATABASE_URL: 'postgresql://x' },
    });
    expect(unreadable.migration.status).toBe('UNKNOWN');
    expect(unreadable.migration.applied).toBeNull();

    const unknownExpected = await projectReadinessFacts({
      prisma: fakePrisma({ count: 46 }),
      env: { DATABASE_URL: 'postgresql://x' },
    });
    expect(unknownExpected.migration.status).toBe('UNKNOWN');
  });

  it('DB 探针失败只标记 database.ok=false（不抛错、不带原始错误）', async () => {
    const facts = await projectReadinessFacts({
      prisma: fakePrisma({ select1: 'throw', count: 46 }),
      expectedMigrations: 46,
      env: { DATABASE_URL: 'postgresql://x' },
    });
    expect(facts.database.ok).toBe(false);
    const raw = JSON.stringify(facts);
    for (const leak of ['ECONNREFUSED', '5432', '127.0.0.1', 'secret=leak', 'password']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('integration gate 不得为 READY；payment gate 可见（ZERO / OFF / HOLD / EXISTS）', async () => {
    const facts = await projectReadinessFacts({
      prisma: fakePrisma({ count: 46 }),
      expectedMigrations: 46,
      env: { DATABASE_URL: 'postgresql://x' },
    });
    for (const platform of ['amazon', 'tiktok', 'walmart', 'carriers', 'customs']) {
      expect(facts.integrations[platform]).toBe('EXTERNAL_GATE');
      expect(facts.integrations[platform]).not.toBe('READY');
    }
    expect(facts.integrations).toEqual(EXTERNAL_INTEGRATION_GATES);
    expect(facts.payment.billingModel).toBe('EXISTS');
    expect(facts.payment.activation).toBe('HOLD');
    expect(facts.payment.payment).toBe(PAYMENT_STATE.payment);
    expect(facts.payment.payment).toBe('ZERO');
    expect(facts.payment.collection).toBe(PAYMENT_STATE.collection);
    expect(facts.payment.collection).toBe('OFF');
  });

  it('required config 缺失 → facts.configuration BLOCKED 且 missing 为安全 key 名（不回取值）', async () => {
    const facts = await projectReadinessFacts({
      prisma: fakePrisma({ count: 46 }),
      expectedMigrations: 46,
      env: {},
    });
    expect(facts.configuration.status).toBe('BLOCKED');
    expect(facts.configuration.missing).toEqual(['DATABASE_URL']);
    expect(JSON.stringify(facts.configuration)).not.toContain('postgresql://');
  });
});

describe('PC-08 FINAL-2 — overall readiness aggregation（MSG-95 ⑨）', () => {
  function fakeOpsPrisma(input: FakePrismaInput): PrismaClient {
    return {
      ...(fakePrisma(input) as unknown as Record<string, unknown>),
      importBatch: { count: async () => 0 },
      claimItem: { count: async () => 0 },
    } as unknown as PrismaClient;
  }

  async function readOps(overrides: {
    select1?: 'ok' | 'throw';
    count?: number | 'throw';
    storageProbe?: () => Promise<boolean>;
    resolverReachable?: boolean;
    actionGuardConfigured?: boolean;
    env?: Record<string, string | undefined>;
  }) {
    return getOpsReadiness({
      prisma: fakeOpsPrisma({
        ...(overrides.select1 ? { select1: overrides.select1 } : {}),
        count: overrides.count ?? 46,
      }),
      killSwitchProbe: async () => overrides.resolverReachable ?? true,
      actionGuardConfigured: overrides.actionGuardConfigured ?? true,
      expectedMigrations: 46,
      ...(overrides.storageProbe ? { storageProbe: overrides.storageProbe } : {}),
      env: overrides.env ?? { DATABASE_URL: "postgresql://x" },
    });
  }

  it('全部关键内部依赖正常 → ready=true / posture=READY', async () => {
    const ops = await readOps({ storageProbe: async () => true });
    expect(ops.readiness.ready).toBe(true);
    expect(ops.readiness.posture).toBe('READY');
    expect(ops.readiness.checks).toEqual({
      database: 'UP',
      migration: 'CURRENT',
      configuration: 'READY',
      storage: 'READY',
      killSwitch: 'UP',
      actionGuard: 'UP',
    });
  });

  it('migration mismatch → ready=false / BLOCKED（不再与 ready=true 并存）', async () => {
    const ops = await readOps({ count: 45, storageProbe: async () => true });
    expect(ops.readiness.ready).toBe(false);
    expect(ops.readiness.posture).toBe('BLOCKED');
    expect(ops.readiness.checks.migration).toBe('MIGRATION_MISMATCH');
  });

  it('config BLOCKED → ready=false / BLOCKED', async () => {
    const ops = await readOps({ storageProbe: async () => true, env: {} });
    expect(ops.facts.configuration.status).toBe('BLOCKED');
    expect(ops.readiness.ready).toBe(false);
    expect(ops.readiness.posture).toBe('BLOCKED');
    expect(ops.readiness.checks.configuration).toBe('BLOCKED');
  });

  it('storage BLOCKED → ready=false / BLOCKED；storage 未注入 → ready=false / DEGRADED', async () => {
    const blocked = await readOps({ storageProbe: async () => false });
    expect(blocked.readiness.ready).toBe(false);
    expect(blocked.readiness.posture).toBe('BLOCKED');
    expect(blocked.readiness.checks.storage).toBe('BLOCKED');

    const notConfigured = await readOps({});
    expect(notConfigured.facts.storage.status).toBe('NOT_CONFIGURED');
    expect(notConfigured.readiness.ready).toBe(false);
    expect(notConfigured.readiness.posture).toBe('DEGRADED');
  });

  it('DB DOWN → ready=false / BLOCKED', async () => {
    const ops = await readOps({ select1: 'throw', storageProbe: async () => true });
    expect(ops.facts.database.ok).toBe(false);
    expect(ops.readiness.ready).toBe(false);
    expect(ops.readiness.posture).toBe('BLOCKED');
    expect(ops.readiness.checks.database).toBe('DOWN');
  });

  it('kill switch resolver fail-closed / Action Guard 缺失 → ready=false / BLOCKED', async () => {
    const resolverDown = await readOps({ storageProbe: async () => true, resolverReachable: false });
    expect(resolverDown.readiness.ready).toBe(false);
    expect(resolverDown.readiness.posture).toBe('BLOCKED');
    expect(resolverDown.readiness.checks.killSwitch).toBe('DOWN');

    const guardMissing = await readOps({ storageProbe: async () => true, actionGuardConfigured: false });
    expect(guardMissing.readiness.ready).toBe(false);
    expect(guardMissing.readiness.posture).toBe('BLOCKED');
    expect(guardMissing.readiness.checks.actionGuard).toBe('DOWN');
  });

  it('provider EXTERNAL_GATE / Payment HOLD / transport DISABLED 不把内部 runtime readiness 拉成 false', async () => {
    const ops = await readOps({ storageProbe: async () => true });
    expect(ops.facts.integrations.amazon).toBe('EXTERNAL_GATE');
    expect(ops.facts.payment.payment).toBe('ZERO');
    expect(ops.facts.payment.activation).toBe('HOLD');
    expect(ops.facts.payment.collection).toBe('OFF');
    expect(ops.transport).toBe('DISABLED');
    expect(ops.readiness.ready).toBe(true);
    expect(ops.readiness.posture).toBe('READY');
  });
});
