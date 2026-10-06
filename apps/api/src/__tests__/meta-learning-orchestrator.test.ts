// SI/RSI GAP-CLOSURE — 单元 D — Meta Learning / Controlled Improvement v1 回归
// ---------------------------------------------------------------------------
// 覆盖：12 段端到端闸门（缺段/乱序/失败）、verifiable reward 强制、Experience 不足阻断、
// Builder/Judge 分离、Guard 拒绝、SANDBOX-only 采用 + 回滚计划前置、观测回归 → 回滚要求、
// 禁止能力（改 Policy Core / 第二 Guard / 绕 Action Catalog / 关 Kill Switch / 扩权 / 开 Payment·Customs /
// 取生产凭据 / 自动生产推广回滚）一律 fail-closed、确定性摘要。

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_META_CAPABILITIES,
  META_LEARNING_BOUNDARY,
  META_LEARNING_STAGES,
  META_LEARNING_VERSION,
  MetaLearningError,
  assertMetaLearningIsControlled,
  assertNoForbiddenCapabilities,
  assertSandboxOnlyAdoption,
  evaluateMetaLearning,
  type MetaLearningInput,
  type MetaLearningStageEvidence,
} from '../services/meta-learning/meta-learning-orchestrator';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const DIGEST_A = 'a'.repeat(64);
const SCOPE = { organizationId: 'org-ml-1', platformAccountId: 'acct-ml-a' };

function stages(overrides: Partial<Record<(typeof META_LEARNING_STAGES)[number], 'PASSED' | 'FAILED' | 'SKIPPED'>> = {}) {
  return META_LEARNING_STAGES.map(
    (stage) =>
      ({
        stage,
        ref: 'ref:' + stage.toLowerCase(),
        digest: DIGEST_A,
        status: overrides[stage] ?? 'PASSED',
      }) satisfies MetaLearningStageEvidence,
  );
}

function input(overrides: Partial<MetaLearningInput> = {}): MetaLearningInput {
  return {
    scope: SCOPE,
    stages: stages(),
    experience: { experienceDigest: DIGEST_A, sourceCount: 12, decisionSupport: 'ADVISORY' },
    builderRef: 'builder-1',
    judgeRef: 'judge-1',
    guardAllowed: true,
    guardDecisionRef: 'guard:1',
    reward: {
      kpiKey: 'recovery_success_rate',
      baselineValue: 0.6,
      candidateValue: 0.66,
      sampleCount: 200,
      minDeltaBp: 300,
      evidenceRef: 'offline-eval:1',
    },
    adoption: { scope: 'SANDBOX', adoptionRef: 'sandbox:1', rollbackPlanRef: 'rollback:1' },
    observation: null,
    now: NOW,
    ...overrides,
  };
}

describe('D Meta Learning v1 — 端到端闸门', () => {
  it('全链齐备 + verifiable reward + 独立 Judge + Guard 允许 → SANDBOX_ADOPTION_APPROVED（尚未 integrated）', () => {
    const result = evaluateMetaLearning(input());
    expect(result.kind).toBe('META_LEARNING_RESULT');
    expect(result.version).toBe(META_LEARNING_VERSION);
    expect(result.disposition).toBe('SANDBOX_ADOPTION_APPROVED');
    expect(result.metaImprovementIntegrated).toBe(false); // 尚未完成观测
    expect(result.stagesPresent).toEqual([...META_LEARNING_STAGES]);
    expect(result.stagesMissing).toEqual([]);
    expect(result.reward.verifiable).toBe(true);
    expect(result.reward.deltaBp).toBe(1_000);
    expect(result.judgeSeparated).toBe(true);
    expect(result.adoptionPerformed).toBe(false);
    expect(result.externalWritePerformed).toBe(false);
    expect(result.productionAdoptionAllowed).toBe(false);
    expect(() => assertMetaLearningIsControlled(result)).not.toThrow();
  });

  it('观测窗口稳定 → OBSERVED_STABLE 且 metaImprovementIntegrated=true', () => {
    const result = evaluateMetaLearning(
      input({ observation: { windowDays: 14, sampleCount: 300, regressionDetected: false, rollbackExecuted: false, observationRef: 'obs:1' } }),
    );
    expect(result.disposition).toBe('OBSERVED_STABLE');
    expect(result.metaImprovementIntegrated).toBe(true);
    expect(result.rollbackRequired).toBe(false);
    expect(result.reasonCodes).toContain('OBSERVATION_WINDOW_STABLE');
    expect(() => assertMetaLearningIsControlled(result)).not.toThrow();
  });

  it('缺段 → BLOCKED_MISSING_STAGE（不得跳过 Replay/Benchmark/Security/Policy 任一段）', () => {
    const incomplete = stages().filter((stage) => stage.stage !== 'SECURITY_EVALUATION');
    const result = evaluateMetaLearning(input({ stages: incomplete }));
    expect(result.disposition).toBe('BLOCKED_MISSING_STAGE');
    expect(result.stagesMissing).toEqual(['SECURITY_EVALUATION']);
    expect(result.metaImprovementIntegrated).toBe(false);
  });

  it('乱序 → BLOCKED_OUT_OF_ORDER（顺序不可协商）', () => {
    const ordered = stages();
    const shuffled = [ordered[1], ordered[0], ...ordered.slice(2)];
    const result = evaluateMetaLearning(input({ stages: shuffled }));
    expect(result.disposition).toBe('BLOCKED_OUT_OF_ORDER');
    expect(result.outOfOrder).toBe(true);
  });

  it('digest 非法 → BLOCKED_MISSING_STAGE（证据必须可绑定）', () => {
    const bad = stages().map((stage, index) => (index === 4 ? { ...stage, digest: 'not-a-digest' } : stage));
    const result = evaluateMetaLearning(input({ stages: bad }));
    expect(result.disposition).toBe('BLOCKED_MISSING_STAGE');
    expect(result.reasonCodes).toContain('INVALID_STAGE_DIGEST');
  });

  it('某段 FAILED → BLOCKED_BY_EVALUATION', () => {
    const result = evaluateMetaLearning(input({ stages: stages({ BENCHMARK: 'FAILED' }) }));
    expect(result.disposition).toBe('BLOCKED_BY_EVALUATION');
    expect(result.reasonCodes).toContain('STAGE_NOT_PASSED:BENCHMARK');
  });
});

describe('D — verifiable reward / Experience / Judge / Guard 强制', () => {
  it('没有 reward 证据 → BLOCKED_BY_REWARD（无 verifiable reward 不得 promote）', () => {
    const result = evaluateMetaLearning(input({ reward: null }));
    expect(result.disposition).toBe('BLOCKED_BY_REWARD');
    expect(result.reasonCodes).toContain('NO_REWARD_EVIDENCE');
    expect(result.metaImprovementIntegrated).toBe(false);
  });

  it('提升低于阈值 / 样本为 0 → BLOCKED_BY_REWARD（不可验证）', () => {
    const tooSmall = evaluateMetaLearning(
      input({
        reward: { kpiKey: 'k', baselineValue: 0.6, candidateValue: 0.601, sampleCount: 100, minDeltaBp: 300, evidenceRef: 'e' },
      }),
    );
    expect(tooSmall.disposition).toBe('BLOCKED_BY_REWARD');
    expect(tooSmall.reward.deltaBp).toBe(17);

    const zeroSample = evaluateMetaLearning(
      input({
        reward: { kpiKey: 'k', baselineValue: 0.6, candidateValue: 0.9, sampleCount: 0, minDeltaBp: 300, evidenceRef: 'e' },
      }),
    );
    expect(zeroSample.disposition).toBe('BLOCKED_BY_REWARD');
    expect(zeroSample.reward.verifiable).toBe(false);
  });

  it('Experience 不足（FAIL_CLOSED / NO_AUTOMATIC_LEARNING / IGNORED）→ BLOCKED_BY_EXPERIENCE', () => {
    for (const decisionSupport of ['FAIL_CLOSED', 'NO_AUTOMATIC_LEARNING', 'IGNORED'] as const) {
      const result = evaluateMetaLearning(
        input({ experience: { experienceDigest: DIGEST_A, sourceCount: 0, decisionSupport } }),
      );
      expect(result.disposition).toBe('BLOCKED_BY_EXPERIENCE');
      expect(result.reasonCodes).toContain('EXPERIENCE_' + decisionSupport);
    }
  });

  it('Builder 与 Judge 同一 actor → BLOCKED_BY_JUDGE', () => {
    const result = evaluateMetaLearning(input({ judgeRef: 'builder-1' }));
    expect(result.disposition).toBe('BLOCKED_BY_JUDGE');
    expect(result.judgeSeparated).toBe(false);
    expect(result.reasonCodes).toContain('BUILDER_JUDGE_SAME_ACTOR');
  });

  it('Guard 拒绝 → BLOCKED_BY_GUARD', () => {
    const result = evaluateMetaLearning(input({ guardAllowed: false }));
    expect(result.disposition).toBe('BLOCKED_BY_GUARD');
    expect(result.reasonCodes).toContain('GUARD_DENIED');
  });
});

describe('D — SANDBOX-only 采用、回滚前置与观测回归', () => {
  it('采用范围必须是 SANDBOX；PRODUCTION / GLOBAL 一律 BLOCKED_BY_SCOPE', () => {
    for (const scope of ['PRODUCTION', 'GLOBAL', 'CANARY']) {
      const result = evaluateMetaLearning(
        input({ adoption: { scope, adoptionRef: 'a:1', rollbackPlanRef: 'rollback:1' } }),
      );
      expect(result.disposition).toBe('BLOCKED_BY_SCOPE');
      expect(result.reasonCodes).toContain('ADOPTION_SCOPE_NOT_SANDBOX');
    }
  });

  it('采用前必须齐备回滚计划', () => {
    const result = evaluateMetaLearning(
      input({ adoption: { scope: 'SANDBOX', adoptionRef: 'a:1', rollbackPlanRef: '' } }),
    );
    expect(result.disposition).toBe('BLOCKED_BY_SCOPE');
    expect(result.reasonCodes).toContain('ROLLBACK_PLAN_REQUIRED_BEFORE_ADOPTION');
  });

  it('观测发现回归 → REGRESSION_DETECTED_ROLLBACK_REQUIRED（integrated=false）', () => {
    const result = evaluateMetaLearning(
      input({ observation: { windowDays: 7, sampleCount: 150, regressionDetected: true, rollbackExecuted: false, observationRef: 'obs:2' } }),
    );
    expect(result.disposition).toBe('REGRESSION_DETECTED_ROLLBACK_REQUIRED');
    expect(result.rollbackRequired).toBe(true);
    expect(result.rollbackExecuted).toBe(false);
    expect(result.metaImprovementIntegrated).toBe(false);
  });

  it('回归已回滚 → ROLLED_BACK（integrated=false）', () => {
    const result = evaluateMetaLearning(
      input({ observation: { windowDays: 7, sampleCount: 150, regressionDetected: true, rollbackExecuted: true, observationRef: 'obs:3' } }),
    );
    expect(result.disposition).toBe('ROLLED_BACK');
    expect(result.rollbackExecuted).toBe(true);
    expect(result.rollbackRequired).toBe(false);
    expect(result.metaImprovementIntegrated).toBe(false);
  });

  it('assertSandboxOnlyAdoption 只放行 SANDBOX', () => {
    expect(() => assertSandboxOnlyAdoption('SANDBOX')).not.toThrow();
    expect(() => assertSandboxOnlyAdoption('PRODUCTION')).toThrowError(MetaLearningError);
  });
});

describe('D — 禁止能力与边界', () => {
  it('请求任何禁止能力（改 Policy Core / 第二 Guard / 绕 Action Catalog / 关 Kill Switch / 扩权 / 开 Payment·Customs / 取凭据 / 自动生产推广回滚）→ 立即抛错', () => {
    for (const capability of FORBIDDEN_META_CAPABILITIES) {
      expect(() => assertNoForbiddenCapabilities([capability])).toThrowError(MetaLearningError);
      expect(() => evaluateMetaLearning(input({ requestedCapabilities: [capability] }))).toThrowError(
        MetaLearningError,
      );
    }
    expect(() => assertNoForbiddenCapabilities(['recommendation_ranking'])).not.toThrow();
  });

  it('边界常量：只编排、不执行、SANDBOX-only、必须有 verifiable reward 与独立 Judge、生产推广/回滚=false', () => {
    expect(META_LEARNING_BOUNDARY.orchestratesOnly).toBe(true);
    expect(META_LEARNING_BOUNDARY.executesAdoption).toBe(false);
    expect(META_LEARNING_BOUNDARY.externalWritePerformed).toBe(false);
    expect(META_LEARNING_BOUNDARY.productionAdoptionAllowed).toBe(false);
    expect(META_LEARNING_BOUNDARY.autoProductionPromotion).toBe(false);
    expect(META_LEARNING_BOUNDARY.autoProductionRollout).toBe(false);
    expect(META_LEARNING_BOUNDARY.autoProductionRollback).toBe(false);
    expect(META_LEARNING_BOUNDARY.requiresVerifiableReward).toBe(true);
    expect(META_LEARNING_BOUNDARY.requiresIndependentJudge).toBe(true);
    expect(META_LEARNING_BOUNDARY.requiresSandboxScope).toBe(true);
    expect(META_LEARNING_BOUNDARY.requiresRollbackPlanBeforeAdoption).toBe(true);
    expect(META_LEARNING_BOUNDARY.policyCoreMutationAllowed).toBe(false);
    expect(META_LEARNING_BOUNDARY.secondGuardAllowed).toBe(false);
    expect(META_LEARNING_BOUNDARY.forbidden.length).toBeGreaterThanOrEqual(7);
    expect(META_LEARNING_STAGES).toHaveLength(12);
  });

  it('assertMetaLearningIsControlled：伪造 integrated（无 verifiable reward / 非 OBSERVED_STABLE）被拒绝', () => {
    expect(() =>
      assertMetaLearningIsControlled({ metaImprovementIntegrated: true, reward: { verifiable: false }, disposition: 'OBSERVED_STABLE' }),
    ).toThrowError(MetaLearningError);
    expect(() =>
      assertMetaLearningIsControlled({ metaImprovementIntegrated: true, reward: { verifiable: true }, disposition: 'SANDBOX_ADOPTION_APPROVED' }),
    ).toThrowError(MetaLearningError);
    expect(() => assertMetaLearningIsControlled({ productionAdoptionAllowed: true as never })).toThrowError(
      MetaLearningError,
    );
  });

  it('确定性：同输入同 now → 同 decisionDigest；reward 变化 → 摘要变', () => {
    const a = evaluateMetaLearning(input());
    const b = evaluateMetaLearning(input());
    const c = evaluateMetaLearning(
      input({
        reward: { kpiKey: 'k', baselineValue: 0.6, candidateValue: 0.75, sampleCount: 200, minDeltaBp: 300, evidenceRef: 'e' },
      }),
    );
    expect(a.decisionDigest).toBe(b.decisionDigest);
    expect(a.decisionDigest).not.toBe(c.decisionDigest);
    expect(a.decisionDigest).toHaveLength(64);
    expect(a.decidedAt).toBe(NOW.toISOString());
  });
});
