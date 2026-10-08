/**
 * PHASE 1（SI/RSI 客户自治执行）—— 权威 durable 任务源
 * ---------------------------------------------------------------
 * 复用仓库**既有**的 durable 结构，不新增第二套队列 / 运行时 / 调度器：
 *   · `AutonomyTask`（`dedupeKey` 全局唯一、`status`）＝ 持久化任务行；
 *   · `AutonomyLease`（`taskId` 唯一、`ownerRef` / `expiresAt` / `status`）＝ 领取租约；
 *   · 既有 `rsi-restart-reconcile`（reboot reconcile）会把中断在 IN_PROGRESS 的任务放回 READY ⇒ 崩溃恢复。
 *
 * 领取语义（多 worker 安全，无重复执行）：
 *   1. 选出 READY 候选（按 createdAt 升序，保证公平与顺序）；
 *   2. 对每条做**条件更新** CAS：`updateMany({ where: { id, status: 'READY' }, data: { status: 'IN_PROGRESS' } })`
 *      —— 只有 count === 1 的 worker 才算真正领取成功（其余 worker 自动放弃，不产生重复副作用）；
 *   3. 领取成功后写入 / 续写该任务的 ACTIVE 租约（ownerRef + expiresAt）。
 *
 * 边界：不新建 scheduler / event loop / controller；本模块只提供 `claim(limit)`，
 * 由**既有**事件循环的 60s 兜底 tick 调用（见 `rsi-run.ts` 的 `taskSource`）。
 */

import type { PrismaClient } from '@prisma/client';

import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

/** 客户 Recovery 任务的既有保留命名空间（与 Goal 计划一致） */
export const RECOVERY_QUEUE_TASK_PREFIX = 'task:recovery:';

export interface RsiDurableTaskSource {
  /** 原子领取至多 limit 条已就绪任务；只有 CAS 成功者会被返回。 */
  claim(limit: number): Promise<readonly RsiSafeTask[]>;
  /** 该任务源使用的命名空间（可观测 / 断言用） */
  taskPrefix(): string;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export function createAutonomyTaskSource(input: {
  prisma: PrismaClient;
  ownerRef: string;
  now?: () => Date;
  leaseMs?: number;
  taskPrefix?: string;
  /** 缺省 P2：`AutonomyTask` 目前没有 priority 列（已知限制，登记在 checkpoint） */
  priority?: RsiSafeTask['priority'];
}): RsiDurableTaskSource {
  const now = (): Date => (input.now ?? (() => new Date()))();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const taskPrefix = input.taskPrefix ?? RECOVERY_QUEUE_TASK_PREFIX;
  const priority = input.priority ?? 'P2';

  return {
    taskPrefix: () => taskPrefix,
    async claim(limit: number): Promise<readonly RsiSafeTask[]> {
      if (!Number.isInteger(limit) || limit <= 0) return [];
      const at = now();
      const candidates = await input.prisma.autonomyTask.findMany({
        where: { status: 'READY', dedupeKey: { startsWith: taskPrefix } },
        orderBy: [{ createdAt: 'asc' }],
        take: limit,
        select: { id: true, dedupeKey: true },
      });

      const claimed: RsiSafeTask[] = [];
      for (const row of candidates) {
        const cas = await input.prisma.autonomyTask.updateMany({
          where: { id: row.id, status: 'READY' },
          data: { status: 'IN_PROGRESS' },
        });
        if (cas.count !== 1) continue; // 已被其它 worker 领取
        const expiresAt = new Date(at.getTime() + leaseMs);
        await input.prisma.autonomyLease.upsert({
          where: { taskId: row.id },
          create: {
            taskId: row.id,
            ownerRef: input.ownerRef,
            acquiredAt: at,
            renewedAt: at,
            expiresAt,
            status: 'ACTIVE',
          },
          update: {
            ownerRef: input.ownerRef,
            acquiredAt: at,
            renewedAt: at,
            expiresAt,
            status: 'ACTIVE',
          },
        });
        claimed.push({ id: row.id, priority, dedupeKey: row.dedupeKey });
      }
      return claimed;
    },
  };
}

export const RSI_DURABLE_TASK_SOURCE_BOUNDARY = {
  reusesExistingDurableStore: true,
  store: 'AutonomyTask + AutonomyLease',
  createsSecondQueue: false,
  createsScheduler: false,
  createsRuntime: false,
  atomicClaim: 'CAS(updateMany where status=READY)',
  leasePerClaim: true,
  crashRecoveryDelegatedTo: 'rsi-restart-reconcile（IN_PROGRESS → READY）',
  readsCredentials: false,
  performsNetworkCalls: false,
  externalWrite: false,
} as const;
