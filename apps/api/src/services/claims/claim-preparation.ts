/**
 * CLAIM 内部准备写入 —— 受保护动作 `claim.prepare`（Gate 7 / ② 下一小批次 · INTERNAL_WRITE）
 * ---------------------------------------------------------------------------------------
 * 依据 MSG-20261001-07 §6：本批次把「内部准备写入」接入 Action Guard，**不引入人工审批**，
 * 只要求能力闸门（Kill Switch scope=workflow + 动作 feature + 控制面模式允许 INTERNAL_WRITE）。
 *
 * 纪律：
 *   - 入口必须先经 Action Guard 断言（路由层），本服务只在**放行后**执行；
 *   - 业务权限与 claim.submit 同一口径（claimTrackingApprove），非提交者不能准备草稿；
 *   - 案件与 Claim 一律按 organizationId 限定（跨租户一律 NOT_FOUND，不泄露存在性）；
 *   - 业务写入与业务审计（claim.prepared）在**同一事务**完成：审计失败 → 整笔回滚；
 *   - 只写业务库：不调用任何平台适配器写入面，不产生资金对象，也**不推进** Claim 状态。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
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
  /** 会话内已解析的角色；权限矩阵在服务内再次裁决 */
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
 */
export async function prepareClaimDraft(
  input: ClaimPreparationInput,
  deps: ClaimPreparationDeps,
): Promise<ClaimPreparationResult> {
  assertPermission(input.role, 'claimTrackingApprove');
  const target = normalizeTarget(input.target);
  const draftText = normalizeDraftText(input.draftText);
  const now = deps.now ?? (() => new Date());

  return deps.prisma.$transaction(
    async (tx) => {
      // 租户隔离：案件必须属于调用方租户，否则一律 NOT_FOUND
      const kase = await tx.case.findFirst({
        where: { id: input.caseId, organizationId: input.organizationId },
        select: { id: true },
      });
      if (!kase) throw new WorkflowError('NOT_FOUND', '案件不存在或不属于该租户');

      // 第 1 轮草稿：存在则必须是 DRAFT（已离开 DRAFT 的 Claim 不得再准备）
      const existing = await tx.claim.findFirst({
        where: { organizationId: input.organizationId, caseId: input.caseId, round: 1 },
        select: { id: true, status: true },
      });
      if (existing && existing.status !== 'DRAFT') {
        throw new WorkflowError('ILLEGAL_TRANSITION', 'Claim 已离开 DRAFT，不能再准备草稿');
      }

      // 全部校验通过后再生成时间，并在本事务内统一使用
      const at = now();
      const claim = existing
        ? await tx.claim.update({
            where: { id: existing.id },
            data: { target, aiDraftText: draftText },
            select: { id: true, status: true },
          })
        : await tx.claim.create({
            data: {
              organizationId: input.organizationId,
              caseId: input.caseId,
              round: 1,
              status: 'DRAFT',
              target,
              aiDraftText: draftText,
            },
            select: { id: true, status: true },
          });

      await insertTxAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: CLAIM_PREPARED_ACTION,
        entityType: 'Claim',
        entityId: claim.id,
        changes: {
          caseId: input.caseId,
          claimId: claim.id,
          round: 1,
          target,
          created: !existing,
          draftChars: draftText.length,
        },
        at,
      });

      return {
        caseId: input.caseId,
        claimId: claim.id,
        round: 1 as const,
        status: 'DRAFT' as const,
        target,
        created: !existing,
        preparedAt: at.toISOString(),
        platformWriteExecuted: false as const,
        externalSubmission: 'NOT_ATTEMPTED' as const,
      };
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
}
