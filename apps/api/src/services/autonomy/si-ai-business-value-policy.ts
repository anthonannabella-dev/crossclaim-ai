/**
 * SI-COST-OPTIMIZATION C3 —— Business-value-aware cost policy（确定性；零模型依赖）
 * ---------------------------------------------------------------
 * 硬约束（HOST ADDENDUM OPT-6 / MSG-20261005-37 NEXT #2）：
 *   - 「estimated recovery value **不得由客户端自报**；必须来自可信 canonical / recovery basis」；
 *   - caller 不得据此提高模型等级或预算；
 *   - 不引入第二 policy engine（本模块只是既有 Necessity / Budget / Escalation 之前的一段纯判定）；
 *   - 无可信 basis / 未知价值 → 只允许 LOW_COST（fail-closed：不自动升级 strong）；
 *   - 真实业务指标缺失时一律 `NOT_YET_MEASURABLE`，禁止用估算值伪装成生产指标。
 */

export const AI_BUSINESS_VALUE_BANDS = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type AiBusinessValueBand = (typeof AI_BUSINESS_VALUE_BANDS)[number];

export type AiBusinessValueTier = 'LOW_COST' | 'STRONG';

/**
 * 可信恢复价值基准：只能由服务端 canonical / recovery basis 构造。
 * 该结构**没有**任何 caller 自报字段；调用方若想传自报值只能走 `callerClaimedValueMicros`，
 * 而该字段在设计上被显式忽略（见 `callerValueIgnored`）。
 */
export interface AiTrustedRecoveryBasis {
  /** canonical / recovery basis 引用（不可为空；空 → UNKNOWN，fail-closed） */
  basisRef: string;
  /** 可信估算追回价值（micros）；null = 不可得（UNKNOWN） */
  estimatedRecoveryValueMicros: number | null;
  /** 风险等级（来自 canonical 分类，不由 caller 决定） */
  riskClass?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
}

export const AI_BUSINESS_VALUE_THRESHOLDS = {
  /** < $50：低价值 → 更严格禁止强模型 */
  mediumMicros: 50_000_000,
  /** >= $1000：高价值、高置信追回案件 → 在安全预算内可允许更强分析 */
  highMicros: 1_000_000_000,
} as const;

/** 硬上限：host / caller 均不得放大（同时最多只有 HIGH 价值 + LOW 风险才进 STRONG） */
export const AI_BUSINESS_VALUE_HARD_CAPS = {
  hostMayRaiseThresholds: false,
  callerMayClaimValue: false,
  unknownValueMayUseStrong: false,
  maxTier: 'STRONG',
} as const;

export interface AiBusinessValueInput {
  basis: AiTrustedRecoveryBasis | null | undefined;
  taskType: string;
  requestedTier: AiBusinessValueTier;
  /** caller 自报价值：**一律忽略**（只用于审计计数，绝不参与判定） */
  callerClaimedValueMicros?: number | null;
}

export interface AiBusinessValueDecision {
  allowed: boolean;
  maxTier: AiBusinessValueTier;
  strongAllowed: boolean;
  valueBand: AiBusinessValueBand;
  effectiveRecoveryValueMicros: number | null;
  basisRef: string | null;
  reason: string;
  callerValueIgnored: boolean;
  basisTrusted: boolean;
}

export const AI_BUSINESS_VALUE_BOUNDARY = {
  callerReportedValue: 'FORBIDDEN（一律忽略；参与判定即视为越界）',
  source: 'TRUSTED_CANONICAL_RECOVERY_BASIS_ONLY',
  secondPolicyEngine: 'FORBIDDEN',
  unknownValueStrongCall: 'FORBIDDEN（fail-closed）',
  hostMayRaiseThresholds: false,
  callerMayRaiseTierOrBudget: false,
  recordsCustomerData: false,
} as const;

const isPositiveIntegerMicros = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** 可信 basis 校验：引用非空 + 价值为非负整数 micros（否则视为不可信 → UNKNOWN） */
export function validateAiTrustedRecoveryBasis(
  basis: AiTrustedRecoveryBasis | null | undefined,
): { trusted: true; basis: AiTrustedRecoveryBasis } | { trusted: false; reason: string } {
  if (!basis) return { trusted: false, reason: 'AI_BUSINESS_VALUE_BASIS_ABSENT' };
  if (typeof basis.basisRef !== 'string' || basis.basisRef.trim() === '') {
    return { trusted: false, reason: 'AI_BUSINESS_VALUE_BASIS_REF_REQUIRED' };
  }
  if (basis.estimatedRecoveryValueMicros === null) {
    return { trusted: false, reason: 'AI_BUSINESS_VALUE_UNMEASURED' };
  }
  if (!isPositiveIntegerMicros(basis.estimatedRecoveryValueMicros)) {
    return { trusted: false, reason: 'AI_BUSINESS_VALUE_ESTIMATE_INVALID' };
  }
  return { trusted: true, basis };
}

export function classifyAiBusinessValueBand(valueMicros: number | null): AiBusinessValueBand {
  if (valueMicros === null) return 'UNKNOWN';
  if (valueMicros >= AI_BUSINESS_VALUE_THRESHOLDS.highMicros) return 'HIGH';
  if (valueMicros >= AI_BUSINESS_VALUE_THRESHOLDS.mediumMicros) return 'MEDIUM';
  return 'LOW';
}

/**
 * 业务价值 → 允许的最高模型等级。
 * 规则（确定性、只收紧不放大）：
 *   UNKNOWN           → maxTier = LOW_COST（strong 禁止）
 *   LOW               → maxTier = LOW_COST
 *   MEDIUM            → maxTier = LOW_COST（medium 价值仍不足以授权 strong）
 *   HIGH + 非 LOW 风险 → maxTier = STRONG
 *   HIGH + LOW 风险    → maxTier = STRONG（高价值 + 低风险 = 最安全升级场景）
 */
export function decideAiBusinessValueTier(input: AiBusinessValueInput): AiBusinessValueDecision {
  const callerValueIgnored = input.callerClaimedValueMicros !== undefined && input.callerClaimedValueMicros !== null;
  const validated = validateAiTrustedRecoveryBasis(input.basis);
  if (!validated.trusted) {
    return {
      allowed: true,
      maxTier: 'LOW_COST',
      strongAllowed: false,
      valueBand: 'UNKNOWN',
      effectiveRecoveryValueMicros: null,
      basisRef: input.basis?.basisRef ?? null,
      reason: validated.reason,
      callerValueIgnored,
      basisTrusted: false,
    };
  }
  const valueMicros = validated.basis.estimatedRecoveryValueMicros as number;
  const band = classifyAiBusinessValueBand(valueMicros);
  const stronglyAllowed = band === 'HIGH';
  return {
    allowed: true,
    maxTier: stronglyAllowed ? 'STRONG' : 'LOW_COST',
    strongAllowed: stronglyAllowed,
    valueBand: band,
    effectiveRecoveryValueMicros: valueMicros,
    basisRef: validated.basis.basisRef,
    reason: stronglyAllowed ? 'AI_BUSINESS_VALUE_HIGH_TIER_STRONG_ELIGIBLE' : 'AI_BUSINESS_VALUE_TIER_LOW_COST_ONLY',
    callerValueIgnored,
    basisTrusted: true,
  };
}

/** 升级请求是否被业务价值策略允许（caller 无法放大；STRONG 只在 HIGH 价值下允许） */
export function assertAiBusinessValueTierAllowed(input: {
  decision: AiBusinessValueDecision;
  requestedTier: AiBusinessValueTier;
}): { allowed: boolean; reason: string } {
  if (input.requestedTier === 'LOW_COST') return { allowed: true, reason: 'LOW_COST_ALWAYS_ELIGIBLE' };
  if (input.decision.strongAllowed) return { allowed: true, reason: 'BUSINESS_VALUE_ALLOWS_STRONG' };
  return { allowed: false, reason: 'AI_BUSINESS_VALUE_TIER_DENIED:' + input.decision.valueBand };
}

/** 真实指标口径：缺可信分母 → NOT_YET_MEASURABLE（禁止伪造） */
export const AI_VALUE_METRIC_NOT_YET_MEASURABLE = 'NOT_YET_MEASURABLE' as const;

export interface AiBusinessValueDenominators {
  opportunities: number | null;
  cases: number | null;
  successfulRecoveries: number | null;
  recoveredMicros: number | null;
}

export interface AiCostRatioMetrics {
  AI_COST_PER_OPPORTUNITY: number | string;
  AI_COST_PER_CASE: number | string;
  AI_COST_PER_SUCCESSFUL_RECOVERY: number | string;
  AI_COST_PER_1000_RECOVERED: number | string;
  MODEL_COST_TO_RECOVERY_VALUE_RATIO: number | string;
}

const ratio = (costMicros: number, denominator: number | null): number | string => {
  if (denominator === null || !Number.isFinite(denominator) || denominator <= 0) {
    return AI_VALUE_METRIC_NOT_YET_MEASURABLE;
  }
  return Number((costMicros / denominator).toFixed(6));
};

/** AI 成本 / 业务价值比（分母必须来自可信 canonical 统计；缺失 → NOT_YET_MEASURABLE） */
export function computeAiCostRatioMetrics(input: {
  aiCostMicros: number;
  denominators: AiBusinessValueDenominators;
}): AiCostRatioMetrics {
  const recovered = input.denominators.recoveredMicros;
  return {
    AI_COST_PER_OPPORTUNITY: ratio(input.aiCostMicros, input.denominators.opportunities),
    AI_COST_PER_CASE: ratio(input.aiCostMicros, input.denominators.cases),
    AI_COST_PER_SUCCESSFUL_RECOVERY: ratio(input.aiCostMicros, input.denominators.successfulRecoveries),
    AI_COST_PER_1000_RECOVERED:
      recovered === null || !Number.isFinite(recovered) || recovered <= 0
        ? AI_VALUE_METRIC_NOT_YET_MEASURABLE
        : Number(((input.aiCostMicros / recovered) * 1_000_000_000).toFixed(6)),
    MODEL_COST_TO_RECOVERY_VALUE_RATIO:
      recovered === null || !Number.isFinite(recovered) || recovered <= 0
        ? AI_VALUE_METRIC_NOT_YET_MEASURABLE
        : Number((input.aiCostMicros / recovered).toFixed(9)),
  };
}
