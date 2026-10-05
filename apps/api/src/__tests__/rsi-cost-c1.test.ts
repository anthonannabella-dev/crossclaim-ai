/**
 * SI-COST-OPTIMIZATION C1 —— 验收（MSG-20261005-30：C1 IMPLEMENTATION = AUTHORIZED）
 * 覆盖：AI Necessity Gate / Cache Identity Contract / Cheap→Strong 有界升级合同 + Model Gateway 单咽喉。
 */

import { describe, expect, it } from 'vitest';

import {
  AI_NECESSITY_BOUNDARY,
  evaluateAiNecessity,
  validateAiDeterministicEvidence,
  type AiDeterministicEvidence,
} from '../services/autonomy/rsi-ai-necessity-gate';
import {
  AI_CACHE_BOUNDARY,
  AI_CACHE_IDENTITY_FIELDS,
  buildAiCacheKey,
  evaluateAiCacheLookup,
  type AiCacheIdentity,
} from '../services/autonomy/rsi-model-cache-identity';
import {
  AI_ESCALATION_BOUNDARY,
  AI_ESCALATION_HARD_CAPS,
  AI_ESCALATION_DEFAULTS,
  assertJudgeCannotAuthorizeModelCall,
  clampAiEscalationLimits,
  decideAiEscalation,
} from '../services/autonomy/rsi-model-escalation-policy';
import {
  createRsiModelRouter,
  type RsiModelInvocationRequest,
  type RsiModelProviderAdapter,
} from '../services/autonomy/rsi-model-router';
import type { RsiCostUsage, RsiModelCallRequest } from '../services/autonomy/rsi-cost-policy';

const evidence = (outcome: AiDeterministicEvidence['outcome'], over: Partial<AiDeterministicEvidence> = {}): AiDeterministicEvidence => ({
  outcome,
  ruleVersion: 'rule/v1',
  schemaVersion: 'schema/v1',
  inputDigest: 'a'.repeat(64),
  ...over,
});

const identity = (over: Partial<AiCacheIdentity> = {}): AiCacheIdentity => ({
  taskType: 'SEMANTIC',
  promptDigest: 'b'.repeat(64),
  inputDigest: 'c'.repeat(64),
  ruleVersion: 'rule/v1',
  schemaVersion: 'schema/v1',
  capabilityTier: 'LOW_COST',
  organizationId: 'org-1',
  ...over,
});

const usage = (over: Partial<RsiCostUsage> = {}): RsiCostUsage => ({
  spentToday: 0,
  spentThisMonth: 0,
  incidentSpent: 0,
  incidentAttempts: 0,
  incidentCandidates: 0,
  incidentLlmCalls: 0,
  incidentTokens: 0,
  incidentElapsedMinutes: 0,
  strongCallsForTask: 0,
  ...over,
});

const adapter = (
  tier: 'LOW_COST' | 'STRONG',
  succeeded: boolean,
  counter: { n: number },
): RsiModelProviderAdapter => ({
  providerName: tier === 'LOW_COST' ? 'provider-lowcost' : 'provider-strong',
  tier,
  pricing: { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000002, maxInputTokens: 1_000 },
  async invoke() {
    counter.n += 1;
    const base = { inputTokens: 100, outputTokens: 20, estimatedCost: tier === 'LOW_COST' ? 0.001 : 0.05 };
    return succeeded
      ? { ok: true as const, modelId: tier === 'LOW_COST' ? 'lowcost-model' : 'strong-model', outputRef: 'sim:x', outputDigest: 'd'.repeat(64), usage: base, latencyMs: 100 }
      : { ok: false as const, reason: 'PROVIDER_FAILED' as const, usage: base, latencyMs: 100 };
  },
});

const routerRequest = (
  taskType: string,
  capability: RsiModelCallRequest['requiredCapability'],
  necessity: AiDeterministicEvidence | null,
  escalation?: { quality: 'PASS' | 'FAIL' | 'LOW_CONFIDENCE'; state: { attempts: number; escalations: number } },
): RsiModelInvocationRequest => ({
  taskType,
  complexity: 'LOW',
  maxCost: 0.5,
  latencyRequirementMs: 5_000,
  requiredCapability: capability,
  incidentId: 'inc-c1',
  taskId: 'task-c1',
  promptRef: 'prompt:task-c1',
  promptDigest: 'c'.repeat(64),
  maxOutputTokens: 256,
  timeoutMs: 5_000,
  necessity,
  ...(escalation ? { escalation } : {}),
});

describe('C1 · AI Necessity Gate（deterministic-first，单一咽喉）', () => {
  it('C1_NECESSITY_RULE_SOLVABLE_FORBIDS_MODEL_CALL', () => {
    const r = evaluateAiNecessity({ taskType: 'CI_FAIL', requiredCapability: 'ROOT_CAUSE_ANALYSIS', evidence: evidence('RULE_SOLVABLE') });
    expect(r.decision).toBe('MODEL_CALL_FORBIDDEN');
    expect(r.reason).toBe('RULE_ENGINE');
    expect(r.permittedLevel).toBe('LEVEL_0_RULE');
    expect(r.callerCapabilityIgnored).toBe(true);
  });

  it('C1_NECESSITY_HIGH_CONFIDENCE_FORBIDS_MODEL_CALL', () => {
    const r = evaluateAiNecessity({ taskType: 'SEMANTIC', evidence: evidence('HIGH_CONFIDENCE', { confidence: 'HIGH' }) });
    expect(r.decision).toBe('MODEL_CALL_FORBIDDEN');
    expect(r.permittedLevel).toBe('LEVEL_0_RULE');
  });

  it('C1_NECESSITY_AMBIGUOUS_AND_SEMANTIC_ARE_LEVEL_1_ONLY', () => {
    for (const outcome of ['AMBIGUOUS', 'SEMANTIC_REQUIRED'] as const) {
      const r = evaluateAiNecessity({ taskType: 'SEMANTIC', evidence: evidence(outcome) });
      expect(r.decision).toBe('LEVEL_1_ELIGIBLE');
      expect(r.permittedLevel).toBe('LEVEL_1_LOW_COST');
    }
    expect(AI_NECESSITY_BOUNDARY.strongModelFromGate).toContain('NEVER');
  });

  it('C1_NECESSITY_UNKNOWN_AND_MISSING_EVIDENCE_FAIL_CLOSED', () => {
    expect(evaluateAiNecessity({ taskType: 'SEMANTIC', evidence: evidence('UNKNOWN') }).decision).toBe('FAIL_CLOSED');
    expect(evaluateAiNecessity({ taskType: 'SEMANTIC', evidence: null }).decision).toBe('FAIL_CLOSED');
    expect(evaluateAiNecessity({ taskType: 'SEMANTIC' }).decision).toBe('FAIL_CLOSED');
    expect(validateAiDeterministicEvidence(evidence('SEMANTIC_REQUIRED', { inputDigest: 'not-a-digest' })).ok).toBe(false);
    expect(validateAiDeterministicEvidence(evidence('SEMANTIC_REQUIRED', { ruleVersion: '  ' })).ok).toBe(false);
  });

  it('C1_NECESSITY_CALLER_DECLARED_CAPABILITY_GRANTS_NOTHING', () => {
    // 只声明能力（无证据）→ fail-closed，且边界冻结 callerDeclaredCapabilityGrantsModelCall = false
    const r = evaluateAiNecessity({ taskType: 'COMPLEX_FIX', requiredCapability: 'COMPLEX_CODE_FIX', evidence: null });
    expect(r.decision).toBe('FAIL_CLOSED');
    expect(AI_NECESSITY_BOUNDARY.callerDeclaredCapabilityGrantsModelCall).toBe(false);
    expect(AI_NECESSITY_BOUNDARY.singleChokePoint).toBe('rsi-model-router');
    expect(AI_NECESSITY_BOUNDARY.bypassAllowed).toBe(false);
  });
});

describe('C1 · Cache Identity Contract', () => {
  it('C1_CACHE_IDENTITY_BINDS_ALL_SAFETY_FIELDS', () => {
    expect([...AI_CACHE_IDENTITY_FIELDS]).toEqual([
      'taskType',
      'promptDigest',
      'inputDigest',
      'ruleVersion',
      'schemaVersion',
      'capabilityTier',
      'organizationId',
    ]);
    const key = buildAiCacheKey(identity());
    for (const field of AI_CACHE_IDENTITY_FIELDS) {
      expect(AI_CACHE_BOUNDARY.appendOnlyRequired).toBe(false);
      expect(key.length).toBeGreaterThan(0);
      expect(typeof field).toBe('string');
    }
    // 确定性：同身份 → 同 key；不同 ruleVersion → 不同 key
    expect(buildAiCacheKey(identity())).toBe(buildAiCacheKey(identity()));
    expect(buildAiCacheKey(identity({ ruleVersion: 'rule/v2' }))).not.toBe(buildAiCacheKey(identity()));
    // 残缺身份禁止构造 key（fail-closed）
    expect(() => buildAiCacheKey(identity({ inputDigest: 'bad' }))).toThrow(/AI_CACHE_IDENTITY_INVALID/);
  });

  it('C1_CACHE_HIT_ONLY_WHEN_IDENTICAL_AND_MISS_ON_EACH_MISMATCH', () => {
    const entry = { identity: identity(), createdAtMs: 1_000, ttlMs: 60_000, resultDigest: 'e'.repeat(64) };
    expect(evaluateAiCacheLookup({ requested: identity(), entry, nowMs: 2_000 })).toEqual({
      hit: true,
      reason: 'HIT',
      resultDigest: 'e'.repeat(64),
    });
    const missCases: Array<[Partial<AiCacheIdentity>, string]> = [
      [{ taskType: 'OTHER' }, 'MISS_TASK_TYPE'],
      [{ promptDigest: 'f'.repeat(64) }, 'MISS_PROMPT_DIGEST'],
      [{ inputDigest: 'f'.repeat(64) }, 'MISS_INPUT_DIGEST'],
      [{ ruleVersion: 'rule/v2' }, 'MISS_RULE_VERSION'],
      [{ schemaVersion: 'schema/v2' }, 'MISS_SCHEMA_VERSION'],
      [{ capabilityTier: 'STRONG' }, 'MISS_CAPABILITY_TIER'],
    ];
    for (const [override, reason] of missCases) {
      expect(evaluateAiCacheLookup({ requested: identity(override), entry, nowMs: 2_000 })).toMatchObject({ hit: false, reason });
    }
    expect(evaluateAiCacheLookup({ requested: identity(), entry: null, nowMs: 2_000 })).toMatchObject({ hit: false, reason: 'MISS_ABSENT' });
  });

  it('C1_CACHE_NEVER_CROSSES_TENANTS_AND_STALE_IS_MISS', () => {
    const tenantA = identity({ organizationId: 'org-A' });
    const entryB = { identity: identity({ organizationId: 'org-B' }), createdAtMs: 1_000, ttlMs: 60_000, resultDigest: 'e'.repeat(64) };
    expect(evaluateAiCacheLookup({ requested: tenantA, entry: entryB, nowMs: 2_000 })).toMatchObject({
      hit: false,
      reason: 'MISS_ORGANIZATION',
    });
    const stale = { identity: identity(), createdAtMs: 1_000, ttlMs: 500, resultDigest: 'e'.repeat(64) };
    expect(evaluateAiCacheLookup({ requested: identity(), entry: stale, nowMs: 2_000 })).toMatchObject({ hit: false, reason: 'MISS_STALE' });
    expect(evaluateAiCacheLookup({ requested: identity(), entry: stale, nowMs: 2_000, highRisk: true })).toMatchObject({
      hit: false,
      reason: 'MISS_HIGH_RISK_STALE_FORBIDDEN',
    });
    expect(AI_CACHE_BOUNDARY.crossTenantReuse).toBe('FORBIDDEN');
    expect(AI_CACHE_BOUNDARY.staleHighRiskFallback).toBe('FORBIDDEN');
  });
});

describe('C1 · Cheap → Strong 有界升级合同', () => {
  it('C1_ESCALATION_PASS_NEVER_CALLS_STRONG', () => {
    const pass = decideAiEscalation({ currentTier: 'LOW_COST', quality: 'PASS', state: { attempts: 1, escalations: 0 } });
    expect(pass.action).toBe('STOP_PASS');
    expect(pass.allowStrongCall).toBe(false);
    expect(AI_ESCALATION_BOUNDARY.cheapPassCallsStrong).toBe(false);
  });

  it('C1_ESCALATION_FAIL_ALLOWS_EXACTLY_ONE_BOUNDED_STRONG_CALL', () => {
    const first = decideAiEscalation({ currentTier: 'LOW_COST', quality: 'FAIL', state: { attempts: 1, escalations: 0 } });
    expect(first.action).toBe('ESCALATE_TO_STRONG');
    expect(first.allowStrongCall).toBe(true);
    const second = decideAiEscalation({ currentTier: 'LOW_COST', quality: 'FAIL', state: { attempts: 1, escalations: 1 } });
    expect(second.action).toBe('STOP_BOUNDED');
    expect(second.reason).toBe('AI_ESCALATION_MAX_ESCALATIONS');
    const third = decideAiEscalation({ currentTier: 'LOW_COST', quality: 'LOW_CONFIDENCE', state: { attempts: AI_ESCALATION_DEFAULTS.maxAttempts, escalations: 0 } });
    expect(third.action).toBe('STOP_BOUNDED');
    expect(third.reason).toBe('AI_ESCALATION_MAX_ATTEMPTS');
  });

  it('C1_ESCALATION_NO_RECURSION_AND_JUDGE_CANNOT_AUTHORIZE', () => {
    const strongFail = decideAiEscalation({ currentTier: 'STRONG', quality: 'FAIL', state: { attempts: 2, escalations: 1 } });
    expect(strongFail.action).toBe('STOP_FAILED');
    expect(strongFail.allowAnotherCall).toBe(false);

    const judgeTried = decideAiEscalation({
      currentTier: 'LOW_COST',
      quality: 'FAIL',
      state: { attempts: 1, escalations: 1 },
      judgeAuthorizedMoreCalls: true,
    });
    expect(judgeTried.action).toBe('STOP_BOUNDED');
    expect(judgeTried.notes.join('|')).toContain('JUDGE_AUTHORIZATION_IGNORED');
    expect(AI_ESCALATION_BOUNDARY.judgeMayAuthorizeModelCall).toBe(false);

    expect(() =>
      assertJudgeCannotAuthorizeModelCall({ requestedStrongCall: true, escalation: judgeTried }),
    ).toThrow(/AI_ESCALATION_NOT_AUTHORIZED/);
  });
});

describe('C1 · Model Gateway 单咽喉（router 级证据）', () => {
  it('C1_ROUTER_RULE_SOLVABLE_AND_UNKNOWN_NEVER_CALL_PROVIDER', async () => {
    const low = { n: 0 };
    const strong = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, low),
      strong: adapter('STRONG', true, strong),
      usage: () => usage(),
    });
    const rule = await router.outcomeOf(routerRequest('CI_FAIL', 'ROOT_CAUSE_ANALYSIS', evidence('RULE_SOLVABLE')));
    expect(rule.called).toBe(false);
    expect(rule.reason).toBe('RULE_ENGINE');
    const highConf = await router.outcomeOf(routerRequest('SEMANTIC', 'SEMANTIC_UNDERSTANDING', evidence('HIGH_CONFIDENCE')));
    expect(highConf.called).toBe(false);
    const unknown = await router.outcomeOf(routerRequest('SEMANTIC', 'SEMANTIC_UNDERSTANDING', evidence('UNKNOWN')));
    expect(unknown.called).toBe(false);
    const noEvidence = await router.outcomeOf(routerRequest('COMPLEX_FIX', 'COMPLEX_CODE_FIX', null));
    expect(noEvidence.called).toBe(false);
    expect(noEvidence.reason).toBe('AI_NECESSITY_EVIDENCE_INVALID');
    expect(low.n).toBe(0);
    expect(strong.n).toBe(0);
  });

  it('C1_ROUTER_STRONG_ONLY_VIA_BOUNDED_ESCALATION（FINAL-2：授权来自内部 cheap attempt + deterministic evaluator）', async () => {
    const low = { n: 0 };
    const strong = { n: 0 };
    // ① caller 声明 COMPLEX_CODE_FIX（cost policy 会选 LEVEL_2）→ 被钳制为 LEVEL_1；evaluator PASS → 不升级
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, low),
      strong: adapter('STRONG', true, strong),
      usage: () => usage(),
      qualityEvaluator: () => 'PASS',
    });
    const probe = await router.outcomeOf(routerRequest('COMPLEX_FIX', 'COMPLEX_CODE_FIX', evidence('SEMANTIC_REQUIRED')));
    expect(probe.record?.provider).toBe('provider-lowcost');
    expect(probe.escalatedToStrong).toBeUndefined();
    expect(strong.n).toBe(0);

    // ② cheap 失败（无可用输出 → 确定性 FAIL）→ 一次受控升级到 strong
    const low2 = { n: 0 };
    const strong2 = { n: 0 };
    const failingRouter = createRsiModelRouter({
      lowCost: adapter('LOW_COST', false, low2),
      strong: adapter('STRONG', true, strong2),
      usage: () => usage(),
    });
    const escalated = await failingRouter.outcomeOf(routerRequest('COMPLEX_FIX', 'COMPLEX_CODE_FIX', evidence('SEMANTIC_REQUIRED')));
    expect(escalated.escalatedToStrong).toBe(true);
    expect(escalated.record?.provider).toBe('provider-strong');
    expect(low2.n).toBe(1);
    expect(strong2.n).toBe(1);

    // ③ 触顶后同一 task 再调用 → 不再触达 provider（无递归 / 无 retry storm）
    const bounded = await failingRouter.outcomeOf(routerRequest('COMPLEX_FIX', 'COMPLEX_CODE_FIX', evidence('SEMANTIC_REQUIRED')));
    expect(bounded.called).toBe(false);
    expect(['AI_ESCALATION_STOP_FAILED', 'AI_ESCALATION_MAX_ATTEMPTS']).toContain(bounded.reason);
    expect(strong2.n).toBe(1);
    expect(low2.n).toBe(1);
  });

  it('C1_FINAL2_CALLER_FORGED_ESCALATION_CANNOT_CALL_STRONG', async () => {
    const low = { n: 0 };
    const strong = { n: 0 };
    const router = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, low),
      strong: adapter('STRONG', true, strong),
      usage: () => usage(),
      // server-side deterministic evaluator：判定低成本输出质量合格
      qualityEvaluator: () => 'PASS',
    });
    // caller 试图自报 quality=FAIL + state 来换取 strong → 必须被忽略（仍 PASS → 不升级）
    const forged = {
      ...routerRequest('COMPLEX_FIX', 'COMPLEX_CODE_FIX', evidence('SEMANTIC_REQUIRED')),
      escalation: { quality: 'FAIL' as const, state: { attempts: 1, escalations: 0 } },
    };
    const outcome = await router.outcomeOf(forged);
    expect(outcome.record?.provider).toBe('provider-lowcost');
    expect(outcome.escalatedToStrong).toBeUndefined();
    expect(strong.n).toBe(0);

    // 未配置 server-side evaluator → 无法证明质量 → 即使 cheap 输出存在也不升级
    const noEvaluatorRouter = createRsiModelRouter({
      lowCost: adapter('LOW_COST', true, { n: 0 }),
      strong: adapter('STRONG', true, strong),
      usage: () => usage(),
    });
    const unverified = await noEvaluatorRouter.outcomeOf({
      ...routerRequest('COMPLEX_FIX', 'COMPLEX_CODE_FIX', evidence('SEMANTIC_REQUIRED')),
      escalation: { quality: 'FAIL' as const, state: { attempts: 1, escalations: 0 } },
    });
    expect(unverified.record?.provider).toBe('provider-lowcost');
    expect(strong.n).toBe(0);
  });

  it('C1_FINAL2_ESCALATION_LIMITS_CANNOT_BE_RAISED_BY_HOST', () => {
    const asked = clampAiEscalationLimits({ maxAttempts: 999, maxEscalations: 999 });
    expect(asked.clamped).toBe(true);
    expect(asked.effective).toEqual({ maxAttempts: 2, maxEscalations: 1 });
    expect(AI_ESCALATION_HARD_CAPS).toEqual({ maxAttempts: 2, maxEscalations: 1 });
    expect(AI_ESCALATION_BOUNDARY.hostMayRaiseHardCaps).toBe(false);
    expect(AI_ESCALATION_BOUNDARY.escalationAuthorizationProvenance).toContain('SERVER_SIDE_DETERMINISTIC_EVALUATOR_ONLY');
  });
});
