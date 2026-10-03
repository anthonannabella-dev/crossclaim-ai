/**
 * APPEAL 人工提交 —— 受保护动作 `appeal.submit` 的原子提交服务
 * （Gate 7 / ② 下一小批次 · MSG-20261001-14 §5）
 * ------------------------------------------------------------------
 * 纪律（逐条对应裁决）：
 *   - 独立动作：`appeal.submit` 与 `claim.submit` **互不通用**；审批必须绑定具体 Appeal 与案件，
 *     载荷指纹使用 basisReference = appealId；
 *   - 锁顺序：案件锁 `cc-recovery-case:${caseId}`（与提交/准备/账单共用协议）→ Appeal 行锁（round=2，
 *     限定租户/案件）→ **锁后**重读 ACTIVE 用户、有效 Membership 与当前角色并重验权限；
 *   - 内部提交记录（Appeal DRAFT→SUBMITTED + submittedAt）、成功业务审计（appeal.submitted_by_human）
 *     与审批消费（recovery.approval_consumed）在**同一事务**完成；任一失败整笔回滚；
 *   - 拒绝零推进；拒绝留痕在事务回滚后写入且**不覆盖原始错误**；
 *   - 本批**仅登记内部提交结果**：返回人工后续状态（NEEDS_MANUAL）与 platformWriteExecuted=false，
 *     **不调用任何平台写入面**，也不产生资金动作。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import {
  APPROVAL_CONSUMED_EVENT_ACTION,
  ApprovalBoundaryError,
  verifyApprovalBoundary,
} from '../action-guard/approval-tx-verify';
import { APPEAL_SUBMIT_ACTION } from '../action-guard/approval-verifier';
import { buildAppealSubmissionSnapshot, appealSubmissionDigest } from './appeal-snapshot';
import { WorkflowError } from '../workflow/opportunity-review';
import { ForbiddenError, assertPermission } from '../workflow/permissions';

/** 锁内拒绝留痕（事务回滚后写入；不含敏感取值） */
export const APPEAL_SUBMIT_REJECTED_ACTION = 'appeal.submit_rejected';
/** 成功提交的业务审计动作 */
export const APPEAL_SUBMITTED_ACTION = 'appeal.submitted_by_human';

export interface AppealSubmissionInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  caseId: string;
  /** 本轮要提交的 Appeal（round=2） */
  appealId: string;
  approvalId?: string;
  note?: string;
}

export interface AppealSubmissionResult {
  caseId: string;
  appealId: string;
  status: 'SUBMITTED';
  submittedAt: string;
  operationId: string | null;
  /** 提交恒为人工卡口：未发生任何平台外写 */
  externalSubmission: 'NEEDS_MANUAL';
  platformWriteExecuted: false;
}

export interface AppealSubmissionDeps {
  prisma: PrismaClient;
  now?: () => Date;
}

type TxClient = Prisma.TransactionClient;

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
 * 受保护的 Appeal 人工提交（唯一执行入口）。
 * 前置：调用方已完成 Action Guard + HITL 审批边界（事务外只读校验）。
 */
export async function submitAppealWithApproval(
  input: AppealSubmissionInput,
  deps: AppealSubmissionDeps,
): Promise<AppealSubmissionResult> {
  // 快速拒绝（不能替代锁后重验）
  assertPermission(input.role, 'claimTrackingApprove');
  const now = deps.now ?? (() => new Date());
  const operationId = input.approvalId ? `approval:${input.approvalId}` : null;
  // CHANGE A：审批载荷绑定「服务端提交快照摘要」，在 Appeal 行锁后重算（见事务内 B-A 步骤）

  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        // 1) 案件锁（与 claim.submit / claim.prepare / billing.draft 共用协议）
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          `cc-recovery-case:${input.caseId}`,
        );

        // 2) Appeal 行锁（限定租户/案件；round=2）
        // CHANGE B：行锁必须携带轮次（本批次仅 round=2），并核对关联 Claim 属于同租户同案件
        const locked = await tx.$queryRawUnsafe<
          Array<{ id: string; status: string; round: number; claimId: string }>
        >(
          'SELECT id, status, round, "claimId" FROM "Appeal" WHERE id = $1 AND "organizationId" = $2 AND "caseId" = $3 AND round = 2 FOR UPDATE',
          input.appealId,
          input.organizationId,
          input.caseId,
        );
        if (locked.length !== 1) {
          throw new WorkflowError('NOT_FOUND', 'Appeal 不存在、不属于该租户/案件，或不是 round=2');
        }
        const linkedClaim = await tx.claim.findFirst({
          where: { id: locked[0]!.claimId, organizationId: input.organizationId, caseId: input.caseId },
          select: { id: true, round: true },
        });
        if (!linkedClaim) {
          throw new WorkflowError('NOT_FOUND', 'Appeal 关联的 Claim 不属于同一租户/案件');
        }

        // 3) 锁后**最终**主体与权限重验
        const actor = await tx.user.findFirst({
          where: { id: input.actorUserId, status: 'ACTIVE' },
          select: { id: true },
        });
        const membership = await tx.membership.findFirst({
          where: { organizationId: input.organizationId, userId: input.actorUserId, isActive: true },
          select: { role: true },
        });
        if (!actor || !membership) throw new ApprovalBoundaryError('APPROVAL_ACTOR_MISMATCH', input.caseId);
        assertPermission(membership.role, 'claimTrackingApprove');

        // B-A（CHANGE A）：锁后重读正文，按服务端规则构造快照；空正文失败关闭
        const appealRow = await tx.appeal.findUniqueOrThrow({
          where: { id: input.appealId },
          select: { id: true, caseId: true, claimId: true, round: true, finalText: true, aiDraftText: true },
        });
        const snapshot = buildAppealSubmissionSnapshot({
          appealId: appealRow.id,
          caseId: appealRow.caseId,
          claimId: appealRow.claimId,
          round: appealRow.round,
          finalText: appealRow.finalText,
          aiDraftText: appealRow.aiDraftText,
        });
        if (!snapshot) throw new WorkflowError('APPEAL_BODY_REQUIRED', 'Appeal 正文为空，不能作为有效提交内容');
        // 审批必须绑定该快照摘要（审批创建与执行核验同一规范化算法）
        const payload = {
          amount: null,
          currency: null,
          basisReference: appealSubmissionDigest(snapshot),
          evidenceArtifactId: null,
        };

        // 4) 全部必要锁取得后生成执行时间
        const at = now();

        // 5) 锁内完整重验（动作/目标/载荷/指纹版本/有效期/撤销/轮次/消费/审批人与执行人）
        const decision = await verifyApprovalBoundary(tx, {
          organizationId: input.organizationId,
          approvalId: input.approvalId ?? '',
          action: APPEAL_SUBMIT_ACTION,
          caseId: input.caseId,
          actorUserId: input.actorUserId,
          payload,
          now: at,
        });
        if (!decision.ok) throw new ApprovalBoundaryError(decision.reason, input.caseId);
        if (decision.consumed) throw new ApprovalBoundaryError('APPROVAL_ALREADY_CONSUMED', input.caseId);

        // 6) CAS：Appeal DRAFT → SUBMITTED（仅内部登记，不触达平台）
        // CHANGE B：CAS 必须携带案件与轮次（影响行数恰为 1）
        const cas = await tx.appeal.updateMany({
          where: {
            id: input.appealId,
            organizationId: input.organizationId,
            caseId: input.caseId,
            claimId: locked[0]!.claimId,
            round: 2,
            status: 'DRAFT',
          },
          data: { status: 'SUBMITTED', submittedAt: at },
        });
        if (cas.count === 0) {
          throw new WorkflowError('ILLEGAL_TRANSITION', 'Appeal 状态已变化，请刷新后重试');
        }

        // 7) 成功业务审计 + 审批消费（同一事务客户端）
        await insertTxAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: APPEAL_SUBMITTED_ACTION,
          entityType: 'Appeal',
          entityId: input.appealId,
          changes: {
            from: 'DRAFT',
            to: 'SUBMITTED',
            humanApproved: true,
            caseId: input.caseId,
            appealId: input.appealId,
            claimId: locked[0]!.claimId,
            round: 2,
            snapshotVersion: snapshot.version,
            snapshotDigest: payload.basisReference,
            bodyRule: snapshot.bodyRule,
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
            appealId: input.appealId,
            claimId: locked[0]!.claimId,
            round: 2,
            basisReference: input.appealId,
          },
          at,
        });

        return {
          caseId: input.caseId,
          appealId: input.appealId,
          status: 'SUBMITTED' as const,
          submittedAt: at.toISOString(),
          operationId,
          externalSubmission: 'NEEDS_MANUAL' as const,
          platformWriteExecuted: false as const,
        };
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  } catch (error) {
    // 锁内拒绝留痕：事务已回滚，故在事务外写入；写入失败不得覆盖原始拒绝
    if (
      error instanceof ApprovalBoundaryError ||
      error instanceof WorkflowError ||
      error instanceof ForbiddenError
    ) {
      const reason =
        error instanceof ApprovalBoundaryError
          ? error.reason
          : error instanceof ForbiddenError
            ? 'FORBIDDEN'
            : error.code;
      try {
        const row = prepareAuditInsert(
          {
            organizationId: input.organizationId,
            actorType: 'USER',
            actorUserId: input.actorUserId,
            action: APPEAL_SUBMIT_REJECTED_ACTION,
            entityType: 'Appeal',
            entityId: input.appealId,
            changes: {
              caseId: input.caseId,
              appealId: input.appealId,
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
