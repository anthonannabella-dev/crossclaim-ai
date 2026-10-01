/**
 * R43 S3 —— 人工追回提交（`recovery.manual_submit`）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261001-34（S2 关闭后批准进入 S3）。严格实现以下顺序（同一事务）：
 *   1) case advisory lock
 *   2) ClaimItem FOR UPDATE（租户 + 案件绑定）
 *   3) 锁后重读**当前** ACTIVE user / membership / role（禁止复用锁前结论）
 *   4) 确认 ClaimItem.status == READY_TO_APPEAL
 *   5) 锁定并重读目标 RecoveryPackage
 *   6) package 必须非 SUPERSEDED / WITHDRAWN
 *   7) 服务端重新构造 versioned basis（唯一 builder）
 *   8) verifyApprovalBoundary(recovery.manual_submit)
 *   9) CAS READY_TO_APPEAL → SUBMITTED_MANUAL
 *  10) INSERT RecoveryManualSubmission
 *  11) INSERT submission evidence links
 *  12) write recovery.manual_submitted
 *  13) write recovery.approval_consumed
 *  14) 同一事务 commit
 * 任一步失败：ClaimItem 不推进 · submission 不创建 · approval 不消费。
 * 拒绝审计在主事务回滚后独立写入，且不得覆盖原始领域错误。
 *
 * 明确不做（S4/S5 范围）：providerCaseRef 后补、outcome tracking、reconciliation、
 * Settlement/Billing 联动、任何平台外写。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import {
  APPROVAL_CONSUMED_EVENT_ACTION,
  ApprovalBoundaryError,
  verifyApprovalBoundary,
} from '../action-guard/approval-tx-verify';
import { RECOVERY_MANUAL_SUBMIT_ACTION } from '../action-guard/approval-verifier';
import { WorkflowError } from '../workflow/opportunity-review';
import { ForbiddenError, assertPermission } from '../workflow/permissions';
import { buildRecoveryPackageBasisReference } from './recovery-package';

/** 成功业务审计（人工确认提交这一事实的审计证据） */
export const RECOVERY_MANUAL_SUBMITTED_ACTION = 'recovery.manual_submitted';
/** 锁内拒绝留痕（事务回滚后写入） */
export const RECOVERY_MANUAL_SUBMIT_REJECTED_ACTION = 'recovery.manual_submit_rejected';

const TERMINAL_PACKAGE_STATUSES = ['SUPERSEDED', 'WITHDRAWN'] as const;
const ALLOWED_SOURCE_STATUS = 'READY_TO_APPEAL';

export interface ManualRecoverySubmitInput {
  organizationId: string;
  /** HTTP 层解析出的角色（仅用于**锁前**快速失败；锁内必须用数据库当前角色重验） */
  role: string;
  actorUserId: string;
  claimItemId: string;
  /** 客户端声明的目标 package id（不可信：锁内必须重读并校验归属/状态/digest） */
  packageId: string;
  approvalId?: string;
  evidenceIds?: string[];
  note?: string;
  idempotencyKey?: string;
}

export interface ManualRecoverySubmitResult {
  claimItemId: string;
  submissionId: string;
  caseId: string;
  packageId: string;
  packageDigest: string;
  approvalBasisReference: string;
  status: 'SUBMITTED_MANUAL';
  submittedAt: string;
  operationId: string | null;
  /** 人工提交恒为人工卡口：未发生任何平台外写 */
  externalSubmission: 'NEEDS_MANUAL';
  platformWriteExecuted: false;
}

export interface ManualRecoverySubmitDeps {
  prisma: PrismaClient;
  now?: () => Date;
  /** 事务超时（默认 30s，与 claim.submit 同口径） */
  transactionTimeoutMs?: number;
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
 * 受保护人工提交（唯一执行入口）。
 * 前置：调用方已完成 Action Guard + HITL 审批边界（事务外只读校验，用于快速失败与 approval_decision 审计）。
 * 本函数在**锁内**再次完整校验，保证核验后发生的过期 / 撤销 / 状态变化 / 主体失效无法绕过。
 */
export async function submitManualRecoveryWithApproval(
  input: ManualRecoverySubmitInput,
  deps: ManualRecoverySubmitDeps,
): Promise<ManualRecoverySubmitResult> {
  assertPermission(input.role, 'claimTrackingApprove');
  const now = deps.now ?? (() => new Date());
  const operationId = input.approvalId ? `approval:${input.approvalId}` : null;

  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        // 1) 先取案件 id（租户内只读），再取案件锁（与 claim.submit / submitRecoveryReview 同协议）
        const located = await tx.claimItem.findFirst({
          where: { id: input.claimItemId, organizationId: input.organizationId },
          select: { id: true, caseId: true },
        });
        if (!located || !located.caseId) {
          throw new WorkflowError('NOT_FOUND', 'NOT_FOUND: ClaimItem 不存在或不属于该租户，或缺少案件绑定');
        }
        const caseId = located.caseId;
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          `cc-recovery-case:${caseId}`,
        );

        // 2) ClaimItem 行锁 + 身份/租户/案件确认
        const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: string; caseId: string | null }>>(
          'SELECT id, status, "caseId" FROM "ClaimItem" WHERE id = $1 AND "organizationId" = $2 AND "caseId" = $3 FOR UPDATE',
          input.claimItemId,
          input.organizationId,
          caseId,
        );
        if (locked.length !== 1) {
          throw new WorkflowError('NOT_FOUND', 'NOT_FOUND: ClaimItem 不存在或不属于该租户/案件');
        }

        // 3) 锁后按**当前**成员状态与角色重验执行人（只认数据库现值）
        const currentMembership = await tx.membership.findFirst({
          where: { organizationId: input.organizationId, userId: input.actorUserId, isActive: true },
          select: { role: true },
        });
        if (!currentMembership) {
          throw new ApprovalBoundaryError('APPROVAL_ACTOR_MISMATCH', caseId);
        }
        assertPermission(currentMembership.role, 'claimTrackingApprove');

        // 4) 源状态必须是 READY_TO_APPEAL（唯一前置）
        if (locked[0].status !== ALLOWED_SOURCE_STATUS) {
          throw new WorkflowError(
            'ILLEGAL_TRANSITION',
            'ILLEGAL_TRANSITION: ClaimItem 状态必须为 ' + ALLOWED_SOURCE_STATUS + '，当前为 ' + locked[0].status,
          );
        }

        // 5) 锁定并重读目标 package（客户端声明的 id 不可信）
        const packageRows = await tx.$queryRawUnsafe<
          Array<{
            id: string;
            claimItemId: string;
            caseId: string | null;
            packageVersion: string;
            digestVersion: string;
            packageDigest: string;
            status: string;
          }>
        >(
          'SELECT id, "claimItemId", "caseId", "packageVersion", "digestVersion", "packageDigest", status FROM "RecoveryPackage" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE',
          input.packageId,
          input.organizationId,
        );
        if (packageRows.length !== 1) {
          throw new WorkflowError('NOT_FOUND', 'NOT_FOUND: RecoveryPackage 不存在或不属于该租户');
        }
        const pkg = packageRows[0];
        if (pkg.claimItemId !== input.claimItemId || (pkg.caseId ?? null) !== caseId) {
          throw new WorkflowError('ILLEGAL_TRANSITION', 'ILLEGAL_TRANSITION: RecoveryPackage 与 ClaimItem/Case 绑定不一致');
        }
        // 6) 终态 package 不得用于人工提交
        if ((TERMINAL_PACKAGE_STATUSES as readonly string[]).includes(pkg.status)) {
          throw new WorkflowError('ILLEGAL_TRANSITION', 'ILLEGAL_TRANSITION: RecoveryPackage 已是终态：' + pkg.status);
        }

        const at = now();
        // 7) 服务端重新构造 versioned basis（唯一 builder；不接受客户端传入）
        const basisReference = buildRecoveryPackageBasisReference({
          claimItemId: pkg.claimItemId,
          caseId,
          packageVersion: pkg.packageVersion,
          digestVersion: pkg.digestVersion,
          packageDigest: pkg.packageDigest,
        });

        // 8) 锁内完整审批重验（动作 / 目标 / 载荷 / 额外指纹 / 有效期 / 撤销 / 消费）
        const decision = await verifyApprovalBoundary(tx, {
          organizationId: input.organizationId,
          approvalId: input.approvalId ?? '',
          action: RECOVERY_MANUAL_SUBMIT_ACTION,
          caseId,
          actorUserId: input.actorUserId,
          payload: {
            amount: null,
            currency: null,
            basisReference,
            evidenceArtifactId: null,
          },
          now: at,
          extra: {
            claimItemId: pkg.claimItemId,
            caseId,
            packageVersion: pkg.packageVersion,
            digestVersion: pkg.digestVersion,
            packageDigest: pkg.packageDigest,
          },
        });
        if (!decision.ok) throw new ApprovalBoundaryError(decision.reason, caseId);
        if (decision.consumed) throw new ApprovalBoundaryError('APPROVAL_ALREADY_CONSUMED', caseId);

        // 9) CAS：状态跃迁与后续写入同一事务
        const cas = await tx.claimItem.updateMany({
          where: {
            id: input.claimItemId,
            organizationId: input.organizationId,
            caseId,
            status: ALLOWED_SOURCE_STATUS,
          },
          data: { status: 'SUBMITTED_MANUAL', updatedAt: at },
        });
        if (cas.count === 0) {
          throw new WorkflowError('ILLEGAL_TRANSITION', 'ILLEGAL_TRANSITION: ClaimItem 状态已变化，请刷新后重试');
        }

        // 10) 提交事实（append-only）
        const submission = await tx.recoveryManualSubmission.create({
          data: {
            organizationId: input.organizationId,
            claimItemId: input.claimItemId,
            caseId,
            packageId: pkg.id,
            packageDigest: pkg.packageDigest,
            approvalId: input.approvalId as string,
            approvalBasisReference: basisReference,
            submittedAt: at,
            submittedByUserId: input.actorUserId,
            idempotencyKey: input.idempotencyKey ?? 'rms1-' + input.claimItemId,
            ...(input.note ? { note: input.note } : {}),
          },
          select: { id: true },
        });

        // 11) 提交证据引用（只引用既有 EvidenceArtifact；同租户校验）
        const evidenceIds = [...new Set(input.evidenceIds ?? [])];
        if (evidenceIds.length > 0) {
          const owned = await tx.evidenceArtifact.findMany({
            where: { id: { in: evidenceIds }, organizationId: input.organizationId },
            select: { id: true },
          });
          if (owned.length !== evidenceIds.length) {
            throw new WorkflowError('NOT_FOUND', 'NOT_FOUND: 提交证据包含不存在或不属于该租户的引用');
          }
          for (const evidenceId of evidenceIds) {
            await tx.recoveryManualSubmissionEvidence.create({
              data: {
                organizationId: input.organizationId,
                submissionId: submission.id,
                evidenceId,
                createdAt: at,
              },
            });
          }
        }

        // 12) 业务审计
        await insertTxAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: RECOVERY_MANUAL_SUBMITTED_ACTION,
          entityType: 'ClaimItem',
          entityId: input.claimItemId,
          changes: {
            from: ALLOWED_SOURCE_STATUS,
            to: 'SUBMITTED_MANUAL',
            caseId,
            packageId: pkg.id,
            packageVersion: pkg.packageVersion,
            digestVersion: pkg.digestVersion,
            packageDigest: pkg.packageDigest,
            approvalId: input.approvalId ?? null,
            operationId,
            submissionId: submission.id,
            evidenceCount: evidenceIds.length,
            ...(input.note ? { note: input.note } : {}),
          },
          at,
        });
        // 13) 审批消费（同事务事实）
        await insertTxAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: APPROVAL_CONSUMED_EVENT_ACTION,
          entityType: 'Case',
          entityId: caseId,
          changes: {
            approvalId: input.approvalId ?? null,
            operationId,
            caseId,
            claimItemId: input.claimItemId,
            packageId: pkg.id,
            basisReference,
          },
          at,
        });

        return {
          claimItemId: input.claimItemId,
          submissionId: submission.id,
          caseId,
          packageId: pkg.id,
          packageDigest: pkg.packageDigest,
          approvalBasisReference: basisReference,
          status: 'SUBMITTED_MANUAL' as const,
          submittedAt: at.toISOString(),
          operationId,
          externalSubmission: 'NEEDS_MANUAL' as const,
          platformWriteExecuted: false as const,
        };
      },
      { timeout: deps.transactionTimeoutMs ?? 30_000, maxWait: 30_000 },
    );
  } catch (error) {
    // 锁内拒绝留痕：主事务已回滚，故在事务外写入；写入失败不得覆盖原始拒绝
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
            action: RECOVERY_MANUAL_SUBMIT_REJECTED_ACTION,
            entityType: 'ClaimItem',
            entityId: input.claimItemId,
            changes: {
              claimItemId: input.claimItemId,
              packageId: input.packageId,
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
