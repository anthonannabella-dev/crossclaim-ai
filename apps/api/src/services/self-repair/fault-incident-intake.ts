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
 * 边界：本模块不领取任务、不写租约、不执行任何客户业务动作。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

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

interface AggregatedIncidentRow {
  id: string;
  status: string;
  occurrenceCount: number;
}

const UNIQUE_VIOLATION_CODE = 'P2002';
const AGGREGATABLE_STATUSES = ['OPEN', 'DIAGNOSED'] as const;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}

/**
 * 创建故障 Incident 写入端口。
 *
 * 并发安全：创建路径依赖 `dedupeKey` 唯一约束（P2002 即让位重读），
 * 聚合路径是一条**单语句原子 UPDATE**（隐式行锁 + `WHERE status IN (...)` 前置条件），
 * 因此 N 个并发记录只会得到 1 行、且 occurrenceCount 精确等于 N。
 */
export function createPrismaFaultIncidentIntake(input: {
  prisma: PrismaClient;
  now?: () => Date;
  /** 争用重试上限（默认 3）。 */
  maxAttempts?: number;
}): FaultIncidentIntake {
  const now = (): Date => (input.now ?? (() => new Date()))();
  const maxAttempts = input.maxAttempts ?? 3;

  return {
    async record(observation: FaultObservation): Promise<FaultIncidentIntakeResult> {
      const at = now();
      const { diagnosis, intent } = buildFaultIncidentIntent(observation, { now: at });

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const existing = await input.prisma.autonomyIncident.findUnique({
          where: { dedupeKey: intent.dedupeKey },
          select: { id: true, kind: true, status: true },
        });

        if (existing === null) {
          try {
            const created = await input.prisma.autonomyIncident.create({
              data: {
                kind: intent.kind,
                dedupeKey: intent.dedupeKey,
                status: intent.status,
                riskClass: intent.riskClass,
                sourceRefs: intent.sourceRefs as unknown as Prisma.InputJsonValue,
                detectedAt: new Date(intent.detectedAt),
              },
              select: { id: true, status: true },
            });
            return {
              ok: true,
              incidentId: created.id,
              created: true,
              occurrenceCount: intent.sourceRefs.occurrenceCount,
              status: created.status,
              diagnosis,
            };
          } catch (error) {
            if (isUniqueViolation(error)) continue; // 并发对手已建行 ⇒ 重读后走聚合
            throw error;
          }
        }

        if (existing.kind !== INTERNAL_FAULT_INCIDENT_KIND) {
          return { ok: false, reason: 'KIND_MISMATCH', incidentId: existing.id, status: existing.status };
        }
        if (!(AGGREGATABLE_STATUSES as readonly string[]).includes(existing.status)) {
          return { ok: false, reason: 'INCIDENT_NOT_OPEN', incidentId: existing.id, status: existing.status };
        }
        if (
          existing.status === 'OPEN' &&
          !transition('INCIDENT', 'OPEN', 'DIAGNOSED').ok
        ) {
          return { ok: false, reason: 'ILLEGAL_TRANSITION', incidentId: existing.id, status: existing.status };
        }

        /**
         * 原子聚合：单语句内完成 occurrenceCount+1 与 OPEN→DIAGNOSED；
         * `WHERE kind/status` 前置条件保证不会把并发中已转终态的行改坏（0 行 ⇒ 重读）。
         */
        const rows = await input.prisma.$queryRaw<AggregatedIncidentRow[]>`
          UPDATE "AutonomyIncident"
             SET "sourceRefs" = jsonb_set(
                   "sourceRefs",
                   '{occurrenceCount}',
                   to_jsonb(COALESCE(("sourceRefs" ->> 'occurrenceCount')::int, 0) + 1)
                 ),
                 "status" = CASE WHEN "status" = 'OPEN' THEN 'DIAGNOSED' ELSE "status" END,
                 "updatedAt" = ${at}
           WHERE "dedupeKey" = ${intent.dedupeKey}
             AND "kind" = ${INTERNAL_FAULT_INCIDENT_KIND}
             AND "status" IN ('OPEN', 'DIAGNOSED')
          RETURNING "id", "status", ("sourceRefs" ->> 'occurrenceCount')::int AS "occurrenceCount"
        `;
        const row = rows[0];
        if (row !== undefined) {
          return {
            ok: true,
            incidentId: row.id,
            created: false,
            occurrenceCount: row.occurrenceCount,
            status: row.status,
            diagnosis,
          };
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
} as const;
