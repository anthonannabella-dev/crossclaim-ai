/**
 * RSI-RT-06 reconcile 的 Prisma store（真实落库实现）
 * ---------------------------------------------------------------
 * 与内存 store 语义一致：两条写路径都带**状态前置条件**，因此重复执行 = 0 行更新（幂等）。
 *   · expire lease：where { id, status: 'ACTIVE' } → 只有 ACTIVE 才能被标 EXPIRED
 *   · requeue task：where { id, status: 'IN_PROGRESS' } → 只有 IN_PROGRESS 才能回到 READY
 * 只读写状态字段与时间戳，不存 raw / 客户数据 / 凭据。
 */

import type { PrismaClient } from '@prisma/client';

import type { RsiPersistedLease, RsiPersistedTask, RsiReconcileStore } from './rsi-restart-reconcile';

export function createPrismaRsiReconcileStore(prisma: PrismaClient): RsiReconcileStore {
  return {
    async listLeases(): Promise<readonly RsiPersistedLease[]> {
      const rows = await prisma.autonomyLease.findMany({
        select: {
          id: true,
          taskId: true,
          ownerRef: true,
          status: true,
          acquiredAt: true,
          renewedAt: true,
          expiresAt: true,
        },
      });
      return rows.map((row) => ({
        leaseId: row.id,
        taskId: row.taskId,
        ownerRef: row.ownerRef,
        status: row.status as RsiPersistedLease['status'],
        acquiredAt: row.acquiredAt.toISOString(),
        renewedAt: row.renewedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      }));
    },
    async listTasks(): Promise<readonly RsiPersistedTask[]> {
      const rows = await prisma.autonomyTask.findMany({
        select: { id: true, dedupeKey: true, status: true, createdAt: true },
      });
      return rows.map((row) => ({
        taskId: row.id,
        dedupeKey: row.dedupeKey,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      }));
    },
    async markLeaseStatus({ leaseId, status, at }): Promise<void> {
      await prisma.autonomyLease.updateMany({
        where: { id: leaseId, status: 'ACTIVE' },
        data: { status, renewedAt: new Date(at) },
      });
    },
    async requeueTask({ taskId, at }): Promise<void> {
      await prisma.autonomyTask.updateMany({
        where: { id: taskId, status: 'IN_PROGRESS' },
        data: { status: 'READY' },
      });
      void at; // updatedAt 由 Prisma @updatedAt 维护，保持时间单调
    },
  };
}

export const RSI_RECONCILE_PRISMA_STORE_BOUNDARY = {
  guardedUpdatesOnly: true,
  deletesRows: false,
  insertsRows: false,
  storesRawProviderResponse: false,
  storesCustomerData: false,
  holdsProviderCredentials: false,
} as const;
