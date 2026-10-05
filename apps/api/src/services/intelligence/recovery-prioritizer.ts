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
  /** 与 recoverable 同币种的净额（跨币种成本在无 FX 时不得相减） */
  providerCostUsd: number;
  operationalCostUsd: number;
  riskPenaltyUsd: number;
  /** 与 `currency` 同币种的 expected value；跨币种不可比 */
  expectedRecoveryValue: number;
  /** 仅当 currency === 'USD' 时与 expectedRecoveryValue 相同；否则为 null（不做 FX） */
  expectedRecoveryValueUsd: number | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  eligibility: OpportunitySlice['eligibility'];
  evidenceComplete: boolean;
  authorizationReady: boolean;
  riskClass: OpportunitySlice['riskClass'];
  deadline: string | null;
}

export interface PriorityResult {
  /** 按币种分组的排序（组间按 currency 升序，组内按 EV 降序）——**不做跨币种金额比较** */
  ranked: readonly ScoredOpportunity[];
  /** 按币种分组的 EV 合计（绝不跨币种相加） */
  expectedRecoveryByCurrency: Readonly<Record<string, number>>;
  /** 每个币种内部的排名（1-based），跨币种不可比 */
  rankByCurrency: Readonly<Record<string, readonly string[]>>;
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
    const currency = slice.recoverable.currency;
    // CHANGE A（MSG-20261005-11）：成本字段是 USD 计价；只有在 recoverable 也是 USD 时才允许相减。
    const isUsd = currency === 'USD';
    const riskPenaltyUsd = isUsd ? Number((amount * RISK_PENALTY_RATIO[slice.riskClass]).toFixed(6)) : 0;
    const expectedRecoveryValue = Number(
      Math.max(
        0,
        isUsd
          ? amount - slice.providerCostUsd - slice.expectedOperationalCostUsd - riskPenaltyUsd
          : amount * (1 - RISK_PENALTY_RATIO[slice.riskClass]),
      ).toFixed(6),
    );
    const confidence: ScoredOpportunity['confidence'] =
      slice.evidenceComplete && slice.authorizationReady ? 'HIGH' : slice.evidenceComplete ? 'MEDIUM' : 'LOW';
    scored.push({
      opportunityRef: slice.opportunityRef,
      domain: slice.domain,
      currency,
      recoverableAmount: amount,
      providerCostUsd: isUsd ? slice.providerCostUsd : 0,
      operationalCostUsd: isUsd ? slice.expectedOperationalCostUsd : 0,
      riskPenaltyUsd,
      expectedRecoveryValue,
      expectedRecoveryValueUsd: isUsd ? expectedRecoveryValue : null,
      confidence,
      eligibility: slice.eligibility,
      evidenceComplete: slice.evidenceComplete,
      authorizationReady: slice.authorizationReady,
      riskClass: slice.riskClass,
      deadline: slice.deadline,
    });
  }

  // CHANGE A：**只在同币种内**按 EV 排序；组间顺序由 currency 决定（绝不按金额跨币种比较）。
  const byCurrencyGroups = new Map<string, ScoredOpportunity[]>();
  for (const item of scored) {
    const bucket = byCurrencyGroups.get(item.currency);
    if (bucket === undefined) byCurrencyGroups.set(item.currency, [item]);
    else bucket.push(item);
  }
  const ranked: ScoredOpportunity[] = [];
  const rankByCurrency: Record<string, string[]> = {};
  for (const currency of [...byCurrencyGroups.keys()].sort()) {
    const group = [...byCurrencyGroups.get(currency)!].sort((a, b) => {
      if (b.expectedRecoveryValue !== a.expectedRecoveryValue) {
        return b.expectedRecoveryValue - a.expectedRecoveryValue;
      }
      const aDeadline = a.deadline === null ? Number.POSITIVE_INFINITY : Date.parse(a.deadline);
      const bDeadline = b.deadline === null ? Number.POSITIVE_INFINITY : Date.parse(b.deadline);
      if (aDeadline !== bDeadline) return aDeadline - bDeadline;
      return a.opportunityRef < b.opportunityRef ? -1 : a.opportunityRef > b.opportunityRef ? 1 : 0;
    });
    rankByCurrency[currency] = group.map((entry) => entry.opportunityRef);
    ranked.push(...group);
  }

  const expectedRecoveryByCurrency: Record<string, number> = {};
  for (const item of ranked) {
    expectedRecoveryByCurrency[item.currency] = Number(
      ((expectedRecoveryByCurrency[item.currency] ?? 0) + item.expectedRecoveryValue).toFixed(6),
    );
  }
  const reasonCodes: string[] = [];
  if (Object.keys(expectedRecoveryByCurrency).length > 1) reasonCodes.push('MULTI_CURRENCY_NO_FX');
  if (ranked.some((entry) => entry.currency !== 'USD')) reasonCodes.push('USD_COST_EXCLUDED_NO_FX');
  if (skipped.some((entry) => entry.reason === 'NO_TRUSTED_MONEY')) reasonCodes.push('MONEY_NOT_FROM_FACT');

  return {
    ranked,
    expectedRecoveryByCurrency,
    rankByCurrency,
    skipped,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}

export const RECOVERY_PRIORITIZER_BOUNDARY = {
  deterministicOrdering: true,
  usesModelScores: false,
  crossCurrencySummation: false,
  crossCurrencyMonetaryRanking: false,
  usdCostsOnlySubtractedWhenCurrencyIsUsd: true,
  recomputesMoneyTruth: false,
  riskPenaltyRatio: RISK_PENALTY_RATIO,
} as const;
