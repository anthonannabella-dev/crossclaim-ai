/**
 * R45 S4 —— 对账期受保护动作（第二批：人工 override / 人工 provider outcome 录入）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261002-49 ③ + S4 特别要求：
 *   - `recovery.reconciliation_override`：**每个 reimbursement fact 独立 approval**；不修改原事实；
 *     需要 reason + evidence；cross-tenant / 错误 fact binding 一律 fail-closed。
 *   - `recovery.reconciliation_provider_outcome_record`（人工录入）：
 *     `sourceKind = MANUAL_WITH_EVIDENCE`、EvidenceArtifact ≥1、每个 evidence 存在 / 同租户 / 不重复 /
 *     具备可用来源（fileAssetId 或 externalUrl）；structured reason；approval binding；
 *     **失败时事实 / 审计 / approval consumption 全部零推进**。
 *
 * 事务顺序（与既有受保护动作同口径）：
 *   advisory lock → ClaimItem FOR UPDATE（租户/案件绑定）→ 锁后重读 ACTIVE membership/role
 *   → （override）目标 reimbursement fact FOR UPDATE + 绑定校验 + evidence 校验
 *   → （outcome）evidence 逐条校验
 *   → verifyApprovalBoundary(<action>；载荷 + 服务端 extra 指纹)
 *   → INSERT 事实（append-only）→ 业务审计 → approval consumption → commit
 *
 * 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write。
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import {
  APPROVAL_CONSUMED_EVENT_ACTION,
  ApprovalBoundaryError,
  verifyApprovalBoundary,
} from '../action-guard/approval-tx-verify';
import {
  RECONCILIATION_OVERRIDE_ACTION,
  RECONCILIATION_PROVIDER_OUTCOME_ACTION,
} from '../action-guard/approval-verifier';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';
import { providerEventFingerprintV1 } from './fingerprint';

export const RECONCILIATION_OVERRIDE_RECORDED_ACTION = 'reconciliation.override_recorded';
export const RECONCILIATION_PROVIDER_OUTCOME_RECORDED_ACTION = 'reconciliation.provider_outcome_recorded';

/** 人工动作的领域错误（携带稳定 code；不影响既有 WorkflowError 词表） */
export class ReconciliationManualActionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'ReconciliationManualActionError';
    this.code = code;
  }
}

export interface ManualActionDeps {
  prisma: PrismaClient;
  now?: () => Date;
  transactionTimeoutMs?: number;
}

type TxClient = Prisma.TransactionClient;

function requireNonEmpty(value: string | null | undefined, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) throw new WorkflowError('INVALID_INPUT', label + ' 必填');
  return text;
}

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

/** 锁内：ACTIVE membership + 角色重验（禁止复用锁前结论） */
async function assertActorMembership(tx: TxClient, organizationId: string, actorUserId: string): Promise<void> {
  const membership = await tx.membership.findFirst({
    where: { organizationId, userId: actorUserId, isActive: true },
    select: { role: true },
  });
  if (!membership) throw new WorkflowError('FORBIDDEN', '执行主体不是该租户的活跃成员');
  assertPermission(membership.role, 'claimTrackingApprove');
}

/**
 * evidence 逐条校验（MSG-20261002-49 S4 特别要求）：
 *   存在 / 同租户 / 不重复 / 具备可用来源（fileAssetId 或 externalUrl）。
 */
async function assertEvidenceUsable(
  tx: TxClient,
  organizationId: string,
  evidenceIds: readonly string[],
): Promise<string[]> {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
    throw new WorkflowError('INVALID_INPUT', '至少需要一条 EvidenceArtifact（人工录入必须带证据）');
  }
  const unique = [...new Set(evidenceIds.map((id) => requireNonEmpty(id, 'evidenceId')))];
  if (unique.length !== evidenceIds.length) {
    throw new WorkflowError('INVALID_INPUT', 'evidenceArtifactIds 不得重复');
  }
  const rows = await tx.evidenceArtifact.findMany({
    where: { organizationId, id: { in: unique } },
    select: { id: true, fileAssetId: true, externalUrl: true },
  });
  if (rows.length !== unique.length) {
    throw new WorkflowError('INVALID_INPUT', '存在不存在或跨租户的 EvidenceArtifact');
  }
  for (const row of rows) {
    if (!row.fileAssetId && !row.externalUrl) {
      throw new WorkflowError('INVALID_INPUT', 'EvidenceArtifact 缺少可用来源（fileAssetId / externalUrl）');
    }
  }
  return unique;
}

export interface RecordReconciliationOverrideInput {
  organizationId: string;
  role: string;
  actorUserId: string;
  claimItemId: string;
  reimbursementFactId: string;
  decisionKind: 'MATCHED' | 'UNMATCHED';
  reasonCode: string;
  reasonText: string;
  evidenceIds: string[];
  approvalId: string;
}

export interface RecordOverrideResult {
  overrideDecisionId: string;
  claimItemId: string;
  reimbursementFactId: string;
  decisionKind: 'MATCHED' | 'UNMATCHED';
  evidenceArtifactIds: string[];
  approvalConsumed: true;
  platformWriteExecuted: false;
}

/**
 * 人工 override（每笔 reimbursement fact 独立审批；不修改原事实）。
 */
export async function recordReconciliationOverride(
  deps: ManualActionDeps,
  input: RecordReconciliationOverrideInput,
): Promise<RecordOverrideResult> {
  const organizationId = requireNonEmpty(input.organizationId, 'organizationId');
  const claimItemId = requireNonEmpty(input.claimItemId, 'claimItemId');
  const reimbursementFactId = requireNonEmpty(input.reimbursementFactId, 'reimbursementFactId');
  const actorUserId = requireNonEmpty(input.actorUserId, 'actorUserId');
  const approvalId = requireNonEmpty(input.approvalId, 'approvalId');
  const reasonCode = requireNonEmpty(input.reasonCode, 'reasonCode');
  const reasonText = requireNonEmpty(input.reasonText, 'reasonText');
  if (input.decisionKind !== 'MATCHED' && input.decisionKind !== 'UNMATCHED') {
    throw new WorkflowError('INVALID_INPUT', 'decisionKind 必须是 MATCHED 或 UNMATCHED');
  }
  const at = deps.now ? deps.now() : new Date();
  assertPermission(input.role, 'claimTrackingApprove');

  return deps.prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId + ':' + claimItemId}))`;

      const claimRows = await tx.$queryRaw<{ id: string; caseId: string | null }[]>`
        SELECT "id", "caseId" FROM "ClaimItem"
         WHERE "id" = ${claimItemId} AND "organizationId" = ${organizationId}
         FOR UPDATE`;
      if (claimRows.length !== 1) throw new WorkflowError('NOT_FOUND', 'ClaimItem 不存在或不属于该租户');
      const caseId = requireNonEmpty(claimRows[0].caseId, 'ClaimItem.caseId');

      await assertActorMembership(tx, organizationId, actorUserId);

      // 目标事实必须存在、同租户、且绑定到同一 claimItem（错误绑定 fail-closed）
      const factRows = await tx.$queryRaw<{ id: string; claimItemId: string | null }[]>`
        SELECT "id", "claimItemId" FROM "ReimbursementFact"
         WHERE "id" = ${reimbursementFactId} AND "organizationId" = ${organizationId}
         FOR UPDATE`;
      if (factRows.length !== 1) throw new WorkflowError('NOT_FOUND', '目标 reimbursement fact 不存在或跨租户');
      if ((factRows[0].claimItemId ?? null) !== claimItemId) {
        throw new WorkflowError('INVALID_INPUT', '目标事实与 claimItem 绑定不一致（fail-closed）');
      }

      const existing = await tx.reconciliationOverrideDecision.count({
        where: { organizationId, reimbursementFactId },
      });
      if (existing > 0) {
        throw new WorkflowError('ILLEGAL_TRANSITION', '该 reimbursement fact 已存在 override 决策（一票制）');
      }

      const evidenceIds = await assertEvidenceUsable(tx, organizationId, input.evidenceIds);

      const boundary = await verifyApprovalBoundary(tx, {
        organizationId,
        approvalId,
        action: RECONCILIATION_OVERRIDE_ACTION,
        caseId,
        actorUserId,
        payload: { amount: null, currency: null, basisReference: reasonCode, evidenceArtifactId: evidenceIds[0] },
        now: at,
        extra: { claimItemId, reimbursementFactId, decisionKind: input.decisionKind },
      });
      if (!boundary.ok) throw new ApprovalBoundaryError(boundary.reason, caseId);

      const created = await tx.reconciliationOverrideDecision.create({
        data: {
          organizationId,
          claimItemId,
          reimbursementFactId,
          decisionKind: input.decisionKind,
          reasonCode,
          reasonText,
          approvalId,
          decidedByUserId: actorUserId,
          decidedAt: at,
        },
        select: { id: true },
      });

      await insertTxAudit(tx, {
        organizationId,
        actorUserId,
        action: RECONCILIATION_OVERRIDE_RECORDED_ACTION,
        entityType: 'ReconciliationOverrideDecision',
        entityId: created.id,
        changes: {
          claimItemId,
          caseId,
          reimbursementFactId,
          decisionKind: input.decisionKind,
          reasonCode,
          reasonText,
          evidenceArtifactIds: evidenceIds,
          approvalId,
        },
        at,
      });
      await insertTxAudit(tx, {
        organizationId,
        actorUserId,
        action: APPROVAL_CONSUMED_EVENT_ACTION,
        entityType: 'Case',
        entityId: caseId,
        changes: { approvalId, boundAction: RECONCILIATION_OVERRIDE_ACTION, overrideDecisionId: created.id },
        at,
      });

      return {
        overrideDecisionId: created.id,
        claimItemId,
        reimbursementFactId,
        decisionKind: input.decisionKind,
        evidenceArtifactIds: evidenceIds,
        approvalConsumed: true as const,
        platformWriteExecuted: false as const,
      };
    },
    { timeout: deps.transactionTimeoutMs ?? 20000 },
  );
}

export interface RecordManualProviderOutcomeInput {
  organizationId: string;
  role: string;
  actorUserId: string;
  caseId: string;
  claimItemId?: string | null;
  provider: string;
  kind: 'ACCEPTED' | 'ACCEPTANCE_REVOKED';
  sourceResource: string;
  canonicalSourceIdentity: string;
  providerCaseRefRaw?: string | null;
  occurredAt: Date;
  evidenceIds: string[];
  reasonCode: string;
  approvalId: string;
  note?: string;
}

export interface RecordManualOutcomeResult {
  /** CREATED = 本次创建；REUSED = 同一 event identity 的完全重放（execution replay，不新建事实） */
  outcome: 'CREATED' | 'REUSED';
  providerOutcomeFactId: string;
  caseId: string;
  provider: string;
  kind: 'ACCEPTED' | 'ACCEPTANCE_REVOKED';
  sourceKind: 'MANUAL_WITH_EVIDENCE';
  evidenceArtifactIds: string[];
  providerEventFingerprint: string;
  approvalConsumed: boolean;
  providerAcceptedInferred: false;
  platformWriteExecuted: false;
}

/** 规范化比较用：evidence 集合按 id 升序（REPLAY 判定） */
function sameEvidenceSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/**
 * 人工 provider outcome 录入（受保护路径；MANUAL_WITH_EVIDENCE + evidence 逐条校验）。
 */
export async function recordManualProviderOutcomeFact(
  deps: ManualActionDeps,
  input: RecordManualProviderOutcomeInput,
): Promise<RecordManualOutcomeResult> {
  const organizationId = requireNonEmpty(input.organizationId, 'organizationId');
  const caseId = requireNonEmpty(input.caseId, 'caseId');
  const actorUserId = requireNonEmpty(input.actorUserId, 'actorUserId');
  const approvalId = requireNonEmpty(input.approvalId, 'approvalId');
  const provider = requireNonEmpty(input.provider, 'provider').toLowerCase();
  const reasonCode = requireNonEmpty(input.reasonCode, 'reasonCode');
  const canonicalSourceIdentity = requireNonEmpty(input.canonicalSourceIdentity, 'canonicalSourceIdentity');
  if (input.kind !== 'ACCEPTED' && input.kind !== 'ACCEPTANCE_REVOKED') {
    throw new WorkflowError('INVALID_INPUT', 'kind 必须是 ACCEPTED 或 ACCEPTANCE_REVOKED');
  }
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
    throw new WorkflowError('INVALID_INPUT', 'occurredAt 必须是有效时间');
  }
  const at = deps.now ? deps.now() : new Date();
  assertPermission(input.role, 'claimTrackingApprove');

  const fingerprint = providerEventFingerprintV1({
    provider,
    sourceResource: input.sourceResource,
    eventKind: input.kind,
    canonicalSourceIdentity,
  }).fingerprint;

  return deps.prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId + ':' + caseId}))`;

      const claimItemId = input.claimItemId ? requireNonEmpty(input.claimItemId, 'claimItemId') : null;
      if (claimItemId) {
        const claimRows = await tx.$queryRaw<{ id: string; caseId: string | null }[]>`
          SELECT "id", "caseId" FROM "ClaimItem"
           WHERE "id" = ${claimItemId} AND "organizationId" = ${organizationId}
           FOR UPDATE`;
        if (claimRows.length !== 1) throw new WorkflowError('NOT_FOUND', 'ClaimItem 不存在或不属于该租户');
        if ((claimRows[0].caseId ?? null) !== caseId) {
          throw new WorkflowError('INVALID_INPUT', 'claimItem 与 caseId 绑定不一致');
        }
      }

      await assertActorMembership(tx, organizationId, actorUserId);

      // evidence 逐条校验（必须全部通过；任一失败 → 事实/审计/消费零推进）
      const evidenceIds = await assertEvidenceUsable(tx, organizationId, input.evidenceIds);

      const boundary = await verifyApprovalBoundary(tx, {
        organizationId,
        approvalId,
        action: RECONCILIATION_PROVIDER_OUTCOME_ACTION,
        caseId,
        actorUserId,
        payload: {
          amount: null,
          currency: null,
          basisReference: canonicalSourceIdentity,
          evidenceArtifactId: evidenceIds[0],
        },
        now: at,
        extra: {
          caseId,
          provider,
          kind: input.kind,
          occurredAt: input.occurredAt.toISOString(),
          canonicalSourceIdentity,
        },
      });
      if (!boundary.ok) throw new ApprovalBoundaryError(boundary.reason, caseId);

      // ingest 幂等：同指纹已存在 → 复用既有事实（不新建、不双计）
      const existing = await tx.providerOutcomeFact.findFirst({
        where: { organizationId, providerEventFingerprint: fingerprint },
        select: {
          id: true,
          caseId: true,
          claimItemId: true,
          provider: true,
          kind: true,
          occurredAt: true,
          evidenceArtifactIds: true,
        },
      });
      if (existing) {
        // MSG-20261002-50 CHANGE A：完全重放 → REUSED（execution replay，不创建第二 fact / 成功审计，也不再消费 approval）
        const identical =
          existing.caseId === caseId &&
          (existing.claimItemId ?? null) === claimItemId &&
          existing.provider === provider &&
          existing.kind === input.kind &&
          existing.occurredAt.getTime() === input.occurredAt.getTime() &&
          sameEvidenceSet(existing.evidenceArtifactIds, evidenceIds);
        if (!identical) {
          throw new ReconciliationManualActionError(
            'EVENT_IDENTITY_CONFLICT',
            '同一 provider event identity 已存在但关键事实内容不同（kind/evidence/occurredAt 等）→ fail-closed',
          );
        }
        return {
          outcome: 'REUSED' as const,
          providerOutcomeFactId: existing.id,
          caseId,
          provider,
          kind: input.kind,
          sourceKind: 'MANUAL_WITH_EVIDENCE' as const,
          evidenceArtifactIds: evidenceIds,
          providerEventFingerprint: fingerprint,
          approvalConsumed: false,
          providerAcceptedInferred: false as const,
          platformWriteExecuted: false as const,
        };
      }

      const created = await tx.providerOutcomeFact.create({
        data: {
          organizationId,
          caseId,
          claimItemId,
          provider,
          kind: input.kind,
          providerCaseRefCanonical: input.providerCaseRefRaw ? input.providerCaseRefRaw.trim() : null,
          occurredAt: input.occurredAt,
          providerEventId: null,
          providerEventFingerprint: fingerprint,
          fingerprintVersion: 'v1',
          sourceKind: 'MANUAL_WITH_EVIDENCE',
          sourceRef: 'manual/' + approvalId,
          capturedAt: at,
          parserVersion: null,
          ingestedByUserId: actorUserId,
          evidenceArtifactIds: evidenceIds,
          reasonCode,
          note: input.note ?? null,
        },
        select: { id: true },
      });

      await insertTxAudit(tx, {
        organizationId,
        actorUserId,
        action: RECONCILIATION_PROVIDER_OUTCOME_RECORDED_ACTION,
        entityType: 'ProviderOutcomeFact',
        entityId: created.id,
        changes: {
          caseId,
          claimItemId,
          provider,
          kind: input.kind,
          sourceKind: 'MANUAL_WITH_EVIDENCE',
          evidenceArtifactIds: evidenceIds,
          reasonCode,
          providerEventFingerprint: fingerprint,
          approvalId,
        },
        at,
      });
      await insertTxAudit(tx, {
        organizationId,
        actorUserId,
        action: APPROVAL_CONSUMED_EVENT_ACTION,
        entityType: 'Case',
        entityId: caseId,
        changes: { approvalId, boundAction: RECONCILIATION_PROVIDER_OUTCOME_ACTION, providerOutcomeFactId: created.id },
        at,
      });

      return {
        outcome: 'CREATED' as const,
        providerOutcomeFactId: created.id,
        caseId,
        provider,
        kind: input.kind,
        sourceKind: 'MANUAL_WITH_EVIDENCE' as const,
        evidenceArtifactIds: evidenceIds,
        providerEventFingerprint: fingerprint,
        approvalConsumed: true as const,
        // 人工录入不得推导出「provider 已受理」的结论（providerAccepted=true 边界）
        providerAcceptedInferred: false as const,
        platformWriteExecuted: false as const,
      };
    },
    { timeout: deps.transactionTimeoutMs ?? 20000 },
  );
}
