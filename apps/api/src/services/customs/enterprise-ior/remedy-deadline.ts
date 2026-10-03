/**
 * ENTERPRISE IOR RECOVERY LAYER — ④ REMEDY TAXONOMY + DEADLINE ENGINE（versioned deterministic policy）。
 * ---------------------------------------------------------------
 * 不得使用统一「过去 3–5 年均可追回」规则；缺关键日期 → INDETERMINATE，不调用昂贵 provider、不 filing。
 */

export const CUSTOMS_REMEDY_ROUTES = [
  'DRAWBACK',
  'PROTEST',
  'POST_SUMMARY_CORRECTION',
  'EXCLUSION_REFUND',
  'CLASSIFICATION_CORRECTION',
  'DUPLICATE_DUTY',
  'OTHER',
] as const;
export type CustomsRemedyRoute = (typeof CUSTOMS_REMEDY_ROUTES)[number];

export interface CustomsRemedyDeadlinePolicy {
  policyId: string;
  policyVersion: string;
  jurisdiction: string;
  remedy: CustomsRemedyRoute;
  /** deadline = anchor + days（anchor 由 policy 指定，例如 liquidationDate）。 */
  anchorField: 'entryDate' | 'liquidationDate' | 'exportDate' | 'destructionDate' | 'exclusionEffectiveDate';
  daysFromAnchor: number;
}

export interface RemedyDeadlineInput {
  jurisdiction: string;
  remedy: string;
  entryDate: string | null;
  liquidationDate: string | null;
  exportDate: string | null;
  destructionDate: string | null;
  exclusionEffectiveDate: string | null;
}

export interface RemedyDeadlineResult {
  status: 'ELIGIBLE_WINDOW' | 'INDETERMINATE' | 'EXPIRED';
  deadline: string | null;
  anchorUsed: string | null;
  policyId: string | null;
  policyVersion: string | null;
  reasonCodes: readonly string[];
  readonly callsExpensiveProvider: false;
  readonly autoFilingAllowed: false;
}

const MS_PER_DAY = 86400000;

/**
 * 确定性 deadline 计算（无全局「3–5 年」硬编码；全部来自 policy）。
 */
export function evaluateRemedyDeadline(
  input: RemedyDeadlineInput,
  policies: readonly CustomsRemedyDeadlinePolicy[],
  now: string,
): RemedyDeadlineResult {
  const remedy = String(input.remedy ?? '').toUpperCase();
  const policy = policies.find((candidate) => candidate.jurisdiction === input.jurisdiction && candidate.remedy === remedy);
  if (!policy) {
    return {
      status: 'INDETERMINATE',
      deadline: null,
      anchorUsed: null,
      policyId: null,
      policyVersion: null,
      reasonCodes: ['NO_POLICY_FOR_JURISDICTION_REMEDY'],
      callsExpensiveProvider: false,
      autoFilingAllowed: false,
    };
  }
  const anchor = input[policy.anchorField];
  if (!anchor) {
    return {
      status: 'INDETERMINATE',
      deadline: null,
      anchorUsed: policy.anchorField,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      reasonCodes: ['MISSING_ANCHOR_DATE:' + policy.anchorField],
      callsExpensiveProvider: false,
      autoFilingAllowed: false,
    };
  }
  const deadlineMs = Date.parse(anchor) + policy.daysFromAnchor * MS_PER_DAY;
  const deadline = new Date(deadlineMs).toISOString().slice(0, 10);
  const expired = deadlineMs < Date.parse(now);
  return {
    status: expired ? 'EXPIRED' : 'ELIGIBLE_WINDOW',
    deadline,
    anchorUsed: policy.anchorField,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    reasonCodes: expired ? ['DEADLINE_PASSED'] : ['OK'],
    callsExpensiveProvider: false,
    autoFilingAllowed: false,
  };
}

export const REMEDY_DEADLINE_BOUNDARY = {
  globalThreeToFiveYearRule: false,
  missingAnchorIsIndeterminate: true,
  callsExpensiveProviderWhenIndeterminate: false,
  autoFilingAllowed: false,
} as const;
