/**
 * PHASE 2 / P0-B1（审计 MSG-20261008-20）—— Recovery 业务步骤的**可审计持久记录**
 * ---------------------------------------------------------------
 * 审计对 P0-B1 的第 ③ 条要求：*本地机会识别或索赔准备必须产生**可审计的 durable 记录***。
 * 之前的实现只有**内存 dispatch log**：pack 跑完（只读步骤真的执行了）之后没有任何 durable 痕迹，
 * 因此无法证明「业务步骤确实执行」而非「只写了一条 dispatch 日志」。
 *
 * 本模块负责把 domain step 的**最终结果**写成一条**追加式**审计事实（`AuditLog`，租户归属）：
 *   · `action = RECOVERY_DOMAIN_STEP_EXECUTED`；
 *   · `entityType = 'AutonomyTask'` / `entityId = taskId`（与 durable 任务行可互相追溯）；
 *   · `changes` 只放**非敏感投影**：packId / status / evidenceRef / domain / opportunityRef /
 *     guardActions / businessOutcome / externalWritePerformed=false / dedupeKey；
 *   · `businessOutcome` 使用 §3.9 词表：PASS ⇒ `OPPORTUNITY_IDENTIFIED`，其余 ⇒ `BLOCKED`
 *     —— **绝不**映射为终局完成（终局档另有 CHANGE 3A 的可信证据门禁）。
 *
 * fail-closed：
 *   · 无可信租户（organizationId 缺失）⇒ **不写任何行**并返回拒绝原因；
 *   · 写入异常由调用方（domain runner）捕获并降级为 BLOCK —— 不允许「审计写失败但仍报 PASS」。
 *
 * 幂等：同一 (taskId, evidenceRef, action) 已存在时**不重复追加**，返回 `ALREADY_RECORDED`。
 */

import type { PrismaClient } from '@prisma/client';

export const RECOVERY_DOMAIN_STEP_ACTION = 'RECOVERY_DOMAIN_STEP_EXECUTED';
export const RECOVERY_DOMAIN_OUTCOME_RECORDER_ACTOR = 'rsi-run:domain-step';

export interface RecoveryDomainOutcomeEntry {
  taskId: string;
  dedupeKey: string;
  packId: string;
  /** pack 最终状态（PASS / BLOCK / 其它 runner 状态） */
  status: string;
  evidenceRef: string;
  /** 可信租户（来自 durable claim）。缺失 ⇒ 拒绝写入 */
  organizationId?: string;
  domain?: string;
  opportunityRef?: string;
  guardActions?: readonly { action: string; decision: string }[];
  /** BLOCK 时的原因码（非敏感） */
  reasonCodes?: readonly string[];
}

export interface RecoveryDomainOutcomeRecordResult {
  recorded: boolean;
  reason: string;
  id?: string;
  businessOutcome?: string;
}

export interface RecoveryDomainOutcomeRecorder {
  record(entry: RecoveryDomainOutcomeEntry): Promise<RecoveryDomainOutcomeRecordResult>;
}

/** pack 状态 → §3.9 业务结果词表（**永不**产生终局完成档） */
export function businessOutcomeForDomainStep(status: string): 'OPPORTUNITY_IDENTIFIED' | 'BLOCKED' {
  return status === 'PASS' ? 'OPPORTUNITY_IDENTIFIED' : 'BLOCKED';
}

const RECOVERY_TASK_RE = /^task:recovery:([A-Z_]+):(.+)$/;
/** Goal 域 token → RecoveryDomain（与 `recovery-si-production-composition.ts` 的映射保持一致） */
const GOAL_DOMAIN_TO_RECOVERY_DOMAIN: Record<string, string> = {
  PLATFORM: 'PLATFORM',
  LOGISTICS: 'CARRIER',
  CUSTOMS: 'CUSTOMS',
  INDEPENDENT_SITE: 'INDEPENDENT_SITE',
};

/** 从任务去重键解析 (domain, opportunityRef)；解析不出则返回空（不猜） */
function parseRecoveryScope(dedupeKey: string): { domain: string | null; opportunityRef: string | null } {
  const match = RECOVERY_TASK_RE.exec(dedupeKey);
  if (match === null) return { domain: null, opportunityRef: null };
  return {
    domain: GOAL_DOMAIN_TO_RECOVERY_DOMAIN[match[1]!] ?? null,
    opportunityRef: match[2]!,
  };
}

export function createRecoveryDomainOutcomeRecorder(input: {
  prisma: PrismaClient;
  now?: () => Date;
}): RecoveryDomainOutcomeRecorder {
  const now = (): Date => (input.now ?? (() => new Date()))();

  return {
    async record(entry) {
      const organizationId = entry.organizationId;
      if (typeof organizationId !== 'string' || organizationId === '') {
        // 无可信租户 ⇒ 不写（也不猜租户）
        return { recorded: false, reason: 'DOMAIN_OUTCOME_NO_TRUSTED_TENANT' };
      }
      const businessOutcome = businessOutcomeForDomainStep(entry.status);
      const parsed = parseRecoveryScope(entry.dedupeKey);
      const domain = entry.domain ?? parsed.domain;
      const opportunityRef = entry.opportunityRef ?? parsed.opportunityRef;
      /**
       * 幂等键：PASS 用真实证据摘要；BLOCK 无 evidenceRef ⇒ 用**原因码集合**构造稳定键
       * （保证「同一原因不重复追加」而「不同原因各留一条」，不把不同失败合并成一条）。
       */
      const effectiveEvidenceRef =
        entry.evidenceRef.trim() !== ''
          ? entry.evidenceRef
          : 'domain-pack:block:' + (entry.reasonCodes ?? []).join('|');

      // 幂等：同一任务同一证据引用只追加一次
      const existing = await input.prisma.auditLog.findFirst({
        where: {
          organizationId,
          action: RECOVERY_DOMAIN_STEP_ACTION,
          entityType: 'AutonomyTask',
          entityId: entry.taskId,
        },
        select: { id: true, changes: true },
        orderBy: { createdAt: 'desc' },
      });
      if (existing !== null) {
        const changes = existing.changes as Record<string, unknown> | null;
        if (changes !== null && changes.evidenceRef === effectiveEvidenceRef) {
          return { recorded: false, reason: 'ALREADY_RECORDED', id: existing.id, businessOutcome };
        }
      }

      const row = await input.prisma.auditLog.create({
        data: {
          organizationId,
          actorType: 'SYSTEM',
          actorRef: RECOVERY_DOMAIN_OUTCOME_RECORDER_ACTOR,
          action: RECOVERY_DOMAIN_STEP_ACTION,
          entityType: 'AutonomyTask',
          entityId: entry.taskId,
          changes: {
            packId: entry.packId,
            dedupeKey: entry.dedupeKey,
            status: entry.status,
            evidenceRef: effectiveEvidenceRef,
            reasonCodes: [...(entry.reasonCodes ?? [])],
            domain,
            opportunityRef,
            guardActions: (entry.guardActions ?? []).map((a) => ({ action: a.action, decision: a.decision })),
            businessOutcome,
            externalWritePerformed: false,
            recordedAt: now().toISOString(),
          },
        },
        select: { id: true },
      });
      return { recorded: true, reason: 'RECORDED', id: row.id, businessOutcome };
    },
  };
}

export const RECOVERY_DOMAIN_OUTCOME_RECORDER_BOUNDARY = {
  storage: 'AuditLog（租户归属、追加式审计事实；不新增第二套事实源）',
  writesDatabase: true,
  updatesTaskState: false,
  producesTerminalCompletion: false,
  businessOutcomeVocabulary: 'PASS ⇒ OPPORTUNITY_IDENTIFIED / 其它 ⇒ BLOCKED',
  requiresTrustedTenant: true,
  idempotent: true,
  externalWrite: false,
  payment: false,
  customsFiling: false,
  readsCredentials: false,
} as const;
