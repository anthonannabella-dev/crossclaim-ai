// STANDING AUTHORIZATION / RISK-TIERED EXECUTION — slice SA-1 — 风险分级政策（多维度，不是只看金额）
// ---------------------------------------------------------------------------
// 四级：
//   TIER 0 READ / ANALYZE        → 自动执行
//   TIER 1 LOW-RISK RECOVERY     → 在 Standing Authorization 范围内自动执行
//   TIER 2 ELEVATED              → 需要 HITL
//   TIER 3 REGULATED / HIGH-RISK → 必须 OWNER / ADMIN / Broker / Regulatory Gate
// 维度（至少）：amount · provider · domain · evidence completeness · evidence conflicts ·
//   authorization validity · historical/recovery confidence · action type · jurisdiction ·
//   provider terms · regulatory requirements。
// 高金额规则**继续保留**：> USD 1,000 → OWNER/ADMIN；≥ USD 10,000 → ADMIN（HIGH_VALUE_HITL = KEEP）。

import { digestOf } from '../config-execution-durability/digests';
import { ACTION_GUARD_CATALOG, type ActionRiskClass } from '../action-guard/action-guard';
import {
  DEFAULT_ADMIN_APPROVAL_THRESHOLD_USD,
  DEFAULT_HIGH_VALUE_THRESHOLD_USD,
} from '../provider-support/follow-up-package';

export const RISK_TIER_VERSION = 'risk-tier-policy/v1';

export const RISK_TIERS = [
  'TIER_0_READ_ANALYZE',
  'TIER_1_LOW_RISK_RECOVERY',
  'TIER_2_ELEVATED',
  'TIER_3_REGULATED_HIGH_RISK',
] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export type RiskDimension =
  | 'AMOUNT'
  | 'PROVIDER'
  | 'DOMAIN'
  | 'EVIDENCE_COMPLETENESS'
  | 'EVIDENCE_CONFLICTS'
  | 'AUTHORIZATION_VALIDITY'
  | 'HISTORICAL_CONFIDENCE'
  | 'ACTION_TYPE'
  | 'JURISDICTION'
  | 'PROVIDER_TERMS'
  | 'REGULATORY_REQUIREMENTS';

export interface RiskTierInput {
  action: string;
  amountUsd: number | null;
  provider: string;
  domain: string;
  jurisdiction: string;
  evidence: { completeness: 'COMPLETE' | 'PARTIAL' | 'MISSING'; conflicts: readonly string[] };
  authorization: { valid: boolean; withinScope: boolean; amountWithinLimit: boolean } | null;
  /** 历史 / 追回置信度（来自 Experience Memory；null = 无依据） */
  experienceDecisionSupport:
    | 'ADVISORY'
    | 'FAIL_CLOSED'
    | 'NO_AUTOMATIC_LEARNING'
    | 'DOWNWEIGHTED'
    | 'IGNORED'
    | null;
  experienceSuccessRateBp: number | null;
  /** provider 条款限制（例如禁止自动提交 / 需要人工签署） */
  providerTermsFlags?: readonly string[];
  /** 法规要求（例如 customs filing / regulatory gate） */
  regulatoryFlags?: readonly string[];
  highValueThresholdUsd?: number;
  adminThresholdUsd?: number;
}

export interface RiskTierResult {
  kind: 'RISK_TIER_RESULT';
  version: string;
  tier: RiskTier;
  riskClass: ActionRiskClass | 'UNKNOWN';
  requiresHitl: boolean;
  requiredApprovalRole: 'REVIEWER' | 'OWNER' | 'ADMIN' | 'BROKER' | 'REGULATORY' | null;
  autoExecutionAllowed: boolean;
  /** 明确「不是只看金额」：给出参与判定且命中的维度 */
  triggeredDimensions: RiskDimension[];
  evaluatedDimensions: RiskDimension[];
  highValueHitl: {
    applicable: boolean;
    thresholdUsd: number;
    adminThresholdUsd: number;
    role: 'OWNER' | 'ADMIN' | null;
  };
  reasonCodes: string[];
  evaluatedAt: string | null;
  tierDigest: string;
}

export const RISK_TIER_BOUNDARY = {
  amountOnlyDecision: false,
  highValueHitl: 'KEEP',
  regulatoryAlwaysTier3: true,
  conflictsAlwaysHitl: true,
  unknownActionRequiresHitl: true,
  externalWriteStillRequiresGates: true,
  standingAuthorizationSatisfiesOnlyHumanApproval: true,
} as const;

/** 受监管/报关相关动作前缀（必须 TIER 3 + Regulatory/Broker gate） */
export const REGULATED_ACTION_PREFIXES = ['customs.', 'broker.', 'abi.'] as const;
const REGULATED_DOMAIN = 'CUSTOMS';

export function classifyRiskTier(input: RiskTierInput, now: Date | null = null): RiskTierResult {
  const highValueThresholdUsd = input.highValueThresholdUsd ?? DEFAULT_HIGH_VALUE_THRESHOLD_USD;
  const adminThresholdUsd = input.adminThresholdUsd ?? DEFAULT_ADMIN_APPROVAL_THRESHOLD_USD;
  const entry = Object.prototype.hasOwnProperty.call(ACTION_GUARD_CATALOG, input.action)
    ? ACTION_GUARD_CATALOG[input.action]
    : undefined;
  const riskClass: ActionRiskClass | 'UNKNOWN' = entry?.risk ?? 'UNKNOWN';

  const evaluatedDimensions: RiskDimension[] = [
    'AMOUNT',
    'PROVIDER',
    'DOMAIN',
    'EVIDENCE_COMPLETENESS',
    'EVIDENCE_CONFLICTS',
    'AUTHORIZATION_VALIDITY',
    'HISTORICAL_CONFIDENCE',
    'ACTION_TYPE',
    'JURISDICTION',
    'PROVIDER_TERMS',
    'REGULATORY_REQUIREMENTS',
  ];
  const triggeredDimensions: RiskDimension[] = [];
  const reasonCodes: string[] = [];

  const amountUsd = input.amountUsd;
  const isHighValue = amountUsd !== null && amountUsd > highValueThresholdUsd;
  const isAdminTier = amountUsd !== null && amountUsd >= adminThresholdUsd;
  const hasConflict = input.evidence.conflicts.length > 0;
  const evidenceIncomplete = input.evidence.completeness !== 'COMPLETE';
  const regulated =
    input.domain.toUpperCase() === REGULATED_DOMAIN ||
    (input.regulatoryFlags ?? []).length > 0 ||
    REGULATED_ACTION_PREFIXES.some((prefix) => input.action.startsWith(prefix));
  const providerTermsBlocking = (input.providerTermsFlags ?? []).some((flag) =>
    /MANUAL|BLOCK|FORBID|REQUIRE_APPROVAL/i.test(flag),
  );
  const authorizationValid = input.authorization?.valid === true;
  const authorizationWithinScope = input.authorization?.withinScope === true;
  const authorizationAmountWithinLimit = input.authorization?.amountWithinLimit === true;
  const experienceConfidence =
    input.experienceDecisionSupport === 'ADVISORY'
      ? 'CONFIDENT'
      : input.experienceDecisionSupport === 'DOWNWEIGHTED'
        ? 'DOWNWEIGHTED'
        : 'INSUFFICIENT';

  if (isHighValue) triggeredDimensions.push('AMOUNT');
  if (regulated) triggeredDimensions.push('REGULATORY_REQUIREMENTS');
  if (hasConflict) triggeredDimensions.push('EVIDENCE_CONFLICTS');
  if (evidenceIncomplete) triggeredDimensions.push('EVIDENCE_COMPLETENESS');
  if (!authorizationValid || !authorizationWithinScope || !authorizationAmountWithinLimit) {
    triggeredDimensions.push('AUTHORIZATION_VALIDITY');
  }
  if (experienceConfidence !== 'CONFIDENT') triggeredDimensions.push('HISTORICAL_CONFIDENCE');
  if (riskClass === 'EXTERNAL_WRITE' || riskClass === 'MONEY_MOVEMENT' || riskClass === 'SECRET_ACCESS') {
    triggeredDimensions.push('ACTION_TYPE');
  }
  if (providerTermsBlocking) triggeredDimensions.push('PROVIDER_TERMS');
  if (regulated) triggeredDimensions.push('JURISDICTION');

  let tier: RiskTier;
  let requiredApprovalRole: RiskTierResult['requiredApprovalRole'] = null;
  let requiresHitl: boolean;

  if (riskClass === 'READ_ONLY') {
    tier = 'TIER_0_READ_ANALYZE';
    requiresHitl = false;
    reasonCodes.push('READ_ONLY_AUTO_EXECUTION');
  } else if (regulated) {
    tier = 'TIER_3_REGULATED_HIGH_RISK';
    requiresHitl = true;
    requiredApprovalRole = 'REGULATORY';
    reasonCodes.push('REGULATED_ACTION_REQUIRES_TIER3');
  } else if (isAdminTier) {
    tier = 'TIER_3_REGULATED_HIGH_RISK';
    requiresHitl = true;
    requiredApprovalRole = 'ADMIN';
    reasonCodes.push('HIGH_VALUE_ABOVE_ADMIN_THRESHOLD');
  } else if (isHighValue) {
    tier = 'TIER_2_ELEVATED';
    requiresHitl = true;
    requiredApprovalRole = 'OWNER';
    reasonCodes.push('HIGH_VALUE_HITL_REQUIRED');
  } else if (hasConflict) {
    tier = 'TIER_2_ELEVATED';
    requiresHitl = true;
    requiredApprovalRole = 'REVIEWER';
    reasonCodes.push('EVIDENCE_CONFLICT_REQUIRES_HITL');
  } else if (
    riskClass === 'EXTERNAL_WRITE' ||
    riskClass === 'MONEY_MOVEMENT' ||
    riskClass === 'SECRET_ACCESS'
  ) {
    tier = 'TIER_2_ELEVATED';
    requiresHitl = true;
    requiredApprovalRole = 'OWNER';
    reasonCodes.push('HIGH_RISK_CLASS_REQUIRES_HITL');
  } else if (riskClass === 'UNKNOWN') {
    tier = 'TIER_2_ELEVATED';
    requiresHitl = true;
    requiredApprovalRole = 'REVIEWER';
    reasonCodes.push('UNKNOWN_ACTION_REQUIRES_HITL');
  } else if (
    authorizationValid &&
    authorizationWithinScope &&
    authorizationAmountWithinLimit &&
    !evidenceIncomplete &&
    experienceConfidence !== 'INSUFFICIENT' &&
    !providerTermsBlocking
  ) {
    tier = 'TIER_1_LOW_RISK_RECOVERY';
    requiresHitl = false;
    reasonCodes.push('LOW_RISK_WITHIN_STANDING_AUTHORIZATION');
    if (experienceConfidence === 'DOWNWEIGHTED') reasonCodes.push('HISTORICAL_CONFIDENCE_DOWNWEIGHTED');
  } else {
    tier = 'TIER_2_ELEVATED';
    requiresHitl = true;
    requiredApprovalRole = 'REVIEWER';
    reasonCodes.push(
      !authorizationValid || !authorizationWithinScope || !authorizationAmountWithinLimit
        ? 'AUTHORIZATION_NOT_SUFFICIENT'
        : evidenceIncomplete
          ? 'EVIDENCE_INCOMPLETE'
          : experienceConfidence === 'INSUFFICIENT'
            ? 'NO_HISTORICAL_CONFIDENCE'
            : 'PROVIDER_TERMS_REQUIRE_REVIEW',
    );
  }

  const body = {
    version: RISK_TIER_VERSION,
    tier,
    riskClass,
    requiresHitl,
    requiredApprovalRole,
    autoExecutionAllowed: tier === 'TIER_0_READ_ANALYZE' || tier === 'TIER_1_LOW_RISK_RECOVERY',
    triggeredDimensions: [...new Set(triggeredDimensions)],
    evaluatedDimensions,
    highValueHitl: {
      applicable: isHighValue,
      thresholdUsd: highValueThresholdUsd,
      adminThresholdUsd,
      role: (isAdminTier ? 'ADMIN' : isHighValue ? 'OWNER' : null) as 'OWNER' | 'ADMIN' | null,
    },
    reasonCodes: [...new Set(reasonCodes)].sort(),
    evaluatedAt: now?.toISOString() ?? null,
  };

  return { kind: 'RISK_TIER_RESULT', ...body, tierDigest: digestOf(body) };
}

/** 边界断言：任何声称「只看金额」或「授权可满足任意 gate」的记录都必须被拒绝 */
export function assertRiskTierIsMultiDimensional(record: {
  evaluatedDimensions?: readonly string[];
  autoExecutionAllowed?: boolean;
  tier?: RiskTier;
}): void {
  const dimensions = record.evaluatedDimensions ?? [];
  if (dimensions.length < 8) {
    throw new Error('RISK_TIER_MUST_BE_MULTI_DIMENSIONAL');
  }
  if (dimensions.length === 1 && dimensions[0] === 'AMOUNT') {
    throw new Error('RISK_TIER_MUST_NOT_BE_AMOUNT_ONLY');
  }
  if (record.autoExecutionAllowed === true && record.tier !== undefined && record.tier !== 'TIER_0_READ_ANALYZE' && record.tier !== 'TIER_1_LOW_RISK_RECOVERY') {
    throw new Error('AUTO_EXECUTION_ONLY_FOR_TIER_0_1');
  }
}
