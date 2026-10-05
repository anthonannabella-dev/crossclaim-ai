/**
 * Recovery SI —— 确定性优先级（Phase 1）
 * ---------------------------------------------------------------
 * 规则：
 *   · 只有**可信金额**（CANONICAL_FACT / PERSISTED_ESTIMATE）才参与排序；金额缺失 → 该 opportunity 不参与；
 *   · Expected Recovery Value = amount − providerCost − operationalCost − riskPenalty（全部 USD 记账口径）；
 *   · 风险罚金：HIGH = 25% / MEDIUM = 10% / LOW = 0（**确定性系数**，非模型打分）；
 *   · **多币种不硬加**：按币种分组，出现多种币种时给出 `MULTI_CURRENCY_NO_FX`（不做 FX 换算）；
 *   · 排序键：EV 降序 → deadline 升序（null 视为最后）→ opportunityRef 升序（完全确定性）。
 */

import type { CustomerRecoveryState, OpportunitySlice } from './customer-recovery-state';

const RISK_PENALTY_RATIO: Record<OpportunitySlice['riskClass'], number> = {
  HIGH: 0.25,
  MEDIUM: 0.1,
  LOW: 0,
};

export interface ScoredOpportunity {
  opportunityRef: string;
  domain: OpportunitySlice['domain'];
  currency: string;
  recoverableAmount: number;
  providerCostUsd: number;
  operationalCostUsd: number;
  riskPenaltyUsd: number;
  expectedRecoveryValueUsd: number;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  eligibility: OpportunitySlice['eligibility'];
  evidenceComplete: boolean;
  authorizationReady: boolean;
  riskClass: OpportunitySlice['riskClass'];
  deadline: string | null;
}

export interface PriorityResult {
  ranked: readonly ScoredOpportunity[];
  /** 按币种分组的 EV 合计（绝不跨币种相加） */
  expectedRecoveryByCurrency: Readonly<Record<string, number>>;
  skipped: readonly { opportunityRef: string; reason: 'NO_TRUSTED_MONEY' | 'NOT_ELIGIBLE' }[];
  reasonCodes: readonly string[];
}

export function prioritizeOpportunities(state: CustomerRecoveryState): PriorityResult {
  const skipped: { opportunityRef: string; reason: 'NO_TRUSTED_MONEY' | 'NOT_ELIGIBLE' }[] = [];
  const scored: ScoredOpportunity[] = [];

  for (const slice of state.opportunities) {
    if (slice.eligibility === 'NOT_ELIGIBLE') {
      skipped.push({ opportunityRef: slice.opportunityRef, reason: 'NOT_ELIGIBLE' });
      continue;
    }
    if (slice.recoverable === null) {
      skipped.push({ opportunityRef: slice.opportunityRef, reason: 'NO_TRUSTED_MONEY' });
      continue;
    }
    const amount = slice.recoverable.amount;
    const riskPenaltyUsd = Number((amount * RISK_PENALTY_RATIO[slice.riskClass]).toFixed(6));
    const expectedRecoveryValueUsd = Number(
      Math.max(0, amount - slice.providerCostUsd - slice.expectedOperationalCostUsd - riskPenaltyUsd).toFixed(6),
    );
    const confidence: ScoredOpportunity['confidence'] =
      slice.evidenceComplete && slice.authorizationReady ? 'HIGH' : slice.evidenceComplete ? 'MEDIUM' : 'LOW';
    scored.push({
      opportunityRef: slice.opportunityRef,
      domain: slice.domain,
      currency: slice.recoverable.currency,
      recoverableAmount: amount,
      providerCostUsd: slice.providerCostUsd,
      operationalCostUsd: slice.expectedOperationalCostUsd,
      riskPenaltyUsd,
      expectedRecoveryValueUsd,
      confidence,
      eligibility: slice.eligibility,
      evidenceComplete: slice.evidenceComplete,
      authorizationReady: slice.authorizationReady,
      riskClass: slice.riskClass,
      deadline: slice.deadline,
    });
  }

  const ranked = [...scored].sort((a, b) => {
    if (b.expectedRecoveryValueUsd !== a.expectedRecoveryValueUsd) {
      return b.expectedRecoveryValueUsd - a.expectedRecoveryValueUsd;
    }
    const aDeadline = a.deadline === null ? Number.POSITIVE_INFINITY : Date.parse(a.deadline);
    const bDeadline = b.deadline === null ? Number.POSITIVE_INFINITY : Date.parse(b.deadline);
    if (aDeadline !== bDeadline) return aDeadline - bDeadline;
    return a.opportunityRef < b.opportunityRef ? -1 : a.opportunityRef > b.opportunityRef ? 1 : 0;
  });

  const expectedRecoveryByCurrency: Record<string, number> = {};
  for (const item of ranked) {
    expectedRecoveryByCurrency[item.currency] = Number(
      ((expectedRecoveryByCurrency[item.currency] ?? 0) + item.expectedRecoveryValueUsd).toFixed(6),
    );
  }
  const reasonCodes: string[] = [];
  if (Object.keys(expectedRecoveryByCurrency).length > 1) reasonCodes.push('MULTI_CURRENCY_NO_FX');
  if (skipped.some((entry) => entry.reason === 'NO_TRUSTED_MONEY')) reasonCodes.push('MONEY_NOT_FROM_FACT');

  return {
    ranked,
    expectedRecoveryByCurrency,
    skipped,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}

export const RECOVERY_PRIORITIZER_BOUNDARY = {
  deterministicOrdering: true,
  usesModelScores: false,
  crossCurrencySummation: false,
  recomputesMoneyTruth: false,
  riskPenaltyRatio: RISK_PENALTY_RATIO,
} as const;
