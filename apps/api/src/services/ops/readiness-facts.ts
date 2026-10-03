/**
 * TRACK A / PC-08 REVISE（MSG-20261003-94 CHANGE B/C/D/E/F）— machine-decidable readiness facts.
 * ---------------------------------------------------------------
 * 只读事实投影：迁移状态、必需配置、storage 探针、集成门、payment gate。
 * 严禁：返回 SQL error / 连接串 / 堆栈 / secret / 凭据取值；严禁由 GET 触发任何写操作或 migrate。
 */

import type { PrismaClient } from '@prisma/client';

import { PAYMENT_STATE } from '../entitlements/plan-entitlements';
import { rateLimitPolicyFromEnv, type RateLimitPolicy } from '../ops/rate-limit';

export type MigrationStatus = 'CURRENT' | 'MIGRATION_MISMATCH' | 'UNKNOWN';
export type ConfigStatus = 'READY' | 'BLOCKED';
export type StorageStatus = 'READY' | 'BLOCKED' | 'NOT_CONFIGURED';
export type IntegrationStatus = 'READY' | 'NOT_CONFIGURED' | 'EXTERNAL_GATE';

/** 必需配置 key（**只检查存在性，绝不读取/返回取值**）。 */
export const REQUIRED_CONFIG_KEYS: readonly string[] = ['DATABASE_URL'] as const;

/**
 * 外部集成门（PC-08 CHANGE E）：未配置生产 provider credentials 时**绝不能**是 READY。
 * 这些状态由「是否已获得平台审批 + 是否已写入生产凭据」决定，当前全部 HOLD。
 */
export const EXTERNAL_INTEGRATION_GATES: Record<string, IntegrationStatus> = {
  amazon: 'EXTERNAL_GATE',
  tiktok: 'EXTERNAL_GATE',
  walmart: 'EXTERNAL_GATE',
  carriers: 'EXTERNAL_GATE',
  customs: 'EXTERNAL_GATE',
};

export interface ReadinessFactsInput {
  prisma: PrismaClient;
  /** 期望的已应用迁移数量（调用方从 migrations 目录统计；不可读时传 undefined → UNKNOWN）。 */
  expectedMigrations?: number;
  env?: Record<string, string | undefined>;
  /** 可选 storage 探针（由组合根注入；本模块不直接依赖具体驱动）。 */
  storageProbe?: () => Promise<boolean>;
  rateLimit?: RateLimitPolicy;
}

export interface ReadinessFacts {
  database: { ok: boolean };
  migration: { status: MigrationStatus; applied: number | null; expected: number | null };
  configuration: { status: ConfigStatus; missing: string[] };
  storage: { status: StorageStatus };
  integrations: Record<string, IntegrationStatus>;
  payment: {
    billingModel: 'EXISTS';
    activation: 'HOLD';
    payment: typeof PAYMENT_STATE.payment;
    collection: typeof PAYMENT_STATE.collection;
    activationReason: string;
  };
  rateLimit: { enabled: boolean; windowMs: number; max: number; scope: readonly string[] };
}

export function projectConfiguration(env: Record<string, string | undefined> = process.env): ReadinessFacts['configuration'] {
  const missing = REQUIRED_CONFIG_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.trim() === '';
  });
  return { status: missing.length === 0 ? 'READY' : 'BLOCKED', missing };
}

async function projectMigration(
  prisma: PrismaClient,
  expectedMigrations: number | undefined,
): Promise<ReadinessFacts['migration']> {
  let applied: number | null = null;
  try {
    const rows = await prisma.$queryRaw<Array<{ count: bigint | number }>>`
      SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    `;
    const value = rows[0]?.count;
    applied = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : null;
  } catch {
    // 迁移表不可读（例如未初始化）→ UNKNOWN（不猜测）
    return { status: 'UNKNOWN', applied: null, expected: expectedMigrations ?? null };
  }
  if (applied === null || expectedMigrations === undefined) {
    return { status: 'UNKNOWN', applied, expected: expectedMigrations ?? null };
  }
  return {
    status: applied === expectedMigrations ? 'CURRENT' : 'MIGRATION_MISMATCH',
    applied,
    expected: expectedMigrations,
  };
}

export async function projectReadinessFacts(input: ReadinessFactsInput): Promise<ReadinessFacts> {
  const env = input.env ?? process.env;
  const policy = input.rateLimit ?? rateLimitPolicyFromEnv(env);

  let databaseOk = true;
  try {
    await input.prisma.$queryRaw`SELECT 1`;
  } catch {
    databaseOk = false;
  }

  const migration = await projectMigration(input.prisma, input.expectedMigrations);
  const configuration = projectConfiguration(env);

  let storage: ReadinessFacts['storage'];
  if (!input.storageProbe) {
    storage = { status: 'NOT_CONFIGURED' };
  } else {
    try {
      storage = { status: (await input.storageProbe()) ? 'READY' : 'BLOCKED' };
    } catch {
      storage = { status: 'BLOCKED' };
    }
  }

  return {
    database: { ok: databaseOk },
    migration,
    configuration,
    storage,
    integrations: { ...EXTERNAL_INTEGRATION_GATES },
    payment: {
      billingModel: 'EXISTS',
      activation: 'HOLD',
      payment: PAYMENT_STATE.payment,
      collection: PAYMENT_STATE.collection,
      activationReason: 'PAYMENT_NOT_ENABLED',
    },
    rateLimit: {
      enabled: policy.enabled,
      windowMs: policy.windowMs,
      max: policy.max,
      scope: policy.scope,
    },
  };
}
