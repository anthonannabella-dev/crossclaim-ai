/**
 * INTERNAL CODE REPAIR V1 / PHASE 2 —— 分流扫描（**只读 + 只登记**，零执行）
 * ---------------------------------------------------------------
 * 授权依据：MSG-20261009-08（`PHASE2_IMPLEMENTATION_AUTHORIZED = YES_SAFE_SCOPE_ONLY`）。
 *
 * 本模块把“纯函数分流”接到**真实持久化 Incident**上，但仍然**不执行任何动作**：
 *   · 只读扫描 `AutonomyIncident`（kind = `INTERNAL_FAULT` 且 status = `DIAGNOSED`）；
 *   · 可信事实**必须由调用方注入**（`resolveTrustedFacts`），默认 fail-closed（无法确认 ⇒ BLOCK）；
 *   · 只把 3 个**固定服务端字段**登记回 `sourceRefs`：`triageDecision` / `triageReason` / `triagedAt`
 *     （不含自由文本；登记语句带 kind/status 前置条件，不会覆盖并发中的状态变化）；
 *   · **绝不**创建任务 / 租约、绝不调用 ONE SI Runtime、绝不做外部写（`tasksCreated/leasesCreated/runtimeInvocations` 恒为 0）。
 *
 * 也就是说：A 路径在这里只是「被登记为可交回既有运行时的候选」，
 * 真正执行仍必须由既有运行时入口按其自身门禁（授权重解析 / 租约 fencing / Action Guard / 外写 HOLD）决定。
 */

import type { PrismaClient } from '@prisma/client';

import { INTERNAL_FAULT_INCIDENT_KIND } from './fault-classification';
import {
  assertTrustedFactSources,
  triageFaultIncident,
  TrustedFactSourceContractError,
  type FaultTriageDecision,
  type PersistedFaultIncidentRow,
  type TrustedFactSourceDeclaration,
  type TriageTrustedFacts,
} from './fault-triage';

/** 允许登记回 `sourceRefs` 的服务端字段（固定三项，均非自由文本）。 */
export const TRIAGE_REGISTRATION_FIELDS = ['triageDecision', 'triageReason', 'triagedAt'] as const;

export interface FaultTriageSweepResult {
  scanned: number;
  /** 本次**首次**写入登记的条数（first-write-wins）。 */
  registered: number;
  /** 已登记过、本次按幂等语义跳过更新的条数（`triagedAt` 不漂移、决策不被覆盖）。 */
  alreadyRegistered: number;
  /** 因 kind/status 前置条件被挡下的条数（含并发中转为终态）。 */
  skipped: number;
  decisions: readonly FaultTriageDecision[];
  /** 恒定 0：本模块不执行任何业务动作（由测试断言）。 */
  tasksCreated: 0;
  leasesCreated: 0;
  runtimeInvocations: 0;
}

export interface FaultTriageSweep {
  sweepOnce(input?: { limit?: number }): Promise<FaultTriageSweepResult>;
}

interface SweepIncidentRow {
  id: string;
  kind: string;
  dedupeKey: string;
  status: string;
  riskClass: string;
  sourceRefs: unknown;
}

export function createPrismaFaultTriageSweep(input: {
  prisma: PrismaClient;
  now?: () => Date;
  /**
   * 服务端可信事实解析器（**不得**从请求参数 / 客户端 / 模型输出取值）。
   * 缺省 = 无法确认 ⇒ 一律 fail-closed 到 BLOCK。
   */
  resolveTrustedFacts?: (incident: { id: string; sourceRefs: unknown }) => Promise<TriageTrustedFacts>;
  /** 是否登记结论（默认 true）。登记只写 `TRIAGE_REGISTRATION_FIELDS` 三项。 */
  register?: boolean;
  /**
   * MSG-20261009-09 / CHANGE 3 —— 可信事实来源声明。**生产适配器必须提供**；
   * 一旦提供即在此处校验，违规（请求参数 / 客户端输入 / 模型输出 / 未声明）**接线期抛错**。
   */
  trustedFactSources?: TrustedFactSourceDeclaration;
}): FaultTriageSweep {
  if (input.trustedFactSources !== undefined) {
    const check = assertTrustedFactSources(input.trustedFactSources);
    if (!check.ok) throw new TrustedFactSourceContractError(check.reason, check.offending);
  }
  const now = (): Date => (input.now ?? (() => new Date()))();
  const register = input.register ?? true;
  const failClosedFacts: TriageTrustedFacts = {
    organizationIdResolved: false,
    authorizationActive: false,
    operationRecheck: 'NOT_CONFIRMED',
  };

  return {
    async sweepOnce(options: { limit?: number } = {}): Promise<FaultTriageSweepResult> {
      const at = now();
      const limit = Number.isInteger(options.limit) && (options.limit ?? 0) > 0 ? (options.limit as number) : 50;
      const rows = await input.prisma.$queryRaw<SweepIncidentRow[]>`
        SELECT "id", "kind", "dedupeKey", "status", "riskClass", "sourceRefs"
          FROM "AutonomyIncident"
         WHERE "kind" = ${INTERNAL_FAULT_INCIDENT_KIND}
           AND "status" = 'DIAGNOSED'
         ORDER BY "detectedAt" ASC, "id" ASC
         LIMIT ${limit}
      `;

      const decisions: FaultTriageDecision[] = [];
      let registered = 0;
      let alreadyRegistered = 0;
      let skipped = 0;
      for (const row of rows) {
        const incident: PersistedFaultIncidentRow = {
          id: row.id,
          kind: row.kind,
          dedupeKey: row.dedupeKey,
          status: row.status,
          riskClass: row.riskClass,
          sourceRefs: row.sourceRefs,
        };
        const trusted =
          input.resolveTrustedFacts === undefined
            ? failClosedFacts
            : await input.resolveTrustedFacts({ id: row.id, sourceRefs: row.sourceRefs });
        const decision = triageFaultIncident({ incident, trusted });
        decisions.push(decision);

        if (!register) continue;
        /**
         * **first-write-wins 幂等登记**（MSG-20261009-09 / CHANGE 2）：
         *   · `||` 做 jsonb **合并**（只加固定三项，绝不整对象覆盖 ⇒ 并发下不会丢失其它引用）；
         *   · `NOT ("sourceRefs" ? 'triageDecision')` ⇒ **只有首次写入才登记**：
         *     重复扫描不改 `triagedAt`、不覆盖既有决策；并发扫描在行锁 + 条件重判下只有一次生效；
         *   · `kind`/`status` 前置条件 ⇒ `DIAGNOSED` 之外的任何状态（含并发转 `CLOSED`）绝对禁止登记。
         */
        const registeredRows = await input.prisma.$executeRaw`
          UPDATE "AutonomyIncident"
             SET "sourceRefs" = "sourceRefs" || ${JSON.stringify({
               triageDecision: decision.disposition,
               triageReason: decision.reason,
               triagedAt: at.toISOString(),
             })}::jsonb,
                 "updatedAt" = ${at}
           WHERE "id" = ${row.id}
             AND "kind" = ${INTERNAL_FAULT_INCIDENT_KIND}
             AND "status" = 'DIAGNOSED'
             AND NOT ("sourceRefs" ? 'triageDecision')
        `;
        if (registeredRows === 1) {
          registered += 1;
          continue;
        }
        /**
         * 0 行 ⇒ 要么已登记（幂等跳过），要么被 kind/status 前置条件挡下。
         * 这里只做**只读**判定，保证计数语义可审计（不猜、不吞）。
         */
        const settled = await input.prisma.autonomyIncident.findUnique({
          where: { id: row.id },
          select: { kind: true, status: true, sourceRefs: true },
        });
        const alreadyHasDecision =
          settled !== null &&
          typeof settled.sourceRefs === 'object' &&
          settled.sourceRefs !== null &&
          !Array.isArray(settled.sourceRefs) &&
          'triageDecision' in (settled.sourceRefs as Record<string, unknown>);
        if (alreadyHasDecision) alreadyRegistered += 1;
        else skipped += 1;
      }

      return {
        scanned: rows.length,
        registered,
        alreadyRegistered,
        skipped,
        decisions,
        tasksCreated: 0,
        leasesCreated: 0,
        runtimeInvocations: 0,
      };
    },
  };
}

/** 边界声明（供审计与源码级测试断言）。 */
export const FAULT_TRIAGE_SWEEP_BOUNDARY = {
  readOnlyScan: true,
  registersFixedFieldsOnly: true,
  createsTasks: false,
  createsLeases: false,
  invokesRuntime: false,
  performsExternalWrites: false,
  requiresInjectedTrustedFacts: true,
  defaultTrustedFacts: 'FAIL_CLOSED',
  /** MSG-20261009-09 CHANGE 2：首次写入生效，此后不更新（时间戳不漂移、决策不被覆盖）。 */
  firstWriteWinsRegistration: true,
  neverOverwritesExistingDecision: true,
  /** jsonb 合并只增不改 ⇒ 并发下不会丢失 `sourceRefs` 的其它引用。 */
  mergesJsonbWithoutLosingOtherRefs: true,
  /** 登记是**快照**，不是运行时授权凭证；运行时仍须自行复核。 */
  registrationIsSnapshotNotAuthorization: true,
  /** MSG-20261009-09 CHANGE 3：适配器必须声明可信事实来源，违规在接线期失败。 */
  requiresTrustedFactDeclarationForAdapters: true,
  verifiesTrustedFactSourcesAtWiringTime: true,
} as const;
