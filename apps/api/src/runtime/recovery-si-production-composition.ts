/**
 * PHASE 2 / C5 —— Recovery SI 的**生产组装根**（关闭 P0-B）
 * ---------------------------------------------------------------
 * 目标：让生产启动入口（`dist/src/runtime/rsi-run.js`）真正装配 Recovery SI pack，
 * 使 `task:recovery:*` 进入**既有** ONE SI Runtime 的真实业务执行链，而不是恒 `BLOCK`。
 *
 * 硬约束（沿用既有裁决，不新增任何运行时）：
 *   · 唯一组装点 `createProductRecoverySiPack()` —— 只接受 `AppActionGuardDeps`，
 *     内部唯一调用 `createAppActionGuard()`；**禁止**注入自定义 guard port（SECOND_GUARD_IMPLEMENTATION = FORBIDDEN）；
 *   · 读工具复用既有 `createPrismaRecoveryReadPorts()`（租户绑定 + 权限判定 fail-closed）；
 *   · `organizationId` **不硬编码**：由 durable 任务源在 claim 时从可信事实（task→incident.sourceRefs）解析并随任务携带；
 *     缺失即 `bind` 返回 null ⇒ pack 侧 `RECOVERY_PACK_UNBOUND_TASK`（fail-closed，绝不猜测租户）；
 *   · 只做只读检查与证据/机会读取；不产生外部写、支付、报关、运输。
 */

import type { PrismaClient } from '@prisma/client';

import { loadScanScopeForClaimedTask } from '../services/historical-scan/scan-scope-loader';
import { createPrismaRecoveryReadPorts } from '../services/intelligence/recovery-read-tool-adapters';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';
import type { AppActionGuardDeps } from '../services/action-guard/runtime-guard-composition';
import type { RecoverySiPackDependencies, RecoverySiTaskBinding } from './recovery-si-pack';

/** 与既有 recovery read 适配器一致的角色口径（权限判定仍由既有服务执行，缺权限即拒绝） */
export const RECOVERY_SI_PRODUCTION_READ_ROLE = 'OWNER';

/** 受审的 recovery 任务命名空间（与 Goal/Runtime 绑定一致） */
const RECOVERY_TASK_RE = /^task:recovery:([A-Z_]+):(.+)$/;

/**
 * Goal 域 → RecoveryDomain **显式映射**（两套词表不同：Goal 用 LOGISTICS，Recovery 用 CARRIER）。
 * 未列出的 token 一律 unbound（fail-closed），绝不猜测。
 */
const GOAL_DOMAIN_TO_RECOVERY_DOMAIN: Record<string, 'PLATFORM' | 'CARRIER' | 'CUSTOMS' | 'INDEPENDENT_SITE'> = {
  PLATFORM: 'PLATFORM',
  LOGISTICS: 'CARRIER',
  CUSTOMS: 'CUSTOMS',
  INDEPENDENT_SITE: 'INDEPENDENT_SITE',
};

/**
 * 生产组装根：返回 `composeRsiRuntime` 所需的 `productRecoveryPack` **依赖形状**
 * （pack 本体由唯一组装点 `createProductRecoverySiPack()` 在组合根内部创建，调用方不得自行组装 guard）。
 */
export function createProductionRecoveryPackDeps(input: {
  prisma: PrismaClient;
  role?: string;
}): {
  appActionGuardDeps: AppActionGuardDeps;
  readPorts: RecoveryReadPorts;
  /** 参数取 compose 组合根使用的**较宽**形状（priority: string + 可选 organizationId） */
  bind: (task: {
    id: string;
    dedupeKey: string;
    priority: string;
    organizationId?: string;
  }) => RecoverySiTaskBinding | null;
  scanScope: NonNullable<RecoverySiPackDependencies['scanScope']>;
} {
  const role = input.role ?? RECOVERY_SI_PRODUCTION_READ_ROLE;

  /**
   * 读端口按**调用输入**绑定 actor（tenant-bound）：每次调用用该次 input.organizationId 构造 adapter，
   * 从而既保持 adapter 的租户 fail-closed 语义，又允许一个 runtime 服务多个租户的任务。
   */
  const readPorts: RecoveryReadPorts = {
    async opportunityRead(i) {
      return createPrismaRecoveryReadPorts(input.prisma, { organizationId: i.organizationId, role }).opportunityRead(i);
    },
    async evidenceRead(i) {
      return createPrismaRecoveryReadPorts(input.prisma, { organizationId: i.organizationId, role }).evidenceRead(i);
    },
    async customsAuthorizationReadinessRead(i) {
      return createPrismaRecoveryReadPorts(input.prisma, { organizationId: i.organizationId, role }).customsAuthorizationReadinessRead(i);
    },
  };

  return {
    // 共享 guard：只给构造依赖（prisma），不注入 guard 实例 / 自定义 port
    appActionGuardDeps: { prisma: input.prisma },
    readPorts,
    bind: (task) => {
      // 租户必须来自 claim 时的可信解析；缺失 ⇒ 拒绝绑定（fail-closed，绝不猜）
      const organizationId = task.organizationId;
      if (typeof organizationId !== 'string' || organizationId === '') return null;
      const match = RECOVERY_TASK_RE.exec(task.dedupeKey);
      if (match === null) return null;
      const domain = GOAL_DOMAIN_TO_RECOVERY_DOMAIN[match[1]!];
      if (domain === undefined) return null; // 未知域 ⇒ 不绑定（fail-closed）
      return {
        organizationId,
        domain: domain as never,
        actionKind: 'EXECUTE_READ_ONLY_CHECK' as never,
        opportunityRef: match[2]!,
      };
    },
    scanScope: {
      async load(ref: { organizationId: string; dedupeKey: string }) {
        const loaded = await loadScanScopeForClaimedTask(input.prisma, {
          organizationId: ref.organizationId,
          dedupeKey: ref.dedupeKey,
        });
        return { ok: loaded.ok, reasonCodes: loaded.reasonCodes };
      },
    },
  };
}

export const RECOVERY_SI_PRODUCTION_COMPOSITION_BOUNDARY = {
  uniqueAssemblyPoint: 'createProductRecoverySiPack（内部唯一 createAppActionGuard）',
  secondGuardImplementation: 'FORBIDDEN',
  callerSuppliedGuardPort: 'FORBIDDEN',
  createsRuntime: false,
  createsScheduler: false,
  createsController: false,
  readPortsOwner: 'services/intelligence/recovery-read-tool-adapters.createPrismaRecoveryReadPorts',
  tenantSource: 'durable claim（task→incident.sourceRefs 可信解析），缺失即 fail-closed',
  hardcodedOrganizationId: false,
  externalWrite: false,
  payment: false,
  transport: false,
  customsFiling: false,
} as const;
