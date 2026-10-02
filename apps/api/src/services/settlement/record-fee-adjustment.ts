/**
 * R46 S4 —— FeeCalculationAdjustment 受保护写路径（append-only；不修改历史 FeeCalculation）
 * 依据：MSG-20261002-59 §3/§4。
 *
 * 只做：历史 FeeCalculation + verified SettlementAdjustment(REVERSAL) → FeeCalculationAdjustment。
 * 禁止：UPDATE 历史 FeeCalculation；创建 BillingInvoice / Payment；触发 autopay。
 */

import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { canonicalJson } from '../platform-write/snapshot';
import { feeAdjustmentEffect, type FeeAdjustmentKind } from './fee-compute';

export const FEE_ADJUST_ACTION = 'billing.fee_adjust';

export type FeeAdjustmentErrorCode =
  | 'INVALID_INPUT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_ALREADY_CONSUMED'
  | 'FEE_CALCULATION_NOT_FOUND'
  | 'CROSS_TENANT_REFERENCE'
  | 'REVERSAL_ADJUSTMENT_NOT_FOUND'
  | 'ADJUSTMENT_REPLAYED'
  | 'VOID_AMOUNT_MISMATCH'
  | 'EVIDENCE_REQUIRED';

export class FeeAdjustmentError extends Error {
  constructor(
    public readonly code: FeeAdjustmentErrorCode,
    message?: string,
  ) {
    super(message ? code + ': ' + message : code);
    this.name = 'FeeAdjustmentError';
  }
}

export interface FeeAdjustmentDeps {
  prisma: PrismaClient;
  verifyApproval: (request: {
    organizationId: string;
    action: string;
    approvalId: string;
    actorUserId: string;
    boundExtra: Record<string, string | null>;
  }) => Promise<boolean>;
  assertActiveMembership: (organizationId: string, userId: string) => Promise<void>;
}

export interface RecordFeeAdjustmentInput {
  organizationId: string;
  actorUserId: string;
  approvalId: string;
  targetFeeCalculationId: string;
  adjustmentKind: FeeAdjustmentKind;
  /** 只存正数；方向由 kind 决定 */
  amount: string;
  currency: string;
  /** REVERSAL 必填：触发本次调整的 SettlementAdjustment id 列表 */
  triggerSettlementAdjustmentIds?: string[];
  evidenceReferences?: { evidenceArtifactId: string }[];
  reasonCode: string;
  reasonText?: string | null;
  correctionDirection?: 'INCREASE' | 'DECREASE';
}

export interface RecordFeeAdjustmentResult {
  status: 'CREATED';
  feeCalculationAdjustmentId: string;
  netFeeEffect: string;
}

export async function recordFeeAdjustment(
  deps: FeeAdjustmentDeps,
  input: RecordFeeAdjustmentInput,
): Promise<RecordFeeAdjustmentResult> {
  if (!input.targetFeeCalculationId || !input.reasonCode) {
    throw new FeeAdjustmentError('INVALID_INPUT', 'targetFeeCalculationId and reasonCode are required');
  }
  if (!input.evidenceReferences || input.evidenceReferences.length < 1) {
    throw new FeeAdjustmentError('EVIDENCE_REQUIRED', 'at least one evidence reference is required');
  }
  if (input.adjustmentKind === 'REVERSAL' && (!input.triggerSettlementAdjustmentIds || input.triggerSettlementAdjustmentIds.length < 1)) {
    throw new FeeAdjustmentError('INVALID_INPUT', 'REVERSAL requires triggerSettlementAdjustmentIds');
  }
  const organizationId = String(input.organizationId ?? '').trim();
  const feeSnapshotDigest = createHash('sha256')
    .update(
      canonicalJson({
        organizationId,
        targetFeeCalculationId: input.targetFeeCalculationId,
        adjustmentKind: input.adjustmentKind,
        amount: input.amount,
        currency: input.currency,
        triggerSettlementAdjustmentIds: [...(input.triggerSettlementAdjustmentIds ?? [])].sort(),
        reasonCode: input.reasonCode,
      }),
    )
    .digest('hex');

  const approved = await deps.verifyApproval({
    organizationId,
    action: FEE_ADJUST_ACTION,
    approvalId: input.approvalId,
    actorUserId: input.actorUserId,
    boundExtra: {
      feeAdjustmentSnapshotDigest: feeSnapshotDigest,
      targetFeeCalculationId: input.targetFeeCalculationId,
      adjustmentKind: input.adjustmentKind,
      amount: input.amount,
      currency: input.currency,
    },
  });
  if (!approved) throw new FeeAdjustmentError('APPROVAL_REQUIRED', 'human approval is required for fee adjustment');

  return deps.prisma.$transaction(async (tx) => {
    await deps.assertActiveMembership(organizationId, input.actorUserId);

    const target = await tx.feeCalculation.findFirst({
      where: { id: input.targetFeeCalculationId },
      select: { id: true, organizationId: true, feeAmount: true, currency: true },
    });
    if (!target) throw new FeeAdjustmentError('FEE_CALCULATION_NOT_FOUND', 'fee calculation not found');
    if (target.organizationId !== organizationId) {
      throw new FeeAdjustmentError('CROSS_TENANT_REFERENCE', 'fee calculation belongs to another tenant');
    }

    for (const adjustmentId of input.triggerSettlementAdjustmentIds ?? []) {
      const row = await tx.settlementAdjustment.findFirst({
        where: { id: adjustmentId, organizationId, adjustmentKind: 'REVERSAL' },
        select: { id: true },
      });
      if (!row) throw new FeeAdjustmentError('REVERSAL_ADJUSTMENT_NOT_FOUND', 'reversal adjustment not found in tenant');
      const replayed = await tx.feeCalculationAdjustment.findFirst({
        where: { organizationId, triggerSettlementAdjustmentIds: { equals: [adjustmentId] } },
        select: { id: true },
      });
      if (replayed) throw new FeeAdjustmentError('ADJUSTMENT_REPLAYED', 'this reversal already produced a fee adjustment');
    }

    let netFeeEffect: string;
    try {
      netFeeEffect = feeAdjustmentEffect({
        kind: input.adjustmentKind,
        amount: input.amount,
        originalFeeAmount: String(target.feeAmount),
        correctionDirection: input.correctionDirection,
      });
    } catch (error) {
      throw new FeeAdjustmentError('VOID_AMOUNT_MISMATCH', (error as Error)?.message ?? 'invalid adjustment');
    }

    await tx.auditLog
      .create({
        data: {
          id: 'fee-adjustment-approval-' + input.approvalId,
          organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action: 'billing.fee_adjust.approval_consumed',
          entityType: 'Approval',
          entityId: input.approvalId,
          changes: { feeAdjustmentSnapshotDigest: feeSnapshotDigest },
        },
        select: { id: true },
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2002') {
          throw new FeeAdjustmentError('APPROVAL_ALREADY_CONSUMED', 'approval has already been consumed');
        }
        throw error;
      });

    const created = await tx.feeCalculationAdjustment.create({
      data: {
        organizationId,
        targetFeeCalculationId: target.id,
        adjustmentKind: input.adjustmentKind,
        amount: input.amount,
        currency: input.currency,
        triggerSettlementAdjustmentIds: input.triggerSettlementAdjustmentIds ?? undefined,
        evidenceReferences: input.evidenceReferences ?? [],
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
        approvalId: input.approvalId,
        createdByUserId: input.actorUserId,
      },
      select: { id: true },
    });

    await tx.auditLog.create({
      data: {
        organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'billing.fee_adjusted',
        entityType: 'FeeCalculationAdjustment',
        entityId: created.id,
        changes: { targetFeeCalculationId: target.id, kind: input.adjustmentKind, netFeeEffect },
      },
    });

    // 历史 FeeCalculation 保持不可变：本路径不执行任何 UPDATE。
    return { status: 'CREATED' as const, feeCalculationAdjustmentId: created.id, netFeeEffect };
  });
}
