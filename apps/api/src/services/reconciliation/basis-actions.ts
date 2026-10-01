/**
 * R45 S4 —— 对账期受保护动作（第一批：expected basis 建立 / supersede）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261002-49 ③（批准进入 R45 S4）+ MSG-20261001-46 Q1（supersede 事务顺序冻结）。
 *
 * `recovery.reconciliation_basis_set`（首次建立）与 `recovery.reconciliation_basis_supersede`（受控取代）
 * 均为 INTERNAL_WRITE + humanApproval，同一事务内顺序：
 *   case advisory lock
 *   → ClaimItem FOR UPDATE（租户 + 案件绑定）
 *   → 锁后重读当前 ACTIVE membership / role（禁止复用锁前结论）
 *   → （supersede）锁定当前 effective basis FOR UPDATE
 *   → verifyApprovalBoundary(<action>；载荷 + 服务端 extra 指纹逐项比对)
 *   → （set）确认本 claim 尚无 effective basis；INSERT 新 basis
 *     （supersede）UPDATE old SET supersededAt / supersededByBasisId（受控 CAS）→ INSERT 新 basis
 *   → 业务审计 + approval consumption
 *   → commit
 * 任一步失败：**旧 effective basis 保持不变**、不产生新 basis、不消费 approval。
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
  RECONCILIATION_BASIS_SET_ACTION,
  RECONCILIATION_BASIS_SUPERSEDE_ACTION,
} from '../action-guard/approval-verifier';
import { WorkflowError } from '../workflow/opportunity-review';
import { assertPermission } from '../workflow/permissions';

export const RECONCILIATION_BASIS_SET_RECORDED_ACTION = 'reconciliation.basis_set';
export const RECONCILIATION_BASIS_SUPERSEDED_ACTION = 'reconciliation.basis_superseded';

const BASIS_KINDS = ['CARRIER_CLAIM', 'PROVIDER_POLICY', 'CONTRACTUAL'] as const;
export type ReconBasisKind = (typeof BASIS_KINDS)[number];

export interface ReconciliationBasisInput {
  organizationId: string;
  /** 会话内角色：仅作锁前快速拒绝；锁内必须按数据库当前角色重验 */
  role: string;
  actorUserId: string;
  claimItemId: string;
  approvalId: string;
  expectedRecoveryAmount: string;
  currency: string;
  basisKind: ReconBasisKind;
  basisVersion: string;
  basisSource: string;
  effectiveAt?: Date;
  supersedesBasisId?: string;
  note?: string;
}

export interface ReconciliationBasisResult {
  basisId: string;
  claimItemId: string;
  caseId: string;
  expectedRecoveryAmount: string;
  currency: string;
  basisKind: ReconBasisKind;
  basisVersion: string;
  supersededBasisId: string | null;
  operation: 'SET' | 'SUPERSEDE';
  effectiveAt: string;
  approvalConsumed: true;
  platformWriteExecuted: false;
}

export interface BasisActionDeps {
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

function normalizeAmount(value: string): string {
  const text = requireNonEmpty(value, 'expectedRecoveryAmount');
  if (!/^\d+(\.\d{1,4})?$/.test(text)) {
    throw new WorkflowError('INVALID_INPUT', 'expectedRecoveryAmount 必须为非负十进制（≤4 位小数）');
  }
  if (Number(text) <= 0) throw new WorkflowError('INVALID_INPUT', 'expectedRecoveryAmount 必须 > 0');
  return Number(text).toFixed(4);
}

function normalizeCurrency(value: string): string {
  const text = requireNonEmpty(value, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(text)) throw new WorkflowError('INVALID_INPUT', 'currency 必须是 ISO-4217 三字母');
  return text;
}

function normalizeBasisKind(value: string): ReconBasisKind {
  const text = requireNonEmpty(value, 'basisKind').toUpperCase();
  if (!(BASIS_KINDS as readonly string[]).includes(text)) {
    throw new WorkflowError('INVALID_INPUT', 'basisKind 不在允许集合内');
  }
  return text as ReconBasisKind;
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

interface BasisRow {
  id: string;
  claimItemId: string;
  supersededAt: Date | null;
}

/**
 * 建立 / 取代 expected recovery basis（同一实现，operation 由 `supersedesBasisId` 是否给出决定）。
 */
async function applyBasis(
  input: ReconciliationBasisInput,
  deps: BasisActionDeps,
): Promise<ReconciliationBasisResult> {
  const organizationId = requireNonEmpty(input.organizationId, 'organizationId');
  const claimItemId = requireNonEmpty(input.claimItemId, 'claimItemId');
  const actorUserId = requireNonEmpty(input.actorUserId, 'actorUserId');
  const approvalId = requireNonEmpty(input.approvalId, 'approvalId');
  const basisSource = requireNonEmpty(input.basisSource, 'basisSource');
  const basisVersion = requireNonEmpty(input.basisVersion, 'basisVersion');
  const amount = normalizeAmount(input.expectedRecoveryAmount);
  const currency = normalizeCurrency(input.currency);
  const basisKind = normalizeBasisKind(input.basisKind);
  const supersedesBasisId = input.supersedesBasisId ? requireNonEmpty(input.supersedesBasisId, 'supersedesBasisId') : null;
  const operation: 'SET' | 'SUPERSEDE' = supersedesBasisId ? 'SUPERSEDE' : 'SET';
  const action = operation === 'SET' ? RECONCILIATION_BASIS_SET_ACTION : RECONCILIATION_BASIS_SUPERSEDE_ACTION;
  const at = deps.now ? deps.now() : new Date();
  const effectiveAt = input.effectiveAt ?? at;

  // 锁前快速拒绝（最终裁决在锁内按数据库当前角色执行）
  assertPermission(input.role, 'claimTrackingApprove');

  return deps.prisma.$transaction(
    async (tx) => {
      // 1) 案件级 advisory lock（与既有 recovery 动作同口径）
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId + ':' + claimItemId}))`;

      // 2) ClaimItem FOR UPDATE + 租户绑定
      const claimRows = await tx.$queryRaw<{ id: string; caseId: string | null; currency: string }[]>`
        SELECT "id", "caseId", "currency" FROM "ClaimItem"
         WHERE "id" = ${claimItemId} AND "organizationId" = ${organizationId}
         FOR UPDATE`;
      if (claimRows.length !== 1) {
        throw new WorkflowError('NOT_FOUND', 'ClaimItem 不存在或不属于该租户');
      }
      const claim = claimRows[0];
      const caseId = requireNonEmpty(claim.caseId, 'ClaimItem.caseId');

      // 3) 锁后重读 ACTIVE membership / role
      const membership = await tx.membership.findFirst({
        where: { organizationId, userId: actorUserId, isActive: true },
        select: { role: true },
      });
      if (!membership) throw new WorkflowError('FORBIDDEN', '执行主体不是该租户的活跃成员');
      assertPermission(membership.role, 'claimTrackingApprove');

      // 4) 当前 effective basis（supersede 时需要锁旧行）
      const current = await tx.$queryRaw<BasisRow[]>`
        SELECT "id", "claimItemId", "supersededAt" FROM "ExpectedRecoveryBasis"
         WHERE "organizationId" = ${organizationId} AND "claimItemId" = ${claimItemId} AND "supersededAt" IS NULL
         FOR UPDATE`;
      if (current.length > 1) throw new WorkflowError('INVALID_INPUT', '同一 claimItem 存在多条 effective basis');
      const currentBasis = current[0] ?? null;

      if (operation === 'SET' && currentBasis) {
        throw new WorkflowError('ILLEGAL_TRANSITION', '已存在 effective basis，必须使用 recovery.reconciliation_basis_supersede');
      }
      if (operation === 'SUPERSEDE') {
        if (!currentBasis) throw new WorkflowError('NOT_FOUND', '不存在 effective basis，无法取代');
        if (currentBasis.id !== supersedesBasisId) {
          throw new WorkflowError('ILLEGAL_TRANSITION', 'supersedesBasisId 与当前 effective basis 不一致');
        }
      }

      // 5) 锁内审批边界重验（动作 + 载荷 + 服务端 extra 指纹）
      const boundary = await verifyApprovalBoundary(tx, {
        organizationId,
        approvalId,
        action,
        caseId,
        actorUserId,
        payload: { amount, currency, basisReference: basisVersion, evidenceArtifactId: null },
        now: at,
        extra: {
          claimItemId,
          caseId,
          expectedRecoveryAmount: amount,
          currency,
          basisKind,
          basisVersion,
          ...(supersedesBasisId ? { supersedesBasisId } : {}),
        },
      });
      if (!boundary.ok) throw new ApprovalBoundaryError(boundary.reason, caseId);

      // 6) 受控写入：supersede 先标旧（CAS 语义：锁内读到哪条就取代哪条），再 INSERT 新 basis
      const newBasisId = globalThis.crypto.randomUUID();
      if (operation === 'SUPERSEDE' && currentBasis) {
        const affected = await tx.$executeRaw`
          UPDATE "ExpectedRecoveryBasis"
             SET "supersededAt" = ${at}, "supersededByBasisId" = ${newBasisId}
           WHERE "id" = ${currentBasis.id} AND "supersededAt" IS NULL
             AND "organizationId" = ${organizationId}`;
        if (affected !== 1) {
          throw new WorkflowError('ILLEGAL_TRANSITION', '旧 basis 取代失败（并发或状态不符）');
        }
      }
      await tx.$executeRaw`
        INSERT INTO "ExpectedRecoveryBasis"
          ("id", "organizationId", "claimItemId", "caseId", "expectedRecoveryAmount", "currency",
           "basisKind", "basisVersion", "basisSource", "effectiveAt", "createdByUserId", "createdAt")
        VALUES (${newBasisId}, ${organizationId}, ${claimItemId}, ${caseId}, ${amount}::numeric, ${currency},
                ${basisKind}::"ExpectedRecoveryBasisKind", ${basisVersion}, ${basisSource}, ${effectiveAt}, ${actorUserId}, ${at})`;

      // 7) 业务审计 + approval consumption（同一事务）
      await insertTxAudit(tx, {
        organizationId,
        actorUserId,
        action: operation === 'SET' ? RECONCILIATION_BASIS_SET_RECORDED_ACTION : RECONCILIATION_BASIS_SUPERSEDED_ACTION,
        entityType: 'ExpectedRecoveryBasis',
        entityId: newBasisId,
        changes: {
          claimItemId,
          caseId,
          expectedRecoveryAmount: amount,
          currency,
          basisKind,
          basisVersion,
          operation,
          supersededBasisId: operation === 'SUPERSEDE' ? supersedesBasisId : null,
          approvalId,
          ...(input.note ? { note: input.note } : {}),
        },
        at,
      });
      await insertTxAudit(tx, {
        organizationId,
        actorUserId,
        action: APPROVAL_CONSUMED_EVENT_ACTION,
        entityType: 'Case',
        entityId: caseId,
        changes: { approvalId, boundAction: action, basisId: newBasisId },
        at,
      });

      return {
        basisId: newBasisId,
        claimItemId,
        caseId,
        expectedRecoveryAmount: amount,
        currency,
        basisKind,
        basisVersion,
        supersededBasisId: operation === 'SUPERSEDE' ? supersedesBasisId : null,
        operation,
        effectiveAt: effectiveAt.toISOString(),
        approvalConsumed: true as const,
        platformWriteExecuted: false as const,
      };
    },
    { timeout: deps.transactionTimeoutMs ?? 20000 },
  );
}

export async function setReconciliationBasis(
  deps: BasisActionDeps,
  input: Omit<ReconciliationBasisInput, 'supersedesBasisId'>,
): Promise<ReconciliationBasisResult> {
  return applyBasis({ ...input, supersedesBasisId: undefined }, deps);
}

export async function supersedeReconciliationBasis(
  deps: BasisActionDeps,
  input: Omit<ReconciliationBasisInput, 'supersedesBasisId'> & { supersedesBasisId: string },
): Promise<ReconciliationBasisResult> {
  if (!input.supersedesBasisId) throw new WorkflowError('INVALID_INPUT', 'supersedesBasisId 必填');
  return applyBasis(input, deps);
}
