// CUSTOMS / DUTY RECOVERY — slice B-S11 — Refund → Settlement → Success Fee guard（严格化 + 回归）
// ---------------------------------------------------------------------------
// 审计结论（既有实现）：
//   * `commercial/fee-policy.ts` 的 evaluateFeeGuard 负责「金额与策略」：拒绝 client 提供的费率、
//     拒绝 estimate 作为计费依据、要求策略 rateBps 存在、币种一致、金额格式合法 → 产出 fee due；
//   * `customs/customs-refund-settlement-linkage.ts` 的 evaluateCustomsRefundFeeTrigger 在金额层之上
//     增加了「refund evidence 不得为 USER_REPORTED」「必须存在 verified receipt」两道前置判断。
// 审计发现的缺口（本 slice 补上，fail-closed）：
//   ① 既有 guard **未在运行时校验来源级别**（仅靠类型约束）→ 非 VERIFIED 来源可能漏过；
//   ② 既有 guard **未校验 confirmationStatus / reconciliationStatus** → 未确认或仅 PARTIAL 对账也可能计费；
//   ③ 无「争议 / 冲正 → 已计费用必须冲回」的表达；
//   ④ 无「同一 settlement 只能计费一次」的幂等检查。
// 硬边界：本模块只做**计费资格判定**（复用既有 fee guard 计算金额），不扣款、不收款、不写外部、不自扣佣。

import { digestOf } from '../config-execution-durability/digests';
import { evaluateFeeGuard, type FeePolicy, type SuccessFeeDue } from '../commercial/fee-policy';

export const CUSTOMS_SUCCESS_FEE_GUARD_VERSION = 'customs-success-fee-guard/v1';

/** 允许计费的来源级别（其余一律 fail-closed） */
export const FEE_ELIGIBLE_SOURCE_LEVELS = ['PROVIDER_VERIFIED', 'AUTHORITY_VERIFIED'] as const;
export type FeeSourceLevel = 'USER_REPORTED' | 'UNVERIFIED' | (typeof FEE_ELIGIBLE_SOURCE_LEVELS)[number];

export const FEE_CONFIRMATION_STATUSES = ['CONFIRMED', 'PENDING_CONFIRMATION', 'REJECTED_BY_REVIEW'] as const;
export type FeeConfirmationStatus = (typeof FEE_CONFIRMATION_STATUSES)[number];

export const FEE_RECONCILIATION_STATUSES = [
  'NOT_STARTED',
  'PARTIAL',
  'RECONCILED',
  'DISPUTED',
  'REVERSED',
] as const;
export type FeeReconciliationStatus = (typeof FEE_RECONCILIATION_STATUSES)[number];

export const FEE_GUARD_DECISIONS = [
  'BILLABLE',
  'NOT_BILLABLE',
  'NEEDS_RECONCILIATION',
  'FEE_REVERSAL_REQUIRED',
  'DUPLICATE_FEE_SUPPRESSED',
] as const;
export type FeeGuardDecisionKind = (typeof FEE_GUARD_DECISIONS)[number];

export interface CustomsSettlementMoneyTruth {
  settlementId: string;
  /** 来源级别：只有 PROVIDER_VERIFIED / AUTHORITY_VERIFIED 可作为计费依据 */
  sourceLevel: FeeSourceLevel;
  confirmationStatus: FeeConfirmationStatus;
  reconciliationStatus: FeeReconciliationStatus;
  verifiedAmount: string;
  currency: string;
}

export interface CustomsSuccessFeeGuardInput {
  scope: { organizationId: string; platformAccountId: string };
  moneyTruth: CustomsSettlementMoneyTruth;
  policy: FeePolicy;
  /** 该 settlement 上已存在的成功费记录（幂等检查） */
  existingFees?: readonly { settlementId: string; feeId: string; feeAmount: string; chargedAt: string }[];
  /** client 提供的费率 —— 一律拒绝（服务端策略为准） */
  clientSuppliedRateBps?: number | null;
  /** 计费依据：estimate 一律不得计费 */
  basis?: 'ESTIMATED_RECOVERABLE' | 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED';
  now: Date;
}

export interface CustomsSuccessFeeGuardResult {
  kind: 'CUSTOMS_SUCCESS_FEE_GUARD';
  version: string;
  organizationId: string;
  platformAccountId: string;
  settlementId: string;
  decision: FeeGuardDecisionKind;
  billable: boolean;
  /** 只有 BILLABLE 时才有值；金额由既有 fee guard 计算（本模块不另算） */
  fee: SuccessFeeDue | null;
  /** 争议 / 冲正时：已计入的成功费必须冲回 */
  requiresFeeReversal: boolean;
  duplicateFeeDetected: boolean;
  reconciliationStrict: true;
  sourceLevelVerified: boolean;
  reasonCodes: string[];
  autoChargePerformed: false;
  paymentCollectionPerformed: false;
  autopayEnabled: false;
  externalPaymentWrite: false;
  productionCredentials: 'ABSENT';
  warnings: string[];
  evaluatedAt: string;
  guardDigest: string;
}

export type CustomsSuccessFeeGuardErrorCode = 'CUSTOMS_FEE_GUARD_CANNOT_CHARGE';

export class CustomsSuccessFeeGuardError extends Error {
  readonly code: CustomsSuccessFeeGuardErrorCode;

  constructor(code: CustomsSuccessFeeGuardErrorCode, message: string) {
    super(message);
    this.name = 'CustomsSuccessFeeGuardError';
    this.code = code;
  }
}

/**
 * 判定某笔 settlement 是否可计成功费（严格版）。
 * 通过后再交由既有 evaluateFeeGuard 产出金额；本模块不扣款、不收款。
 */
export function evaluateCustomsSuccessFeeGuard(
  input: CustomsSuccessFeeGuardInput,
): CustomsSuccessFeeGuardResult {
  const { moneyTruth } = input;
  const reasonCodes: string[] = [];
  const warnings: string[] = [];

  const existingFees = (input.existingFees ?? []).filter(
    (fee) => fee.settlementId === moneyTruth.settlementId,
  );
  const duplicateFeeDetected = existingFees.length > 0;

  const sourceLevelVerified = (FEE_ELIGIBLE_SOURCE_LEVELS as readonly string[]).includes(
    moneyTruth.sourceLevel,
  );
  if (!sourceLevelVerified) {
    reasonCodes.push('SOURCE_LEVEL_NOT_VERIFIED:' + moneyTruth.sourceLevel);
  }

  if (moneyTruth.confirmationStatus !== 'CONFIRMED') {
    reasonCodes.push('SETTLEMENT_NOT_CONFIRMED:' + moneyTruth.confirmationStatus);
  }

  const reversed = moneyTruth.reconciliationStatus === 'REVERSED';
  const disputed = moneyTruth.reconciliationStatus === 'DISPUTED';
  if (reversed || disputed) {
    reasonCodes.push('RECONCILIATION_' + moneyTruth.reconciliationStatus);
  }
  const reconciled = moneyTruth.reconciliationStatus === 'RECONCILED';
  if (!reconciled && !reversed && !disputed) {
    // PARTIAL（或未开始）→ 需要完成 reconciliation 才可计费
    reasonCodes.push('RECONCILIATION_NOT_COMPLETE:' + moneyTruth.reconciliationStatus);
  }

  if (input.clientSuppliedRateBps !== undefined && input.clientSuppliedRateBps !== null) {
    reasonCodes.push('CLIENT_SUPPLIED_RATE_REJECTED');
  }
  const basis = input.basis ?? 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED';
  if (basis !== 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED') {
    reasonCodes.push('ESTIMATE_NOT_BILLABLE');
  }

  // 金额与策略层：交给既有 fee guard（不重复实现）
  const feeGuard = evaluateFeeGuard({
    policy: input.policy,
    basis,
    verifiedRecovered:
      moneyTruth.confirmationStatus === 'CONFIRMED'
        ? {
            settlementId: moneyTruth.settlementId,
            verifiedAmount: moneyTruth.verifiedAmount,
            currency: moneyTruth.currency,
            confirmationStatus: 'CONFIRMED',
            // 既有 guard 的类型允许 PARTIAL；严格性由本模块的 reconciliation 检查承担
            reconciliationStatus: reconciled ? 'RECONCILED' : 'PARTIAL',
          }
        : null,
    ...(input.clientSuppliedRateBps !== undefined ? { clientSuppliedRateBps: input.clientSuppliedRateBps } : {}),
  });
  if (!feeGuard.allowed) reasonCodes.push('FEE_GUARD_REJECTED:' + feeGuard.reasonCode);

  const requiresFeeReversal = (reversed || disputed) && duplicateFeeDetected;
  if (requiresFeeReversal) {
    warnings.push('EXISTING_FEE_MUST_BE_REVERSED');
  }

  let decision: FeeGuardDecisionKind;
  let fee: SuccessFeeDue | null = null;

  if (reversed || disputed) {
    decision = requiresFeeReversal ? 'FEE_REVERSAL_REQUIRED' : 'NOT_BILLABLE';
  } else if (duplicateFeeDetected) {
    decision = 'DUPLICATE_FEE_SUPPRESSED';
    warnings.push('ONE_FEE_PER_SETTLEMENT');
  } else if (sourceLevelVerified && moneyTruth.confirmationStatus === 'CONFIRMED' && reconciled && feeGuard.allowed) {
    decision = 'BILLABLE';
    fee = feeGuard.fee;
  } else if (
    sourceLevelVerified &&
    moneyTruth.confirmationStatus === 'CONFIRMED' &&
    !reconciled
  ) {
    decision = 'NEEDS_RECONCILIATION';
  } else {
    decision = 'NOT_BILLABLE';
  }

  const body = {
    version: CUSTOMS_SUCCESS_FEE_GUARD_VERSION,
    organizationId: input.scope.organizationId,
    platformAccountId: input.scope.platformAccountId,
    settlementId: moneyTruth.settlementId,
    decision,
    billable: decision === 'BILLABLE',
    fee,
    requiresFeeReversal,
    duplicateFeeDetected,
    reconciliationStrict: true as const,
    sourceLevelVerified,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    autoChargePerformed: false as const,
    paymentCollectionPerformed: false as const,
    autopayEnabled: false as const,
    externalPaymentWrite: false as const,
    productionCredentials: 'ABSENT' as const,
    warnings,
    evaluatedAt: input.now.toISOString(),
  };

  return {
    kind: 'CUSTOMS_SUCCESS_FEE_GUARD',
    ...body,
    guardDigest: digestOf(body),
  };
}

export const CUSTOMS_SUCCESS_FEE_GUARD_BOUNDARY = {
  strictSourceLevel: true,
  strictReconciliation: true,
  oneFeePerSettlement: true,
  estimateIsNotBillable: true,
  clientSuppliedRateRejected: true,
  autoChargePerformed: false,
  paymentCollectionPerformed: false,
  autopayEnabled: false,
  externalPaymentWrite: false,
  productionCredentials: 'ABSENT',
  reversalOnDisputeOrReversal: true,
  forbidden: [
    'billing on an estimate',
    'billing on a USER_REPORTED or UNVERIFIED source',
    'billing before reconciliation completes',
    'charging twice for the same settlement',
    'collecting payment / auto-charging a success fee',
    'honouring a client-supplied rate',
  ],
} as const;

/** 边界断言：任何声称已扣款 / 已收款 / 已自动扣佣 / 依据未验证来源计费的记录都必须被拒绝 */
export function assertFeeGuardDidNotCharge(record: {
  autoChargePerformed?: boolean;
  paymentCollectionPerformed?: boolean;
  autopayEnabled?: boolean;
  externalPaymentWrite?: boolean;
  billable?: boolean;
  sourceLevelVerified?: boolean;
}): void {
  if (
    record.autoChargePerformed === true ||
    record.paymentCollectionPerformed === true ||
    record.autopayEnabled === true ||
    record.externalPaymentWrite === true ||
    (record.billable === true && record.sourceLevelVerified === false)
  ) {
    throw new CustomsSuccessFeeGuardError(
      'CUSTOMS_FEE_GUARD_CANNOT_CHARGE',
      '本模块只判定计费资格：不得扣款、不得收款、不得自动扣佣，也不得依据未验证来源计费。',
    );
  }
}
