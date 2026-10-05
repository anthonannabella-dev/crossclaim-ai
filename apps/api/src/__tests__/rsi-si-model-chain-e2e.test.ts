/**
 * PHASE 2 U2 —— SI Runtime 端到端模型链 E2E
 * ---------------------------------------------------------------
 * 链路：signal → task → Policy Core → product Recovery Pack → Shared Action Guard →
 *      Model Gateway capability port（local simulation adapter）→ evidence → proposal → Judge → verdict
 *
 * 必须证明（HOST PHASE 2 要求）：
 *   - 唯一 Model Gateway（无第二 Router）；
 *   - cheap-first；strong escalation 有界；
 *   - budget guard 不可绕过；quality gate 不可由模型自证；
 *   - provider 缺失定价 / budget 拒绝 / Cost Safe Mode → fail-closed（零 provider 调用）；
 *   - Recovery 任务经 product 组装点后强制 park-for-judge（external verdict 才能完成）。
 *
 * 边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD（只用 local simulation adapter）。
 */

import { describe, expect, it } from 'vitest';

import { composeRsiRuntime } from '../runtime/rsi-run';
import { createSiModelGatewayPort, SI_MODEL_GATEWAY_BOUNDARY } from '../runtime/rsi-si-model-gateway';
import { createAppActionGuard } from '../services/action-guard/runtime-guard-composition';
import { createRsiLocalSimAdapter } from '../services/autonomy/rsi-local-sim-adapter';
import type { RsiCostUsage, RsiModelCallRequest } from '../services/autonomy/rsi-cost-policy';
import type { RsiModelProviderAdapter } from '../services/autonomy/rsi-model-router';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';

const queue = JSON.stringify([{ id: 'task-1', dedupeKey: 'task:recovery:PLATFORM:opp-1', priority: 'P2' }]);

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

const request = (): RsiModelCallRequest =>
  ({
    taskType: 'SEMANTIC',
    complexity: 'LOW',
    maxCost: 0.5,
    latencyRequirementMs: 5_000,
    requiredCapability: 'SEMANTIC_UNDERSTANDING',
    incidentId: 'inc-p2',
    taskId: 'task-p2',
    promptRef: 'prompt:task-p2',
    promptDigest: 'c'.repeat(64),
    maxOutputTokens: 256,
    timeoutMs: 5_000,
    necessity: {
      outcome: 'AMBIGUOUS',
      ruleVersion: 'rule/v1',
      schemaVersion: 'schema/v1',
      inputDigest: 'a'.repeat(64),
    },
  }) as RsiModelCallRequest;

const localSim = () =>
  createRsiLocalSimAdapter({
    tier: 'LOW_COST',
    providerName: 'rsi-local-sim-low-cost',
    resolvePrompt: () => 'local-sim-prompt',
  });

const failingAdapter = (tier: 'LOW_COST' | 'STRONG', counter: { n: number }): RsiModelProviderAdapter => ({
  providerName: tier === 'LOW_COST' ? 'probe-low' : 'probe-strong',
  tier,
  pricing: { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000002, maxInputTokens: 1_000 },
  async invoke() {
    counter.n += 1;
    return { ok: false as const, reason: 'PROVIDER_FAILED' as const, latencyMs: 5 };
  },
});

const readPorts = (): RecoveryReadPorts => ({
  async opportunityRead(i) {
    return {
      opportunityRef: i.opportunityRef,
      status: 'READY',
      currency: 'USD',
      hasRecoverableAmount: true,
      hasRuleEvaluation: true,
    };
  },
  async evidenceRead(i) {
    return { opportunityRef: i.opportunityRef, caseRef: 'case-1', evidenceCount: 1, kinds: ['POD'] };
  },
  async customsAuthorizationReadinessRead(i) {
    return { opportunityRef: i.opportunityRef, route: 'MODE_A', readyToFile: false, blockerCodes: [] };
  },
});

const bind = () => ({
  organizationId: 'org-1',
  domain: 'PLATFORM' as never,
  actionKind: 'EXECUTE_READ_ONLY_CHECK' as never,
  opportunityRef: 'opp-1',
});

describe('PHASE 2 U2 · SI Runtime 端到端模型链（local sim）', () => {
  it('P2U2_1 product Recovery 链路 + Model Gateway port → 经 recovery-si 派发并强制 park-for-judge', async () => {
    const gateway = createSiModelGatewayPort({ lowCost: localSim(), usage: () => usage() });
    const composition = await composeRsiRuntime({
      readFile: async (p: string) => (p === 'mem://tasks' ? queue : '[]'),
      tasksPath: 'mem://tasks',
      productRecoveryPack: {
        appActionGuardDeps: {
          killSwitchResolver: {
            async resolve(scope: string) {
              return { scope, value: 'enabled', degraded: false, stale: false };
            },
          },
          audit: { async write() {} },
        } as never,
        readPorts: readPorts(),
        bind,
        modelGateway: gateway,
      },
    });
    const outcome = await composition.controller.tick();
    expect(outcome.claimed?.dedupeKey).toBe('task:recovery:PLATFORM:opp-1');
    expect(composition.domainDispatchLog()[0]?.packId).toBe('recovery-si');
    // proposal 与 verdict 分离：必须等 external verdict
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    expect(composition.controller.state().verdict).toBeNull();
    expect(composition.controller.proposal()).not.toBeNull();
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(composition.controller.state().waitingForVerdict).toBe(false);
  });

  it('P2U2_2 budget guard 不可绕过：缺 provider pricing → BUDGET_GUARD_UNENFORCEABLE，零 provider 调用', async () => {
    const counter = { n: 0 };
    const noPricing: RsiModelProviderAdapter = {
      providerName: 'probe-no-pricing',
      tier: 'LOW_COST',
      async invoke() {
        counter.n += 1;
        return { ok: true as const, modelId: 'x', outputRef: 'sim', outputDigest: 'd'.repeat(64), usage: { inputTokens: 1, outputTokens: 1, estimatedCost: 0 }, latencyMs: 1 };
      },
    };
    const gateway = createSiModelGatewayPort({ lowCost: noPricing, usage: () => usage() });
    const result = await gateway.invoke(request());
    expect(result.called).toBe(false);
    expect(result.reason).toContain('BUDGET_GUARD_UNENFORCEABLE');
    expect(counter.n).toBe(0);
  });

  it('P2U2_3 Cost Safe Mode 拒绝 → 零 provider 调用（fail-closed）', async () => {
    const counter = { n: 0 };
    const gateway = createSiModelGatewayPort({
      lowCost: failingAdapter('LOW_COST', counter),
      usage: () => usage(),
      costSafeMode: () => ({ standardAiAllowed: false, state: 'COST_SAFE', reason: 'AI_COST_SAFE_MODE:DAILY' }),
    });
    const result = await gateway.invoke(request());
    expect(result.called).toBe(false);
    expect(result.reason).toBe('AI_COST_SAFE_MODE:DAILY');
    expect(counter.n).toBe(0);
  });

  it('P2U2_4 quality gate 不可由模型自证：cheap 成功但无 evaluator → 不升级；evaluator FAIL → 有界升级 ≤ 1', async () => {
    const succeeding = (tier: 'LOW_COST' | 'STRONG', counter: { n: number }): RsiModelProviderAdapter => ({
      providerName: tier === 'LOW_COST' ? 'probe-low-ok' : 'probe-strong-ok',
      tier,
      pricing: { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000002, maxInputTokens: 1_000 },
      async invoke() {
        counter.n += 1;
        return {
          ok: true as const,
          modelId: tier === 'LOW_COST' ? 'low-ok' : 'strong-ok',
          outputRef: 'sim:x',
          outputDigest: 'd'.repeat(64),
          usage: { inputTokens: 10, outputTokens: 5, estimatedCost: 0.001 },
          latencyMs: 3,
        };
      },
    });

    // ① cheap 成功 ≠ 质量合格：未配置 server-side evaluator → 不得升级 strong
    const cheap1 = { n: 0 };
    const strong1 = { n: 0 };
    const noEvaluator = createSiModelGatewayPort({
      lowCost: succeeding('LOW_COST', cheap1),
      strong: succeeding('STRONG', strong1),
      usage: () => usage(),
    });
    const r1 = await noEvaluator.invoke(request());
    expect(cheap1.n).toBe(1);
    expect(strong1.n).toBe(0);
    expect(r1.escalatedToStrong).toBe(false);

    // ② evaluator 明确 FAIL → 允许一次有界升级（hard caps: attempts 2 / escalations 1）
    const cheap2 = { n: 0 };
    const strong2 = { n: 0 };
    const withEvaluator = createSiModelGatewayPort({
      lowCost: succeeding('LOW_COST', cheap2),
      strong: succeeding('STRONG', strong2),
      usage: () => usage(),
      qualityEvaluator: () => 'FAIL' as const,
    });
    await withEvaluator.invoke(request());
    await withEvaluator.invoke(request());
    expect(cheap2.n).toBeGreaterThan(0);
    expect(strong2.n).toBeLessThanOrEqual(1);
  });

  it('P2U2_5 边界：唯一 Gateway、真实网络与付费调用保持 HOLD', () => {
    expect(SI_MODEL_GATEWAY_BOUNDARY.owner).toContain('rsi-model-router');
    expect(SI_MODEL_GATEWAY_BOUNDARY.secondRouter).toBe('FORBIDDEN');
    expect(SI_MODEL_GATEWAY_BOUNDARY.realProviderNetwork).toBe('HOLD');
    expect(SI_MODEL_GATEWAY_BOUNDARY.paidModelCalls).toBe('HOLD');
    expect(typeof createAppActionGuard).toBe('function'); // 共享 Guard 唯一实现仍在位
  });
});
