/**
 * PHASE 1 —— 客户 Goal 的 **durable** 任务队列端口（PostgreSQL）
 * ---------------------------------------------------------------
 * 替换 `createJsonTaskQueuePort`（JSON 读-改-写：并发丢任务、运行中实例不消费、无租户字段）。
 *
 * 复用**既有** durable 结构，不新增第二套队列：
 *   · `AutonomyIncident`（kind = CUSTOMER_GOAL_QUEUE）作为每个租户的队列锚点（FK 需要）；
 *   · `AutonomyTask`（dedupeKey **全局唯一**）作为持久化任务行，状态机复用既有 READY / IN_PROGRESS；
 *   · `AutonomyLease` 由 `createAutonomyTaskSource` 在领取时写入（本端口不碰租约）。
 *
 * 关键性质：
 *   · **幂等**：`createMany({ skipDuplicates: true })` + dedupeKey 唯一 ⇒ 同一 Goal 重复提交不产生重复任务；
 *   · **不丢任务**：数据库事务语义，取代 JSON 读-改-写；
 *   · **租户可信**：incident 的 `sourceRefs` 固化 `{ organizationId }`，不接受客户端自报字段；
 *   · **入队 ≠ 执行**：本端口只落库 READY 任务，执行由既有 ONE SI Runtime 的 claim + lease 决定。
 *
 * 已知限制（登记在 checkpoint，需后续 Schema Delta）：`AutonomyTask` 无 priority / attempts /
 * nextAttemptAt / lastError 列，因此本轮优先级固定 P2、重试与死信状态只能借用既有 status 字符串。
 */

import type { PrismaClient } from '@prisma/client';

import type { GoalTaskQueuePort } from './goal-runtime-binding';

export const CUSTOMER_GOAL_QUEUE_INCIDENT_KIND = 'CUSTOMER_GOAL_QUEUE';

export function createPrismaTaskQueuePort(input: {
  prisma: PrismaClient;
  now?: () => Date;
}): GoalTaskQueuePort {
  const now = (): Date => (input.now ?? (() => new Date()))();

  return {
    async admit({ organizationId, tasks }) {
      const at = now();
      const incidentDedupeKey = `customer-goal-queue:${organizationId}`;
      const incident = await input.prisma.autonomyIncident.upsert({
        where: { dedupeKey: incidentDedupeKey },
        create: {
          kind: CUSTOMER_GOAL_QUEUE_INCIDENT_KIND,
          dedupeKey: incidentDedupeKey,
          status: 'OPEN',
          riskClass: 'LOW',
          sourceRefs: [{ organizationId }],
          detectedAt: at,
        },
        update: {},
      });

      const admitted: string[] = [];
      const alreadyPresent: string[] = [];
      for (const task of tasks) {
        const created = await input.prisma.autonomyTask.createMany({
          data: [
            {
              incidentId: incident.id,
              status: 'READY',
              riskClass: 'LOW',
              ownerGateRequired: task.requiresStandingAuthorizationForAutoExecution === true,
              dedupeKey: task.dedupeKey,
            },
          ],
          skipDuplicates: true,
        });
        if (created.count === 1) admitted.push(task.dedupeKey);
        else alreadyPresent.push(task.dedupeKey);
      }
      return { admitted, alreadyPresent };
    },
  };
}

export const PRISMA_TASK_QUEUE_PORT_BOUNDARY = {
  durable: true,
  store: 'AutonomyIncident + AutonomyTask',
  idempotentByDedupeKey: true,
  lostUpdateImpossible: true,
  tenantFromServer: true,
  clientReportedScopeIgnored: true,
  admissionIsNotExecution: true,
  createsSecondQueue: false,
  createsRuntime: false,
  knownLimitations: [
    'no priority column on AutonomyTask (fixed P2 for now)',
    'no attempts / nextAttemptAt / lastError columns (retry bookkeeping pending Schema Delta)',
  ],
} as const;
