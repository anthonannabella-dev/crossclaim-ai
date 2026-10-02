/**
 * TRACK A / PC-08 — Ops readiness projection（MSG-20261003-93 PC-08）.
 * ---------------------------------------------------------------
 * 只读运维视图：把「系统是否具备上线前的运维可靠性」所需的**只读**事实集中暴露：
 *   · liveness / readiness（数据库连通性；kill switch resolver 探针）
 *   · Action Guard / kill switch 状态可见（不改变任何开关）
 *   · 失败任务 / 待人工处理积压（真实计数，不猜）
 *   · rate limit 基线策略（可见，不含任何 secret）
 *   · transport 状态（PC-08 明确不打开：恒为 DISABLED）
 *
 * 严禁：写操作、任何外写、任何秘密值、任何跨租户数据。
 */

import type { PrismaClient } from '@prisma/client';

import { rateLimitPolicyFromEnv, type RateLimitPolicy } from '../ops/rate-limit';
import { projectReadinessFacts, type ReadinessFacts } from '../ops/readiness-facts';

export interface OpsReadinessDeps {
  prisma: PrismaClient;
  /** kill switch resolver 只读探针（与 /health 同一实现）。 */
  killSwitchProbe: () => Promise<boolean>;
  /** Action Guard 是否已装配（缺省装配为 READ_ONLY 姿态）。 */
  actionGuardConfigured: boolean;
  rateLimit?: RateLimitPolicy;
  /** 期望的已应用迁移数量（组合根统计；不可读时省略 → UNKNOWN）。 */
  expectedMigrations?: number;
  /** storage 探针（组合根注入；缺省 → NOT_CONFIGURED）。 */
  storageProbe?: () => Promise<boolean>;
  now?: () => Date;
}

export interface OpsReadiness {
  liveness: 'UP';
  readiness: { ready: boolean; checks: { database: 'UP' | 'DOWN' } };
  killSwitch: { resolverReachable: boolean; posture: 'READ_ONLY_DEFAULT' | 'CONFIGURED' };
  actionGuard: { configured: boolean; posture: 'READ_ONLY_DEFAULT' | 'ENFORCING' };
  failedJobs: {
    importFailed: number;
    importPartial: number;
    claimItemReviewRequired: number;
    /** 平台写入账本（DEAD_LETTER 等）在本视图只给引用，不在 PC-08 内暴露明细。 */
    platformWriteLedgerRef: string;
  };
  rateLimit: { enabled: boolean; windowMs: number; max: number; scope: readonly string[] };
  transport: 'DISABLED';
  /** PC-08 CHANGE B/C/D/E/F：机器可判定的 readiness facts。 */
  facts: ReadinessFacts;
  runbookRef: string;
  checkedAt: string;
}

export async function getOpsReadiness(deps: OpsReadinessDeps): Promise<OpsReadiness> {
  const at = (deps.now ?? (() => new Date()))();
  const policy = deps.rateLimit ?? rateLimitPolicyFromEnv();

  let databaseUp = true;
  try {
    await deps.prisma.$queryRaw`SELECT 1`;
  } catch {
    databaseUp = false;
  }

  let resolverReachable = false;
  try {
    resolverReachable = await deps.killSwitchProbe();
  } catch {
    resolverReachable = false;
  }

  const [importFailed, importPartial, claimItemReviewRequired] = databaseUp
    ? await Promise.all([
        deps.prisma.importBatch.count({ where: { status: 'FAILED' } }),
        deps.prisma.importBatch.count({ where: { status: 'PARTIAL' } }),
        deps.prisma.claimItem.count({ where: { status: 'REVIEW_REQUIRED' } }),
      ])
    : [0, 0, 0];

  const facts = await projectReadinessFacts({
    prisma: deps.prisma,
    ...(deps.expectedMigrations === undefined ? {} : { expectedMigrations: deps.expectedMigrations }),
    ...(deps.storageProbe ? { storageProbe: deps.storageProbe } : {}),
    rateLimit: policy,
  });

  return {
    liveness: 'UP',
    readiness: { ready: databaseUp, checks: { database: databaseUp ? 'UP' : 'DOWN' } },
    killSwitch: {
      resolverReachable,
      posture: resolverReachable ? 'CONFIGURED' : 'READ_ONLY_DEFAULT',
    },
    actionGuard: {
      configured: deps.actionGuardConfigured,
      posture: deps.actionGuardConfigured ? 'ENFORCING' : 'READ_ONLY_DEFAULT',
    },
    failedJobs: {
      importFailed,
      importPartial,
      claimItemReviewRequired,
      platformWriteLedgerRef: 'docs/releases/PLATFORM-WRITE-ATTEMPT-LEDGER-DESIGN.md',
    },
    rateLimit: {
      enabled: policy.enabled,
      windowMs: policy.windowMs,
      max: policy.max,
      scope: policy.scope,
    },
    // PC-08 硬边界：不打开 transport。
    transport: 'DISABLED',
    facts,
    runbookRef: 'docs/releases/PC-08-OPERATIONAL-RUNBOOK.md',
    checkedAt: at.toISOString(),
  };
}
