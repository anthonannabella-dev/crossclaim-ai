/**
 * R43 S4 —— providerCaseRef canonical 补录（受保护动作 + append-only 事实）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261001-36（S3 关闭后批准进入 S4）。范围严格限定：
 *   已有 RecoveryManualSubmission → 受保护的 reference 补录动作 → canonicalization
 *   → RecoveryManualSubmissionReference append-only INSERT → 审计 → 读取/展示语义。
 * 12 项要求（逐条落实）：
 *   ① 不 UPDATE RecoveryManualSubmission；② raw + canonical 分开保存；
 *   ③ canonical：trim → NFKC → 去零宽 → 折叠空白（**不 lower-case**）；
 *   ④ canonical duplicate 由数据库唯一约束最终兜底；⑤ 空 reference 拒绝；
 *   ⑥ 跨 tenant / 错 submission / 非 ACTIVE membership fail-closed；
 *   ⑦ 并发补录相同 canonical ref 至多一次；⑧ 不得产生 provider accepted / reimbursed / recovered 事实；
 *   ⑨ 不改变 ClaimItem SUBMITTED_MANUAL；⑩ 不消费 recovery.manual_submit 的旧 approval；
 *   ⑪ 若需 human approval → 独立 action + 独立 approval binding；⑫ 读取/展示语义（raw + canonical 均可读）。
 * 明确不做：outcome / reimbursement reconciliation（后续独立边界）。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import {
  APPROVAL_CONSUMED_EVENT_ACTION,
  ApprovalBoundaryError,
  verifyApprovalBoundary,
} from '../action-guard/approval-tx-verify';
import { RECOVERY_MANUAL_REFERENCE_ACTION } from '../action-guard/approval-verifier';
import { WorkflowError } from '../workflow/opportunity-review';
import { ForbiddenError, assertPermission } from '../workflow/permissions';

/** 成功审计（补录事实的审计证据） */
export const RECOVERY_MANUAL_REFERENCE_RECORDED_ACTION = 'recovery.manual_submission_reference_recorded';
/** 锁内拒绝留痕（主事务回滚后独立写入） */
export const RECOVERY_MANUAL_REFERENCE_REJECTED_ACTION = 'recovery.manual_submit_reference_rejected';

/** basis 版本前缀（与 S3 的 rmp1- 区分，防止跨动作复用） */
export const RECOVERY_REFERENCE_BASIS_PREFIX = 'rmr1';

/** 零宽字符（U+200B..U+200D / U+FEFF）——canonical 化时剔除 */
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;
const WHITESPACE_RUN = /\s+/g;

export class ManualReferenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'ManualReferenceError';
    this.code = code;
  }
}

/**
 * canonical 化：trim → NFKC → 去零宽 → 折叠空白。
 * **不做大小写折叠**（MSG-20261001-31 ④ / MSG-20261001-36 RISKS：Amazon 大小写语义未获官方证明）。
 */
export function canonicalizeProviderCaseRef(raw: string): string {
  if (typeof raw !== 'string') {
    throw new ManualReferenceError('REFERENCE_REQUIRED', 'provider case reference 必须是字符串');
  }
  const canonical = raw
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  if (canonical.length === 0) {
    throw new ManualReferenceError('REFERENCE_EMPTY', 'provider case reference 不得为空');
  }
  return canonical;
}

/**
 * 独立 approval binding builder（MSG-20261001-36 ⑪）：
 * 与 S3 的 `rmp1:…` 完全分离，禁止复用 recovery.manual_submit 的审批。
 */
export function buildRecoveryReferenceBasisReference(input: {
  submissionId: string;
  claimItemId: string;
  providerCaseRefCanonical: string;
}): string {
  return [
    RECOVERY_REFERENCE_BASIS_PREFIX,
    input.submissionId,
    input.claimItemId,
    input.providerCaseRefCanonical,
  ].join(':');
}

export interface RecordManualReferenceInput {
  organizationId: string;
  /** HTTP 层解析出的角色（仅锁前快速失败；锁内以数据库当前角色重验） */
  role: string;
  actorUserId: string;
  submissionId: string;
  /** 用户原始输入（展示 / 审计）；canonical 由服务端计算 */
  providerCaseRefRaw: string;
  approvalId?: string;
  note?: string;
}

export interface RecordManualReferenceResult {
  referenceId: string;
  submissionId: string;
  claimItemId: string;
  providerCaseRefRaw: string;
  providerCaseRefCanonical: string;
  recordedAt: string;
  approvalBasisReference: string;
  /** 补录恒不产生 provider 受理/赔付语义 */
  providerAccepted: false;
  platformWriteExecuted: false;
}

export interface RecordManualReferenceDeps {
  prisma: PrismaClient;
  now?: () => Date;
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
): Promise<void> {
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
  await tx.auditLog.create({
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
  });
}

/**
 * 受保护 reference 补录（唯一执行入口）。失败一律 fail-closed；
 * 不修改 RecoveryManualSubmission / ClaimItem，不消费 S3 审批。
 */
export async function recordManualRecoveryReference(
  input: RecordManualReferenceInput,
  deps: RecordManualReferenceDeps,
): Promise<RecordManualReferenceResult> {
  assertPermission(input.role, 'claimTrackingApprove');
  const now = deps.now ?? (() => new Date());
  const canonical = canonicalizeProviderCaseRef(input.providerCaseRefRaw);
  const operationId = input.approvalId ? `approval:${input.approvalId}` : null;
  let resolvedCaseId: string | null = null;
  let resolvedClaimItemId: string | null = null;

  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        // 1) 只读定位 submission（租户内）+ 案件绑定
        const located = await tx.recoveryManualSubmission.findFirst({
          where: { id: input.submissionId, organizationId: input.organizationId },
          select: { id: true, caseId: true, claimItemId: true, submittedByUserId: true },
        });
        if (!located) {
          throw new WorkflowError('NOT_FOUND', 'NOT_FOUND: RecoveryManualSubmission 不存在或不属于该租户');
        }
        resolvedCaseId = located.caseId;
        resolvedClaimItemId = located.claimItemId;

        // 2) 案件锁（与 S3 同协议）
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-recovery-case:${located.caseId}`);

        // 3) 锁后重读 submission（FOR UPDATE；仅校验，**绝不 UPDATE**）
        const locked = await tx.$queryRawUnsafe<Array<{ id: string; caseId: string; claimItemId: string }>>(
          'SELECT id, "caseId", "claimItemId" FROM "RecoveryManualSubmission" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE',
          input.submissionId,
          input.organizationId,
        );
        if (locked.length !== 1) {
          throw new WorkflowError('NOT_FOUND', 'NOT_FOUND: RecoveryManualSubmission 不存在或不属于该租户');
        }

        // 4) 锁后按当前成员状态与角色重验执行人
        const membership = await tx.membership.findFirst({
          where: { organizationId: input.organizationId, userId: input.actorUserId, isActive: true },
          select: { role: true },
        });
        if (!membership) throw new ApprovalBoundaryError('APPROVAL_ACTOR_MISMATCH', located.caseId);
        assertPermission(membership.role, 'claimTrackingApprove');

        const at = now();
        const basisReference = buildRecoveryReferenceBasisReference({
          submissionId: located.id,
          claimItemId: located.claimItemId,
          providerCaseRefCanonical: canonical,
        });

        // 5) 独立动作 + 独立 binding：S3 的 approval 在此必然 ACTION_MISMATCH
        const decision = await verifyApprovalBoundary(tx, {
          organizationId: input.organizationId,
          approvalId: input.approvalId ?? '',
          action: RECOVERY_MANUAL_REFERENCE_ACTION,
          caseId: located.caseId,
          actorUserId: input.actorUserId,
          payload: { amount: null, currency: null, basisReference, evidenceArtifactId: null },
          now: at,
          extra: {
            submissionId: located.id,
            claimItemId: located.claimItemId,
            providerCaseRefCanonical: canonical,
          },
        });
        if (!decision.ok) throw new ApprovalBoundaryError(decision.reason, located.caseId);
        if (decision.consumed) throw new ApprovalBoundaryError('APPROVAL_ALREADY_CONSUMED', located.caseId);

        // 6) append-only INSERT（DB 唯一约束兜底 canonical 重复）
        let referenceId = '';
        try {
          const row = await tx.recoveryManualSubmissionReference.create({
            data: {
              organizationId: input.organizationId,
              submissionId: located.id,
              providerCaseRefRaw: input.providerCaseRefRaw,
              providerCaseRefCanonical: canonical,
              approvalId: input.approvalId ?? null,
              recordedAt: at,
              recordedByUserId: input.actorUserId,
              ...(input.note ? { note: input.note } : {}),
            },
            select: { id: true },
          });
          referenceId = row.id;
        } catch (error) {
          if (String((error as Error).message).includes('Unique constraint')) {
            throw new ManualReferenceError(
              'PROVIDER_CASE_REF_CONFLICT',
              '同一租户内该 canonical provider case reference 已被补录',
            );
          }
          throw error;
        }

        // 7) 审计（同事务）
        await insertTxAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: RECOVERY_MANUAL_REFERENCE_RECORDED_ACTION,
          entityType: 'RecoveryManualSubmission',
          entityId: located.id,
          changes: {
            referenceId,
            claimItemId: located.claimItemId,
            caseId: located.caseId,
            providerCaseRefCanonical: canonical,
            approvalId: input.approvalId ?? null,
            operationId,
            basisReference,
            providerAccepted: false,
          },
          at,
        });
        // 8) 消费**本动作**的审批（与 S3 的消费事件同名但 approvalId 不同；不触碰 S3 审批）
        await insertTxAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: APPROVAL_CONSUMED_EVENT_ACTION,
          entityType: 'Case',
          entityId: located.caseId,
          changes: {
            approvalId: input.approvalId ?? null,
            operationId,
            caseId: located.caseId,
            claimItemId: located.claimItemId,
            submissionId: located.id,
            basisReference,
          },
          at,
        });

        return {
          referenceId,
          submissionId: located.id,
          claimItemId: located.claimItemId,
          providerCaseRefRaw: input.providerCaseRefRaw,
          providerCaseRefCanonical: canonical,
          recordedAt: at.toISOString(),
          approvalBasisReference: basisReference,
          providerAccepted: false as const,
          platformWriteExecuted: false as const,
        };
      },
      { timeout: deps.transactionTimeoutMs ?? 30_000, maxWait: 30_000 },
    );
  } catch (error) {
    if (
      error instanceof ApprovalBoundaryError ||
      error instanceof WorkflowError ||
      error instanceof ForbiddenError ||
      error instanceof ManualReferenceError
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
            action: RECOVERY_MANUAL_REFERENCE_REJECTED_ACTION,
            entityType: 'RecoveryManualSubmission',
            entityId: input.submissionId,
            changes: {
              submissionId: input.submissionId,
              claimItemId: resolvedClaimItemId,
              caseId: resolvedCaseId,
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
