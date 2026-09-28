/**
 * FREIGHT_RATE_V1 确定性评估器（C-0004 Checkpoint 1 · Detection Spine）
 * ---------------------------------------------------------------
 * 设计约束（架构方 C-0004 裁定）：
 *   1. 规则是**数据**：业务参数（baseRate / perKg / fuelPct）只能来自
 *      `RuleVersion.definition`，不得散落在代码里。
 *   2. 代码只实现**少量、类型化、确定性**的 evaluator；本文件就是第一种。
 *   3. 金额**必须用十进制定点**（Prisma.Decimal），禁止用 JS Number 参与最终金额。
 *      内部统一 4 位小数，HALF_UP 舍入。
 *   4. 不执行任何动态代码（禁止 eval / new Function / 脚本字符串）。
 *   5. 评估结果必须可独立复算：输出中间值，供 RuleEvaluation.computed 落库。
 */

import { Prisma } from '@prisma/client';

const Decimal = Prisma.Decimal;

/** 金额内部精度（与 Decimal(18,4) 对齐） */
export const MONEY_SCALE = 4;

/** 规则优先级（ARCHITECTURE_CONTRACT 的不变量：合同 > 客户费率表 > 承运商费率 > 政策 > 默认） */
export const RULE_TIER_PRECEDENCE = [
  'CUSTOMER_CONTRACT',
  'CUSTOMER_RATE_CARD',
  'CARRIER_TARIFF',
  'DATED_POLICY',
  'DEFAULT',
] as const;

export type RuleTierName = (typeof RULE_TIER_PRECEDENCE)[number];

export interface FreightRateDefinition {
  schemaVersion: 1;
  kind: 'FREIGHT_RATE_V1';
  match: { lane: string; service: string };
  pricing: { baseRate: string; perKg: string; fuelPct: string };
  rounding?: { scale?: number; mode?: 'HALF_UP' };
}

export interface FreightRateEvaluation {
  /** 应收金额（4 位小数字符串） */
  expected: string;
  /** 可追回金额 = max(actual - expected, 0)（4 位小数字符串） */
  recoverable: string;
  /** 中间值，全部为 4 位小数字符串，供复算与审计 */
  intermediate: {
    baseRate: string;
    perKg: string;
    fuelPct: string;
    weightKg: string;
    weightCharge: string;
    preFuel: string;
    fuelAmount: string;
    expectedAmount: string;
    actualAmount: string;
    recoverableAmount: string;
  };
  rounding: { scale: number; mode: 'HALF_UP' };
}

export class RuleDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleDefinitionError';
  }
}

export class RuleDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleDataError';
  }
}

function round(value: InstanceType<typeof Decimal>, scale: number): InstanceType<typeof Decimal> {
  return value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
}

function fixed(value: InstanceType<typeof Decimal>, scale = MONEY_SCALE): string {
  return round(value, scale).toFixed(scale);
}

function decimalFrom(value: string, field: string): InstanceType<typeof Decimal> {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RuleDataError(`${field} 必须是非空的十进制字符串`);
  }
  try {
    return new Decimal(value.trim());
  } catch {
    throw new RuleDataError(`${field} 不是合法十进制数: ${value}`);
  }
}

/** 定义解析：只接受 FREIGHT_RATE_V1 的明确形状，任何缺失都直接抛错（不猜） */
export function parseFreightRateDefinition(raw: unknown): FreightRateDefinition {
  if (raw === null || typeof raw !== 'object') {
    throw new RuleDefinitionError('RuleVersion.definition 必须是对象');
  }
  const def = raw as Partial<FreightRateDefinition> & Record<string, unknown>;
  if (def.schemaVersion !== 1) throw new RuleDefinitionError('definition.schemaVersion 必须是 1');
  if (def.kind !== 'FREIGHT_RATE_V1') {
    throw new RuleDefinitionError(`不支持的规则类型: ${String(def.kind)}`);
  }
  const match = def.match as FreightRateDefinition['match'] | undefined;
  const pricing = def.pricing as FreightRateDefinition['pricing'] | undefined;
  if (!match?.lane || !match?.service) throw new RuleDefinitionError('definition.match 缺少 lane/service');
  if (!pricing?.baseRate || !pricing?.perKg || !pricing?.fuelPct) {
    throw new RuleDefinitionError('definition.pricing 缺少 baseRate/perKg/fuelPct');
  }
  const scale = def.rounding?.scale ?? MONEY_SCALE;
  if (!Number.isInteger(scale) || scale < 0 || scale > MONEY_SCALE) {
    throw new RuleDefinitionError(`definition.rounding.scale 必须在 0..${MONEY_SCALE}`);
  }
  if (def.rounding?.mode && def.rounding.mode !== 'HALF_UP') {
    throw new RuleDefinitionError(`暂不支持舍入模式: ${def.rounding.mode}`);
  }
  return {
    schemaVersion: 1,
    kind: 'FREIGHT_RATE_V1',
    match: { lane: match.lane, service: match.service },
    pricing: {
      baseRate: String(pricing.baseRate),
      perKg: String(pricing.perKg),
      fuelPct: String(pricing.fuelPct),
    },
    rounding: { scale, mode: 'HALF_UP' },
  };
}

/**
 * 确定性公式：
 *   weightCharge = perKg × weightKg
 *   preFuel      = baseRate + weightCharge
 *   fuel         = preFuel × fuelPct / 100
 *   expected     = preFuel + fuel
 *   recoverable  = max(actual - expected, 0)
 */
export function evaluateFreightRate(input: {
  definition: FreightRateDefinition;
  weightKg: string;
  actualCharge: string;
}): FreightRateEvaluation {
  const { definition } = input;
  const scale = definition.rounding?.scale ?? MONEY_SCALE;

  const baseRate = decimalFrom(definition.pricing.baseRate, 'pricing.baseRate');
  const perKg = decimalFrom(definition.pricing.perKg, 'pricing.perKg');
  const fuelPct = decimalFrom(definition.pricing.fuelPct, 'pricing.fuelPct');
  const weightKg = decimalFrom(input.weightKg, 'weightKg');
  const actual = decimalFrom(input.actualCharge, 'actualCharge');

  if (weightKg.isNegative()) throw new RuleDataError('weightKg 不能为负');

  const weightCharge = perKg.times(weightKg);
  const preFuel = baseRate.plus(weightCharge);
  const fuelAmount = preFuel.times(fuelPct).dividedBy(100);
  // 只在最终金额上按 scale 舍入，中间值不提前舍入，避免多次舍入累积误差
  const expected = round(preFuel.plus(fuelAmount), scale);
  const diff = actual.minus(expected);
  const recoverable = diff.isNegative() ? new Decimal(0) : round(diff, scale);

  return {
    expected: expected.toFixed(scale),
    recoverable: recoverable.toFixed(scale),
    intermediate: {
      baseRate: fixed(baseRate, scale),
      perKg: fixed(perKg, scale),
      fuelPct: fixed(fuelPct, scale),
      weightKg: fixed(weightKg, scale),
      weightCharge: fixed(weightCharge, scale),
      preFuel: fixed(preFuel, scale),
      fuelAmount: fixed(fuelAmount, scale),
      expectedAmount: expected.toFixed(scale),
      actualAmount: fixed(actual, scale),
      recoverableAmount: recoverable.toFixed(scale),
    },
    rounding: { scale, mode: 'HALF_UP' },
  };
}

export interface RuleCandidate {
  ruleVersionId: string;
  tier: RuleTierName;
  version: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  isActive: boolean;
  definition: FreightRateDefinition;
}

const tierRank = (tier: RuleTierName): number => RULE_TIER_PRECEDENCE.indexOf(tier);

/**
 * 规则选择：只保留在给定日期生效的候选，按 tier 优先级取胜；
 * 同 tier 内取 effectiveFrom 更晚者，再取 version 字符串更大者（确定性，不依赖数据库顺序）。
 */
export function selectRuleVersion(
  candidates: readonly RuleCandidate[],
  at: Date,
): RuleCandidate | null {
  const applicable = candidates.filter((c) => {
    if (!c.isActive) return false;
    if (c.effectiveFrom.getTime() > at.getTime()) return false;
    if (c.effectiveTo && c.effectiveTo.getTime() < at.getTime()) return false;
    return true;
  });
  if (applicable.length === 0) return null;

  return applicable.reduce((best, current) => {
    const byTier = tierRank(current.tier) - tierRank(best.tier);
    if (byTier !== 0) return byTier < 0 ? current : best;
    const byDate = current.effectiveFrom.getTime() - best.effectiveFrom.getTime();
    if (byDate !== 0) return byDate > 0 ? current : best;
    return current.version.localeCompare(best.version) > 0 ? current : best;
  });
}

/** 规则定义哈希：用于 RuleEvaluation.computed.definitionHash，保证评估可追溯 */
export function definitionHash(definition: FreightRateDefinition): string {
  const canonical = JSON.stringify([
    definition.schemaVersion,
    definition.kind,
    definition.match.lane,
    definition.match.service,
    definition.pricing.baseRate,
    definition.pricing.perKg,
    definition.pricing.fuelPct,
    definition.rounding?.scale ?? MONEY_SCALE,
    definition.rounding?.mode ?? 'HALF_UP',
  ]);
  // 只做稳定短哈希（不用于安全用途），避免引入新依赖
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < canonical.length; i += 1) {
    const code = canonical.charCodeAt(i);
    h1 = ((h1 ^ code) * 0x01000193) >>> 0;
    h2 = ((h2 ^ code) * 0x85ebca6b) >>> 0;
  }
  return `fnv1a64:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
