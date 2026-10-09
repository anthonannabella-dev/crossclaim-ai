/**
 * V2-04 — CUSTOMS PROFIT GATE（付费关税执行前的盈亏门 · 服务端版本化策略）
 * ---------------------------------------------------------------
 * 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE D。
 *
 * 不变式：
 *  1. **严禁只按预计追回总额判断盈利**：必须按"风险调整后收入 − 直接成本"计算贡献毛利。
 *  2. 成功概率必须由调用方**显式声明为估算**且落在 (0, 1]；缺失 / 声称确定 / 越界 → HOLD。
 *  3. 金额一律定点 decimal（scale 6，BigInt），**不使用浮点**。
 *  4. 缺报价、报价非法、跨币种、超单次上限、超租户预算 → 一律 HOLD，不得调用收费外部服务。
 *  5. 费率来自既有版本化 `CUSTOMS_SUCCESS_15` 政策对象（由调用方解析注入），本模块不新增第二套费率。
 *  6. 本模块不调用 provider、不扣款、不写库、不发起任何外部请求。
 */

import type { FeePolicy } from '../commercial/fee-policy';
import { FEE_BASIS_POINTS_DENOMINATOR } from '../commercial/fee-policy';
import { compareDecimalAmounts, normalizeDecimalAmount } from './customs-paid-api-gate';

export const CUSTOMS_PROFIT_GATE_VERSION = 'customs-profit-gate-v2.0.0';
const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

export type CustomsProfitGateReasonCode =
  | 'FEE_POLICY_MISSING'
  | 'FEE_POLICY_RATE_MISSING'
  | 'FEE_POLICY_INACTIVE_AT_DATE'
  | 'RECOVERED_AMOUNT_INVALID'
  | 'DIRECT_COST_INVALID'
  | 'SUCCESS_PROBABILITY_MISSING'
  | 'SUCCESS_PROBABILITY_OUT_OF_RANGE'
  | 'SUCCESS_PROBABILITY_ASSERTED_CERTAIN'
  | 'PROVIDER_QUOTE_MISSING'
  | 'PROVIDER_QUOTE_INVALID'
  | 'CURRENCY_MISMATCH'
  | 'PER_CHECK_BUDGET_EXCEEDED'
  | 'TENANT_BUDGET_EXCEEDED'
  | 'SUBSCRIPTION_SUBSIDY_NOT_ALLOWED'
  | 'MARGIN_BELOW_FLOOR'
  | 'MARGIN_RATE_BELOW_FLOOR'
  | 'PROFIT_GATE_PASS';

export interface CustomsProfitGatePolicy {
  policyId: string;
  policyVersion: string;
  /** 最低贡献毛利（每币种，decimal string）；缺币种 → HOLD（fail-closed）。 */
  minContributionMarginByCurrency: Readonly<Record<string, string>>;
  /** 最低贡献毛利率（bps，0–10000）。 */
  minContributionMarginBps: number;
  /** 是否允许用订阅收入抵扣单次执行成本。 */
  allowSubscriptionSubsidy: boolean;
}

export interface CustomsProfitGateInput {
  currency: string;
  /** 预计可追回金额（来自既有 C5 预估，不得来自客户自报）。 */
  expectedRecoveredAmount: string;
  /** 成功概率（decimal string，"1" 表示声称 100%）。 */
  successProbability: string;
  /** 必须显式声明"这是估算"；false = 把未知伪装成确定 → HOLD。 */
  probabilityIsEstimate: boolean;
  /** 既有版本化成功费政策（调用方从 registry 解析后注入）。 */
  feePolicy: FeePolicy | null;
  /** 政策生效判定日（ISO 日期，YYYY-MM-DD）。 */
  asOfDate: string;
  /** 已实现订阅收入贡献（decimal string）。 */
  earnedSubscriptionContribution: string;
  /** provider 报价（decimal string）；缺失 → HOLD。 */
  providerQuotedCost: string | null;
  /** 除 provider 报价外的其他直接成本（decimal string）。 */
  expectedDirectCost: string;
  /** 单次核验成本上限（decimal string）。 */
  maximumPerCheckCost: string;
  /** 租户剩余预算（decimal string）。 */
  tenantRemainingBudget: string;
  policy: CustomsProfitGatePolicy;
}

export interface CustomsProfitGateResult {
  kind: 'CUSTOMS_PROFIT_GATE';
  version: string;
  decision: 'PASS' | 'HOLD';
  reasonCodes: readonly CustomsProfitGateReasonCode[];
  currency: string;
  projectedSuccessFee: string | null;
  riskAdjustedSuccessFee: string | null;
  subscriptionContributionApplied: string | null;
  expectedRevenue: string | null;
  expectedCost: string | null;
  expectedContributionMargin: string | null;
  expectedContributionMarginBps: number | null;
  minContributionMargin: string | null;
  minContributionMarginBps: number;
  externalCallPerformed: false;
  chargedAmount: null;
  productionCredentials: 'ABSENT';
}

const SIGNED_DECIMAL_PATTERN = /^-?\d+(\.\d{1,4})?$/;

/** 有符号定点解析（供差额 / 负毛利使用）；非法 → null。 */
function parseScaled(amount: string): bigint | null {
  if (typeof amount !== 'string') return null;
  const trimmed = amount.trim();
  if (!SIGNED_DECIMAL_PATTERN.test(trimmed)) return null;
  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = digits.split('.');
  const scaled = BigInt(whole + fraction.padEnd(SCALE, '0').slice(0, SCALE));
  return negative ? -scaled : scaled;
}

function formatScaled(total: bigint): string {
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(SCALE + 1, '0');
  const whole = digits.slice(0, digits.length - SCALE);
  let fraction = digits.slice(digits.length - SCALE).replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** 应用 bps 费率并**向下取整到分**（floor），避免高估收入。 */
export function applyBpsFloorToCent(amount: string, rateBps: number): string | null {
  const scaled = parseScaled(amount);
  if (scaled === null) return null;
  if (!Number.isInteger(rateBps) || rateBps < 0) return null;
  const bpsScaled = BigInt(rateBps);
  const feeScaled = (scaled * bpsScaled) / BigInt(FEE_BASIS_POINTS_DENOMINATOR);
  const cents = Number(SCALE - 2);
  const centFactor = 10n ** BigInt(cents);
  const floored = (feeScaled / centFactor) * centFactor;
  return formatScaled(floored);
}

/** 乘算（向下取整到分），用于风险调整。 */
export function multiplyFloorToCent(left: string, right: string): string | null {
  const a = parseScaled(left);
  const b = parseScaled(right);
  if (a === null || b === null) return null;
  const product = (a * b) / SCALE_FACTOR;
  const centFactor = 10n ** BigInt(SCALE - 2);
  return formatScaled((product / centFactor) * centFactor);
}

export function addDecimalAmounts(left: string, right: string): string | null {
  const a = parseScaled(left);
  const b = parseScaled(right);
  if (a === null || b === null) return null;
  return formatScaled(a + b);
}

export function subtractDecimalAmounts(left: string, right: string): string | null {
  const a = parseScaled(left);
  const b = parseScaled(right);
  if (a === null || b === null) return null;
  return formatScaled(a - b);
}

/** margin / revenue × 10000，向下取整；revenue 为 0 → null。 */
export function ratioToBpsFloor(numerator: string, denominator: string): number | null {
  const n = parseScaled(numerator);
  const d = parseScaled(denominator);
  if (n === null || d === null || d === 0n) return null;
  return Number((n * BigInt(FEE_BASIS_POINTS_DENOMINATOR)) / d);
}

function policyActiveAt(policy: FeePolicy, asOfDate: string): boolean {
  if (policy.effectiveFrom > asOfDate) return false;
  if (policy.effectiveTo !== null && policy.effectiveTo < asOfDate) return false;
  return true;
}

/**
 * 纯判定：不产生副作用、不调用 provider、不扣款。
 * 只有在"风险调整后贡献毛利 ≥ 政策下限"且预算/报价全部合规时才 PASS。
 */
export function evaluateCustomsProfitGate(input: CustomsProfitGateInput): CustomsProfitGateResult {
  const reasons: CustomsProfitGateReasonCode[] = [];
  const base = {
    kind: 'CUSTOMS_PROFIT_GATE' as const,
    version: CUSTOMS_PROFIT_GATE_VERSION,
    currency: input.currency,
    minContributionMarginBps: input.policy.minContributionMarginBps,
    externalCallPerformed: false as const,
    chargedAmount: null,
    productionCredentials: 'ABSENT' as const,
  };
  const hold = (): CustomsProfitGateResult => ({
    ...base,
    decision: 'HOLD',
    reasonCodes: reasons,
    projectedSuccessFee: null,
    riskAdjustedSuccessFee: null,
    subscriptionContributionApplied: null,
    expectedRevenue: null,
    expectedCost: null,
    expectedContributionMargin: null,
    expectedContributionMarginBps: null,
    minContributionMargin: null,
  });

  if (input.feePolicy === null) {
    reasons.push('FEE_POLICY_MISSING');
    return hold();
  }
  if (input.feePolicy.rateBps === null) {
    reasons.push('FEE_POLICY_RATE_MISSING');
    return hold();
  }
  if (input.feePolicy.currency !== null && input.feePolicy.currency !== input.currency) {
    reasons.push('CURRENCY_MISMATCH');
    return hold();
  }
  if (!policyActiveAt(input.feePolicy, input.asOfDate)) {
    reasons.push('FEE_POLICY_INACTIVE_AT_DATE');
    return hold();
  }

  const recovered = normalizeDecimalAmount(input.expectedRecoveredAmount);
  if (recovered === null || compareDecimalAmounts(recovered, '0') !== 1) {
    reasons.push('RECOVERED_AMOUNT_INVALID');
    return hold();
  }

  const probability = normalizeDecimalAmount(input.successProbability);
  if (probability === null) {
    reasons.push('SUCCESS_PROBABILITY_MISSING');
    return hold();
  }
  if (!input.probabilityIsEstimate) {
    reasons.push('SUCCESS_PROBABILITY_ASSERTED_CERTAIN');
    return hold();
  }
  // 概率必须严格落在 (0, 1)：1.0 属"确定性断言"，不属估算 → 一律 HOLD。
  if (compareDecimalAmounts(probability, '0') !== 1 || compareDecimalAmounts(probability, '1') !== -1) {
    reasons.push('SUCCESS_PROBABILITY_OUT_OF_RANGE');
    return hold();
  }

  if (input.providerQuotedCost === null) {
    reasons.push('PROVIDER_QUOTE_MISSING');
    return hold();
  }
  const quotedCost = normalizeDecimalAmount(input.providerQuotedCost);
  if (quotedCost === null) {
    reasons.push('PROVIDER_QUOTE_INVALID');
    return hold();
  }
  const perCheck = normalizeDecimalAmount(input.maximumPerCheckCost);
  const tenantBudget = normalizeDecimalAmount(input.tenantRemainingBudget);
  if (perCheck === null || tenantBudget === null) {
    reasons.push('PROVIDER_QUOTE_INVALID');
    return hold();
  }
  if (compareDecimalAmounts(quotedCost, perCheck) === 1) {
    reasons.push('PER_CHECK_BUDGET_EXCEEDED');
  }
  if (compareDecimalAmounts(quotedCost, tenantBudget) === 1) {
    reasons.push('TENANT_BUDGET_EXCEEDED');
  }

  const projectedSuccessFee = applyBpsFloorToCent(recovered, input.feePolicy.rateBps);
  const riskAdjustedSuccessFee =
    projectedSuccessFee === null ? null : multiplyFloorToCent(projectedSuccessFee, probability);
  if (projectedSuccessFee === null || riskAdjustedSuccessFee === null) {
    reasons.push('RECOVERED_AMOUNT_INVALID');
    return hold();
  }

  let subscriptionContributionApplied = '0.00';
  const subscription = normalizeDecimalAmount(input.earnedSubscriptionContribution);
  if (subscription === null) {
    reasons.push('SUBSCRIPTION_SUBSIDY_NOT_ALLOWED');
  } else if (compareDecimalAmounts(subscription, '0') === 1) {
    if (input.policy.allowSubscriptionSubsidy) {
      subscriptionContributionApplied = formatScaled(parseScaled(subscription) as bigint);
    } else {
      reasons.push('SUBSCRIPTION_SUBSIDY_NOT_ALLOWED');
    }
  }

  const expectedRevenue = addDecimalAmounts(riskAdjustedSuccessFee, subscriptionContributionApplied);
  const expectedCost = addDecimalAmounts(quotedCost, input.expectedDirectCost);
  if (expectedRevenue === null) {
    reasons.push('RECOVERED_AMOUNT_INVALID');
    return hold();
  }
  if (expectedCost === null) {
    reasons.push('DIRECT_COST_INVALID');
    return hold();
  }
  const margin = subtractDecimalAmounts(expectedRevenue, expectedCost);
  if (margin === null) {
    reasons.push('RECOVERED_AMOUNT_INVALID');
    return hold();
  }
  const marginBps = ratioToBpsFloor(margin, expectedRevenue);

  const minMarginRaw = input.policy.minContributionMarginByCurrency[input.currency];
  const minMargin = minMarginRaw === undefined ? null : normalizeDecimalAmount(minMarginRaw);
  const marginScaled = parseScaled(margin);
  const minMarginScaled = minMargin === null ? null : parseScaled(minMargin);
  if (minMarginScaled === null || marginScaled === null) {
    reasons.push('MARGIN_BELOW_FLOOR');
  } else if (marginScaled < minMarginScaled) {
    reasons.push('MARGIN_BELOW_FLOOR');
  }
  if (marginBps === null || marginBps < input.policy.minContributionMarginBps) {
    reasons.push('MARGIN_RATE_BELOW_FLOOR');
  }

  const decision: 'PASS' | 'HOLD' = reasons.length === 0 ? 'PASS' : 'HOLD';
  if (decision === 'PASS') reasons.push('PROFIT_GATE_PASS');

  return {
    ...base,
    decision,
    reasonCodes: reasons,
    projectedSuccessFee,
    riskAdjustedSuccessFee,
    subscriptionContributionApplied,
    expectedRevenue,
    expectedCost,
    expectedContributionMargin: margin,
    expectedContributionMarginBps: marginBps,
    minContributionMargin: minMargin,
  };
}

/** 边界自证：盈亏门不产生外部调用 / 资金动作。 */
export const CUSTOMS_PROFIT_GATE_BOUNDARY = {
  externalCallPerformed: false,
  providerInvoked: false,
  chargedAmount: null,
  paymentCaptured: false,
  autoCollectionEnabled: false,
  usesFloatingPoint: false,
  productionCredentials: 'ABSENT',
} as const;
