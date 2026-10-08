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

/** C4：客户任务必须挂在这个 kind 的 incident 下（服务端写入的可信容器） */
export const CUSTOMER_GOAL_QUEUE_INCIDENT_KIND = 'CUSTOMER_GOAL_QUEUE';

/**
 * C4 授权门禁的拒绝原因码（只回原因码，不回显任何取值）。
 * 拒绝的任务会被**持久化标记为 BLOCKED**，绝不进入执行链。
 */
export const CLAIM_AUTHORIZATION_DENY = {
  UNTRUSTED_INCIDENT_KIND: 'CLAIM_DENY_UNTRUSTED_INCIDENT_KIND',
  ORGANIZATION_UNRESOLVABLE: 'CLAIM_DENY_ORGANIZATION_UNRESOLVABLE',
  ORGANIZATION_NOT_FOUND: 'CLAIM_DENY_ORGANIZATION_NOT_FOUND',
  STANDING_AUTHORIZATION_REVOKED: 'CLAIM_DENY_STANDING_AUTHORIZATION_REVOKED',
} as const;

export type ClaimAuthorizationDeny =
  (typeof CLAIM_AUTHORIZATION_DENY)[keyof typeof CLAIM_AUTHORIZATION_DENY];

export interface ClaimAuthorizationDecision {
  allowed: boolean;
  reason: string;
  organizationId?: string;
}

export interface RsiDurableTaskSource {
  /** 原子领取至多 limit 条已就绪任务；只有 CAS 成功者会被返回。 */
  claim(limit: number): Promise<readonly RsiSafeTask[]>;
  /** 运行中租约恢复：把**已到期**的 ACTIVE 租约标 EXPIRED，并把其任务放回 READY（无需进程重启）。 */
  reclaimExpired(limit: number): Promise<readonly string[]>;
  /**
   * 结果提交（**fenced**）：只有「本 owner 仍持有未过期 ACTIVE 租约」才允许落终态。
   * 旧 worker 在被接管后调用本方法会被拒绝（不覆盖新 owner 的结果）。
   */
  settle(input: {
    taskId: string;
    ownerRef: string;
    outcome: 'COMPLETED' | 'BLOCKED';
  }): Promise<{ applied: boolean; reason: string }>;
  /**
   * C3（CHANGE 3）—— 失败与重试：fenced 记录失败码、attempts+1、按指数退避设置 nextAttemptAt；
   * 达到 maxAttempts ⇒ 死信（DEAD_LETTER + deadLetteredAt）。仍受 owner+未过期租约保护。
   */
  fail(input: {
    taskId: string;
    ownerRef: string;
    errorCode: string;
  }): Promise<{ applied: boolean; reason: string; attempts?: number; deadLettered?: boolean; nextAttemptAt?: string | null }>;
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
  /** C3：退避函数（毫秒）。缺省 = 指数退避（30s * 2^(n-1)，上限 30 分钟）+ 由 taskId 决定的有界抖动 */
  backoffMs?: (attempt: number, taskId: string) => number;
  /**
   * C4：领取前的**授权重解析**开关（默认开启）。
   * 开启时，每个候选任务在执行前都会从**可信持久化事实**重新解析
   * organizationId 与 Standing Authorization；任一项不满足即拒绝并持久化 BLOCK。
   */
  authorizeOnClaim?: boolean;
}): RsiDurableTaskSource {
  const now = (): Date => (input.now ?? (() => new Date()))();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const taskPrefix = input.taskPrefix ?? RECOVERY_QUEUE_TASK_PREFIX;
  const priority = input.priority ?? 'P2';
  const defaultBackoff = (attempt: number, taskId: string): number => {
    const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60 * 1000);
    // 确定性抖动（0–10%）：跨 worker 不产生同一时刻的重试尖峰，同时保持可测
    let h = 0;
    for (let i = 0; i < taskId.length; i += 1) h = (h * 31 + taskId.charCodeAt(i)) % 1000;
    return base + Math.floor((base * (h % 100)) / 1000);
  };
  const backoffMs = input.backoffMs ?? defaultBackoff;

  /**
   * C4（MSG-20261008-16 CHANGE 4）—— 执行前授权重解析（fail-closed）：
   *   1. incident 必须是由服务端写入的 CUSTOMER_GOAL_QUEUE（不信任任何客户端自报容器）；
   *   2. 从 incident.sourceRefs 解析 organizationId，且该 Organization 必须在可信库中真实存在；
   *   3. 对**需要自动执行授权**的任务（ownerGateRequired），必须存在未撤销且未过期的 StandingAuthorization；
   *      已撤销 / 已过期 ⇒ 拒绝（撤销后不得继续执行受控动作）。
   */
  const authorizeClaim = async (task: {
    id: string;
    incidentId: string;
    ownerGateRequired: boolean;
  }, at: Date): Promise<ClaimAuthorizationDecision> => {
    const incident = await input.prisma.autonomyIncident.findUnique({ where: { id: task.incidentId } });
    if (incident === null) {
      return { allowed: false, reason: CLAIM_AUTHORIZATION_DENY.UNTRUSTED_INCIDENT_KIND };
    }
    if (incident.kind !== CUSTOMER_GOAL_QUEUE_INCIDENT_KIND) {
      return { allowed: false, reason: CLAIM_AUTHORIZATION_DENY.UNTRUSTED_INCIDENT_KIND };
    }
    const refs = incident.sourceRefs as unknown;
    const first = Array.isArray(refs) ? (refs[0] as Record<string, unknown> | undefined) : undefined;
    const organizationId = first !== undefined && typeof first.organizationId === 'string' ? first.organizationId : '';
    if (organizationId === '') {
      return { allowed: false, reason: CLAIM_AUTHORIZATION_DENY.ORGANIZATION_UNRESOLVABLE };
    }
    const organization = await input.prisma.organization.findUnique({ where: { id: organizationId } });
    if (organization === null) {
      return { allowed: false, reason: CLAIM_AUTHORIZATION_DENY.ORGANIZATION_NOT_FOUND };
    }
    if (!task.ownerGateRequired) {
      return { allowed: true, reason: 'AUTHORIZED_NO_STANDING_REQUIRED', organizationId };
    }
    const active = await input.prisma.standingAuthorization.count({
      where: {
        organizationId,
        revocationState: 'ACTIVE',
        expiresAt: { gt: at },
        effectiveAt: { lte: at },
      },
    });
    if (active < 1) {
      return { allowed: false, reason: CLAIM_AUTHORIZATION_DENY.STANDING_AUTHORIZATION_REVOKED, organizationId };
    }
    return { allowed: true, reason: 'AUTHORIZED_STANDING_ACTIVE', organizationId };
  };

  return {
    taskPrefix: () => taskPrefix,
    async claim(limit: number): Promise<readonly RsiSafeTask[]> {
      if (!Number.isInteger(limit) || limit <= 0) return [];
      const at = now();
      const candidates = await input.prisma.autonomyTask.findMany({
        where: {
          status: 'READY',
          dedupeKey: { startsWith: taskPrefix },
          // C3：退避门禁 —— 未到 nextAttemptAt 的任务不可被领取（避免无限立即重试）
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: at } }],
        },
        orderBy: [{ createdAt: 'asc' }],
        take: limit,
        select: { id: true, dedupeKey: true, incidentId: true, ownerGateRequired: true },
      });

      const claimed: RsiSafeTask[] = [];
      for (const row of candidates) {
        // C4：执行前授权重解析 —— 拒绝者持久化 BLOCK，且**不**进入本轮领取结果
        if (input.authorizeOnClaim !== false) {
          const decision = await authorizeClaim(row, at);
          if (!decision.allowed) {
            await input.prisma.autonomyTask.updateMany({
              where: { id: row.id, status: 'READY' },
              data: { status: 'BLOCKED', lastErrorCode: decision.reason },
            });
            continue;
          }
        }
        const expiresAt = new Date(at.getTime() + leaseMs);
        /**
         * C1（审计 CHANGE 1）—— claim 与 lease 创建在**同一事务**：
         * 要么「任务 IN_PROGRESS + 租约 ACTIVE」同时成立，要么整体回滚，
         * 杜绝「IN_PROGRESS 但无有效租约」的悬挂任务。
         */
        const won = await input.prisma.$transaction(async (tx) => {
          const cas = await tx.autonomyTask.updateMany({
            where: { id: row.id, status: 'READY' },
            data: { status: 'IN_PROGRESS' },
          });
          if (cas.count !== 1) return false; // 已被其它 worker 领取
          await tx.autonomyLease.upsert({
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
          return true;
        });
        if (won) claimed.push({ id: row.id, priority, dedupeKey: row.dedupeKey });
      }
      return claimed;
    },

    /**
     * C2（审计 CHANGE 2）—— 运行中租约恢复：
     * 对每条**已到期**的 ACTIVE 租约做 CAS（ACTIVE + expiresAt<=now ⇒ EXPIRED），
     * 成功者再把其任务 CAS（IN_PROGRESS ⇒ READY）放回可领取。
     * 两步都在事务内，且都以状态为前置条件 ⇒ 幂等、并发安全、无需重启进程。
     */
    async reclaimExpired(limit: number): Promise<readonly string[]> {
      if (!Number.isInteger(limit) || limit <= 0) return [];
      const at = now();
      const expired = await input.prisma.autonomyLease.findMany({
        where: { status: 'ACTIVE', expiresAt: { lte: at } },
        orderBy: [{ expiresAt: 'asc' }],
        take: limit,
        select: { id: true, taskId: true },
      });
      const requeued: string[] = [];
      for (const lease of expired) {
        const done = await input.prisma.$transaction(async (tx) => {
          const leaseCas = await tx.autonomyLease.updateMany({
            where: { id: lease.id, status: 'ACTIVE', expiresAt: { lte: at } },
            data: { status: 'EXPIRED', renewedAt: at },
          });
          if (leaseCas.count !== 1) return false;
          const taskCas = await tx.autonomyTask.updateMany({
            where: { id: lease.taskId, status: 'IN_PROGRESS' },
            data: { status: 'READY' },
          });
          return taskCas.count === 1;
        });
        if (done) requeued.push(lease.taskId);
      }
      return requeued;
    },

    /**
     * C2 fencing —— 结果提交必须持有「本 owner 的未过期 ACTIVE 租约」：
     * 旧 worker 被接管后（租约已 EXPIRED / 已换 owner）提交会被拒绝，
     * 从而不会覆盖新 owner 的结果，也不会产生重复副作用。
     */
    async settle(request): Promise<{ applied: boolean; reason: string }> {
      const at = now();
      return input.prisma.$transaction(async (tx) => {
        const lease = await tx.autonomyLease.findUnique({ where: { taskId: request.taskId } });
        if (lease === null) return { applied: false, reason: 'LEASE_MISSING' };
        if (lease.status !== 'ACTIVE') return { applied: false, reason: 'LEASE_NOT_ACTIVE' };
        if (lease.ownerRef !== request.ownerRef) return { applied: false, reason: 'FENCED_OWNER_MISMATCH' };
        if (lease.expiresAt.getTime() <= at.getTime()) return { applied: false, reason: 'FENCED_LEASE_EXPIRED' };
        const released = await tx.autonomyLease.updateMany({
          where: { id: lease.id, status: 'ACTIVE', ownerRef: request.ownerRef, expiresAt: { gt: at } },
          data: { status: 'RELEASED', renewedAt: at },
        });
        if (released.count !== 1) return { applied: false, reason: 'FENCED_LEASE_RACE' };
        const taskCas = await tx.autonomyTask.updateMany({
          where: { id: request.taskId, status: 'IN_PROGRESS' },
          /**
           * 终态映射（复用既有 DB 检查约束 AutonomyTask_status_chk 的合法取值：
           * READY / IN_PROGRESS / CANDIDATE_READY / VALIDATED / JUDGED / PROMOTED / REJECTED / BLOCKED）：
           *   成功 → PROMOTED（该词汇表没有 COMPLETED；语义映射已登记为已知限制）
           *   阻断 → BLOCKED
           */
          data: { status: request.outcome === 'COMPLETED' ? 'PROMOTED' : 'BLOCKED' },
        });
        if (taskCas.count !== 1) return { applied: false, reason: 'TASK_STATE_CONFLICT' };
        return { applied: true, reason: 'SETTLED_' + request.outcome };
      });
    },

    async fail(request) {
      const at = now();
      return input.prisma.$transaction(async (tx) => {
        const lease = await tx.autonomyLease.findUnique({ where: { taskId: request.taskId } });
        if (lease === null) return { applied: false, reason: 'LEASE_MISSING' };
        if (lease.status !== 'ACTIVE') return { applied: false, reason: 'LEASE_NOT_ACTIVE' };
        if (lease.ownerRef !== request.ownerRef) return { applied: false, reason: 'FENCED_OWNER_MISMATCH' };
        if (lease.expiresAt.getTime() <= at.getTime()) return { applied: false, reason: 'FENCED_LEASE_EXPIRED' };

        const task = await tx.autonomyTask.findUnique({ where: { id: request.taskId } });
        if (task === null) return { applied: false, reason: 'TASK_MISSING' };
        if (task.status !== 'IN_PROGRESS') return { applied: false, reason: 'TASK_STATE_CONFLICT' };

        const released = await tx.autonomyLease.updateMany({
          where: { id: lease.id, status: 'ACTIVE', ownerRef: request.ownerRef, expiresAt: { gt: at } },
          data: { status: 'RELEASED', renewedAt: at },
        });
        if (released.count !== 1) return { applied: false, reason: 'FENCED_LEASE_RACE' };

        const attempts = task.attempts + 1;
        const deadLettered = attempts >= task.maxAttempts;
        const nextAttemptAt = deadLettered ? null : new Date(at.getTime() + backoffMs(attempts, task.id));
        const updatedTask = await tx.autonomyTask.updateMany({
          where: { id: request.taskId, status: 'IN_PROGRESS' },
          data: {
            attempts,
            lastErrorCode: request.errorCode,
            status: deadLettered ? 'DEAD_LETTER' : 'READY',
            nextAttemptAt,
            deadLetteredAt: deadLettered ? at : null,
          },
        });
        if (updatedTask.count !== 1) return { applied: false, reason: 'TASK_STATE_CONFLICT' };
        return {
          applied: true,
          reason: deadLettered ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED',
          attempts,
          deadLettered,
          nextAttemptAt: nextAttemptAt === null ? null : nextAttemptAt.toISOString(),
        };
      });
    },
  };
}

export const RSI_DURABLE_TASK_SOURCE_BOUNDARY = {
  reusesExistingDurableStore: true,
  store: 'AutonomyTask + AutonomyLease',
  createsSecondQueue: false,
  createsScheduler: false,
  createsRuntime: false,
  atomicClaim: 'CAS(updateMany where status=READY) + lease upsert **同一事务**',
  atomicClaimAndLeaseInOneTransaction: true,
  runningLeaseReclaimWithoutRestart: true,
  resultSubmissionFencedByOwnerAndUnexpiredLease: true,
  retryWithExponentialBackoff: true,
  backoffGateOnClaim: true,
  maxAttemptsEnforcedByDbConstraint: 'AutonomyTask_attempts_chk',
  deadLetterState: 'DEAD_LETTER (+ deadLetteredAt, DB-enforced by AutonomyTask_dead_letter_chk)',
  defaultMaxAttempts: 3,
  leasePerClaim: true,
  crashRecoveryDelegatedTo: 'rsi-restart-reconcile（IN_PROGRESS → READY）',
  readsCredentials: false,
  performsNetworkCalls: false,
  externalWrite: false,
} as const;
