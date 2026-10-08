/**
 * Readiness（MSG-20260929-70 D1）
 * ---------------------------------------------------------------
 * 语义边界：
 *   /health  = liveness（进程活着）—— resolver 降级不代表服务 down
 *   /readyz  = readiness（是否接收业务流量）：DB 可用 + migration 完整 + resolver 可解析
 *
 * 安全要求（架构方裁决）：
 *   - READY=false 时**只**返回原因码：DATABASE_UNAVAILABLE / MIGRATION_MISMATCH /
 *     KILL_SWITCH_RESOLVER_FAIL_CLOSED
 *   - 禁止返回 SQL 错误、连接串、堆栈、secret 信息（连错误消息都不透出）
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

export const READINESS_REASONS = [
  'DATABASE_UNAVAILABLE',
  'MIGRATION_MISMATCH',
  'KILL_SWITCH_RESOLVER_FAIL_CLOSED',
] as const;
export type ReadinessReason = (typeof READINESS_REASONS)[number];

export interface ReadinessResult {
  ready: boolean;
  reasons: ReadinessReason[];
  checkedAt: string;
  version: string;
}

export interface ReadinessDeps {
  /** DB 可达性探针（抛错即视为不可用）；实现方不得把错误消息带出本模块 */
  databaseProbe: () => Promise<void>;
  /** 已应用迁移数（_prisma_migrations 中 finished_at 非空的行数） */
  appliedMigrations: () => Promise<number>;
  /** 期望迁移数（仓库中 migrations 目录数） */
  expectedMigrations: number;
  /** resolver 是否可完成一次解析（false/抛错 → fail closed） */
  resolverProbe?: () => Promise<boolean>;
  version: string;
  now?: () => Date;
}

/**
 * 只读统计仓库中的迁移目录数（与服务端 schema 同源）。
 *
 * 两种布局都必须正确（否则编译产物会恒判 MIGRATION_MISMATCH）：
 *   · 源码布局  `src/services/readiness.ts`        → `../../prisma/migrations`
 *   · 编译布局  `dist/src/services/readiness.js`   → `../../../prisma/migrations`
 * （tsconfig 的 include 只含 `src/**`，`prisma/` 不会进 dist，因此必须向上多找一层。）
 */
export function migrationDirCandidates(here: string = __dirname): string[] {
  return [
    path.join(here, '..', '..', 'prisma', 'migrations'),
    path.join(here, '..', '..', '..', 'prisma', 'migrations'),
  ];
}

/** 在两种构建布局中择优解析真实迁移目录；全部不可用 → null（调用方据此 fail-closed）。 */
export function resolveMigrationsDir(here: string = __dirname): string | null {
  for (const candidate of migrationDirCandidates(here)) {
    try {
      if (readdirSync(candidate, { withFileTypes: true }).some((entry) => entry.isDirectory())) {
        return candidate;
      }
    } catch {
      // 尝试下一个候选位置
    }
  }
  return null;
}

/** 只读统计迁移目录数。`dir` 为显式迁移目录（保持既有语义）；缺省则自动解析构建布局。 */
export function countLocalMigrations(dir?: string): number {
  const target = dir === undefined ? resolveMigrationsDir() : dir;
  if (target === null) return -1;
  try {
    return readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return -1;
  }
}

export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  const now = deps.now ? deps.now() : new Date();
  const reasons: ReadinessReason[] = [];

  let databaseOk = true;
  try {
    await deps.databaseProbe();
  } catch {
    databaseOk = false;
    reasons.push('DATABASE_UNAVAILABLE');
  }

  if (databaseOk) {
    try {
      const applied = await deps.appliedMigrations();
      if (deps.expectedMigrations < 0 || applied !== deps.expectedMigrations) {
        reasons.push('MIGRATION_MISMATCH');
      }
    } catch {
      reasons.push('MIGRATION_MISMATCH');
    }

    if (deps.resolverProbe) {
      try {
        const ok = await deps.resolverProbe();
        if (!ok) reasons.push('KILL_SWITCH_RESOLVER_FAIL_CLOSED');
      } catch {
        reasons.push('KILL_SWITCH_RESOLVER_FAIL_CLOSED');
      }
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    checkedAt: now.toISOString(),
    version: deps.version,
  };
}

/** readiness 不通过 → 503（部署层据此摘流） */
export function readinessHttpStatus(result: ReadinessResult): number {
  return result.ready ? 200 : 503;
}
