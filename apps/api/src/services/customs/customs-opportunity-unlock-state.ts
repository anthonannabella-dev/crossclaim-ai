/**
 * V2-03 — CUSTOMS OPPORTUNITY UNLOCK STATE（免费阶段六态投影 · 只读事实源）
 * ---------------------------------------------------------------
 * 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE A。
 *
 * 状态机（严格顺序判定）：
 *   NO_DATA → NEEDS_EVIDENCE → NOT_ELIGIBLE → FREE_ESTIMATED → READY_TO_UNLOCK → UNLOCKED
 *
 * 不变式：
 *  1. 只从**可信、可追溯**事实生成预估：C1 事实 / C3 差异 / C4 资格 / C5 预估；
 *     C4 非 ELIGIBLE 或 C5 非 ESTIMATED 时，**不显示任何可追回金额**（不得虚构）。
 *  2. 多币种**分别显示**，禁止汇率换算：跨币种合计恒为 null。
 *  3. 区分 DUTY_CORRECTION 与 DRAWBACK；同一 (currency, lineRef) 只计一次（不得重复计算同一经济利益）。
 *  4. 付费解锁入口仅在该机会具备**真实数据支撑**（READY_TO_UNLOCK）时可见；UNLOCKED 表示已取得付费权益。
 *  5. 免费事实不足 → 只引导补件；**不得**升级为收费检索（paidEscalationAllowed 恒为 false）。
 *  6. 跨租户 / 机会不存在 → 一律 NO_DATA 且不泄露任何金额。
 *  7. 本模块不调用 provider、不扣款、不写库、不发起任何外部请求。
 */

import type { CustomsEligibilityStatus } from './customs-recovery-eligibility';
import type { CustomsEstimateStatus } from './customs-recovery-estimate';
import { compareDecimalAmounts, normalizeDecimalAmount } from './customs-paid-api-gate';

export const CUSTOMS_OPPORTUNITY_PROJECTION_VERSION = 'customs-opportunity-unlock-state-v2.0.0';

export const CUSTOMS_OPPORTUNITY_STATES = [
  'NO_DATA',
  'NEEDS_EVIDENCE',
  'NOT_ELIGIBLE',
  'FREE_ESTIMATED',
  'READY_TO_UNLOCK',
  'UNLOCKED',
] as const;
export type CustomsOpportunityState = (typeof CUSTOMS_OPPORTUNITY_STATES)[number];

export const CUSTOMS_AMOUNT_KINDS = ['DUTY_CORRECTION', 'DRAWBACK'] as const;
export type CustomsAmountKind = (typeof CUSTOMS_AMOUNT_KINDS)[number];

export type CustomsOpportunityProjectionReason =
  | 'CROSS_TENANT_REJECTED'
  | 'OPPORTUNITY_NOT_FOUND'
  | 'NO_ENTRY_FACTS'
  | 'MISSING_REQUIRED_EVIDENCE'
  | 'DISCREPANCY_NOT_OBSERVED'
  | 'ELIGIBILITY_NOT_ELIGIBLE'
  | 'ELIGIBILITY_INDETERMINATE'
  | 'ESTIMATE_ESTIMATED'
  | 'ESTIMATE_NOT_ESTIMATED'
  | 'NO_DISCLOSABLE_AMOUNT'
  | 'NO_CROSS_CURRENCY_TOTAL'
  | 'DUPLICATE_ECONOMIC_BENEFIT_EXCLUDED'
  | 'PAID_ENTITLEMENT_ACTIVE'
  | 'PAID_ESCALATION_FORBIDDEN';

export interface CustomsOpportunityScope {
  organizationId: string;
  opportunityId: string;
  ownerOrganizationId: string | null;
  caseFound: boolean;
}

/** C1 事实（只读投影）。 */
export interface CustomsOpportunityEntryFacts {
  factCount: number;
  currencies: readonly string[];
}

/** 证据完整度（C1/C3 所需的必需证据种类）。 */
export interface CustomsOpportunityEvidence {
  requiredKinds: readonly string[];
  presentKinds: readonly string[];
}

/** C4 资格（只取状态与原因码，避免复制判定逻辑）。 */
export interface CustomsOpportunityEligibilityView {
  status: CustomsEligibilityStatus;
  reasonCodes: readonly string[];
}

/** C5 预估（只取状态）。 */
export interface CustomsOpportunityEstimateView {
  status: CustomsEstimateStatus;
}

/** 可展示金额候选：必须来自可追溯事实，并带 lineRef 以做重复计算抑制。 */
export interface CustomsOpportunityAmountCandidate {
  currency: string;
  kind: CustomsAmountKind;
  lineRef: string;
  estimatedAmount: string;
  source: 'ESTIMATE' | 'DISCREPANCY' | 'DRAWBACK_MODEL';
}

export interface CustomsOpportunityProjectionInput {
  scope: CustomsOpportunityScope;
  entryFacts: CustomsOpportunityEntryFacts | null;
  evidence: CustomsOpportunityEvidence | null;
  discrepancy: { reportPresent: boolean; discrepancyCodes: readonly string[] } | null;
  eligibility: CustomsOpportunityEligibilityView | null;
  estimate: CustomsOpportunityEstimateView | null;
  amountCandidates: readonly CustomsOpportunityAmountCandidate[];
  entitlement: { unlockActive: boolean; entitlementId: string | null };
  historicalScan: { candidateCount: number } | null;
}

export interface CustomsOpportunityCurrencyBucket {
  currency: string;
  dutyCorrection: string | null;
  drawback: string | null;
}

export interface CustomsOpportunityProjection {
  kind: 'CUSTOMS_OPPORTUNITY_PROJECTION';
  version: string;
  state: CustomsOpportunityState;
  reasonCodes: readonly CustomsOpportunityProjectionReason[];
  /** 分币种、分类型的可展示预估（禁止跨币种合计、禁止汇率换算）。 */
  disclosableByCurrency: readonly CustomsOpportunityCurrencyBucket[];
  /** 跨币种合计恒为 null（无汇率依据）。 */
  totalAcrossCurrencies: null;
  unlockEntryVisible: boolean;
  requiresEvidence: readonly string[];
  duplicateBenefitsExcluded: readonly { currency: string; lineRef: string; kind: CustomsAmountKind }[];
  crossTenantRejected: boolean;
  paidEscalationAllowed: false;
  estimateOnly: true;
  finalAmountDerived: false;
  billable: false;
  appliesFxConversion: false;
  filingPerformed: false;
  paymentPerformed: false;
  chargedFee: null;
  productionCredentials: 'ABSENT';
}

const CANDIDATE_SOURCE_ALLOWED: readonly CustomsOpportunityAmountCandidate['source'][] = [
  'ESTIMATE',
  'DISCREPANCY',
  'DRAWBACK_MODEL',
];

function isPositiveAmount(value: string): boolean {
  const normalized = normalizeDecimalAmount(value);
  if (normalized === null) return false;
  return compareDecimalAmounts(normalized, '0') === 1;
}

/**
 * 去重 + 过滤：非正数 / 非法金额 / 未知来源一律剔除；
 * 同一 (currency, lineRef) 只保留第一次出现（DUTY_CORRECTION 优先），其余进入 excluded。
 */
function selectAmounts(
  candidates: readonly CustomsOpportunityAmountCandidate[],
  estimateIsEstimated: boolean,
): {
  byCurrency: CustomsOpportunityCurrencyBucket[];
  excluded: { currency: string; lineRef: string; kind: CustomsAmountKind }[];
} {
  const excluded: { currency: string; lineRef: string; kind: CustomsAmountKind }[] = [];
  if (!estimateIsEstimated) return { byCurrency: [], excluded };

  const ordered = [...candidates].sort((left, right) => {
    if (left.kind === right.kind) return 0;
    return left.kind === 'DUTY_CORRECTION' ? -1 : 1;
  });

  const seen = new Set<string>();
  const buckets = new Map<string, CustomsOpportunityCurrencyBucket>();
  for (const candidate of ordered) {
    if (!CANDIDATE_SOURCE_ALLOWED.includes(candidate.source)) continue;
    if (!isPositiveAmount(candidate.estimatedAmount)) continue;
    const key = `${candidate.currency}:${candidate.lineRef}`;
    if (seen.has(key)) {
      excluded.push({
        currency: candidate.currency,
        lineRef: candidate.lineRef,
        kind: candidate.kind,
      });
      continue;
    }
    seen.add(key);
    const normalized = normalizeDecimalAmount(candidate.estimatedAmount) as string;
    const bucket = buckets.get(candidate.currency) ?? {
      currency: candidate.currency,
      dutyCorrection: null,
      drawback: null,
    };
    if (candidate.kind === 'DUTY_CORRECTION') {
      bucket.dutyCorrection = bucket.dutyCorrection ?? normalized;
    } else {
      bucket.drawback = bucket.drawback ?? normalized;
    }
    buckets.set(candidate.currency, bucket);
  }

  return {
    byCurrency: [...buckets.values()].sort((left, right) =>
      left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0,
    ),
    excluded,
  };
}

function missingEvidence(input: CustomsOpportunityProjectionInput): string[] {
  if (input.evidence === null) return ['*'];
  const present = new Set(input.evidence.presentKinds);
  return input.evidence.requiredKinds.filter((kind) => !present.has(kind));
}

/**
 * 纯投影：输入为既有事实源输出，输出为可展示状态 + 可展示金额 + 解锁入口可见性。
 * 不产生副作用，不调用 provider，不扣款。
 */
export function projectCustomsOpportunity(
  input: CustomsOpportunityProjectionInput,
): CustomsOpportunityProjection {
  const reasons: CustomsOpportunityProjectionReason[] = [];
  const base = {
    kind: 'CUSTOMS_OPPORTUNITY_PROJECTION' as const,
    version: CUSTOMS_OPPORTUNITY_PROJECTION_VERSION,
    paidEscalationAllowed: false as const,
    estimateOnly: true as const,
    finalAmountDerived: false as const,
    billable: false as const,
    appliesFxConversion: false as const,
    filingPerformed: false as const,
    paymentPerformed: false as const,
    chargedFee: null,
    totalAcrossCurrencies: null,
    productionCredentials: 'ABSENT' as const,
  };

  const emptyProjection = (
    state: CustomsOpportunityState,
    extra: Partial<CustomsOpportunityProjection>,
  ): CustomsOpportunityProjection => ({
    ...base,
    state,
    reasonCodes: reasons,
    disclosableByCurrency: [],
    unlockEntryVisible: false,
    requiresEvidence: [],
    duplicateBenefitsExcluded: [],
    crossTenantRejected: false,
    ...extra,
  });

  // 1) 跨租户 / 机会不存在 → 不泄露任何信息
  const crossTenant =
    input.scope.opportunityId !== null &&
    input.scope.ownerOrganizationId !== input.scope.organizationId;
  if (crossTenant) {
    reasons.push('CROSS_TENANT_REJECTED');
    return emptyProjection('NO_DATA', { crossTenantRejected: true });
  }
  if (!input.scope.caseFound) {
    reasons.push('OPPORTUNITY_NOT_FOUND');
    return emptyProjection('NO_DATA', {});
  }

  // 2) 已取得付费权益 → UNLOCKED（仍不展示未经核验的金额）
  if (input.entitlement.unlockActive && input.entitlement.entitlementId !== null) {
    reasons.push('PAID_ENTITLEMENT_ACTIVE');
    return emptyProjection('UNLOCKED', {});
  }

  // 3) 无事实 → NO_DATA
  if (input.entryFacts === null || input.entryFacts.factCount <= 0) {
    reasons.push('NO_ENTRY_FACTS');
    reasons.push('PAID_ESCALATION_FORBIDDEN');
    return emptyProjection('NO_DATA', {});
  }

  // 4) 缺证据 / 未见差异 → NEEDS_EVIDENCE（引导补件，不得转收费检索）
  const missing = missingEvidence(input);
  const discrepancyPresent = input.discrepancy?.reportPresent === true;
  if (missing.length > 0 || !discrepancyPresent) {
    if (missing.length > 0) reasons.push('MISSING_REQUIRED_EVIDENCE');
    if (!discrepancyPresent) reasons.push('DISCREPANCY_NOT_OBSERVED');
    reasons.push('PAID_ESCALATION_FORBIDDEN');
    return emptyProjection('NEEDS_EVIDENCE', { requiresEvidence: missing });
  }

  // 5) 资格明确不通过 → NOT_ELIGIBLE（不展示金额）
  if (input.eligibility === null) {
    reasons.push('ELIGIBILITY_INDETERMINATE');
    reasons.push('PAID_ESCALATION_FORBIDDEN');
    return emptyProjection('NEEDS_EVIDENCE', {});
  }
  if (input.eligibility.status === 'NOT_ELIGIBLE') {
    reasons.push('ELIGIBILITY_NOT_ELIGIBLE');
    return emptyProjection('NOT_ELIGIBLE', {});
  }

  // 6) 金额：仅 C5 ESTIMATED 时才可展示；否则一律空（不得虚构）
  const estimateIsEstimated = input.estimate?.status === 'ESTIMATED';
  const { byCurrency, excluded } = selectAmounts(input.amountCandidates, estimateIsEstimated);
  if (!estimateIsEstimated) {
    reasons.push('ESTIMATE_NOT_ESTIMATED');
  } else {
    reasons.push('ESTIMATE_ESTIMATED');
  }
  if (excluded.length > 0) reasons.push('DUPLICATE_ECONOMIC_BENEFIT_EXCLUDED');
  if (byCurrency.length === 0 && estimateIsEstimated) reasons.push('NO_DISCLOSABLE_AMOUNT');
  if (byCurrency.length > 0) reasons.push('NO_CROSS_CURRENCY_TOTAL');

  const eligibilityEligible = input.eligibility.status === 'ELIGIBLE';
  const readyToUnlock = eligibilityEligible && estimateIsEstimated && byCurrency.length > 0;

  // 7) 状态收敛
  if (readyToUnlock) {
    return {
      ...base,
      state: 'READY_TO_UNLOCK',
      reasonCodes: reasons,
      disclosableByCurrency: byCurrency,
      unlockEntryVisible: true,
      requiresEvidence: [],
      duplicateBenefitsExcluded: excluded,
      crossTenantRejected: false,
    };
  }

  if (input.eligibility.status === 'INDETERMINATE') reasons.push('ELIGIBILITY_INDETERMINATE');
  const state: CustomsOpportunityState = estimateIsEstimated ? 'FREE_ESTIMATED' : 'NEEDS_EVIDENCE';
  if (state === 'NEEDS_EVIDENCE') reasons.push('PAID_ESCALATION_FORBIDDEN');

  return {
    ...base,
    state,
    reasonCodes: reasons,
    disclosableByCurrency: byCurrency,
    unlockEntryVisible: false,
    requiresEvidence: [],
    duplicateBenefitsExcluded: excluded,
    crossTenantRejected: false,
  };
}

/** 边界自证：投影层不产生外部调用 / 资金动作。 */
export const CUSTOMS_OPPORTUNITY_PROJECTION_BOUNDARY = {
  externalCallPerformed: false,
  providerInvoked: false,
  chargedAmount: null,
  paymentCaptured: false,
  autoCollectionEnabled: false,
  billable: false,
  appliesFxConversion: false,
  productionCredentials: 'ABSENT',
} as const;
