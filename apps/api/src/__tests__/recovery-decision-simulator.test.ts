// SI/RSI GAP-CLOSURE — 单元 E — Recovery Decision Simulator v1 回归
// ---------------------------------------------------------------------------
// 覆盖：≥2–4 方案对比与期望净值择优、Experience 不足 → 确定性 Rule/Policy 回退（无数值）、
// 无依据不得编造概率/金额/成本、SUBMIT_NOW 规则门、冲突/审批/授权 → 人工或报关行、守卫/政策阻断 → DEFER、
// 模拟不执行不写事实不由 LLM 决策、确定性摘要。

import { describe, expect, it } from 'vitest';

import {
  RECOVERY_SIMULATION_BOUNDARY,
  RECOVERY_SIMULATION_OPTIONS,
  RECOVERY_SIMULATOR_VERSION,
  RecoverySimulationError,
  assertSimulationIsNonExecuting,
  assertSimulationNumbersAreSourced,
  simulateRecoveryDecision,
  type RecoverySimulationInput,
  type RecoverySimulationOption,
} from '../services/recovery-simulation/recovery-decision-simulator';
import type { ExperienceAggregate } from '../services/experience-memory/experience-memory';

const NOW = new Date('2026-10-06T11:00:00.000Z');

function aggregate(overrides: Partial<ExperienceAggregate> = {}): ExperienceAggregate {
  return {
    kind: 'EXPERIENCE_AGGREGATE',
    experienceClass: 'AGGREGATE',
    scope: { organizationId: 'org-sim-1', platformAccountId: 'acct-sim-a', provider: 'AMAZON', domain: 'PLATFORM' },
    query: { scope: { organizationId: 'org-sim-1' } },
    sourceCount: 40,
    successCount: 28,
    successRateBp: 7_000,
    averageCycleTimeDays: 18,
    averageCostUsd: 12,
    averageRecoveredAmountUsd: 1_200,
    confidenceBp: 8_000,
    window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    sourceRefs: ['exp:1', 'exp:2'],
    decisionSupport: 'ADVISORY',
    requiresHumanReview: false,
    allowedUses: ['recommendation', 'ranking', 'confidence', 'planning'],
    externalWriteGranted: false,
    reasonCodes: ['SUFFICIENT_SAMPLE'],
    computedAt: NOW.toISOString(),
    aggregateDigest: 'b'.repeat(64),
    ...overrides,
  } as ExperienceAggregate;
}

function input(overrides: Partial<RecoverySimulationInput> = {}): RecoverySimulationInput {
  return {
    opportunity: {
      organizationId: 'org-sim-1',
      platformAccountId: 'acct-sim-a',
      provider: 'AMAZON',
      domain: 'PLATFORM',
      amountUsd: 18_400,
      currency: 'USD',
      ruleVersion: 'rules/platform/v1',
      eligibilityConfidenceBp: 7_500,
      evidence: { completeness: 'PARTIAL', conflicts: [], requiredMissing: ['POD'] },
      approvalRequired: false,
      authorizationReady: true,
    },
    experienceByOption: null,
    costInputs: { providerCostUsd: 0, brokerCostUsd: 900, humanReviewCostUsd: 0, timeToRecoveryDays: { SUBMIT_NOW: 18 } },
    policyConstraints: [],
    guardConstraints: [],
    now: NOW,
    ...overrides,
  };
}

function optionOf(
  result: ReturnType<typeof simulateRecoveryDecision>,
  option: RecoverySimulationOption,
) {
  const found = result.options.find((entry) => entry.option === option);
  if (!found) throw new Error('缺少方案：' + option);
  return found;
}

describe('E Recovery Decision Simulator — 方案对比与择优', () => {
  it('HOST 示例场景：18,400 USD 时推荐 COLLECT_MORE_EVIDENCE（按期望净值，而非纯成功率）', () => {
    const result = simulateRecoveryDecision(
      input({
        experienceByOption: {
          // A：68% × 18,400 ≈ 12,500；B：87.5% ≈ 16,100；C：91.3% ≈ 16,800 − 900 broker cost
          SUBMIT_NOW: aggregate({ successRateBp: 6_793, confidenceBp: 7_500, sourceRefs: ['exp:A'] }),
          COLLECT_MORE_EVIDENCE: aggregate({ successRateBp: 8_750, confidenceBp: 8_200, sourceRefs: ['exp:B'] }),
          HUMAN_OR_BROKER_REVIEW: aggregate({ successRateBp: 9_130, confidenceBp: 8_600, sourceRefs: ['exp:C'] }),
        },
      }),
    );
    expect(result.kind).toBe('RECOVERY_SIMULATION');
    expect(result.version).toBe(RECOVERY_SIMULATOR_VERSION);
    expect(result.recommendation.option).toBe('COLLECT_MORE_EVIDENCE');
    expect(result.recommendation.basis).toBe('EXPERIENCE');
    expect(result.recommendation.expectedNetValueUsd).toBe(16_100);
    expect(result.insufficientEvidence).toBe(false);
    expect(result.outcomesUnknown).toBe(false);
    expect(result.externalActionPerformed).toBe(false);
    expect(result.simulationOnly).toBe(true);
    expect(result.worldModelComplete).toBe(false);
    expect(result.llmDecided).toBe(false);

    const submit = optionOf(result, 'SUBMIT_NOW');
    expect(submit.successProbability).toBeCloseTo(0.68, 2);
    expect(submit.expectedRecoveryUsd).toBe(12_499.12);
    expect(submit.expectedTimeDays).toBe(18);
    const collect = optionOf(result, 'COLLECT_MORE_EVIDENCE');
    expect(collect.expectedRecoveryUsd).toBe(16_100);
    expect(collect.sourceExperienceRefs).toEqual(['exp:B']);
    const human = optionOf(result, 'HUMAN_OR_BROKER_REVIEW');
    expect(human.expectedCostUsd).toBe(900);
    // 9,130bp × 18,400 = 16,799.20；减去 broker 成本 900 → 净值 15,899.20
    expect(human.expectedNetValueUsd).toBe(15_899.2);
  });

  it('四个方案都可评估；每个方案都携带 policy/guard 约束与所需证据', () => {
    const result = simulateRecoveryDecision(
      input({ policyConstraints: ['POLICY:NO_AUTO_FILING'], guardConstraints: ['GUARD:REQUIRE_APPROVAL'] }),
    );
    expect(result.options.map((option) => option.option)).toEqual([...RECOVERY_SIMULATION_OPTIONS]);
    for (const option of result.options) {
      expect(option.policyConstraints).toEqual(['POLICY:NO_AUTO_FILING']);
      expect(option.guardConstraints).toEqual(['GUARD:REQUIRE_APPROVAL']);
      expect(Array.isArray(option.requiredEvidence)).toBe(true);
    }
    expect(optionOf(result, 'COLLECT_MORE_EVIDENCE').requiredEvidence).toEqual(['POD']);
  });

  it('净值择优：成本可抵消高成功率（C 成功率更高但仍输给 B）', () => {
    const result = simulateRecoveryDecision(
      input({
        experienceByOption: {
          SUBMIT_NOW: aggregate({ successRateBp: 6_793 }),
          COLLECT_MORE_EVIDENCE: aggregate({ successRateBp: 8_750 }),
          HUMAN_OR_BROKER_REVIEW: aggregate({ successRateBp: 9_130 }),
        },
      }),
    );
    const human = optionOf(result, 'HUMAN_OR_BROKER_REVIEW');
    expect(human.successProbability).toBeGreaterThan(optionOf(result, 'COLLECT_MORE_EVIDENCE').successProbability!);
    expect(human.expectedNetValueUsd).toBeLessThan(optionOf(result, 'COLLECT_MORE_EVIDENCE').expectedNetValueUsd!);
  });

  it('DOWNWEIGHTED 经验仍可用，但 downsideRisk 提升为 MEDIUM', () => {
    const result = simulateRecoveryDecision(
      input({
        experienceByOption: { SUBMIT_NOW: aggregate({ decisionSupport: 'DOWNWEIGHTED', confidenceBp: 5_000 }) },
        opportunity: { ...input().opportunity, evidence: { completeness: 'COMPLETE', conflicts: [], requiredMissing: [] } },
      }),
    );
    expect(optionOf(result, 'SUBMIT_NOW').evidenceBasis).toBe('EXPERIENCE');
    expect(optionOf(result, 'SUBMIT_NOW').downsideRisk).toBe('MEDIUM');
  });
});

describe('E — Experience 不足 → 确定性 Rule/Policy 回退（绝不编造数字）', () => {
  it('无经验 + 缺证据 → COLLECT_MORE_EVIDENCE，全部数值为 null 且标 insufficientEvidence/outcomesUnknown', () => {
    const result = simulateRecoveryDecision(input({ experienceByOption: null }));
    expect(result.recommendation).toMatchObject({
      option: 'COLLECT_MORE_EVIDENCE',
      basis: 'DETERMINISTIC_FALLBACK',
      expectedNetValueUsd: null,
    });
    expect(result.recommendation.reasonCodes).toContain('MISSING_REQUIRED_EVIDENCE');
    expect(result.insufficientEvidence).toBe(true);
    expect(result.outcomesUnknown).toBe(true);
    for (const option of result.options) {
      expect(option.successProbability).toBeNull();
      expect(option.expectedRecoveryUsd).toBeNull();
      expect(option.calibratedConfidenceBp).toBeNull();
      expect(option.downsideRisk).toBe('UNKNOWN');
    }
  });

  it('无经验 + 证据齐备且授权就绪 → SUBMIT_NOW（确定性规则允许）', () => {
    const result = simulateRecoveryDecision(
      input({
        experienceByOption: null,
        opportunity: { ...input().opportunity, evidence: { completeness: 'COMPLETE', conflicts: [], requiredMissing: [] } },
      }),
    );
    expect(result.recommendation.option).toBe('SUBMIT_NOW');
    expect(result.recommendation.reasonCodes).toContain('RULES_ALLOW_SUBMIT');
    expect(result.recommendation.expectedNetValueUsd).toBeNull();
  });

  it('无经验 + 证据冲突 → HUMAN_OR_BROKER_REVIEW', () => {
    const result = simulateRecoveryDecision(
      input({
        experienceByOption: null,
        opportunity: {
          ...input().opportunity,
          evidence: { completeness: 'PARTIAL', conflicts: ['ENTRY_NUMBER'], requiredMissing: [] },
        },
      }),
    );
    expect(result.recommendation.option).toBe('HUMAN_OR_BROKER_REVIEW');
    expect(result.recommendation.reasonCodes).toContain('EVIDENCE_CONFLICT');
  });

  it('需要审批 / 授权未就绪 → HUMAN_OR_BROKER_REVIEW', () => {
    const needsApproval = simulateRecoveryDecision(
      input({
        experienceByOption: null,
        opportunity: {
          ...input().opportunity,
          approvalRequired: true,
          evidence: { completeness: 'COMPLETE', conflicts: [], requiredMissing: [] },
        },
      }),
    );
    expect(needsApproval.recommendation.option).toBe('HUMAN_OR_BROKER_REVIEW');
    expect(needsApproval.recommendation.reasonCodes).toContain('APPROVAL_REQUIRED');

    const notAuthorized = simulateRecoveryDecision(
      input({
        experienceByOption: null,
        opportunity: {
          ...input().opportunity,
          authorizationReady: false,
          evidence: { completeness: 'COMPLETE', conflicts: [], requiredMissing: [] },
        },
      }),
    );
    expect(notAuthorized.recommendation.option).toBe('HUMAN_OR_BROKER_REVIEW');
    expect(notAuthorized.recommendation.reasonCodes).toContain('AUTHORIZATION_NOT_READY');
  });

  it('守卫或政策阻断 → DEFER', () => {
    const result = simulateRecoveryDecision(
      input({
        experienceByOption: null,
        guardConstraints: ['GUARD:KILL_SWITCH_ACTIVE'],
        opportunity: { ...input().opportunity, evidence: { completeness: 'COMPLETE', conflicts: [], requiredMissing: [] } },
      }),
    );
    expect(result.recommendation.option).toBe('DEFER');
    expect(result.recommendation.reasonCodes).toContain('GUARD_OR_POLICY_BLOCKS_SUBMIT');
  });

  it('CONFLICT 经验（NO_AUTOMATIC_LEARNING）不可用 → 回退确定性', () => {
    const result = simulateRecoveryDecision(
      input({
        experienceByOption: {
          SUBMIT_NOW: aggregate({ decisionSupport: 'NO_AUTOMATIC_LEARNING', successRateBp: 5_000, confidenceBp: 2_000 }),
        },
        opportunity: { ...input().opportunity, evidence: { completeness: 'COMPLETE', conflicts: [], requiredMissing: [] } },
      }),
    );
    expect(optionOf(result, 'SUBMIT_NOW').evidenceBasis).toBe('INSUFFICIENT');
    expect(optionOf(result, 'SUBMIT_NOW').successProbability).toBeNull();
    expect(result.recommendation.basis).toBe('DETERMINISTIC_FALLBACK');
  });

  it('金额未知 → 期望回款与净值保持 null（不猜金额）', () => {
    const result = simulateRecoveryDecision(
      input({
        experienceByOption: { SUBMIT_NOW: aggregate() },
        opportunity: { ...input().opportunity, amountUsd: null },
      }),
    );
    expect(optionOf(result, 'SUBMIT_NOW').expectedRecoveryUsd).toBeNull();
    expect(optionOf(result, 'SUBMIT_NOW').expectedNetValueUsd).toBeNull();
    expect(result.outcomesUnknown).toBe(true);
    expect(result.recommendation.basis).toBe('DETERMINISTIC_FALLBACK');
  });

  it('成本未知 → 净值 null，不参与经验择优', () => {
    const result = simulateRecoveryDecision(
      input({
        experienceByOption: { SUBMIT_NOW: aggregate() },
        costInputs: null,
        opportunity: { ...input().opportunity, evidence: { completeness: 'COMPLETE', conflicts: [], requiredMissing: [] } },
      }),
    );
    expect(optionOf(result, 'SUBMIT_NOW').expectedRecoveryUsd).not.toBeNull();
    expect(optionOf(result, 'SUBMIT_NOW').expectedNetValueUsd).toBeNull();
    expect(result.recommendation.basis).toBe('DETERMINISTIC_FALLBACK');
  });

  it('SUBMIT_NOW 在缺证据/冲突/未授权时标记为不可用', () => {
    const missing = simulateRecoveryDecision(input({ experienceByOption: null }));
    expect(optionOf(missing, 'SUBMIT_NOW').available).toBe(false);
    expect(optionOf(missing, 'SUBMIT_NOW').reasonCodes).toContain('SUBMIT_NOW_NOT_ALLOWED_BY_RULES');
  });
});

describe('E — 边界与确定性', () => {
  it('模拟不执行、不写事实、不由 LLM 决策、不宣称 World Model 完整', () => {
    const result = simulateRecoveryDecision(input());
    expect(result.externalActionPerformed).toBe(false);
    expect(result.simulationOnly).toBe(true);
    expect(result.worldModelComplete).toBe(false);
    expect(result.llmDecided).toBe(false);
    expect(result.writesFacts).toBe(false);
    expect(() => assertSimulationIsNonExecuting(result)).not.toThrow();
    expect(() => assertSimulationIsNonExecuting({ externalActionPerformed: true as never })).toThrowError(
      RecoverySimulationError,
    );
    expect(() => assertSimulationIsNonExecuting({ writesFacts: true as never })).toThrowError(RecoverySimulationError);
    expect(() => assertSimulationIsNonExecuting({ llmDecided: true as never })).toThrowError(RecoverySimulationError);
    expect(() => assertSimulationIsNonExecuting({ worldModelComplete: true as never })).toThrowError(
      RecoverySimulationError,
    );
  });

  it('数值来源断言：无经验依据时给出概率或金额一律抛错', () => {
    expect(() =>
      assertSimulationNumbersAreSourced({ evidenceBasis: 'INSUFFICIENT', successProbability: 0.7 }),
    ).toThrowError(RecoverySimulationError);
    expect(() =>
      assertSimulationNumbersAreSourced({ evidenceBasis: 'INSUFFICIENT', expectedRecoveryUsd: 12_000 }),
    ).toThrowError(RecoverySimulationError);
    expect(() =>
      assertSimulationNumbersAreSourced({ evidenceBasis: 'EXPERIENCE', successProbability: 0.7 }),
    ).not.toThrow();
    expect(() => assertSimulationNumbersAreSourced({ evidenceBasis: 'INSUFFICIENT' })).not.toThrow();
  });

  it('边界常量：模拟专用 / 不执行 / 不写 / 非 World Model / 无 LLM 决策 / 不编造数值', () => {
    expect(RECOVERY_SIMULATION_BOUNDARY.simulationOnly).toBe(true);
    expect(RECOVERY_SIMULATION_BOUNDARY.externalActionPerformed).toBe(false);
    expect(RECOVERY_SIMULATION_BOUNDARY.writesFacts).toBe(false);
    expect(RECOVERY_SIMULATION_BOUNDARY.worldModelComplete).toBe(false);
    expect(RECOVERY_SIMULATION_BOUNDARY.llmDecided).toBe(false);
    expect(RECOVERY_SIMULATION_BOUNDARY.inventsProbabilities).toBe(false);
    expect(RECOVERY_SIMULATION_BOUNDARY.inventsCosts).toBe(false);
    expect(RECOVERY_SIMULATION_BOUNDARY.inventsRecoveryAmounts).toBe(false);
    expect(RECOVERY_SIMULATION_BOUNDARY.fallbackWhenExperienceInsufficient).toBe('DETERMINISTIC_RULE_OR_POLICY');
    expect(RECOVERY_SIMULATION_BOUNDARY.forbidden).toContain(
      'inventing success probability / cost / expected recovery without evidence',
    );
  });

  it('确定性：同输入同 now → 同 simulationDigest；经验变化 → 摘要变', () => {
    const a = simulateRecoveryDecision(input());
    const b = simulateRecoveryDecision(input());
    const c = simulateRecoveryDecision(
      input({ experienceByOption: { SUBMIT_NOW: aggregate({ successRateBp: 9_000 }) } }),
    );
    expect(a.simulationDigest).toBe(b.simulationDigest);
    expect(a.simulationDigest).not.toBe(c.simulationDigest);
    expect(a.simulationDigest).toHaveLength(64);
    expect(a.decidedAt).toBe(NOW.toISOString());
  });
});
