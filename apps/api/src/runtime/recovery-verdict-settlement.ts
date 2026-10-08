/**
 * PHASE 3 / RUNTIME_VERDICT_AWARE_FENCED_SETTLEMENT（审计 MSG-20261009-02 批准的修复口径）
 * ---------------------------------------------------------------
 * 裁决原文要求（要点）：
 *   · 修复必须由**运行时**在裁决收口后自动做 **fenced settle**；「一律 BLOCKED」与「settle 交 host」**均被拒绝**；
 *   · 必须**按裁决结果区分状态**：PASS 且**具备可信业务完成证据**才可 `COMPLETED`；
 *     PASS 但只有 domain step 成功（无完成证据）⇒ `BLOCKED`/明确**非完成**态；REJECT/DENY ⇒ `BLOCKED`；
 *     裁决缺失/超时/不可信 ⇒ 安全等待或按故障策略阻断，**不得视为 PASS**；租约过期/owner 失效 ⇒ 拒绝旧 owner settle；
 *   · 特别强调：**judge PASS ≠ Recovery 业务完成**；
 *   · P0-5：verdict 已持久化但 settle 前崩溃 ⇒ 重启后必须**恢复待收口决策**（不得靠重跑 domain step 弥补）；
 *   · P0-6：不得把审计幂等当执行幂等；非只读步骤需持久化执行标识与状态；
 *   · 收口审计必须可追踪：taskId / organizationId / owner / fencing 标识 / verdictRef / evidenceRef /
 *     收口前后状态 / reasonCode / 时间。
 *
 * 本模块只做两件事：
 *   ① `decideRecoverySettlement()` —— **纯函数**状态映射（可单测，零副作用）；
 *   ② `createRecoveryVerdictSettlement()` —— 把决策落到 durable：先写 **INTENT**（崩溃恢复的锚点），
 *      再走**既有** fenced `settle()`，最后写 **APPLIED**（含前后状态与 reasonCode）。
 *      INTENT / APPLIED 复用既有 `AuditLog`（租户归属、追加式），**不新增表、不新增状态机、不新增 runtime**。
 */

import type { PrismaClient } from '@prisma/client';

import type { RsiDurableTaskSource } from './rsi-durable-task-source';
import type { RecoveryTerminalEvidence } from './recovery-terminal-evidence';

/** 运行时收到的裁决（与既有 verdictWatcher 的取值域一致） */
export type RecoveryVerdictOutcome = 'PASS' | 'REVISE' | 'BLOCK' | null | undefined;

export const RECOVERY_SETTLEMENT_REASON = {
  /** PASS，但只有 domain step 成功、**没有**可信业务完成证据 ⇒ 非完成态收口 */
  PASS_AWAITING_BUSINESS_PROOF: 'VERDICT_PASS_AWAITING_BUSINESS_PROOF',
  /** PASS 且具备可信完成证据（CHANGE 3A 白名单）⇒ 才允许完成级状态 */
  PASS_WITH_TRUSTED_COMPLETION: 'VERDICT_PASS_WITH_TRUSTED_COMPLETION_EVIDENCE',
  /**
   * 端口**声称**有可信完成证据，但既有 `settle()`（CHANGE 3A 白名单）在事务内拒绝 ⇒
   * 回落为**非完成**收口（fail-closed，不留 IN_PROGRESS 悬挂）。
   */
  COMPLETION_REFUSED_FALLBACK_BLOCKED: 'VERDICT_TRUSTED_EVIDENCE_REFUSED_FALLBACK_BLOCKED',
  /** REJECT / DENY ⇒ 阻断 */
  REJECTED: 'VERDICT_REJECTED',
  /** REVISE：裁决未通过 ⇒ 同样按非完成收口（不得当成 PASS） */
  REVISED: 'VERDICT_REVISED_NOT_APPROVED',
  /** 裁决缺失 / 超时 / 来源不可信 ⇒ 安全等待（**不得**视为 PASS，也不落终态） */
  UNTRUSTED_OR_MISSING: 'VERDICT_UNTRUSTED_OR_MISSING_SAFE_WAIT',
} as const;

export type RecoverySettlementReason =
  (typeof RECOVERY_SETTLEMENT_REASON)[keyof typeof RECOVERY_SETTLEMENT_REASON];

export const RECOVERY_SETTLEMENT_ACTIONS = {
  SETTLE_COMPLETED: 'SETTLE_COMPLETED',
  SETTLE_BLOCKED: 'SETTLE_BLOCKED',
  SAFE_WAIT: 'SAFE_WAIT',
} as const;

export type RecoverySettlementAction =
  (typeof RECOVERY_SETTLEMENT_ACTIONS)[keyof typeof RECOVERY_SETTLEMENT_ACTIONS];

export interface RecoverySettlementDecision {
  action: RecoverySettlementAction;
  reason: RecoverySettlementReason;
}

/**
 * 纯函数状态映射（审计方指定的四种语义，逐条对应）：
 *   1. PASS + 可信完成证据充分 → `SETTLE_COMPLETED`（**唯一**允许完成级状态的路径）；
 *   2. PASS + 无完成证据       → `SETTLE_BLOCKED` + `VERDICT_PASS_AWAITING_BUSINESS_PROOF`；
 *   3. REJECT / DENY           → `SETTLE_BLOCKED` + `VERDICT_REJECTED`；REVISE → `SETTLE_BLOCKED` + `VERDICT_REVISED_NOT_APPROVED`；
 *   4. 缺失 / 超时 / 不可信    → `SAFE_WAIT`（保持等待，不落终态、不视为 PASS）。
 */
export function decideRecoverySettlement(input: {
  verdict: RecoveryVerdictOutcome;
  /** 是否具备**可信业务完成证据**（必须来自 CHANGE 3A 的可信来源白名单；由调用方判定后传入布尔） */
  trustedCompletionEvidence?: boolean;
}): RecoverySettlementDecision {
  const verdict = input.verdict;
  if (verdict === null || verdict === undefined) {
    return { action: 'SAFE_WAIT', reason: RECOVERY_SETTLEMENT_REASON.UNTRUSTED_OR_MISSING };
  }
  if (verdict === 'PASS') {
    return input.trustedCompletionEvidence === true
      ? { action: 'SETTLE_COMPLETED', reason: RECOVERY_SETTLEMENT_REASON.PASS_WITH_TRUSTED_COMPLETION }
      : { action: 'SETTLE_BLOCKED', reason: RECOVERY_SETTLEMENT_REASON.PASS_AWAITING_BUSINESS_PROOF };
  }
  if (verdict === 'REVISE') {
    return { action: 'SETTLE_BLOCKED', reason: RECOVERY_SETTLEMENT_REASON.REVISED };
  }
  return { action: 'SETTLE_BLOCKED', reason: RECOVERY_SETTLEMENT_REASON.REJECTED };
}

/** 收口 intent（崩溃恢复锚点）：先落 intent，再尝试 settle */
export const RECOVERY_SETTLEMENT_INTENT_ACTION = 'RECOVERY_SETTLEMENT_INTENT';
/** 收口结果（含前后状态与原因码） */
export const RECOVERY_SETTLEMENT_APPLIED_ACTION = 'RECOVERY_SETTLEMENT_APPLIED';

export interface RecoverySettlementRequest {
  taskId: string;
  dedupeKey: string;
  organizationId: string;
  ownerRef: string;
  verdict: RecoveryVerdictOutcome;
  /** 裁决引用（可追溯：verdict artifact 的 messageId） */
  verdictRef: string;
  /** 可信完成证据引用（仅当 decision = SETTLE_COMPLETED 时应当存在） */
  trustedCompletionEvidenceRef?: string;
}

export interface RecoverySettlementRecord {
  applied: boolean;
  action: RecoverySettlementAction;
  reason: RecoverySettlementReason | string;
  afterStatus?: string;
}

/** 收口被拒绝的原因码（fail-closed：不写任何行、不改任务状态） */
export const RECOVERY_SETTLEMENT_REFUSAL = {
  TENANT_MISMATCH: 'SETTLEMENT_TENANT_MISMATCH',
  TASK_NOT_FOUND: 'SETTLEMENT_TASK_NOT_FOUND',
  /** R9-7「错任务」：请求的去重键与该 durable 任务不一致（lineage 不符）⇒ 拒绝收口 */
  TASK_LINEAGE_MISMATCH: 'SETTLEMENT_TASK_LINEAGE_MISMATCH',
} as const;

export interface RecoveryVerdictSettlement {
  /** 裁决收口后由运行时调用：写 INTENT → fenced settle → 写 APPLIED */
  settleAfterVerdict(request: RecoverySettlementRequest): Promise<RecoverySettlementRecord>;
  /** P0-5 崩溃恢复：列出「已记 intent 但无 applied」的待收口决策 */
  listPendingSettlements(organizationId?: string): Promise<readonly RecoverySettlementRequest[]>;
  /** P0-5：重启后恢复待收口决策（**不重跑 domain step**） */
  resumePendingSettlements(organizationId?: string): Promise<readonly RecoverySettlementRecord[]>;
}

const readChanges = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const intentKey = (taskId: string, verdictRef: string): string => `${taskId}|${verdictRef}`;

export function createRecoveryVerdictSettlement(input: {
  prisma: PrismaClient;
  taskSource: RsiDurableTaskSource;
  /**
   * 当前运行时的 owner（用于 P0-5 恢复：崩溃重启后由**新 owner** 收口，而不是沿用 intent 里的旧 owner）。
   * 缺省时恢复沿用 intent 记录的 ownerRef（旧 owner 通常已被 fence 拒绝，属 fail-closed）。
   */
  ownerRef?: string;
  /**
   * 可信完成证据提供者（host 注入）：仅当返回**已校验**的终局证据时才尝试 `COMPLETED`；
   * 该证据仍会被既有 `settle()`（CHANGE 3A 白名单）**在事务内重新判定** —— 端口说"有"不算数。
   * 缺省不提供 ⇒ 一律走非完成收口。
   */
  trustedEvidenceProvider?: (request: RecoverySettlementRequest) => Promise<RecoveryTerminalEvidence | undefined>;
  now?: () => Date;
}): RecoveryVerdictSettlement {
  const now = (): Date => (input.now ?? (() => new Date()))();

  /** 权威租户：task → incident(必须是服务端写入的队列 incident) → sourceRefs[0].organizationId */
  const authoritativeScopeOf = async (
    taskId: string,
  ): Promise<{ organizationId: string; dedupeKey: string } | null> => {
    const task = await input.prisma.autonomyTask.findUnique({
      where: { id: taskId },
      select: { incidentId: true, dedupeKey: true },
    });
    if (task === null) return null;
    const incident = await input.prisma.autonomyIncident.findUnique({
      where: { id: task.incidentId },
      select: { sourceRefs: true },
    });
    if (incident === null) return null;
    const refs = incident.sourceRefs as unknown;
    const first = Array.isArray(refs) ? (refs[0] as Record<string, unknown> | undefined) : undefined;
    const organizationId =
      first !== undefined && typeof first.organizationId === 'string' && first.organizationId !== ''
        ? first.organizationId
        : null;
    if (organizationId === null) return null;
    return { organizationId, dedupeKey: String(task.dedupeKey) };
  };

  const applyDecision = async (request: RecoverySettlementRequest): Promise<RecoverySettlementRecord> => {
    /**
     * R7（跨租户 fail-closed）：收口只允许作用于**本任务权威租户**，请求里的 organizationId 必须与之一致；
     * 否则一律拒绝且**不写任何行**（既不写到请求租户，也不写回权威租户）。
     */
    const authoritative = await authoritativeScopeOf(request.taskId);
    if (authoritative === null) {
      return { applied: false, action: 'SAFE_WAIT', reason: RECOVERY_SETTLEMENT_REFUSAL.TASK_NOT_FOUND };
    }
    // R9-7「错任务」：请求的去重键必须与该 durable 任务一致
    if (authoritative.dedupeKey !== request.dedupeKey) {
      return { applied: false, action: 'SAFE_WAIT', reason: RECOVERY_SETTLEMENT_REFUSAL.TASK_LINEAGE_MISMATCH };
    }
    if (authoritative.organizationId !== request.organizationId) {
      return { applied: false, action: 'SAFE_WAIT', reason: RECOVERY_SETTLEMENT_REFUSAL.TENANT_MISMATCH };
    }
    /**
     * 可信完成证据：由 host 提供者给出；且只有**权威租户 + 本任务 lineage** 的已校验证据才可能通过
     * `settle()` 的 CHANGE 3A 门禁（此处仅做传递，不做放行判断 —— 放行判断在事务内）。
     */
    const terminalEvidence =
      input.trustedEvidenceProvider === undefined ? undefined : await input.trustedEvidenceProvider(request);
    const decision = decideRecoverySettlement({
      verdict: request.verdict,
      trustedCompletionEvidence:
        request.trustedCompletionEvidenceRef !== undefined || terminalEvidence !== undefined,
    });
    if (decision.action === 'SAFE_WAIT') {
      // 安全等待：不落终态（也不写 applied），交由后续裁决/故障策略处理
      return { applied: false, action: decision.action, reason: decision.reason };
    }

    const before = await input.prisma.autonomyTask.findUnique({
      where: { id: request.taskId },
      select: { status: true },
    });

    // 走**既有** fenced settle（owner + 未过期租约 + 事务内 CAS）；非完成路径一律 BLOCKED
    let settled = await input.taskSource.settle({
      taskId: request.taskId,
      ownerRef: request.ownerRef,
      outcome: decision.action === 'SETTLE_COMPLETED' ? 'COMPLETED' : 'BLOCKED',
      ...(decision.action === 'SETTLE_COMPLETED'
        ? {
            businessOutcome: 'SETTLEMENT_RECEIVED' as const,
            ...(terminalEvidence === undefined ? {} : { terminalEvidence }),
          }
        : {}),
    });
    let finalAction = decision.action;
    let finalReason: RecoverySettlementReason | string = decision.reason;
    /**
     * CHANGE 3A 白名单说"不算完成"时**必须回落为非完成收口**（否则会留下 IN_PROGRESS 悬挂 —— 正是本缺口）。
     * 这是 fail-closed：宁可把任务落到 BLOCKED，也不留下未收口任务，更不伪造完成。
     */
    if (!settled.applied && decision.action === 'SETTLE_COMPLETED') {
      const fallback = await input.taskSource.settle({
        taskId: request.taskId,
        ownerRef: request.ownerRef,
        outcome: 'BLOCKED',
      });
      settled = { ...fallback };
      finalAction = 'SETTLE_BLOCKED';
      finalReason = RECOVERY_SETTLEMENT_REASON.COMPLETION_REFUSED_FALLBACK_BLOCKED;
    }

    const after = await input.prisma.autonomyTask.findUnique({
      where: { id: request.taskId },
      select: { status: true },
    });

    await input.prisma.auditLog.create({
      data: {
        organizationId: request.organizationId,
        actorType: 'SYSTEM',
        actorRef: 'rsi-run:verdict-settlement',
        action: RECOVERY_SETTLEMENT_APPLIED_ACTION,
        entityType: 'AutonomyTask',
        entityId: request.taskId,
        changes: {
          dedupeKey: request.dedupeKey,
          ownerRef: request.ownerRef,
          verdict: request.verdict,
          verdictRef: request.verdictRef,
          decisionAction: finalAction,
          decidedAction: decision.action,
          reasonCode: finalReason,
          settleApplied: settled.applied,
          settleReason: settled.reason,
          beforeStatus: before?.status ?? null,
          afterStatus: after?.status ?? null,
          trustedCompletionEvidenceRef:
            request.trustedCompletionEvidenceRef ?? terminalEvidence?.verificationRef ?? null,
          trustedCompletionEvidenceSource: terminalEvidence?.source ?? null,
          trustedCompletionEvidenceKind: terminalEvidence?.kind ?? null,
          recordedAt: now().toISOString(),
        },
      },
    });

    return {
      applied: settled.applied,
      action: finalAction,
      reason: settled.applied ? finalReason : settled.reason,
      ...(after?.status === undefined || after?.status === null ? {} : { afterStatus: after.status }),
    };
  };

  const listPendingSettlements = async (
    organizationId?: string,
  ): Promise<readonly RecoverySettlementRequest[]> => {
      const intents = await input.prisma.auditLog.findMany({
        where: {
          action: RECOVERY_SETTLEMENT_INTENT_ACTION,
          ...(organizationId === undefined ? {} : { organizationId }),
        },
        select: { id: true, organizationId: true, entityId: true, changes: true },
        orderBy: { createdAt: 'asc' },
      });
      const applied = await input.prisma.auditLog.findMany({
        where: {
          action: RECOVERY_SETTLEMENT_APPLIED_ACTION,
          ...(organizationId === undefined ? {} : { organizationId }),
        },
        select: { entityId: true, changes: true },
      });
      const appliedKeys = new Set(
        applied.map((row) => intentKey(String(row.entityId), String(readChanges(row.changes)?.verdictRef ?? ''))),
      );
      const pending: RecoverySettlementRequest[] = [];
      for (const row of intents) {
        const changes = readChanges(row.changes);
        if (changes === null) continue;
        const key = intentKey(String(row.entityId), String(changes.verdictRef ?? ''));
        if (appliedKeys.has(key)) continue;
        const verdict = changes.verdict;
        pending.push({
          taskId: String(row.entityId),
          dedupeKey: String(changes.dedupeKey ?? ''),
          organizationId: String(row.organizationId),
          ownerRef: String(changes.ownerRef ?? ''),
          verdict: verdict === 'PASS' || verdict === 'REVISE' || verdict === 'BLOCK' ? verdict : null,
          verdictRef: String(changes.verdictRef ?? ''),
        });
      }
      return pending;
  };

  return {
    async settleAfterVerdict(request) {
      // R7：先做权威租户核对（不一致 ⇒ 直接拒绝，连 INTENT 都不写）
      const authoritative = await authoritativeScopeOf(request.taskId);
      if (authoritative === null) {
        return {
          applied: false,
          action: 'SAFE_WAIT',
          reason: RECOVERY_SETTLEMENT_REFUSAL.TASK_NOT_FOUND,
        };
      }
      if (authoritative.dedupeKey !== request.dedupeKey) {
        return {
          applied: false,
          action: 'SAFE_WAIT',
          reason: RECOVERY_SETTLEMENT_REFUSAL.TASK_LINEAGE_MISMATCH,
        };
      }
      if (authoritative.organizationId !== request.organizationId) {
        return {
          applied: false,
          action: 'SAFE_WAIT',
          reason: RECOVERY_SETTLEMENT_REFUSAL.TENANT_MISMATCH,
        };
      }
      // P0-5 ①：先把「待收口决策」写成 durable INTENT（崩溃锚点），再去 settle
      const existing = await input.prisma.auditLog.findMany({
        where: {
          organizationId: request.organizationId,
          action: RECOVERY_SETTLEMENT_INTENT_ACTION,
          entityType: 'AutonomyTask',
          entityId: request.taskId,
        },
        select: { changes: true },
      });
      const alreadyRecorded = existing.some(
        (row) => readChanges(row.changes)?.verdictRef === request.verdictRef,
      );
      if (!alreadyRecorded) {
        await input.prisma.auditLog.create({
          data: {
            organizationId: request.organizationId,
            actorType: 'SYSTEM',
            actorRef: 'rsi-run:verdict-settlement',
            action: RECOVERY_SETTLEMENT_INTENT_ACTION,
            entityType: 'AutonomyTask',
            entityId: request.taskId,
            changes: {
              dedupeKey: request.dedupeKey,
              ownerRef: request.ownerRef,
              verdict: request.verdict,
              verdictRef: request.verdictRef,
              intentKey: intentKey(request.taskId, request.verdictRef),
              recordedAt: now().toISOString(),
            },
          },
        });
      }
      return applyDecision(request);
    },

    listPendingSettlements,

    async resumePendingSettlements(organizationId) {
      const pending = await listPendingSettlements(organizationId);
      const results: RecoverySettlementRecord[] = [];
      for (const request of pending) {
        // 恢复时**不重跑 domain step**：只用既有 fenced settle 补齐收口；
        // owner/租约不匹配时 settle 会被既有的 FENCED_* 拒绝（交由既有恢复路径处理）。
        // P0-5：崩溃重启后由**当前 owner** 收口（若已通过 reclaimExpired/claim 接管），
        // 否则沿用 intent 里的旧 owner —— 那时会被 fence 拒绝，属 fail-closed。
        results.push(await applyDecision({ ...request, ownerRef: input.ownerRef ?? request.ownerRef }));
      }
      return results;
    },
  };
}

export const RECOVERY_VERDICT_SETTLEMENT_BOUNDARY = {
  source: '审计 MSG-20261009-02（FIX_SPEC = RUNTIME_VERDICT_AWARE_FENCED_SETTLEMENT）',
  passImpliesBusinessCompletion: false,
  trustedCompletionEvidenceRequired: true,
  nonCompletionSettlement: 'BLOCKED + reasonCode（VERDICT_PASS_AWAITING_BUSINESS_PROOF / VERDICT_REJECTED / VERDICT_REVISED_NOT_APPROVED）',
  missingOrUntrustedVerdict: 'SAFE_WAIT（不落终态、不视为 PASS）',
  usesExistingFencedSettle: true,
  createsRuntime: false,
  createsScheduler: false,
  createsController: false,
  createsSecondStateMachine: false,
  durableIntentBeforeSettle: true,
  crashRecoveryResumesPendingSettlement: true,
  writesDatabase: true,
  externalWrite: false,
  payment: false,
  customsFiling: false,
  readsCredentials: false,
} as const;
