/**
 * INTERNAL CODE REPAIR V1 / PHASE 1 —— 故障 Incident 持久化（复用既有 `AutonomyIncident`）
 * ---------------------------------------------------------------
 * 设计要点（与 HOST 指令第四节一致）：
 *   · **不新增表、不新增第二套容器**：直接复用既有 `AutonomyIncident`（`dedupeKey` 全局唯一）；
 *   · 容器 kind 固定为 `INTERNAL_FAULT`，与客户执行面的 `CUSTOMER_GOAL_QUEUE` **严格区分**：
 *     既有 `createAutonomyTaskSource().claim()` 只信任 `CUSTOMER_GOAL_QUEUE` ⇒
 *     修复平面的 Incident **结构上无法授权任何客户业务执行**；
 *   · 同一故障反复发生 ⇒ **聚合到同一行**（`sourceRefs.occurrenceCount` 原子累加），不刷行、不重复建；
 *   · 已 CLOSED / REJECTED 的 Incident **不静默复活**（fail-closed，交回调用方决策）；
 *   · kind 不符（例如别人占用了同一 dedupeKey）⇒ 拒绝写入，绝不劫持他人容器；
 *   · 状态跃迁复用 `rsi-lifecycle` 的合法跃迁表（OPEN → DIAGNOSED）。
 *
 * MSG-20261009-07 / CHANGE 1（P0）—— 首次并发创建的原子性：
 *   旧实现是「先 `findUnique` 再 `create`，冲突后重读再 UPDATE」，两条并发请求可能**同时观察到不存在**
 *   而各自 INSERT（一条必然撞唯一约束），重试预算耗尽时会丢接纳（本次故障未入账）。
 *   新实现把「创建 + 聚合 + 终态保护 + 容器隔离」压进**一条** `INSERT ... ON CONFLICT DO UPDATE ... WHERE`
 *   语句（数据库级原子 upsert）：并发 N 路只会有 1 行，`occurrenceCount` 精确等于 N，
 *   且 `WHERE kind/status` 前置条件保证**永不改坏**他人容器或终态行（0 行返回 ⇒ 只读定位原因）。
 *   判定「本次是否新建」不依赖实现细节：返回行 id 等于本请求预生成的 id ⇒ 我们的 INSERT 胜出。
 *
 * 边界：本模块不领取任务、不写租约、不执行任何客户业务动作。
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { transition } from '../autonomy/rsi-lifecycle';

import {
  buildFaultIncidentIntent,
  INTERNAL_FAULT_INCIDENT_KIND,
  type FaultDiagnosis,
  type FaultObservation,
} from './fault-classification';

export type FaultIncidentIntakeFailureReason =
  /** 同一 dedupeKey 已被**别的 kind** 的容器占用（绝不劫持）。 */
  | 'KIND_MISMATCH'
  /** 既有 Incident 已是终态（CLOSED / REJECTED / TASKED），不静默复活。 */
  | 'INCIDENT_NOT_OPEN'
  /** 状态跃迁不合法（既有契约拒绝）。 */
  | 'ILLEGAL_TRANSITION'
  /** 并发争用下未能收敛（调用方可安全重试）。 */
  | 'CONTENTION';

export interface FaultIncidentIntakeOk {
  ok: true;
  incidentId: string;
  /** true = 本次新建；false = 聚合到既有行。 */
  created: boolean;
  occurrenceCount: number;
  status: string;
  diagnosis: FaultDiagnosis;
}

export interface FaultIncidentIntakeRejected {
  ok: false;
  reason: FaultIncidentIntakeFailureReason;
  incidentId: string | null;
  status: string | null;
}

export type FaultIncidentIntakeResult = FaultIncidentIntakeOk | FaultIncidentIntakeRejected;

export interface FaultIncidentIntake {
  record(observation: FaultObservation): Promise<FaultIncidentIntakeResult>;
}

interface AtomicIncidentRow {
  id: string;
  status: string;
  occurrenceCount: number;
}

const AGGREGATABLE_STATUSES = ['OPEN', 'DIAGNOSED'] as const;
const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * 状态机契约必须允许 `OPEN → DIAGNOSED`（本模块的 upsert 会隐式做这次跃迁）。
 * 契约一旦被改坏，接线时立即 fail-fast，而不是在并发路径上悄悄写坏数据。
 */
const INCIDENT_DIAGNOSIS_TRANSITION = transition('INCIDENT', 'OPEN', 'DIAGNOSED');
if (!INCIDENT_DIAGNOSIS_TRANSITION.ok) {
  throw new Error('FAULT_INTAKE_LIFECYCLE_CONTRACT_BROKEN: INCIDENT OPEN→DIAGNOSED 必须是合法跃迁');
}

/**
 * 创建故障 Incident 写入端口。
 *
 * 并发安全（MSG-20261009-07 CHANGE 1）：
 *   · 创建与聚合同为**一条** `INSERT ... ON CONFLICT ("dedupeKey") DO UPDATE ... WHERE ...`；
 *   · 冲突分支只在 `kind = INTERNAL_FAULT` 且 `status ∈ {OPEN, DIAGNOSED}` 时生效 ⇒ 终态与外来容器**不可被写**；
 *   · 返回 0 行 ⇒ 只读定位（KIND_MISMATCH / INCIDENT_NOT_OPEN）或重试，绝不盲目重放。
 */
export function createPrismaFaultIncidentIntake(input: {
  prisma: PrismaClient;
  now?: () => Date;
  /** 争用重试上限（默认 10；仅在并发状态变更导致 0 行时才会用到）。 */
  maxAttempts?: number;
}): FaultIncidentIntake {
  const now = (): Date => (input.now ?? (() => new Date()))();
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return {
    async record(observation: FaultObservation): Promise<FaultIncidentIntakeResult> {
      const at = now();
      const { diagnosis, intent } = buildFaultIncidentIntent(observation, { now: at });

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        /** 预生成主键：返回行的 id 与本值相等 ⇒ 本请求的 INSERT 胜出（不依赖 xmax 等实现细节）。 */
        const proposedId = randomUUID();
        const rows = await input.prisma.$queryRaw<AtomicIncidentRow[]>`
          INSERT INTO "AutonomyIncident"
            ("id", "kind", "dedupeKey", "status", "riskClass", "sourceRefs", "detectedAt", "createdAt", "updatedAt")
          VALUES (
            ${proposedId},
            ${INTERNAL_FAULT_INCIDENT_KIND},
            ${intent.dedupeKey},
            ${'DIAGNOSED'},
            ${intent.riskClass},
            ${JSON.stringify(intent.sourceRefs)}::jsonb,
            ${new Date(intent.detectedAt)},
            ${at},
            ${at}
          )
          ON CONFLICT ("dedupeKey") DO UPDATE
             SET "sourceRefs" = jsonb_set(
                   "AutonomyIncident"."sourceRefs",
                   '{occurrenceCount}',
                   to_jsonb(COALESCE(("AutonomyIncident"."sourceRefs" ->> 'occurrenceCount')::int, 0) + 1)
                 ),
                 "status" = CASE
                   WHEN "AutonomyIncident"."status" = 'OPEN' THEN 'DIAGNOSED'
                   ELSE "AutonomyIncident"."status"
                 END,
                 "updatedAt" = ${at}
           WHERE "AutonomyIncident"."kind" = ${INTERNAL_FAULT_INCIDENT_KIND}
             AND "AutonomyIncident"."status" IN ('OPEN', 'DIAGNOSED')
          RETURNING "id", "status", ("sourceRefs" ->> 'occurrenceCount')::int AS "occurrenceCount"
        `;

        const row = rows[0];
        if (row !== undefined) {
          return {
            ok: true,
            incidentId: row.id,
            created: row.id === proposedId,
            occurrenceCount: row.occurrenceCount,
            status: row.status,
            diagnosis,
          };
        }

        /**
         * 0 行 ⇒ 冲突行没被我们的 `WHERE` 接纳。只读定位原因（绝不写它），
         * 三种收口：外来容器 / 终态 ⇒ 明确拒绝；其余（并发状态变更、行被删）⇒ 重试。
         */
        const existing = await input.prisma.autonomyIncident.findUnique({
          where: { dedupeKey: intent.dedupeKey },
          select: { id: true, kind: true, status: true },
        });
        if (existing === null) continue;
        if (existing.kind !== INTERNAL_FAULT_INCIDENT_KIND) {
          return { ok: false, reason: 'KIND_MISMATCH', incidentId: existing.id, status: existing.status };
        }
        if (!(AGGREGATABLE_STATUSES as readonly string[]).includes(existing.status)) {
          return { ok: false, reason: 'INCIDENT_NOT_OPEN', incidentId: existing.id, status: existing.status };
        }
      }

      return { ok: false, reason: 'CONTENTION', incidentId: null, status: null };
    },
  };
}

/** 边界声明（供审计与源码级测试断言）。 */
export const FAULT_INCIDENT_INTAKE_BOUNDARY = {
  reusesAutonomyIncident: true,
  createsNewTables: false,
  createsTasks: false,
  acquiresLeases: false,
  executesCustomerActions: false,
  reopensTerminalIncidents: false,
  hijacksForeignIncidentContainers: false,
  aggregatesByDedupeKey: true,
  /** MSG-20261009-07 CHANGE 1：创建与聚合是数据库级原子 upsert（单语句）。 */
  atomicUpsert: true,
  /** 冲突分支带 kind/status 前置条件 ⇒ 终态行与外来容器在 SQL 层就不可写。 */
  guardedConflictClause: true,
} as const;
