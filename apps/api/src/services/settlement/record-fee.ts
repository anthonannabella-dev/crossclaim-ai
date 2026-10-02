/**
 * R46 S4 —— FeeCalculation 受保护写路径（membership + FeeCalculation）
 * 依据：MSG-20261002-59（S4 AUTHORIZED）。
 * 只做：eligible unreversed Settlement → FeeCalculationSettlement membership → FeeCalculation。
 * 禁止：修改历史 FeeCalculation；创建 BillingInvoice / Payment；触发 autopay；Release R13 Gate。
 */

import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import {
  verifyApprovalOrThrow,
  type ActionGuardApprovalVerifier,
} from '../action-guard/approval-verifier';
import { canonicalJson } from '../platform-write/snapshot';
import { computeSettlementFee } from './fee-compute';
import {
  assertNoClientPolicyFields,
  type FeePolicyRecord,
} from './fee-policy-source';
import { isSettlementFeeEligible } from './fee-eligibility';

export const FEE_CALCULATE_ACTION = 'billing.fee_calculate';

export type FeeRecordErrorCode =
  | 'INVALID_INPUT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_ALREADY_CONSUMED'
  | 'CLIENT_FEE_INPUT_NOT_TRUSTED'
  | 'SETTLEMENT_NOT_FOUND'
  | 'CROSS_TENANT_REFERENCE'
  | 'SETTLEMENT_NOT_FEE_ELIGIBLE'
  | 'MEMBERSHIP_CHAIN_CONFLICT'
  | 'FEE_POLICY_INVALID';

export class FeeRecordError extends Error {
  constructor(
    public readonly code: FeeRecordErrorCode,
    message?: string,
  ) {
    super(message ? code + ': ' + message : code);
    this.name = 'FeeRecordError';
  }
}

export interface FeeRecordDeps {
  prisma: PrismaClient;
  verifyApproval: (request: {
    organizationId: string;
    action: string;
    approvalId: string;
    actorUserId: string;
    boundExtra: Record<string, string | null>;
  }) => Promise<boolean>;
  assertActiveMembership: (organizationId: string, userId: string) => Promise<void>;
  /** 服务端可信、版本化 fee policy 解析（MSG-60 CHANGE A） */
  resolveFeePolicy: (request: {
    organizationId: string;
    policyRef: string;
    feeBasisVersion: string;
  }) => Promise<FeePolicyRecord>;
}

export interface RecordFeeInput {
  organizationId: string;
  actorUserId: string;
  approvalId: string;
  feeChainId: string;
  claimItemId: string;
  settlementIds: string[];
  /** 只允许提交 policy 引用；费率/币种等可信字段由服务端解析（MSG-60 CHANGE A） */
  policyRef: string;
  feeBasisVersion: string;
  /** 任何客户端提交的 policy 字段 → CLIENT_POLICY_FIELDS_NOT_TRUSTED */
  clientPolicyFields?: Record<string, unknown> | null;
  clientSuppliedRate?: string | null;
  clientSuppliedPolicyRef?: string | null;
}

export interface RecordFeeResult {
  status: 'CREATED';
  feeCalculationId: string;
  baseAmount: string;
  feeAmount: string;
  membershipDigest: string;
}

export function createFeeRecordDeps(
  prisma: PrismaClient,
  approval: FeeRecordDeps['verifyApproval'] | ActionGuardApprovalVerifier,
  resolveFeePolicy: FeeRecordDeps['resolveFeePolicy'],
): FeeRecordDeps {
  return {
    prisma,
    resolveFeePolicy,
    verifyApproval: async (request) => {
      if (typeof approval === 'function') return approval(request);
      try {
        const decision = await verifyApprovalOrThrow({
          verifier: approval,
          query: {
            approvalId: request.approvalId,
            organizationId: request.organizationId,
            action: request.action,
            actorUserId: request.actorUserId,
            targetRef: request.boundExtra.feeSnapshotDigest ?? undefined,
            payload: {
              recoveredAmount: request.boundExtra.baseAmount,
              currency: request.boundExtra.currency,
            },
          },
        });
        return decision.valid === true;
      } catch (error) {
        throw new FeeRecordError('APPROVAL_REQUIRED', (error as Error)?.message ?? 'approval rejected');
      }
    },
    assertActiveMembership: async (organizationId, userId) => {
      const row = await prisma.membership.findFirst({
        where: { organizationId, userId, isActive: true },
        select: { id: true },
      });
      if (!row) throw new FeeRecordError('APPROVAL_REQUIRED', 'no ACTIVE membership for actor');
    },
  };
}

export async function recordFeeCalculation(
  deps: FeeRecordDeps,
  input: RecordFeeInput,
): Promise<RecordFeeResult> {
  assertNoClientPolicyFields((input.clientPolicyFields ?? {}) as Record<string, unknown>);
  if (input.clientSuppliedRate || input.clientSuppliedPolicyRef) {
    throw new FeeRecordError('CLIENT_FEE_INPUT_NOT_TRUSTED', 'client-supplied rate/policy is not trusted');
  }
  if (!input.settlementIds || input.settlementIds.length < 1) {
    throw new FeeRecordError('INVALID_INPUT', 'at least one settlementId is required');
  }
  if (!input.feeChainId || !input.claimItemId) {
    throw new FeeRecordError('INVALID_INPUT', 'feeChainId and claimItemId are required');
  }
  const organizationId = String(input.organizationId ?? '').trim();
  const policy = await deps.resolveFeePolicy({
    organizationId,
    policyRef: input.policyRef,
    feeBasisVersion: input.feeBasisVersion,
  });
  const feeSnapshotDigest = createHash('sha256')
    .update(
      canonicalJson({
        organizationId,
        claimItemId: input.claimItemId,
        feeChainId: input.feeChainId,
        settlementIds: [...input.settlementIds].sort(),
        policy,
        policyDigest: policy.policyDigest,
      }),
    )
    .digest('hex');

  const approved = await deps.verifyApproval({
    organizationId,
    action: FEE_CALCULATE_ACTION,
    approvalId: input.approvalId,
    actorUserId: input.actorUserId,
    boundExtra: {
      feeSnapshotDigest,
      claimItemId: input.claimItemId,
      feeChainId: input.feeChainId,
      policyRef: policy.policyRef,
      feeBasisVersion: policy.feeBasisVersion,
      currency: policy.currency,
    },
  });
  if (!approved) throw new FeeRecordError('APPROVAL_REQUIRED', 'human approval is required for fee calculation');

  return deps.prisma.$transaction(async (tx) => {
    await deps.assertActiveMembership(organizationId, input.actorUserId);

    // 同一个 claimItem 至多一条 active（未被 supersede）fee chain —— 防「互不相关 active chain 双计费」
    const activeChain = await tx.feeCalculation.findFirst({
      where: { organizationId, claimItemId: input.claimItemId, supersededByFeeCalculationId: null },
      select: { id: true, feeChainId: true },
    });
    if (activeChain && activeChain.feeChainId !== input.feeChainId) {
      throw new FeeRecordError('MEMBERSHIP_CHAIN_CONFLICT', 'another active fee chain exists for this claim');
    }

    const memberships: { settlementId: string; amount: string; currency: string }[] = [];
    const adjustments: { settlementId: string; amount: string; currency: string }[] = [];
    for (const settlementId of input.settlementIds) {
      const s = await tx.settlement.findFirst({
        where: { id: settlementId },
        select: {
          id: true,
          organizationId: true,
          status: true,
          confirmationStatus: true,
          reconciliationStatus: true,
          amount: true,
          currency: true,
          evidenceId: true,
          reversedBySettlementId: true,
        },
      });
      if (!s) throw new FeeRecordError('SETTLEMENT_NOT_FOUND', 'settlement not found');
      if (s.organizationId !== organizationId) {
        throw new FeeRecordError('CROSS_TENANT_REFERENCE', 'settlement belongs to another tenant');
      }
      const activeReversals = await tx.settlementAdjustment.findMany({
        where: { organizationId, originalSettlementId: s.id, adjustmentKind: 'REVERSAL' },
        select: { id: true, amount: true, currency: true },
      });
      const verdict = isSettlementFeeEligible({
        settlementId: s.id,
        status: s.status,
        confirmationStatus: s.confirmationStatus,
        reconciliationStatus: s.reconciliationStatus,
        amount: String(s.amount),
        currency: s.currency,
        evidenceId: s.evidenceId,
        reversedBySettlementId: s.reversedBySettlementId,
        hasActiveReversalAdjustment: activeReversals.length > 0,
      });
      if (!verdict.eligible) {
        throw new FeeRecordError('SETTLEMENT_NOT_FEE_ELIGIBLE', verdict.reason);
      }
      memberships.push({ settlementId: s.id, amount: String(s.amount), currency: s.currency });
      for (const adj of activeReversals) {
        adjustments.push({ settlementId: adj.id, amount: String(adj.amount), currency: adj.currency });
      }
    }

    const computed = computeSettlementFee({ memberships, adjustments, policy });

    await tx.auditLog
      .create({
        data: {
          id: 'fee-approval-' + input.approvalId,
          organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action: 'billing.fee_calculate.approval_consumed',
          entityType: 'Approval',
          entityId: input.approvalId,
          changes: { feeSnapshotDigest, feeChainId: input.feeChainId },
        },
        select: { id: true },
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2002') {
          throw new FeeRecordError('APPROVAL_ALREADY_CONSUMED', 'approval has already been consumed');
        }
        throw error;
      });

    const fee = await tx.feeCalculation.create({
      data: {
        organizationId,
        caseId: null,
        claimItemId: input.claimItemId,
        feeChainId: input.feeChainId,
        basis: policy.basis,
        rate: policy.rate ?? null,
        baseAmount: computed.baseAmount,
        feeAmount: computed.feeAmount,
        currency: computed.currency,
        computation: {
          algorithmVersion: computed.algorithmVersion,
          policyRef: computed.policyRef,
          feeBasisVersion: computed.feeBasisVersion,
          settlementIds: memberships.map((m) => m.settlementId),
        },
        membershipDigest: computed.membershipDigest,
        feeBasisVersion: computed.feeBasisVersion,
        policyRef: computed.policyRef,
      },
      select: { id: true },
    });

    for (const m of memberships) {
      await tx.feeCalculationSettlement.create({
        data: {
          organizationId,
          feeCalculationId: fee.id,
          settlementId: m.settlementId,
          basisRole: 'POSITIVE',
          amountContribution: m.amount,
          currency: m.currency,
        },
      });
    }
    for (const a of adjustments) {
      await tx.feeCalculationSettlement.create({
        data: {
          organizationId,
          feeCalculationId: fee.id,
          adjustmentId: a.settlementId,
          basisRole: 'NEGATIVE',
          amountContribution: '-' + a.amount.replace(/^-/, ''),
          currency: a.currency,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'billing.fee_calculated',
        entityType: 'FeeCalculation',
        entityId: fee.id,
        changes: {
          baseAmount: computed.baseAmount,
          feeAmount: computed.feeAmount,
          currency: computed.currency,
          membershipDigest: computed.membershipDigest,
          feeChainId: input.feeChainId,
        },
      },
    });

    return {
      status: 'CREATED' as const,
      feeCalculationId: fee.id,
      baseAmount: computed.baseAmount,
      feeAmount: computed.feeAmount,
      membershipDigest: computed.membershipDigest,
    };
  });
}
