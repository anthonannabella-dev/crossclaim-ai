/**
 * CLAIM 人工提交 —— 受保护动作 `claim.submit` 的**原子提交服务**（R19 裁决 MSG-20261001-02 CHANGE A/B）
 * -------------------------------------------------------------------------------------------------
 * 纪律（逐条对应裁决）：
 *   A. 提交、人工提交审计（claim.submitted_by_human）、审批消费（recovery.approval_consumed）
 *      **同一事务、同一事务客户端**完成；任一写入失败 → 状态/提交时间/提交人/批准字段/审计/消费全部回滚。
 *      业务审计绑定事务客户端（不使用绑定根 Prisma 客户端的 AuditWriter）。
 *   B. 取得锁后**完整重验**审批与主体：先取与 `submitRecoveryReview` 同一协议的**案件锁**
 *      （`cc-recovery-case:${caseId}`），再取 Claim 行锁并确认身份与租户；随后生成执行时间、重读 Claim，
 *      核验动作/目标/载荷/指纹版本/有效期/撤销/轮次/消费/审批人与执行人有效性；执行角色必须满足
 *      Claim 提交权限；已消费审批 → 结构化拒绝（不重复执行）；并发下最多一次成功。
 *   拒绝留痕在**事务回滚之后**写入，且拒绝审计失败不得覆盖原始错误。
 *
 * 明确不做：不调用任何平台适配器写入面（零平台外写）；不新增 schema/迁移。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import {
  APPROVAL_CONSUMED_EVENT_ACTION,
  ApprovalBoundaryError,
  verifyApprovalBoundary,
} from '../action-guard/approval-tx-verify';
import { CLAIM_SUBMIT_ACTION } from '../action-guard/approval-verifier';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';
import { CLAIM_TRACKING_ACTION } from './tracking-service';

/** 锁内拒绝留痕（事务回滚后写入；不含敏感取值） */
export const CLAIM_SUBMIT_REJECTED_ACTION = 'claim.submit_rejected';

export interface ClaimSubmissionInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  caseId: string;
  /** 第 1 轮 Claim（审批荷载绑定依据） */
  claimId: string;
  approvalId?: string;
  note?: string;
}

export interface ClaimSubmissionResult {
  caseId: string;
  claimId: string;
  status: 'SUBMITTED';
  approvedAt: string;
  operationId: string | null;
  /** 提交恒为人工卡口：未发生任何平台外写 */
  externalSubmission: 'NEEDS_MANUAL';
  platformWriteExecuted: false;
}

export interface ClaimSubmissionDeps {
  prisma: PrismaClient;
  now?: () => Date;
}

type TxClient = Prisma.TransactionClient;

/** 事务内审计写入（绑定事务客户端；字段白名单与 sanitize 与 AuditWriter 同源） */
async function insertTxAudit(
  tx: TxClient,
  input: {
    organizationId: string;
    actorUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<string> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: input.changes,
    },
    { maxStringLength: 512, now: () => input.at },
  );
  const created = await tx.auditLog.create({
    data: {
      organizationId: row.organizationId,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorRef: row.actorRef,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: input.at,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * 受保护 Claim 提交（唯一执行入口）。
 * 前置：调用方已完成 Action Guard + HITL 审批边界（事务外只读校验，用于快速失败与 approval_decision 审计）。
 * 本函数在**锁内**再次完整校验，保证核验后发生的过期/撤销/新一轮/主体失效无法绕过。
 */
export async function submitClaimWithApproval(
  input: ClaimSubmissionInput,
  deps: ClaimSubmissionDeps,
): Promise<ClaimSubmissionResult> {
  assertPermission(input.role, 'claimTrackingApprove');
  const now = deps.now ?? (() => new Date());
  const operationId = input.approvalId ? `approval:${input.approvalId}` : null;
  // claim.submit 无金额语义：审批载荷仅绑定本轮 Claim 依据
  const payload = {
    amount: null,
    currency: null,
    basisReference: input.claimId,
    evidenceArtifactId: null,
  };

  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        // B-1：案件锁（与 submitRecoveryReview 共用协议，串行化审批生命周期与提交）
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          `cc-recovery-case:${input.caseId}`,
        );
        // B-2：Claim 行锁 + 身份/租户/轮次确认
        const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM "Claim" WHERE id = $1 AND "organizationId" = $2 AND "caseId" = $3 AND round = 1 FOR UPDATE',
          input.claimId,
          input.organizationId,
          input.caseId,
        );
        if (locked.length !== 1) {
          throw new WorkflowError('NOT_FOUND', 'Claim 不存在或不属于该租户/案件');
        }
        // B-2b（MSG-20261001-04 遗留项）：锁后按**Claim 提交权限**重验「执行这一刻」的角色。
        // 禁止复用锁前 role / 锁前 permission 结论 / 审批创建时角色；只认锁后从数据库读到的当前成员角色。
        const currentMembership = await tx.membership.findFirst({
          where: {
            organizationId: input.organizationId,
            userId: input.actorUserId,
            isActive: true,
          },
          select: { role: true },
        });
        // 成员缺失/停用 → 与既有主体重验口径一致（APPROVAL_ACTOR_MISMATCH）；
        // 成员仍在但角色已不足以提交 → 权限矩阵拒绝（FORBIDDEN）。
        if (!currentMembership) {
          throw new ApprovalBoundaryError('APPROVAL_ACTOR_MISMATCH', input.claimId);
        }
        assertPermission(currentMembership.role, 'claimTrackingApprove');
        // B-3：全部必要锁取得后再生成执行时间，并在本事务内统一使用
        const at = now();
        const claim = await tx.claim.findFirst({
          where: {
            id: input.claimId,
            organizationId: input.organizationId,
            caseId: input.caseId,
            round: 1,
          },
          select: { id: true, status: true },
        });
        if (!claim) {
          throw new WorkflowError('NOT_FOUND', 'Claim 不存在或不属于该租户/案件');
        }
        // B-4：锁内完整重验（动作/目标/载荷/指纹版本/有效期/撤销/轮次/消费/审批人与执行人）
        const decision = await verifyApprovalBoundary(tx, {
          organizationId: input.organizationId,
          approvalId: input.approvalId ?? '',
          action: CLAIM_SUBMIT_ACTION,
          caseId: input.caseId,
          actorUserId: input.actorUserId,
          payload,
          now: at,
        });
        if (!decision.ok) throw new ApprovalBoundaryError(decision.reason, input.caseId);
        if (decision.consumed) throw new ApprovalBoundaryError('APPROVAL_ALREADY_CONSUMED', input.caseId);

        // A：CAS + 业务审计 + 审批消费 —— 同一事务客户端
        const cas = await tx.claim.updateMany({
          where: { id: input.claimId, organizationId: input.organizationId, status: 'DRAFT' },
          data: {
            status: 'SUBMITTED',
            submittedAt: at,
            submittedBy: input.actorUserId,
            approvedByUserId: input.actorUserId,
            approvedAt: at,
          },
        });
        if (cas.count === 0) {
          throw new WorkflowError('ILLEGAL_TRANSITION', 'Claim 状态已变化，请刷新后重试');
        }
        await insertTxAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: CLAIM_TRACKING_ACTION.submission,
          entityType: 'Claim',
          entityId: input.claimId,
          changes: {
            from: 'DRAFT',
            to: 'SUBMITTED',
            humanApproved: true,
            caseId: input.caseId,
            approvalId: input.approvalId ?? null,
            operationId,
            ...(input.note ? { note: input.note } : {}),
          },
          at,
        });
        await insertTxAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: APPROVAL_CONSUMED_EVENT_ACTION,
          entityType: 'Case',
          entityId: input.caseId,
          changes: {
            approvalId: input.approvalId ?? null,
            operationId,
            caseId: input.caseId,
            claimId: input.claimId,
            basisReference: input.claimId,
          },
          at,
        });

        return {
          caseId: input.caseId,
          claimId: input.claimId,
          status: 'SUBMITTED' as const,
          approvedAt: at.toISOString(),
          operationId,
          externalSubmission: 'NEEDS_MANUAL' as const,
          platformWriteExecuted: false as const,
        };
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  } catch (error) {
    // 锁内拒绝留痕：事务已回滚，故在事务外写入；写入失败不得覆盖原始拒绝
    if (error instanceof ApprovalBoundaryError || error instanceof WorkflowError) {
      const reason = error instanceof ApprovalBoundaryError ? error.reason : error.code;
      try {
        const row = prepareAuditInsert(
          {
            organizationId: input.organizationId,
            actorType: 'USER',
            actorUserId: input.actorUserId,
            action: CLAIM_SUBMIT_REJECTED_ACTION,
            entityType: 'Claim',
            entityId: input.claimId,
            changes: {
              caseId: input.caseId,
              claimId: input.claimId,
              approvalId: input.approvalId ?? null,
              operationId,
              stage: 'LOCKED_RECHECK',
              reason,
              result: 'REJECTED',
            },
          },
          { maxStringLength: 512 },
        );
        await deps.prisma.auditLog.create({
          data: {
            organizationId: row.organizationId,
            actorType: row.actorType,
            actorUserId: row.actorUserId,
            actorRef: row.actorRef,
            action: row.action,
            entityType: row.entityType,
            entityId: row.entityId,
            changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
            ip: row.ip,
            userAgent: row.userAgent,
          },
        });
      } catch {
        // 审计不可用不改变拒绝判定
      }
    }
    throw error;
  }
}
