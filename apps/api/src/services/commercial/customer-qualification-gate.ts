/**
 * P0-2（MASTER GAP CLOSURE · BUSINESS SURVIVAL GATE）— Customer Qualification / Recovery Economics Gate。
 * ---------------------------------------------------------------
 * 目标：在调用任何**昂贵外部能力**（Customs API / Broker / Filing / 付费数据源）之前，
 *       用 versioned policy 判断「这个客户 / 这笔机会是否值得进入正式追回」。
 *
 * 硬规则：
 *   · 数据不完整（缺少导入历史 / 退货证据 / lineage 不完整）→ INDETERMINATE，**不得**触发昂贵外部调用。
 *   · 预计追回 < 最小阈值 → NOT_QUALIFIED（只生成免费报告）。
 *   · API/Broker 成本占比超过政策上限 → NOT_QUALIFIED（不允许自动追回）。
 *   · 高价值 → CONDITIONAL（需人工/架构确认后才允许昂贵调用），绝不自动放行。
 *   · 全部判定来自确定性政策与十进制计算；**无模型判断**、无 magic number（阈值全部来自 policy）。
 *   · 判定本身不等于 filing 授权；Production / Transport Gate 仍 HOLD。
 */

export const CUSTOMS_QUALIFICATION_STATUSES = ['QUALIFIED', 'CONDITIONAL', 'NOT_QUALIFIED', 'INDETERMINATE'] as const;
export type CustomsQualificationStatus = (typeof CUSTOMS_QUALIFICATION_STATUSES)[number];

export const CUSTOMS_QUALIFICATION_REASONS = [
  'OK',
  'LOW_VALUE_BELOW_THRESHOLD',
  'HIGH_VALUE_REQUIRES_CONFIRMATION',
  'COST_RATIO_EXCEEDED',
  'NEGATIVE_NET_RECOVERY',
  'INCOMPLETE_DATA',
  'AMBIGUOUS_LINEAGE',
  'UNKNOWN_CURRENCY_POLICY',
  'NO_RECOVERY_ESTIMATE',
] as const;
export type CustomsQualificationReason = (typeof CUSTOMS_QUALIFICATION_REASONS)[number];

export const CUSTOMS_QUALIFICATION_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_AMOUNT',
  'INVALID_POLICY',
  'CROSS_TENANT_REJECTED',
] as const;
export type CustomsQualificationErrorCode = (typeof CUSTOMS_QUALIFICATION_ERROR_CODES)[number];

export class CustomsQualificationError extends Error {
  readonly code: CustomsQualificationErrorCode;

  constructor(code: CustomsQualificationErrorCode, detail: string) {
    super(code + ': ' + detail);
    this.name = 'CustomsQualificationError';
    this.code = code;
  }
}

export interface CustomerReadiness {
  organizationId: string;
  platformAccountId: string;
  /** 已授权且可读取的真实数据是否可用（false → INDETERMINATE）。 */
  verifiedDataAvailable: boolean;
  importHistoryAvailable: boolean;
  returnExportDestructionEvidenceAvailable: boolean;
  /** lineage 完整性：'COMPLETE' | 'PARTIAL' | 'AMBIGUOUS'。 */
  lineageCompleteness: 'COMPLETE' | 'PARTIAL' | 'AMBIGUOUS';
  dataCompletenessScore: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  checkedAt: string;
}

export interface RecoveryEconomicsPolicy {
  policyId: string;
  policyVersion: string;
  currency: string;
  /** 低于该预计追回额 → NOT_QUALIFIED（免费报告）。 */
  minimumRecoveryThreshold: string;
  /** 达到该金额视为高价值 → CONDITIONAL（需人工确认）。 */
  highValueThreshold: string;
  /** API + Broker 成本 / 预计追回 的上限（十进制字符串，例如 '0.35'）。 */
  maxCostRatio: string;
  /** 数据完整度下限（十进制 0-1）。 */
  minimumDataCompleteness: string;
}

export interface CustomerQualificationDecision {
  organizationId: string;
  platformAccountId: string;
  currency: string;
  qualificationStatus: CustomsQualificationStatus;
  reasonCodes: readonly CustomsQualificationReason[];
  estimatedRecoveryAmount: string;
  estimatedExternalApiCost: string;
  estimatedBrokerCost: string;
  expectedNetRecovery: string;
  costRatio: string | null;
  policyId: string;
  policyVersion: string;
  computedAt: string;
  /** 只有在 QUALIFIED 时，才允许调用昂贵外部能力（CONDITIONAL 需人工确认）。 */
  readonly expensiveAdapterCallAllowed: boolean;
  readonly requiredConfirmation: boolean;
  readonly advisoryOnly: boolean;
  readonly filingAuthorized: false;
  readonly transportEnabled: false;
  readonly appliedCosts: false;
  readonly productionCredentials: 'ABSENT';
}

const DECIMAL_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;

function fail(code: CustomsQualificationErrorCode, detail: string): never {
  throw new CustomsQualificationError(code, detail);
}

export function decimal6(value: string): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value.trim())) fail('INVALID_AMOUNT', '非法十进制值');
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = digits.split('.');
  return (negative ? '-' : '') + whole + '.' + fraction.padEnd(6, '0').slice(0, 6);
}

function toScaled(value: string): bigint {
  const normalised = decimal6(value);
  const negative = normalised.startsWith('-');
  const digits = (negative ? normalised.slice(1) : normalised).replace('.', '');
  const scaled = BigInt(digits);
  return negative ? -scaled : scaled;
}

function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(7, '0');
  return (negative ? '-' : '') + digits.slice(0, digits.length - 6) + '.' + digits.slice(digits.length - 6);
}

function compareScaled(left: string, right: string): number {
  const a = toScaled(left);
  const b = toScaled(right);
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

/** 成本占比（decimal6）： (apiCost + brokerCost) / recoveryAmount；recoveryAmount<=0 → null。 */
export function computeCostRatio(apiCost: string, brokerCost: string, recoveryAmount: string): string | null {
  const numerator = toScaled(apiCost) + toScaled(brokerCost);
  const denominator = toScaled(recoveryAmount);
  if (denominator <= 0n) return null;
  return formatScaled((numerator * 1_000_000n) / denominator);
}

/**
 * 确定性资格判定（不调用任何外部系统）。
 */
export function evaluateCustomerQualification(input: {
  readiness: CustomerReadiness;
  estimatedRecoveryAmount: string;
  estimatedExternalApiCost: string;
  estimatedBrokerCost: string;
  policy: RecoveryEconomicsPolicy;
  computedAt: string;
}): CustomerQualificationDecision {
  const { readiness, policy } = input;
  if (!readiness || typeof readiness.organizationId !== 'string' || typeof readiness.platformAccountId !== 'string') {
    fail('INVALID_REQUEST', 'readiness 必填（organizationId / platformAccountId）');
  }
  if (!policy || !policy.policyId || !policy.policyVersion || !policy.currency) fail('INVALID_POLICY', 'policy 必填');
  if (!(readiness.lineageCompleteness === 'COMPLETE' || readiness.lineageCompleteness === 'PARTIAL' || readiness.lineageCompleteness === 'AMBIGUOUS')) {
    fail('INVALID_REQUEST', 'lineageCompleteness 非法');
  }

  const recovery = decimal6(input.estimatedRecoveryAmount);
  const apiCost = decimal6(input.estimatedExternalApiCost);
  const brokerCost = decimal6(input.estimatedBrokerCost);
  const net = formatScaled(toScaled(recovery) - toScaled(apiCost) - toScaled(brokerCost));
  const costRatio = computeCostRatio(apiCost, brokerCost, recovery);
  const reasons: CustomsQualificationReason[] = [];

  const incomplete =
    !readiness.verifiedDataAvailable ||
    !readiness.importHistoryAvailable ||
    !readiness.returnExportDestructionEvidenceAvailable ||
    compareScaled(readiness.dataCompletenessScore, policy.minimumDataCompleteness) < 0;
  const ambiguous = readiness.lineageCompleteness !== 'COMPLETE';

  let status: CustomsQualificationStatus;
  if (incomplete) {
    status = 'INDETERMINATE';
    reasons.push('INCOMPLETE_DATA');
  } else if (ambiguous) {
    status = 'INDETERMINATE';
    reasons.push('AMBIGUOUS_LINEAGE');
  } else if (toScaled(recovery) <= 0n) {
    status = 'NOT_QUALIFIED';
    reasons.push('NO_RECOVERY_ESTIMATE');
  } else if (compareScaled(recovery, policy.minimumRecoveryThreshold) < 0) {
    status = 'NOT_QUALIFIED';
    reasons.push('LOW_VALUE_BELOW_THRESHOLD');
  } else if (costRatio === null || compareScaled(costRatio, policy.maxCostRatio) > 0) {
    status = 'NOT_QUALIFIED';
    reasons.push('COST_RATIO_EXCEEDED');
  } else if (toScaled(net) < 0n) {
    status = 'NOT_QUALIFIED';
    reasons.push('NEGATIVE_NET_RECOVERY');
  } else if (compareScaled(recovery, policy.highValueThreshold) >= 0) {
    status = 'CONDITIONAL';
    reasons.push('HIGH_VALUE_REQUIRES_CONFIRMATION');
  } else {
    status = 'QUALIFIED';
    reasons.push('OK');
  }

  return {
    organizationId: readiness.organizationId,
    platformAccountId: readiness.platformAccountId,
    currency: policy.currency,
    qualificationStatus: status,
    reasonCodes: reasons,
    estimatedRecoveryAmount: recovery,
    estimatedExternalApiCost: apiCost,
    estimatedBrokerCost: brokerCost,
    expectedNetRecovery: net,
    costRatio,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    computedAt: input.computedAt,
    expensiveAdapterCallAllowed: status === 'QUALIFIED',
    requiredConfirmation: status === 'CONDITIONAL',
    advisoryOnly: status === 'NOT_QUALIFIED' || status === 'INDETERMINATE',
    filingAuthorized: false,
    transportEnabled: false,
    appliedCosts: false,
    productionCredentials: 'ABSENT',
  };
}

export const CUSTOMS_QUALIFICATION_BOUNDARY = {
  gatesExpensiveAdapters: true,
  autoExternalCallWhenNotQualified: false,
  conditionalRequiresHumanConfirmation: true,
  indeterminateTriggersExternalCall: false,
  filingAuthorized: false,
  transportEnabled: false,
  productionCredentials: 'ABSENT',
} as const;
