/**
 * CLAIM 内部准备写入 —— 受保护动作 `claim.prepare`（Gate 7 / ② 下一小批次 · INTERNAL_WRITE）
 * ---------------------------------------------------------------------------------------
 * 依据 MSG-20261001-07 §6（批次范围）与 MSG-20261001-08 CHANGE A/B（并发与锁后权限）：
 *   - 能力闸门（Kill Switch scope=workflow + 动作 feature + 控制面模式允许 INTERNAL_WRITE），**无人审批**；
 *   - 准备事务**先取与提交服务一致的案件锁** `cc-recovery-case:${caseId}`，再对既有 Claim 取行锁；
 *   - **取得案件锁与 Claim 行锁之后**重读主体（ACTIVE 用户 + 有效 Membership + 当前角色）并重新裁决本动作权限；
 *   - 更新使用带租户/案件/round=1/status=DRAFT 条件的 CAS，恰一行才算成功；
 *   - 业务写入与 `claim.prepared` 审计同一事务，审计失败整笔回滚；
 *   - 只写业务库：不调用平台适配器写入面、不产生资金对象、不推进 Claim 状态。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { ApprovalBoundaryError } from '../action-guard/approval-tx-verify';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';

/** 受保护动作名（与 ACTION_GUARD_CATALOG 保持一致） */
export const CLAIM_PREPARE_ACTION = 'claim.prepare';
/** 内部准备写入的业务审计动作 */
export const CLAIM_PREPARED_ACTION = 'claim.prepared';

export const CLAIM_PREPARE_TARGETS = [
  'PLATFORM',
  'CARRIER',
  'FREIGHT_FORWARDER',
  'INSURER',
  'CUSTOMS_AUTHORITY',
  'CUSTOMS_BROKER',
  'CUSTOMER_SELF',
  'NONE',
] as const;
export type ClaimPrepareTarget = (typeof CLAIM_PREPARE_TARGETS)[number];

const MAX_DRAFT_CHARS = 20_000;

export interface ClaimPreparationInput {
  organizationId: string;
  actorUserId: string;
  /** 会话内已解析的角色；仅作事务前快速拒绝，最终裁决在锁后用数据库当前角色执行 */
  role: string;
  caseId: string;
  /** 路由目标（RouteTarget 枚举的合法取值） */
  target: string;
  /** AI / 人工准备的草稿正文 */
  draftText: string;
}

export interface ClaimPreparationResult {
  caseId: string;
  claimId: string;
  round: 1;
  status: 'DRAFT';
  target: ClaimPrepareTarget;
  /** true = 本次新建草稿；false = 就既有 DRAFT 草稿更新 */
  created: boolean;
  preparedAt: string;
  /** 内部准备写入恒不触达平台 */
  platformWriteExecuted: false;
  externalSubmission: 'NOT_ATTEMPTED';
}

export interface ClaimPreparationDeps {
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

function normalizeTarget(raw: unknown): ClaimPrepareTarget {
  const target = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!(CLAIM_PREPARE_TARGETS as readonly string[]).includes(target)) {
    throw new WorkflowError('INVALID_FIELD', 'claim.prepare 需要合法的 target');
  }
  return target as ClaimPrepareTarget;
}

function normalizeDraftText(raw: unknown): string {
  const draftText = String(raw ?? '').trim();
  if (draftText === '' || draftText.length > MAX_DRAFT_CHARS) {
    throw new WorkflowError('INVALID_FIELD', `claim.prepare 需要非空且不超过 ${MAX_DRAFT_CHARS} 字符的 draftText`);
  }
  return draftText;
}

/**
 * 受保护的内部准备写入（唯一执行入口）。
 * 前置：调用方已完成 Action Guard 能力闸门（`claim.prepare`，INTERNAL_WRITE，无人工审批）。
 * 纪律：锁前权限检查只是快速拒绝；**最终裁决在案件锁 + Claim 行锁之后按数据库当前角色执行**。
 */
export async function prepareClaimDraft(
  input: ClaimPreparationInput,
  deps: ClaimPreparationDeps,
): Promise<ClaimPreparationResult> {
  // 快速拒绝（不能替代锁后重验）
  assertPermission(input.role, 'claimTrackingApprove');
  const target = normalizeTarget(input.target);
  const draftText = normalizeDraftText(input.draftText);
  const now = deps.now ?? (() => new Date());

  return deps.prisma.$transaction(
    async (tx) => {
      // A-1：案件锁（与 submitRecoveryReview / claim.submit 同一协议）——串行化「提交」与「准备」
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `cc-recovery-case:${input.caseId}`,
      );

      // A-2：租户隔离：案件必须属于调用方租户，否则一律 NOT_FOUND
      const kase = await tx.case.findFirst({
        where: { id: input.caseId, organizationId: input.organizationId },
        select: { id: true },
      });
      if (!kase) throw new WorkflowError('NOT_FOUND', '案件不存在或不属于该租户');

      // A-3：既有 Claim 行锁（与提交服务同一顺序：案件锁 → 行锁；限定租户/案件/round=1）
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        'SELECT id, status FROM "Claim" WHERE "organizationId" = $1 AND "caseId" = $2 AND round = 1 FOR UPDATE',
        input.organizationId,
        input.caseId,
      );

      // B（MSG-20261001-09 CHANGE B）：**最终**主体与权限重验必须在「案件锁 + Claim 行锁」之后、任何业务写入之前。
      // 锁前 assertPermission 仅为快速拒绝，不能替代本处裁决；等待行锁期间发生的角色降权/成员停用/用户停用在此被拦下。
      const actor = await tx.user.findFirst({
        where: { id: input.actorUserId, status: 'ACTIVE' },
        select: { id: true },
      });
      const membership = await tx.membership.findFirst({
        where: { organizationId: input.organizationId, userId: input.actorUserId, isActive: true },
        select: { role: true },
      });
      // 主体失效（用户停用/成员停用或缺失）→ 稳定且明确的拒绝原因
      if (!actor || !membership) throw new ApprovalBoundaryError('APPROVAL_ACTOR_MISMATCH', input.caseId);
      // 权限不足（角色降权）→ 与 claim.submit 一致的权限矩阵拒绝
      assertPermission(membership.role, 'claimTrackingApprove');

      // 全部必要锁与锁后校验完成后才生成执行时间
      const at = now();
      let claimId: string;
      let created: boolean;

      if (locked.length > 0) {
        // A-4：带租户/案件/round=1/status=DRAFT 条件的 CAS，恰一行才算成功
        const cas = await tx.claim.updateMany({
          where: {
            id: locked[0]!.id,
            organizationId: input.organizationId,
            caseId: input.caseId,
            round: 1,
            status: 'DRAFT',
          },
          data: { target, aiDraftText: draftText },
        });
        if (cas.count !== 1) {
          throw new WorkflowError('ILLEGAL_TRANSITION', 'Claim 已离开 DRAFT，不能再准备草稿');
        }
        claimId = locked[0]!.id;
        created = false;
      } else {
        // A-5：无草稿也在案件锁内重新确认不存在（上面的行锁查询即确认），再创建
        const applied = await tx.claim.create({
          data: {
            organizationId: input.organizationId,
            caseId: input.caseId,
            round: 1,
            status: 'DRAFT',
            target,
            aiDraftText: draftText,
          },
          select: { id: true },
        });
        claimId = applied.id;
        created = true;
      }

      await insertTxAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: CLAIM_PREPARED_ACTION,
        entityType: 'Claim',
        entityId: claimId,
        changes: {
          caseId: input.caseId,
          claimId,
          round: 1,
          target,
          created,
          draftChars: draftText.length,
        },
        at,
      });

      return {
        caseId: input.caseId,
        claimId,
        round: 1 as const,
        // 仅当上面的 CAS / 创建真正成功才会返回（不存在「状态不符仍宣称 DRAFT」的路径）
        status: 'DRAFT' as const,
        target,
        created,
        preparedAt: at.toISOString(),
        platformWriteExecuted: false as const,
        externalSubmission: 'NOT_ATTEMPTED' as const,
      };
    },
    { timeout: 30_000, maxWait: 30_000 },
  );
}
