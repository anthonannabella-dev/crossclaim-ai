/**
 * R46 S3 —— SettlementAdjustment / Full Reversal 受保护写路径
 * 依据：MSG-20261002-56（S3 授权；v1 仅 full reversal）。
 *
 * 只做：existing Settlement → verified reversal evidence → SettlementAdjustment(kind=REVERSAL)（append-only）。
 * 禁止：修改/删除原 Settlement；触发 Fee 重算 / Invoice VOID / Payment·refund / autopay / 平台外写。
 */

import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { canonicalJson } from '../platform-write/snapshot';

import {
  verifyApprovalOrThrow,
  type ActionGuardApprovalVerifier,
} from '../action-guard/approval-verifier';
import { canonicalAmount, canonicalCurrency } from './receipt-snapshot';

export const SETTLEMENT_REVERSAL_ACTION = 'settlement.reversal';

export type ReversalErrorCode =
  | 'INVALID_INPUT'
  | 'CLIENT_DERIVED_FIELD_NOT_TRUSTED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_ALREADY_CONSUMED'
  | 'ORIGINAL_SETTLEMENT_NOT_FOUND'
  | 'CROSS_TENANT_REFERENCE'
  | 'REVERSAL_AMOUNT_MISMATCH'
  | 'REVERSAL_CURRENCY_MISMATCH'
  | 'REVERSAL_ALREADY_APPLIED'
  | 'EVENT_IDENTITY_CONFLICT'
  | 'EVIDENCE_REQUIRED'
  | 'EVIDENCE_NOT_FOUND';

export class ReversalError extends Error {
  constructor(
    public readonly code: ReversalErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ReversalError';
  }
}

export interface ReversalDeps {
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

export interface RecordReversalInput {
  organizationId: string;
  actorUserId: string;
  approvalId: string;
  originalSettlementId: string;
  amount: string;
  currency: string;
  occurredAt: string | Date;
  externalIdentityKind:
    | 'BANK_TRANSACTION'
    | 'PSP_SETTLEMENT'
    | 'PLATFORM_SETTLEMENT_REPORT'
    | 'CARRIER_SETTLEMENT'
    | 'INSURER_PAYOUT'
    | 'CHECK_REFERENCE'
    | 'MANUAL_DOCUMENT'
    | 'OTHER';
  externalIdentityValue?: string | null;
  externalIdentityValueHash?: string | null;
  externalIdentityVersion?: string | null;
  financialEventFingerprint?: string | null;
  evidenceReferences: { evidenceArtifactId: string; digest: string; kind: string }[];
  reasonCode: string;
  reasonText?: string | null;
  clientDerivedFields?: Record<string, unknown> | null;
}

export interface RecordReversalResult {
  status: 'CREATED' | 'REUSED';
  adjustmentId: string;
  originalSettlementId: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** 生产装配：action-guard verifier + ACTIVE membership 复验（与 S2 同构） */
export function createReversalDeps(
  prisma: PrismaClient,
  approval: ReversalDeps['verifyApproval'] | ActionGuardApprovalVerifier,
): ReversalDeps {
  return {
    prisma,
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
            targetRef: request.boundExtra.originalSettlementId ?? undefined,
            payload: {
              recoveredAmount: request.boundExtra.amount,
              currency: request.boundExtra.currency,
            },
          },
        });
        return decision.valid === true;
      } catch (error) {
        throw new ReversalError('APPROVAL_REQUIRED', (error as Error)?.message ?? 'approval rejected');
      }
    },
    assertActiveMembership: async (organizationId, userId) => {
      const row = await prisma.membership.findFirst({
        where: { organizationId, userId, isActive: true },
        select: { id: true },
      });
      if (!row) throw new ReversalError('APPROVAL_REQUIRED', 'no ACTIVE membership for actor');
    },
  };
}

export async function recordSettlementReversal(
  deps: ReversalDeps,
  input: RecordReversalInput,
): Promise<RecordReversalResult> {
  if (input.clientDerivedFields && Object.keys(input.clientDerivedFields).length > 0) {
    throw new ReversalError('CLIENT_DERIVED_FIELD_NOT_TRUSTED', 'client-provided derived fields');
  }
  if (!input.evidenceReferences || input.evidenceReferences.length < 1) {
    throw new ReversalError('EVIDENCE_REQUIRED', 'at least one evidence reference is required');
  }
  const organizationId = String(input.organizationId ?? '').trim();
  if (!organizationId) throw new ReversalError('INVALID_INPUT', 'organizationId is required');
  const amount = canonicalAmount(input.amount);
  const currency = canonicalCurrency(input.currency);
  const valueHash = input.externalIdentityValueHash
    ? String(input.externalIdentityValueHash).trim().toLowerCase()
    : null;
  const fingerprint = input.financialEventFingerprint
    ? String(input.financialEventFingerprint).trim().toLowerCase()
    : null;
  if (valueHash && !HEX64.test(valueHash)) throw new ReversalError('INVALID_INPUT', 'valueHash must be 64hex');
  if (fingerprint && !HEX64.test(fingerprint)) throw new ReversalError('INVALID_INPUT', 'fingerprint must be 64hex');
  if (!valueHash && !fingerprint) {
    throw new ReversalError('INVALID_INPUT', 'reversal requires its own external identity / fingerprint');
  }
  const occurredAt = input.occurredAt instanceof Date ? input.occurredAt : new Date(String(input.occurredAt));
  if (Number.isNaN(occurredAt.getTime())) throw new ReversalError('INVALID_INPUT', 'occurredAt invalid');

  // CHANGE 1（MSG-20261002-57）：把全部可信不可变 reversal 字段纳入服务端 canonical snapshot，
  // 审批绑定该 digest，锁后重验 —— 杜绝「审批 A、落库 B」。
  const reversalSnapshotDigest = createHash('sha256')
    .update(
      canonicalJson({
        organizationId,
        originalSettlementId: input.originalSettlementId,
        amount,
        currency,
        occurredAtUtc: occurredAt.toISOString(),
        externalIdentityKind: input.externalIdentityKind,
        externalIdentityValueHash: valueHash,
        financialEventFingerprint: fingerprint,
        reasonCode: input.reasonCode,
        evidenceArtifactIds: input.evidenceReferences.map((r) => r.evidenceArtifactId).sort(),
      }),
    )
    .digest('hex');

  const approved = await deps.verifyApproval({
    organizationId,
    action: SETTLEMENT_REVERSAL_ACTION,
    approvalId: input.approvalId,
    actorUserId: input.actorUserId,
    boundExtra: {
      reversalSnapshotDigest,
      originalSettlementId: input.originalSettlementId,
      amount,
      currency,
      organizationId,
      externalIdentityValueHash: valueHash,
      financialEventFingerprint: fingerprint,
    },
  });
  if (!approved) throw new ReversalError('APPROVAL_REQUIRED', 'human approval is required');

  const identityWhere = valueHash
    ? {
        organizationId,
        externalIdentityKind: input.externalIdentityKind,
        externalIdentityValueHash: valueHash,
        externalIdentityVersion: input.externalIdentityVersion ?? null,
      }
    : {
        organizationId,
        financialEventFingerprint: fingerprint,
        financialEventFingerprintVersion: null,
      };

  return deps.prisma.$transaction(async (tx) => {
    await deps.assertActiveMembership(organizationId, input.actorUserId);

    const original = await tx.settlement.findFirst({
      where: { id: input.originalSettlementId },
      select: { id: true, organizationId: true, amount: true, currency: true, receiptSnapshotId: true },
    });
    if (!original) throw new ReversalError('ORIGINAL_SETTLEMENT_NOT_FOUND', 'original settlement not found');
    if (original.organizationId !== organizationId) {
      throw new ReversalError('CROSS_TENANT_REFERENCE', 'original settlement belongs to another tenant');
    }
    if (Number(original.amount) !== Number(amount)) {
      throw new ReversalError('REVERSAL_AMOUNT_MISMATCH', 'v1 requires full reversal with equal amount');
    }
    if (original.currency !== currency) {
      throw new ReversalError('REVERSAL_CURRENCY_MISMATCH', 'reversal currency must equal original currency');
    }

    // 幂等：同一 reversal event 重放 → REUSED；identity 相同但事实不同 → EVENT_IDENTITY_CONFLICT
    const existing = await tx.settlementAdjustment.findFirst({
      where: identityWhere,
      select: { id: true, originalSettlementId: true, amount: true, currency: true },
    });
    if (existing) {
      const same =
        existing.originalSettlementId === input.originalSettlementId &&
        Number(existing.amount) === Number(amount) &&
        existing.currency === currency;
      if (!same) throw new ReversalError('EVENT_IDENTITY_CONFLICT', 'same reversal identity, different facts');
      return { status: 'REUSED' as const, adjustmentId: existing.id, originalSettlementId: existing.originalSettlementId };
    }

    // v1 full reversal 唯一：同一 original Settlement 已存在调整事实 → REVERSAL_ALREADY_APPLIED
    const already = await tx.settlementAdjustment.findFirst({
      where: { organizationId, originalSettlementId: input.originalSettlementId },
      select: { id: true },
    });
    if (already) {
      throw new ReversalError('REVERSAL_ALREADY_APPLIED', 'this settlement has already been fully reversed');
    }

    for (const ref of input.evidenceReferences) {
      const artifact = await tx.evidenceArtifact.findFirst({
        where: { id: ref.evidenceArtifactId },
        select: { organizationId: true },
      });
      if (!artifact) throw new ReversalError('EVIDENCE_NOT_FOUND', 'evidence artifact not found');
      if (artifact.organizationId !== organizationId) {
        throw new ReversalError('CROSS_TENANT_REFERENCE', 'evidence belongs to another tenant');
      }
    }

    await tx.auditLog
      .create({
        data: {
          id: 'settlement-reversal-approval-' + input.approvalId,
          organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action: 'settlement.reversal.approval_consumed',
          entityType: 'Approval',
          entityId: input.approvalId,
          changes: { originalSettlementId: input.originalSettlementId, amount, currency },
        },
        select: { id: true },
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2002') {
          throw new ReversalError('APPROVAL_ALREADY_CONSUMED', 'approval has already been consumed');
        }
        throw error;
      });

    const adjustment = await tx.settlementAdjustment.create({
      data: {
        organizationId,
        originalSettlementId: input.originalSettlementId,
        adjustmentKind: 'REVERSAL',
        amount,
        currency,
        occurredAt,
        externalIdentityKind: input.externalIdentityKind,
        externalIdentityValue: input.externalIdentityValue ?? null,
        externalIdentityValueHash: valueHash,
        externalIdentityVersion: input.externalIdentityVersion ?? null,
        financialEventFingerprint: fingerprint,
        evidenceReferences: input.evidenceReferences,
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
        action: 'settlement.reversal_recorded',
        entityType: 'SettlementAdjustment',
        entityId: adjustment.id,
        changes: { originalSettlementId: input.originalSettlementId, amount, currency, reasonCode: input.reasonCode },
      },
    });

    return { status: 'CREATED' as const, adjustmentId: adjustment.id, originalSettlementId: input.originalSettlementId };
  });
}
