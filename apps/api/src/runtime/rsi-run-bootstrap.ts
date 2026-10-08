/**
 * RSI run 启动装配 —— durable reconcile 接线 / 进程身份
 * ---------------------------------------------------------------
 * 解决的问题（AUDIT-RC-1 CHANGE 3，MSG-20261008-14）：
 *   生产入口此前从不传 `reconcile.store`，启动日志恒为 `RSI_RECONCILE=NOT_CONFIGURED`，
 *   于是「重启后租约收敛 / 去重 / exactly-once」在部署形态下不生效。
 *
 * 本模块只做**决策**与**装配**，不新增任何运行时：
 *   · 不新建 scheduler / controller / runner；复用既有 ONE SI Runtime 与既有
 *     `createPrismaRsiReconcileStore()`；
 *   · 决策是纯函数（可无 DB 单测）；唯一副作用（动态 import PrismaClient）只在 PRISMA 分支发生；
 *   · fail-closed：`RSI_RECONCILE_REQUIRED=true` 且缺 `DATABASE_URL` ⇒ 调用方必须拒绝启动，
 *     绝不静默退化成 `NOT_CONFIGURED`，也绝不用内存队列冒充持久化。
 */

import type { RsiReconcileStore } from './rsi-restart-reconcile';
import type { RsiDurableTaskSource } from './rsi-durable-task-source';

export type RsiReconcileBootstrapKind = 'PRISMA' | 'NOT_CONFIGURED' | 'REQUIRED_BUT_MISSING_DATABASE_URL';

export interface RsiReconcileBootstrapDecision {
  kind: RsiReconcileBootstrapKind;
  /** durable 执行身份：写入 / 收敛租约时使用，必须是全局唯一且进程生命周期内稳定 */
  ownerRef: string;
  trigger: 'BOOT';
  /** 只进日志与断言的原因码；不含任何取值 */
  reason: string;
}

const nonEmpty = (value: string | undefined): boolean => (value ?? '').trim() !== '';

/**
 * 纯决策：给定环境与默认身份，决定 reconcile 的装配方式。
 * 优先级：显式 `RSI_RUNTIME_OWNER_REF` > 进程默认身份；`DATABASE_URL` 存在即接线。
 */
export function planReconcileBootstrap(
  env: Record<string, string | undefined>,
  deps: { defaultOwnerRef: string },
): RsiReconcileBootstrapDecision {
  const ownerRef = nonEmpty(env.RSI_RUNTIME_OWNER_REF)
    ? (env.RSI_RUNTIME_OWNER_REF as string).trim()
    : deps.defaultOwnerRef;

  if (nonEmpty(env.DATABASE_URL)) {
    return { kind: 'PRISMA', ownerRef, trigger: 'BOOT', reason: 'DATABASE_URL_PRESENT' };
  }
  if ((env.RSI_RECONCILE_REQUIRED ?? '').trim().toLowerCase() === 'true') {
    return {
      kind: 'REQUIRED_BUT_MISSING_DATABASE_URL',
      ownerRef,
      trigger: 'BOOT',
      reason: 'RSI_RECONCILE_REQUIRED_WITHOUT_DATABASE_URL',
    };
  }
  return { kind: 'NOT_CONFIGURED', ownerRef, trigger: 'BOOT', reason: 'NO_DATABASE_URL_AND_NOT_REQUIRED' };
}

export interface OpenedRsiReconcile {
  spec: { store: RsiReconcileStore; ownerRef: string; trigger: 'BOOT' };
  /**
   * PHASE 1：与 reconcile 共用**同一个** PrismaClient 的 durable 任务源。
   * 运行中的实例靠它领取新任务（无需重启），且与 API 使用**同一**持久化源。
   */
  taskSource: RsiDurableTaskSource;
  disconnect: () => Promise<void>;
}

/**
 * 打开真实 Prisma reconcile store（唯一副作用点）。
 * 动态 import：只有确实要接线时才加载 @prisma/client，骨架运行不会被牵连。
 */
export async function openPrismaReconcile(ownerRef: string): Promise<OpenedRsiReconcile> {
  const [{ PrismaClient }, { createPrismaRsiReconcileStore }, { createAutonomyTaskSource }] = await Promise.all([
    import('@prisma/client'),
    import('./rsi-reconcile-prisma-store'),
    import('./rsi-durable-task-source'),
  ]);
  const prisma = new PrismaClient();
  return {
    spec: { store: createPrismaRsiReconcileStore(prisma), ownerRef, trigger: 'BOOT' },
    taskSource: createAutonomyTaskSource({ prisma, ownerRef }),
    disconnect: async () => {
      await prisma.$disconnect();
    },
  };
}

export const RSI_RUN_BOOTSTRAP_BOUNDARY = {
  createsScheduler: false,
  createsController: false,
  createsRunner: false,
  reusesExistingSiRuntime: true,
  reusesExistingReconcileStore: 'createPrismaRsiReconcileStore',
  createsSecondReconcileStore: false,
  inMemoryQueueAsFallback: false,
  failClosedWhenRequired: true,
  readsCredentials: false,
  performsNetworkCalls: false,
  externalWrite: false,
  payment: false,
  transport: false,
} as const;
