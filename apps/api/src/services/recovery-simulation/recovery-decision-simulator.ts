// SI/RSI GAP-CLOSURE — 单元 E — Recovery Simulation / Lightweight Recovery Decision Simulator v1
// ---------------------------------------------------------------------------
// 定位：**只做决策模拟**（Recovery Decision Simulator），不是通用 World Model。
//   输入：机会金额/币种/domain/provider/account/证据完整度与冲突/ruleVersion/eligibility 置信度/
//         Experience Memory 聚合/provider·broker·human 成本/预计 time-to-recovery/审批与授权要求
//   输出：对 2–4 个方案（SUBMIT_NOW / COLLECT_MORE_EVIDENCE / HUMAN_OR_BROKER_REVIEW / DEFER）逐项给出
//         expectedRecovery · successProbability · calibratedConfidence · expectedCost · expectedTime ·
//         downsideRisk · requiredEvidence · policyConstraints · guardConstraints · sourceExperienceRefs
//
// 硬边界：
//   ① externalActionPerformed 恒为 false（只模拟、只建议，不执行）；
//   ② 概率 / 金额 / 成本**只能**来自 Experience Memory 或调用方提供的成本/时长输入；
//      没有依据一律 null 并标 insufficientEvidence —— 禁止 LLM 或本模块自行编造；
//   ③ Experience 不足 → 回退到**确定性 Rule/Policy**（规则/政策/证据/授权/守卫），不产生任何数字；
//   ④ simulation ≠ World Model complete：不预测外部世界、不写任何事实。

import { digestOf } from '../config-execution-durability/digests';
import type { ExperienceAggregate, ExperienceDecisionSupport } from '../experience-memory/experience-memory';

export const RECOVERY_SIMULATOR_VERSION = 'recovery-decision-simulator/v1';

export const RECOVERY_SIMULATION_OPTIONS = [
  'SUBMIT_NOW',
  'COLLECT_MORE_EVIDENCE',
  'HUMAN_OR_BROKER_REVIEW',
  'DEFER',
] as const;
export type RecoverySimulationOption = (typeof RECOVERY_SIMULATION_OPTIONS)[number];

export const RECOVERY_RECOMMENDATION_BASIS = ['EXPERIENCE', 'DETERMINISTIC_FALLBACK'] as const;
export type RecoveryRecommendationBasis = (typeof RECOVERY_RECOMMENDATION_BASIS)[number];

export const RECOVERY_DOWNSIDE_RISKS = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'] as const;
export type RecoveryDownsideRisk = (typeof RECOVERY_DOWNSIDE_RISKS)[number];

export interface RecoverySimulationInput {
  opportunity: {
    organizationId: string;
    platformAccountId: string | null;
    provider: string;
    domain: string;
    amountUsd: number | null;
    currency: string | null;
    ruleVersion: string;
    eligibilityConfidenceBp: number | null;
    evidence: {
      completeness: 'COMPLETE' | 'PARTIAL' | 'MISSING';
      conflicts: readonly string[];
      requiredMissing: readonly string[];
    };
    approvalRequired: boolean;
    authorizationReady: boolean;
  };
  /** 每个方案的 Experience Memory 聚合（缺失 → 该方案无经验依据） */
  experienceByOption?: Partial<Record<RecoverySimulationOption, ExperienceAggregate | null>> | null;
  /** 成本与时长必须由调用方提供（不允许本模块编造） */
  costInputs?: {
    providerCostUsd?: number | null;
    brokerCostUsd?: number | null;
    humanReviewCostUsd?: number | null;
    timeToRecoveryDays?: Partial<Record<RecoverySimulationOption, number | null>> | null;
  } | null;
  /** 政策 / 守卫约束（来自既有 Policy Core 与 Action Guard 的只读输出） */
  policyConstraints?: readonly string[];
  guardConstraints?: readonly string[];
  now: Date;
}

export interface RecoveryOptionSimulation {
  option: RecoverySimulationOption;
  available: boolean;
  /** 概率 / 金额 / 成本 / 时长：无依据一律 null（绝不编造） */
  successProbability: number | null;
  expectedRecoveryUsd: number | null;
  calibratedConfidenceBp: number | null;
  expectedCostUsd: number | null;
  /** 期望净值 = expectedRecovery − expectedCost（仅在两者都有值时可算） */
  expectedNetValueUsd: number | null;
  expectedTimeDays: number | null;
  downsideRisk: RecoveryDownsideRisk;
  requiredEvidence: string[];
  policyConstraints: string[];
  guardConstraints: string[];
  sourceExperienceRefs: string[];
  evidenceBasis: 'EXPERIENCE' | 'DETERMINISTIC' | 'INSUFFICIENT';
  reasonCodes: string[];
}

export interface RecoverySimulationResult {
  kind: 'RECOVERY_SIMULATION';
  version: string;
  organizationId: string;
  platformAccountId: string | null;
  provider: string;
  domain: string;
  ruleVersion: string;
  options: RecoveryOptionSimulation[];
  recommendation: {
    option: RecoverySimulationOption;
    basis: RecoveryRecommendationBasis;
    expectedNetValueUsd: number | null;
    reasonCodes: string[];
  };
  insufficientEvidence: boolean;
  outcomesUnknown: boolean;
  externalActionPerformed: false;
  simulationOnly: true;
  worldModelComplete: false;
  llmDecided: false;
  writesFacts: false;
  decidedAt: string;
  simulationDigest: string;
}

export type RecoverySimulationErrorCode =
  | 'RECOVERY_SIMULATION_CANNOT_EXECUTE'
  | 'RECOVERY_SIMULATION_CANNOT_INVENT_NUMBERS';

export class RecoverySimulationError extends Error {
  readonly code: RecoverySimulationErrorCode;

  constructor(code: RecoverySimulationErrorCode, message: string) {
    super(message);
    this.name = 'RecoverySimulationError';
    this.code = code;
  }
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** 经验是否足够支撑数值化模拟（FAIL_CLOSED / NO_AUTOMATIC_LEARNING / IGNORED 一律不足） */
function experienceUsable(aggregate: ExperienceAggregate | null | undefined): boolean {
  if (aggregate === null || aggregate === undefined) return false;
  if (aggregate.successRateBp === null || aggregate.sourceCount === 0) return false;
  const support: ExperienceDecisionSupport = aggregate.decisionSupport;
  return support === 'ADVISORY' || support === 'DOWNWEIGHTED';
}

/**
 * 决策模拟（纯函数）。
 * 只输出模拟与建议；不执行任何动作、不写任何事实。
 */
export function simulateRecoveryDecision(input: RecoverySimulationInput): RecoverySimulationResult {
  const opportunity = input.opportunity;
  const amountUsd = typeof opportunity.amountUsd === 'number' ? opportunity.amountUsd : null;
  const costs = input.costInputs ?? null;
  const policyConstraints = [...(input.policyConstraints ?? [])].sort();
  const guardConstraints = [...(input.guardConstraints ?? [])].sort();
  const evidenceMissing = [...opportunity.evidence.requiredMissing];
  const hasConflict = opportunity.evidence.conflicts.length > 0;

  const optionCost = (option: RecoverySimulationOption): number | null => {
    if (costs === null) return null;
    switch (option) {
      case 'SUBMIT_NOW':
        return typeof costs.providerCostUsd === 'number' ? costs.providerCostUsd : null;
      case 'COLLECT_MORE_EVIDENCE':
        return 0;
      case 'HUMAN_OR_BROKER_REVIEW':
        return typeof costs.brokerCostUsd === 'number'
          ? costs.brokerCostUsd + (typeof costs.humanReviewCostUsd === 'number' ? costs.humanReviewCostUsd : 0)
          : null;
      case 'DEFER':
        return 0;
    }
  };

  const options: RecoveryOptionSimulation[] = RECOVERY_SIMULATION_OPTIONS.map((option) => {
    const aggregate = input.experienceByOption?.[option] ?? null;
    const usable = experienceUsable(aggregate);
    const reasonCodes: string[] = [];
    const syntheticEvidence = option === 'COLLECT_MORE_EVIDENCE' ? evidenceMissing : [];

    // 可用性：确定性规则优先判定（与经验无关）
    let available = true;
    if (option === 'SUBMIT_NOW' && (evidenceMissing.length > 0 || hasConflict || !opportunity.authorizationReady)) {
      available = false;
      reasonCodes.push('SUBMIT_NOW_NOT_ALLOWED_BY_RULES');
    }
    if (option === 'DEFER' && !hasConflict && evidenceMissing.length === 0 && opportunity.authorizationReady) {
      // 一切就绪时 DEFER 仍可评估，但会被净值为负时才推荐
      reasonCodes.push('DEFER_NOT_PREFERRED_WHEN_READY');
    }

    const successProbability = usable ? (aggregate as ExperienceAggregate).successRateBp! / 10_000 : null;
    const expectedRecoveryUsd =
      usable && amountUsd !== null ? round2(amountUsd * (aggregate as ExperienceAggregate).successRateBp! / 10_000) : null;
    const calibratedConfidenceBp = usable ? (aggregate as ExperienceAggregate).confidenceBp : null;
    const expectedCostUsd = optionCost(option);
    const expectedNetValueUsd =
      expectedRecoveryUsd !== null && expectedCostUsd !== null ? round2(expectedRecoveryUsd - expectedCostUsd) : null;

    const downsideRisk: RecoveryDownsideRisk = experienceUsable(aggregate)
      ? (aggregate as ExperienceAggregate).decisionSupport === 'DOWNWEIGHTED'
        ? 'MEDIUM'
        : hasConflict
          ? 'MEDIUM'
          : 'LOW'
      : 'UNKNOWN';

    let evidenceBasis: RecoveryOptionSimulation['evidenceBasis'];
    if (usable) {
      evidenceBasis = 'EXPERIENCE';
      reasonCodes.push('EXPERIENCE_BASED');
    } else if (option === 'COLLECT_MORE_EVIDENCE' && evidenceMissing.length > 0) {
      evidenceBasis = 'DETERMINISTIC';
      reasonCodes.push('DETERMINISTIC_REQUIRED_EVIDENCE');
    } else if (option === 'HUMAN_OR_BROKER_REVIEW' && (hasConflict || opportunity.approvalRequired)) {
      evidenceBasis = 'DETERMINISTIC';
      reasonCodes.push('DETERMINISTIC_HUMAN_REVIEW_REQUIRED');
    } else if (option === 'DEFER') {
      evidenceBasis = 'DETERMINISTIC';
      reasonCodes.push('DETERMINISTIC_DEFER_OPTION');
    } else {
      evidenceBasis = 'INSUFFICIENT';
      reasonCodes.push('NO_SUFFICIENT_EXPERIENCE');
    }

    return {
      option,
      available,
      successProbability,
      expectedRecoveryUsd,
      calibratedConfidenceBp,
      expectedCostUsd,
      expectedNetValueUsd,
      expectedTimeDays: costs?.timeToRecoveryDays?.[option] ?? null,
      downsideRisk,
      requiredEvidence: syntheticEvidence,
      policyConstraints,
      guardConstraints,
      sourceExperienceRefs: usable ? [...(aggregate as ExperienceAggregate).sourceRefs] : [],
      evidenceBasis,
      reasonCodes: [...new Set(reasonCodes)].sort(),
    };
  });

  // 推荐：先看有净值且有经验依据的可用方案；否则回退确定性 Rule/Policy
  const experienceCandidates = options.filter(
    (option) => option.available && option.evidenceBasis === 'EXPERIENCE' && option.expectedNetValueUsd !== null,
  );

  let recommendation: RecoverySimulationResult['recommendation'];
  if (experienceCandidates.length > 0) {
    const best = experienceCandidates.slice().sort((a, b) => {
      const byValue = (b.expectedNetValueUsd ?? 0) - (a.expectedNetValueUsd ?? 0);
      if (byValue !== 0) return byValue;
      const byCost = (a.expectedCostUsd ?? 0) - (b.expectedCostUsd ?? 0);
      if (byCost !== 0) return byCost;
      return RECOVERY_SIMULATION_OPTIONS.indexOf(a.option) - RECOVERY_SIMULATION_OPTIONS.indexOf(b.option);
    })[0];
    recommendation = {
      option: best.option,
      basis: 'EXPERIENCE',
      expectedNetValueUsd: best.expectedNetValueUsd,
      reasonCodes: ['MAX_EXPECTED_NET_VALUE', ...best.reasonCodes],
    };
  } else {
    // 确定性回退：证据缺口 → 补件；冲突/审批/授权 → 人工或报关行；守卫/政策阻断 → DEFER；否则提交
    const guardBlocksSubmit = guardConstraints.length > 0 || policyConstraints.some((c) => /BLOCK|DENY|HOLD/i.test(c));
    let option: RecoverySimulationOption;
    const reasonCodes: string[] = ['DETERMINISTIC_FALLBACK'];
    if (evidenceMissing.length > 0) {
      option = 'COLLECT_MORE_EVIDENCE';
      reasonCodes.push('MISSING_REQUIRED_EVIDENCE');
    } else if (hasConflict || opportunity.approvalRequired || !opportunity.authorizationReady) {
      option = 'HUMAN_OR_BROKER_REVIEW';
      reasonCodes.push(
        hasConflict
          ? 'EVIDENCE_CONFLICT'
          : opportunity.approvalRequired
            ? 'APPROVAL_REQUIRED'
            : 'AUTHORIZATION_NOT_READY',
      );
    } else if (guardBlocksSubmit) {
      option = 'DEFER';
      reasonCodes.push('GUARD_OR_POLICY_BLOCKS_SUBMIT');
    } else {
      option = 'SUBMIT_NOW';
      reasonCodes.push('RULES_ALLOW_SUBMIT');
    }
    recommendation = { option, basis: 'DETERMINISTIC_FALLBACK', expectedNetValueUsd: null, reasonCodes };
  }

  const insufficientEvidence = options.every((option) => option.evidenceBasis !== 'EXPERIENCE');
  const outcomesUnknown = options.every((option) => option.expectedRecoveryUsd === null);

  const body = {
    version: RECOVERY_SIMULATOR_VERSION,
    organizationId: opportunity.organizationId,
    platformAccountId: opportunity.platformAccountId,
    provider: opportunity.provider,
    domain: opportunity.domain,
    ruleVersion: opportunity.ruleVersion,
    options,
    recommendation,
    insufficientEvidence,
    outcomesUnknown,
    externalActionPerformed: false as const,
    simulationOnly: true as const,
    worldModelComplete: false as const,
    llmDecided: false as const,
    writesFacts: false as const,
    decidedAt: input.now.toISOString(),
  };

  return {
    kind: 'RECOVERY_SIMULATION',
    ...body,
    simulationDigest: digestOf(body),
  };
}

export const RECOVERY_SIMULATION_BOUNDARY = {
  simulationOnly: true,
  externalActionPerformed: false,
  writesFacts: false,
  worldModelComplete: false,
  llmDecided: false,
  inventsProbabilities: false,
  inventsCosts: false,
  inventsRecoveryAmounts: false,
  fallbackWhenExperienceInsufficient: 'DETERMINISTIC_RULE_OR_POLICY',
  forbidden: [
    'performing any external action from a simulation',
    'inventing success probability / cost / expected recovery without evidence',
    'treating the simulation as a complete world model',
    'letting an LLM decide the recommendation',
    'writing simulated numbers as facts',
  ],
} as const;

/** 边界断言：任何声称已执行 / 已写事实 / 由 LLM 决策 / 数值无依据的记录都必须被拒绝 */
export function assertSimulationIsNonExecuting(record: {
  externalActionPerformed?: boolean;
  writesFacts?: boolean;
  llmDecided?: boolean;
  worldModelComplete?: boolean;
}): void {
  if (
    record.externalActionPerformed === true ||
    record.writesFacts === true ||
    record.llmDecided === true ||
    record.worldModelComplete === true
  ) {
    throw new RecoverySimulationError(
      'RECOVERY_SIMULATION_CANNOT_EXECUTE',
      'Recovery Simulation 只做模拟与建议：不执行、不写事实、不由 LLM 决策，也不宣称 World Model 完整。',
    );
  }
}

/** 数值来源断言：任何缺依据的数值字段被填成具体数字时抛错 */
export function assertSimulationNumbersAreSourced(option: {
  evidenceBasis?: RecoveryOptionSimulation['evidenceBasis'];
  successProbability?: number | null;
  expectedRecoveryUsd?: number | null;
}): void {
  if (
    option.evidenceBasis !== 'EXPERIENCE' &&
    (option.successProbability !== null && option.successProbability !== undefined
      ? true
      : option.expectedRecoveryUsd !== null && option.expectedRecoveryUsd !== undefined)
  ) {
    throw new RecoverySimulationError(
      'RECOVERY_SIMULATION_CANNOT_INVENT_NUMBERS',
      '没有 Experience 依据时不得给出成功概率或期望回款金额。',
    );
  }
}
