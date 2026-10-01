/**
 * R46 S2 —— Settlement record / ingest 受保护写路径
 * ---------------------------------------------------------------
 * 依据：MSG-20261002-53 CHANGE E / MSG-20261002-55（S2 AUTHORIZED）。
 *
 * 只做一条链路：可信到账证据 → server-side canonical immutable ReceiptSnapshot → humanApproval → Settlement 财务事实。
 * 明确不做：SettlementAdjustment / FeeCalculation / BillingInvoice / Payment / RecoveryLedger 写入。
 *
 * 硬约束：
 *   - snapshot / digest **只能**由服务端 canonicalizer 计算；客户端自证派生字段 → fail-closed；
 *   - evidence 必须存在、同租户、不重复（DB 复合租户守卫 + 服务层双保险）；
 *   - 完全重放 → REUSED（同一 Settlement，不新建、不双计）；identity 相同但事实冲突 → EVENT_IDENTITY_CONFLICT；
 *   - approval 恰好消费一次（DB 层：AuditLog 主键 `settlement-approval-<approvalId>`，重复插入 → 唯一冲突 → 整体回滚）；
 *   - 任何一步失败 → 整体回滚，零部分状态（Settlement / snapshot / audit / approval 消费全部不落）。
 */

import type { PrismaClient } from '@prisma/client';

import {
  verifyApprovalOrThrow,
  type ActionGuardApprovalVerifier,
} from '../action-guard/approval-verifier';

import {
  buildReceiptSnapshot,
  ReceiptSnapshotError,
  type ReceiptEvidenceRefInput,
  type ReceiptSnapshotRecord,
  type SettlementExternalIdentityKind,
  type SettlementLinkageBasisKind,
  type SettlementReceiptSourceKind,
} from './receipt-snapshot';

export const SETTLEMENT_RECORD_ACTION = 'settlement.record';

export type SettlementRecordErrorCode =
  | 'INVALID_INPUT'
  | 'CLIENT_DERIVED_FIELD_NOT_TRUSTED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_ALREADY_CONSUMED'
  | 'CLAIM_ITEM_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'EVIDENCE_NOT_FOUND'
  | 'CROSS_TENANT_REFERENCE'
  | 'EVIDENCE_REQUIRED'
  | 'EVENT_IDENTITY_CONFLICT'
  | 'PROJECTION_CANNOT_CREATE_SETTLEMENT';

export class SettlementRecordError extends Error {
  constructor(
    public readonly code: SettlementRecordErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SettlementRecordError';
  }
}

export interface SettlementApprovalRequest {
  organizationId: string;
  action: string;
  approvalId: string;
  actorUserId: string;
  boundExtra: Record<string, string | null>;
}

export interface SettlementRecordDeps {
  prisma: PrismaClient;
  /** 审批校验（生产实现接入 action-guard；测试可注入受控 stub） */
  verifyApproval: (request: SettlementApprovalRequest) => Promise<boolean>;
  /** 锁内 ACTIVE membership / role 复验 */
  assertActiveMembership: (organizationId: string, userId: string) => Promise<void>;
}

export interface RecordSettlementInput {
  organizationId: string;
  actorUserId: string;
  approvalId: string;
  claimItemId?: string | null;
  caseId?: string | null;
  linkageBasisKind: SettlementLinkageBasisKind;
  linkageBasisRef?: string | null;
  externalIdentityKind: SettlementExternalIdentityKind;
  externalIdentityValue?: string | null;
  externalIdentityValueHash?: string | null;
  externalIdentityVersion?: string | null;
  financialEventFingerprint?: string | null;
  financialEventFingerprintVersion?: string | null;
  amount: string;
  currency: string;
  receivedAt: string | Date;
  sourceKind: SettlementReceiptSourceKind;
  evidenceReferences: ReceiptEvidenceRefInput[];
  /** 客户端若提供以下任一 → fail-closed */
  clientSnapshotDigest?: string | null;
  clientDerivedFields?: Record<string, unknown> | null;
  /** R45 projection / override 不得成为 Settlement 创建入口 */
  sourceProjectionId?: string | null;
  sourceOverrideId?: string | null;
}

export type RecordSettlementStatus = 'CREATED' | 'REUSED';

export interface RecordSettlementResult {
  status: RecordSettlementStatus;
  settlementId: string;
  receiptSnapshotId: string;
  snapshotDigest: string;
}

const SOURCE_MAP: Record<SettlementReceiptSourceKind, 'BANK_TRANSFER' | 'PLATFORM_CREDIT' | 'OTHER'> = {
  BANK_STATEMENT: 'BANK_TRANSFER',
  PSP_SETTLEMENT_REPORT: 'PLATFORM_CREDIT',
  PLATFORM_REPORT: 'PLATFORM_CREDIT',
  OFFICIAL_API: 'PLATFORM_CREDIT',
  MANUAL_DOCUMENT: 'OTHER',
};

function snapshotFromInput(input: RecordSettlementInput): ReceiptSnapshotRecord {
  if (input.clientSnapshotDigest) {
    throw new SettlementRecordError(
      'CLIENT_DERIVED_FIELD_NOT_TRUSTED',
      'client-provided snapshotDigest is not trusted',
    );
  }
  if (input.clientDerivedFields && Object.keys(input.clientDerivedFields).length > 0) {
    throw new SettlementRecordError(
      'CLIENT_DERIVED_FIELD_NOT_TRUSTED',
      'client-provided derived fields are not trusted',
    );
  }
  if (input.sourceProjectionId || input.sourceOverrideId) {
    throw new SettlementRecordError(
      'PROJECTION_CANNOT_CREATE_SETTLEMENT',
      'R45 projection / override cannot be a Settlement creation entry',
    );
  }
  if (!input.evidenceReferences || input.evidenceReferences.length < 1) {
    throw new SettlementRecordError('EVIDENCE_REQUIRED', 'at least one evidence reference is required');
  }
  try {
    return buildReceiptSnapshot({
      organizationId: input.organizationId,
      claimItemId: input.claimItemId ?? null,
      caseId: input.caseId ?? null,
      linkageBasisKind: input.linkageBasisKind,
      linkageBasisRef: input.linkageBasisRef ?? null,
      externalIdentityKind: input.externalIdentityKind,
      externalIdentityValue: input.externalIdentityValue ?? null,
      externalIdentityValueHash: input.externalIdentityValueHash ?? null,
      externalIdentityVersion: input.externalIdentityVersion ?? null,
      financialEventFingerprint: input.financialEventFingerprint ?? null,
      financialEventFingerprintVersion: input.financialEventFingerprintVersion ?? null,
      amount: input.amount,
      currency: input.currency,
      receivedAt: input.receivedAt,
      sourceKind: input.sourceKind,
      evidenceReferences: input.evidenceReferences,
      createdByUserId: input.actorUserId,
    });
  } catch (error) {
    if (error instanceof ReceiptSnapshotError) {
      throw new SettlementRecordError(
        error.code === 'CLIENT_DERIVED_FIELD_NOT_TRUSTED'
          ? 'CLIENT_DERIVED_FIELD_NOT_TRUSTED'
          : 'INVALID_INPUT',
        error.message,
      );
    }
    throw error;
  }
}

/** 已存在 Settlement 的不可变事实比对：全等 → REUSED；任一不同 → EVENT_IDENTITY_CONFLICT */
function assertSameImmutableFacts(
  existing: { amount: unknown; currency: string; receivedAt: Date | null; receiptSnapshotId: string | null },
  snapshot: ReceiptSnapshotRecord,
): void {
  const sameAmount = Number(existing.amount) === Number(snapshot.amount);
  const sameCurrency = existing.currency === snapshot.currency;
  const sameReceivedAt =
    existing.receivedAt instanceof Date && existing.receivedAt.toISOString() === snapshot.receivedAtUtc;
  if (!sameAmount || !sameCurrency || !sameReceivedAt) {
    throw new SettlementRecordError(
      'EVENT_IDENTITY_CONFLICT',
      'same financial identity with conflicting immutable facts',
    );
  }
}

/**
 * 受保护写路径：可信到账证据 → immutable snapshot → humanApproval → Settlement。
 * 整体事务：Settlement + snapshot + audit + approval 消费 同生共死。
 */
export async function recordSettlement(
  deps: SettlementRecordDeps,
  input: RecordSettlementInput,
): Promise<RecordSettlementResult> {
  const snapshot = snapshotFromInput(input);
  const organizationId = snapshot.organizationId;
  const approved = await deps.verifyApproval({
    organizationId,
    action: SETTLEMENT_RECORD_ACTION,
    approvalId: input.approvalId,
    actorUserId: input.actorUserId,
    boundExtra: {
      receiptSnapshotDigest: snapshot.snapshotDigest,
      organizationId,
      claimItemId: snapshot.claimItemId,
      caseId: snapshot.caseId,
      externalIdentityValueHash: snapshot.externalIdentityValueHash,
      financialEventFingerprint: snapshot.financialEventFingerprint,
      amount: snapshot.amount,
      currency: snapshot.currency,
      receivedAt: snapshot.receivedAtUtc,
    },
  });
  if (!approved) {
    throw new SettlementRecordError('APPROVAL_REQUIRED', 'human approval is required for settlement.record');
  }

  const identityWhere = snapshot.externalIdentityValueHash
    ? {
        organizationId,
        externalIdentityKind: snapshot.externalIdentityKind,
        externalIdentityValueHash: snapshot.externalIdentityValueHash,
        externalIdentityVersion: snapshot.externalIdentityVersion,
      }
    : {
        organizationId,
        financialEventFingerprint: snapshot.financialEventFingerprint,
        financialEventFingerprintVersion: snapshot.financialEventFingerprintVersion,
      };

  return deps.prisma.$transaction(async (tx) => {
    await deps.assertActiveMembership(organizationId, input.actorUserId);

    // 同租户引用校验（DB 触发器为第二道防线）
    if (snapshot.claimItemId) {
      const claimItem = await tx.claimItem.findFirst({
        where: { id: snapshot.claimItemId },
        select: { id: true, organizationId: true, caseId: true },
      });
      if (!claimItem) throw new SettlementRecordError('CLAIM_ITEM_NOT_FOUND', 'claimItem not found');
      if (claimItem.organizationId !== organizationId) {
        throw new SettlementRecordError('CROSS_TENANT_REFERENCE', 'claimItem belongs to another tenant');
      }
      if (snapshot.caseId && claimItem.caseId && claimItem.caseId !== snapshot.caseId) {
        throw new SettlementRecordError('CROSS_TENANT_REFERENCE', 'claimItem/case linkage mismatch');
      }
    } else if (snapshot.caseId) {
      const kase = await tx.case.findFirst({
        where: { id: snapshot.caseId },
        select: { id: true, organizationId: true },
      });
      if (!kase) throw new SettlementRecordError('CASE_NOT_FOUND', 'case not found');
      if (kase.organizationId !== organizationId) {
        throw new SettlementRecordError('CROSS_TENANT_REFERENCE', 'case belongs to another tenant');
      }
    }

    for (const ref of snapshot.evidenceReferences) {
      const artifact = await tx.evidenceArtifact.findFirst({
        where: { id: ref.evidenceArtifactId },
        select: { id: true, organizationId: true },
      });
      if (!artifact) throw new SettlementRecordError('EVIDENCE_NOT_FOUND', 'evidence artifact not found');
      if (artifact.organizationId !== organizationId) {
        throw new SettlementRecordError('CROSS_TENANT_REFERENCE', 'evidence belongs to another tenant');
      }
    }

    // 幂等：同一外部到账身份已存在
    const existing = await tx.settlement.findFirst({
      where: identityWhere,
      select: { id: true, amount: true, currency: true, receivedAt: true, receiptSnapshotId: true },
    });
    if (existing) {
      assertSameImmutableFacts(existing, snapshot);
      if (!existing.receiptSnapshotId) {
        throw new SettlementRecordError('EVENT_IDENTITY_CONFLICT', 'existing settlement has no receipt snapshot');
      }
      return {
        status: 'REUSED' as const,
        settlementId: existing.id,
        receiptSnapshotId: existing.receiptSnapshotId,
        snapshotDigest: snapshot.snapshotDigest,
      };
    }

    // approval 恰好消费一次：AuditLog 主键确定性派生（重复 → P2002 → 整体回滚）
    const consumption = await tx.auditLog
      .create({
        data: {
          id: 'settlement-approval-' + input.approvalId,
          organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action: 'settlement.record.approval_consumed',
          entityType: 'Approval',
          entityId: input.approvalId,
          changes: { action: SETTLEMENT_RECORD_ACTION, snapshotDigest: snapshot.snapshotDigest },
        },
        select: { id: true },
      })
      .catch((error: unknown) => {
        const code = (error as { code?: string }).code;
        if (code === 'P2002') {
          throw new SettlementRecordError(
            'APPROVAL_ALREADY_CONSUMED',
            'approval has already been consumed',
          );
        }
        throw error;
      });
    void consumption;

    const receiptSnapshot = await tx.settlementReceiptSnapshot.create({
      data: {
        organizationId,
        claimItemId: snapshot.claimItemId,
        caseId: snapshot.caseId,
        externalIdentityKind: snapshot.externalIdentityKind,
        externalIdentityValueHash: snapshot.externalIdentityValueHash,
        externalIdentityVersion: snapshot.externalIdentityVersion,
        financialEventFingerprint: snapshot.financialEventFingerprint,
        financialEventFingerprintVersion: snapshot.financialEventFingerprintVersion,
        amount: snapshot.amount,
        currency: snapshot.currency,
        receivedAt: new Date(snapshot.receivedAtUtc),
        sourceKind: snapshot.sourceKind,
        evidenceReferences: snapshot.evidenceReferences,
        snapshotVersion: snapshot.snapshotVersion,
        snapshotDigest: snapshot.snapshotDigest,
        createdByUserId: input.actorUserId,
      },
      select: { id: true },
    });

    const settlement = await tx.settlement
      .create({
        data: {
          organizationId,
          caseId: snapshot.caseId,
          status: 'RECEIVED',
          source: SOURCE_MAP[snapshot.sourceKind],
          amount: snapshot.amount,
          currency: snapshot.currency,
          receivedAt: new Date(snapshot.receivedAtUtc),
          evidenceId: snapshot.evidenceReferences[0].evidenceArtifactId,
          confirmedBy: input.actorUserId,
          confirmedAt: new Date(),
          confirmedByUserId: input.actorUserId,
          confirmationStatus: 'CONFIRMED',
          reconciliationStatus: 'NOT_STARTED',
          claimItemId: snapshot.claimItemId,
          linkageBasisKind: snapshot.linkageBasisKind,
          linkageBasisRef: snapshot.linkageBasisRef,
          externalIdentityKind: snapshot.externalIdentityKind,
          externalIdentityValue: snapshot.externalIdentityValue,
          externalIdentityValueHash: snapshot.externalIdentityValueHash,
          externalIdentityVersion: snapshot.externalIdentityVersion,
          financialEventFingerprint: snapshot.financialEventFingerprint,
          financialEventFingerprintVersion: snapshot.financialEventFingerprintVersion,
          receiptSnapshotId: receiptSnapshot.id,
        },
        select: { id: true },
      })
      .catch(async (error: unknown) => {
        const code = (error as { code?: string }).code;
        if (code !== 'P2002') throw error;
        // 并发同 receipt：另一事务已创建 → 读回并按幂等复用判定
        const raced = await tx.settlement.findFirst({
          where: identityWhere,
          select: { id: true, amount: true, currency: true, receivedAt: true, receiptSnapshotId: true },
        });
        if (!raced || !raced.receiptSnapshotId) {
          throw new SettlementRecordError('EVENT_IDENTITY_CONFLICT', 'concurrent settlement conflict');
        }
        assertSameImmutableFacts(raced, snapshot);
        throw new ReusedAfterRace(raced.id, raced.receiptSnapshotId);
      });

    await tx.auditLog.create({
      data: {
        organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'settlement.recorded',
        entityType: 'Settlement',
        entityId: settlement.id,
        changes: {
          receiptSnapshotId: receiptSnapshot.id,
          snapshotDigest: snapshot.snapshotDigest,
          amount: snapshot.amount,
          currency: snapshot.currency,
          receivedAt: snapshot.receivedAtUtc,
          externalIdentityKind: snapshot.externalIdentityKind,
        },
      },
    });

    return {
      status: 'CREATED' as const,
      settlementId: settlement.id,
      receiptSnapshotId: receiptSnapshot.id,
      snapshotDigest: snapshot.snapshotDigest,
    };
  }).catch(async (error: unknown) => {
    if (error instanceof ReusedAfterRace) {
      return {
        status: 'REUSED' as const,
        settlementId: error.settlementId,
        receiptSnapshotId: error.receiptSnapshotId,
        snapshotDigest: snapshot.snapshotDigest,
      };
    }
    throw error;
  });
}

/** 内部信号：并发竞争后按 REUSED 返回（回滚本事务写入） */
class ReusedAfterRace extends Error {
  constructor(
    public readonly settlementId: string,
    public readonly receiptSnapshotId: string,
  ) {
    super('REUSED_AFTER_RACE');
  }
}

/**
 * 生产装配：把受保护写路径的依赖绑定到真实 Prisma + 外部注入的审批校验器
 * （approval 校验仍由 action-guard 提供；membership 复验由本工厂强制，避免调用方漏接）。
 */
export function createSettlementRecordDeps(
  prisma: PrismaClient,
  approval: SettlementRecordDeps['verifyApproval'] | ActionGuardApprovalVerifier,
): SettlementRecordDeps {
  return {
    prisma,
    // 生产装配：action-guard verifier 走 verifyApprovalOrThrow（缺失 verifier → fail-closed）；
    // 仅当调用方显式传入函数时（测试/受控注入）才直接使用。
    verifyApproval: async (request) => {
      if (typeof approval === 'function') {
        return approval(request);
      }
      let decision;
      try {
        decision = await verifyApprovalOrThrow({
        verifier: approval,
        query: {
          approvalId: request.approvalId,
          organizationId: request.organizationId,
          action: request.action,
          actorUserId: request.actorUserId,
          targetRef: request.boundExtra.receiptSnapshotDigest ?? undefined,
          payload: {
            recoveredAmount: request.boundExtra.amount,
            currency: request.boundExtra.currency,
          },
        },
        });
      } catch (error) {
        throw new SettlementRecordError('APPROVAL_REQUIRED', (error as Error)?.message ?? 'approval rejected');
      }
      return decision.valid === true;
    },
    assertActiveMembership: async (organizationId: string, userId: string) => {
      const row = await prisma.membership.findFirst({
        where: { organizationId, userId, isActive: true },
        select: { id: true },
      });
      if (!row) {
        throw new SettlementRecordError('APPROVAL_REQUIRED', 'no ACTIVE membership for actor');
      }
    },
  };
}
