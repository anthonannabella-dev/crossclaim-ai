/**
 * V2-07 — CUSTOMS EXECUTION CHAIN（ONE SI Runtime 内的付费执行链 · 全程 HOLD-first）
 * ---------------------------------------------------------------
 * 授权：HOST DIRECTIVE 2026-10-10「V2-AUTONOMOUS-20261010-01」§二（PHASE F）。
 *
 * 状态链（顺序推进，第一个不满足的门禁即停）：
 *   FREE_DISCOVERY → WAITING_CUSTOMER_START → WAITING_VERIFIED_PAYMENT → TASK_CLAIMED
 *   → RECHECK_ENTITLEMENT_AND_AUTHORIZATION → PROFIT_GATE → PROVIDER_READY
 *   → EVIDENCE_VERIFICATION → CASE_PROGRESS → VERIFIED_SETTLEMENT → SUCCESS_FEE_RECEIVABLE
 *
 * 硬约束：
 *  1. 客户点击启动 ≠ 已付款；已付款 ≠ 已有有效授权（分属三个独立门禁）。
 *  2. 领取任务前后都要重新检查权益与授权（`recheckedAfterClaim`）。
 *  3. Profit Gate 必须在 Provider 之前生效。
 *  4. 任何外写都需要 `externalWriteAuthorized` **且** `actionGuardApproved`；本模块自身不执行外写。
 *  5. 结算必须有可信 Provider / 对账事实；预估、申请中、未到账一律不产生成功费应收。
 *  6. 同一笔结算（settlementId）不得重复生成成功费应收。
 *  7. 失败 / 超时 / 撤销 / 争议 → 明确 HOLD，绝不自动越过。
 *  8. 自动收款恒为 HOLD（`AUTO_COLLECTION=HOLD`）；本模块不发起任何资金操作。
 */

import { applyBpsFloorToCent } from './customs-profit-gate';
import { CUSTOMS_SUCCESS_FEE_RATE_BPS } from './customs-unlock-payment';

export const CUSTOMS_EXECUTION_CHAIN_VERSION = 'customs-execution-chain-v2.0.0';

export const CUSTOMS_EXECUTION_STATES = [
  'FREE_DISCOVERY',
  'WAITING_CUSTOMER_START',
  'WAITING_VERIFIED_PAYMENT',
  'TASK_CLAIMED',
  'RECHECK_ENTITLEMENT_AND_AUTHORIZATION',
  'PROFIT_GATE',
  'PROVIDER_READY',
  'EVIDENCE_VERIFICATION',
  'CASE_PROGRESS',
  'VERIFIED_SETTLEMENT',
  'SUCCESS_FEE_RECEIVABLE',
] as const;
export type CustomsExecutionState = (typeof CUSTOMS_EXECUTION_STATES)[number];

export type CustomsExecutionHoldReason =
  | 'CROSS_TENANT_REJECTED'
  | 'OPPORTUNITY_NOT_FOUND'
  | 'KILL_SWITCH_ENGAGED'
  | 'TIMEOUT_HOLD'
  | 'CUSTOMER_START_REQUIRED'
  | 'VERIFIED_PAYMENT_REQUIRED'
  | 'ENTITLEMENT_REQUIRED'
  | 'QUOTA_EXHAUSTED'
  | 'TASK_NOT_CLAIMED'
  | 'POST_CLAIM_RECHECK_REQUIRED'
  | 'STANDING_AUTHORIZATION_INVALID'
  | 'PROFIT_GATE_HOLD'
  | 'PROVIDER_NOT_READY'
  | 'PROVIDER_QUOTE_MISSING'
  | 'EXTERNAL_WRITE_NOT_AUTHORIZED'
  | 'ACTION_GUARD_APPROVAL_REQUIRED'
  | 'EVIDENCE_NOT_VERIFIED'
  | 'SETTLEMENT_NOT_VERIFIED'
  | 'SETTLEMENT_REFERENCE_MISSING'
  | 'SETTLEMENT_AMOUNT_INVALID'
  | 'DISPUTE_OR_REFUND_OPEN'
  | 'DUPLICATE_SUCCESS_FEE_SUPPRESSED';

export interface CustomsExecutionFacts {
  organizationId: string;
  opportunity: { caseFound: boolean; ownerOrganizationId: string | null };
  customerDecision: { started: boolean };
  payment: { verifiedPaid: boolean; entitlementActive: boolean; quotaRemaining: number };
  claim: { taskClaimed: boolean; recheckedAfterClaim: boolean };
  authorization: {
    standingAuthorizationValid: boolean;
    externalWriteAuthorized: boolean;
    actionGuardApproved: boolean;
  };
  profitGate: { decision: 'PASS' | 'HOLD' };
  provider: { available: boolean; quotedCost: string | null };
  evidence: { verified: boolean };
  settlement: {
    verifiedActualRecovery: boolean;
    settlementId: string | null;
    amount: string | null;
    currency: string | null;
  };
  disputes: { revokedOrRefunded: boolean };
  killSwitch: { engaged: boolean };
  timeouts: { timedOut: boolean };
  /** 已生成过成功费应收的结算 id（同一笔回款不得重复计费）。 */
  billedSettlementIds: ReadonlySet<string>;
}

export interface CustomsExecutionSuccessFee {
  state: 'NONE' | 'CALCULATED' | 'RECEIVABLE';
  basisSettlementId: string | null;
  amount: string | null;
  currency: string | null;
  rateBps: number;
}

export interface CustomsExecutionChainResult {
  kind: 'CUSTOMS_EXECUTION_CHAIN';
  version: string;
  state: CustomsExecutionState;
  /** 只有全部门禁通过时才是下一个状态；否则 null。 */
  nextAllowedState: CustomsExecutionState | null;
  holdReasons: readonly CustomsExecutionHoldReason[];
  /** 是否处于不可自动推进的等待 / HOLD（需要外部事实变化）。 */
  holding: boolean;
  /** 外写是否被允许（仍需 Action Runtime 真实执行；本模块不执行）。 */
  externalWritePermitted: boolean;
  successFee: CustomsExecutionSuccessFee;
  autoCollection: 'HOLD';
  externalWritePerformed: false;
  chargedAmount: null;
  productionCredentials: 'ABSENT';
}

const NO_FEE: CustomsExecutionSuccessFee = {
  state: 'NONE',
  basisSettlementId: null,
  amount: null,
  currency: null,
  rateBps: CUSTOMS_SUCCESS_FEE_RATE_BPS,
};

function positiveAmount(amount: string | null): string | null {
  if (amount === null) return null;
  const normalized = amount.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(normalized)) return null;
  return normalized === '0' || /^0(\.0+)?$/.test(normalized) ? null : normalized;
}

/**
 * 纯判定：给定服务端事实，返回"当前停在哪个状态"以及为什么停止。
 * 不产生副作用、不调用 provider、不写库、不扣款。
 */
export function evaluateCustomsExecutionChain(
  facts: CustomsExecutionFacts,
): CustomsExecutionChainResult {
  const base = {
    kind: 'CUSTOMS_EXECUTION_CHAIN' as const,
    version: CUSTOMS_EXECUTION_CHAIN_VERSION,
    autoCollection: 'HOLD' as const,
    externalWritePerformed: false as const,
    chargedAmount: null,
    productionCredentials: 'ABSENT' as const,
  };
  const at = (
    state: CustomsExecutionState,
    holdReasons: readonly CustomsExecutionHoldReason[],
    fees: CustomsExecutionSuccessFee = NO_FEE,
    externalWritePermitted = false,
  ): CustomsExecutionChainResult => {
    // HOLD 时给出"门禁解除后会进入的状态"；链路终点为 null。
    const index = CUSTOMS_EXECUTION_STATES.indexOf(state);
    const next = CUSTOMS_EXECUTION_STATES[index + 1] ?? null;
    return {
      ...base,
      state,
      nextAllowedState: holdReasons.length === 0 ? null : next,
      holdReasons,
      holding: holdReasons.length > 0,
      externalWritePermitted,
      successFee: fees,
    };
  };

  // 0) 归属与存在性
  const crossTenant =
    facts.opportunity.ownerOrganizationId !== null &&
    facts.opportunity.ownerOrganizationId !== facts.organizationId;
  if (crossTenant) return at('FREE_DISCOVERY', ['CROSS_TENANT_REJECTED']);
  if (!facts.opportunity.caseFound) return at('FREE_DISCOVERY', ['OPPORTUNITY_NOT_FOUND']);

  // 0b) 全局安全闸门：Kill Switch / 超时 / 争议
  if (facts.killSwitch.engaged) return at('FREE_DISCOVERY', ['KILL_SWITCH_ENGAGED']);
  if (facts.timeouts.timedOut) return at('FREE_DISCOVERY', ['TIMEOUT_HOLD']);

  // 1) 客户必须主动启动（点击 ≠ 付款）
  if (!facts.customerDecision.started) {
    return at('WAITING_CUSTOMER_START', ['CUSTOMER_START_REQUIRED']);
  }

  // 2) 真实付款 + 有效权益 + 额度
  const paymentHold: CustomsExecutionHoldReason[] = [];
  if (!facts.payment.verifiedPaid) paymentHold.push('VERIFIED_PAYMENT_REQUIRED');
  if (!facts.payment.entitlementActive) paymentHold.push('ENTITLEMENT_REQUIRED');
  else if (facts.payment.quotaRemaining <= 0) paymentHold.push('QUOTA_EXHAUSTED');
  if (paymentHold.length > 0) return at('WAITING_VERIFIED_PAYMENT', paymentHold);

  // 3) 任务领取
  if (!facts.claim.taskClaimed) return at('TASK_CLAIMED', ['TASK_NOT_CLAIMED']);

  // 4) 领取后重新检查权益与授权
  const recheckHold: CustomsExecutionHoldReason[] = [];
  if (!facts.claim.recheckedAfterClaim) recheckHold.push('POST_CLAIM_RECHECK_REQUIRED');
  if (!facts.authorization.standingAuthorizationValid) {
    recheckHold.push('STANDING_AUTHORIZATION_INVALID');
  }
  if (recheckHold.length > 0) {
    return at('RECHECK_ENTITLEMENT_AND_AUTHORIZATION', recheckHold);
  }

  // 5) Profit Gate 必须在 Provider 之前
  if (facts.profitGate.decision !== 'PASS') return at('PROFIT_GATE', ['PROFIT_GATE_HOLD']);

  // 6) Provider 就绪 + 外写授权 + Action Guard 审批
  const providerHold: CustomsExecutionHoldReason[] = [];
  if (!facts.provider.available) providerHold.push('PROVIDER_NOT_READY');
  if (facts.provider.quotedCost === null) providerHold.push('PROVIDER_QUOTE_MISSING');
  if (!facts.authorization.externalWriteAuthorized) {
    providerHold.push('EXTERNAL_WRITE_NOT_AUTHORIZED');
  }
  if (!facts.authorization.actionGuardApproved) {
    providerHold.push('ACTION_GUARD_APPROVAL_REQUIRED');
  }
  if (providerHold.length > 0) return at('PROVIDER_READY', providerHold, NO_FEE, false);

  const externalWritePermitted = true;

  // 7) 证据核验
  if (!facts.evidence.verified) {
    return at('EVIDENCE_VERIFICATION', ['EVIDENCE_NOT_VERIFIED'], NO_FEE, externalWritePermitted);
  }

  // 8) 争议 / 冲正：不得继续推进到计费
  if (facts.disputes.revokedOrRefunded) {
    return at('CASE_PROGRESS', ['DISPUTE_OR_REFUND_OPEN'], NO_FEE, externalWritePermitted);
  }

  // 9) 真实结算事实
  const settlementHold: CustomsExecutionHoldReason[] = [];
  if (!facts.settlement.verifiedActualRecovery) settlementHold.push('SETTLEMENT_NOT_VERIFIED');
  if (facts.settlement.settlementId === null) settlementHold.push('SETTLEMENT_REFERENCE_MISSING');
  const amount = positiveAmount(facts.settlement.amount);
  if (amount === null) settlementHold.push('SETTLEMENT_AMOUNT_INVALID');
  if (settlementHold.length > 0) {
    return at('CASE_PROGRESS', settlementHold, NO_FEE, externalWritePermitted);
  }

  const settlementId = facts.settlement.settlementId as string;
  if (facts.billedSettlementIds.has(settlementId)) {
    return at(
      'VERIFIED_SETTLEMENT',
      ['DUPLICATE_SUCCESS_FEE_SUPPRESSED'],
      NO_FEE,
      externalWritePermitted,
    );
  }

  // 10) 成功费应收：仅以已验证实际回款为基数，定点向下取整到分
  const feeAmount = applyBpsFloorToCent(amount as string, CUSTOMS_SUCCESS_FEE_RATE_BPS);
  if (feeAmount === null) {
    return at('VERIFIED_SETTLEMENT', ['SETTLEMENT_AMOUNT_INVALID'], NO_FEE, externalWritePermitted);
  }

  return {
    ...base,
    state: 'SUCCESS_FEE_RECEIVABLE',
    nextAllowedState: null,
    holdReasons: [],
    holding: false,
    externalWritePermitted,
    successFee: {
      state: 'RECEIVABLE',
      basisSettlementId: settlementId,
      amount: feeAmount,
      currency: facts.settlement.currency,
      rateBps: CUSTOMS_SUCCESS_FEE_RATE_BPS,
    },
  };
}

/** 失败 / 暂停 / 撤销 / 超时的显式 HOLD 判定（供 Runtime 决定是否停止领取）。 */
export function isCustomsExecutionHolding(result: CustomsExecutionChainResult): boolean {
  return result.holding;
}

/** 边界自证：执行链本身不产生外写 / 资金动作 / 自动收款。 */
export const CUSTOMS_EXECUTION_CHAIN_BOUNDARY = {
  createsRuntime: false,
  createsScheduler: false,
  externalWritePerformed: false,
  providerInvoked: false,
  chargedAmount: null,
  autoCollection: 'HOLD',
  productionCredentials: 'ABSENT',
} as const;
