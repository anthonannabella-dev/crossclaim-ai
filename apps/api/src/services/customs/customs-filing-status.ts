/**
 * C19 — FILING STATUS / WEBHOOK READ MODEL（HOST DIRECTIVE 2026-10-03 补充四 §3）
 * ---------------------------------------------------------------
 * 统一状态 + 来源等级；禁止隐含升级：
 *   · customer says submitted != authority accepted
 *   · APPROVED != PAID
 * append-only 事实 + 确定性投影（按 observedAt / recordedAt / factId）。
 */

export const CUSTOMS_FILING_STATUSES = [
  'PREPARING',
  'READY_TO_FILE',
  'SUBMITTED',
  'ACCEPTED',
  'NEEDS_MORE_INFO',
  'UNDER_REVIEW',
  'DENIED',
  'APPROVED',
  'PAID',
  'UNKNOWN',
] as const;
export type CustomsFilingStatus = (typeof CUSTOMS_FILING_STATUSES)[number];

export const CUSTOMS_FILING_SOURCE_LEVELS = ['USER_REPORTED', 'PROVIDER_VERIFIED', 'AUTHORITY_VERIFIED'] as const;
export type CustomsFilingSourceLevel = (typeof CUSTOMS_FILING_SOURCE_LEVELS)[number];

export interface CustomsFilingStatusFact {
  factId: string;
  organizationId: string;
  opportunityId: string;
  status: CustomsFilingStatus;
  sourceLevel: CustomsFilingSourceLevel;
  providerReference: string | null;
  observedAt: string;
  recordedAt: string;
  derivesRecoveredCash: false;
  derivesFee: false;
}

export interface CustomsFilingStatusProjection {
  organizationId: string;
  opportunityId: string;
  currentStatus: CustomsFilingStatus | null;
  currentSourceLevel: CustomsFilingSourceLevel | null;
  currentFactId: string | null;
  history: ReadonlyArray<{ factId: string; status: CustomsFilingStatus; sourceLevel: CustomsFilingSourceLevel; observedAt: string }>;
  factCount: number;
  hasAuthorityVerifiedFact: boolean;
  inferredTransitions: readonly string[];
  derivesRecoveredCash: false;
  derivesFee: false;
}

export function projectCustomsFilingStatus(
  facts: readonly CustomsFilingStatusFact[],
  input: { organizationId: string; opportunityId: string },
): CustomsFilingStatusProjection {
  const scoped = facts
    .filter((f) => f.organizationId === input.organizationId && f.opportunityId === input.opportunityId)
    .slice()
    .sort((a, b) => {
      if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? -1 : 1;
      if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
      if (a.factId === b.factId) return 0;
      return a.factId < b.factId ? -1 : 1;
    });

  const latest = scoped.length === 0 ? null : scoped[scoped.length - 1];
  return {
    organizationId: input.organizationId,
    opportunityId: input.opportunityId,
    currentStatus: latest === null ? null : latest.status,
    currentSourceLevel: latest === null ? null : latest.sourceLevel,
    currentFactId: latest === null ? null : latest.factId,
    history: scoped.map((f) => ({
      factId: f.factId,
      status: f.status,
      sourceLevel: f.sourceLevel,
      observedAt: f.observedAt,
    })),
    factCount: scoped.length,
    hasAuthorityVerifiedFact: scoped.some((f) => f.sourceLevel === 'AUTHORITY_VERIFIED'),
    inferredTransitions: [],
    derivesRecoveredCash: false,
    derivesFee: false,
  };
}

/** 状态语义护栏：这两个升级永不由本模块推断。 */
export const CUSTOMS_FORBIDDEN_INFERRED_TRANSITIONS = [
  'USER_REPORTED_SUBMITTED_TO_ACCEPTED',
  'APPROVED_TO_PAID',
] as const;
