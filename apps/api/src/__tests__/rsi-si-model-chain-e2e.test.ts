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
import {
  createAppActionGuard,
  staticControlPlaneConfig,
} from '../services/action-guard/runtime-guard-composition';
import { buildRecoverySiEvidenceRef, createRecoverySiPack } from '../runtime/recovery-si-pack';
import { isRsiLocalSimAdapter } from '../services/autonomy/rsi-local-sim-adapter';
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
  capability: { simulated: true },
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
      capability: { simulated: true },
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
      capability: { simulated: true },
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

  it('P2U2_6 Recovery pack 真消费 Model Gateway（server-derived AI-eligible）；缺省 deterministic-first', async () => {
    const invoked = { n: 0 };
    const gateway = createSiModelGatewayPort({
      lowCost: createRsiLocalSimAdapter({
        tier: 'LOW_COST',
        providerName: 'rsi-local-sim-low-cost',
        resolvePrompt: () => 'local-sim-prompt',
      }),
      usage: () => usage(),
      onCall: () => {
        invoked.n += 1;
      },
    });
    const pack = createRecoverySiPack({
      readPorts: readPorts(),
      bind: () => ({
        organizationId: 'org-1',
        domain: 'PLATFORM' as never,
        actionKind: 'EXECUTE_READ_ONLY_CHECK' as never,
        opportunityRef: 'opp-1',
        aiEligible: true,
      }),
      guard: { async evaluate() { return { decision: 'ALLOW', reason: 'TEST_ALLOW' }; } },
    });
    const withGateway = await pack.run({ task: { id: 't1', dedupeKey: 'task:recovery:PLATFORM:opp-1', priority: 'P2' }, packId: 'recovery-si', modelGateway: gateway });
    expect(withGateway.reasonCodes).toContain('RECOVERY_PACK_MODEL_GATEWAY');
    expect(invoked.n).toBe(1);
    expect(withGateway.modelCallCount).toBe(1);
    const withoutGateway = await pack.run({ task: { id: 't2', dedupeKey: 'task:recovery:PLATFORM:opp-2', priority: 'P2' }, packId: 'recovery-si' });
    expect(withoutGateway.reasonCodes).not.toContain('RECOVERY_PACK_MODEL_GATEWAY');
    expect(withoutGateway.modelCallCount).toBe(0);
  });

  it('P2U2_7 真 runtime 链（确定性 ALLOW fixture）：recovery-si → Shared Guard ALLOW → Gateway invoke=1 → park-for-judge', async () => {
    const invoked = { n: 0 };
    const gateway = createSiModelGatewayPort({
      lowCost: createRsiLocalSimAdapter({
        tier: 'LOW_COST',
        providerName: 'rsi-local-sim-low-cost',
        resolvePrompt: () => 'local-sim-prompt',
      }),
      usage: () => usage(),
      onCall: () => {
        invoked.n += 1;
      },
    });
    const composition = await composeRsiRuntime({
      readFile: async (p: string) => (p === 'mem://tasks' ? queue : '[]'),
      tasksPath: 'mem://tasks',
      productRecoveryPack: {
        appActionGuardDeps: {
          config: staticControlPlaneConfig({ mode: 'READ_ONLY', productionGate: 'SATISFIED' } as never),
          killSwitchResolver: {
            async resolve(scope: string) {
              return { scope, value: 'enabled', degraded: false, stale: false };
            },
          },
          audit: { async write() {} },
        } as never,
        readPorts: readPorts(),
        bind: () => ({
          organizationId: 'org-1',
          domain: 'PLATFORM' as never,
          actionKind: 'EXECUTE_READ_ONLY_CHECK' as never,
          opportunityRef: 'opp-1',
          aiEligible: true,
        }),
        modelGateway: gateway,
      },
    });
    const outcome = await composition.controller.tick();
    expect(outcome.claimed?.dedupeKey).toBe('task:recovery:PLATFORM:opp-1');
    expect(composition.domainDispatchLog()[0]?.packId).toBe('recovery-si');
    expect(composition.domainDispatchLog()[0]?.guardActions[0]?.decision).toBe('ALLOW');
    expect(invoked.n).toBe(1);
    expect(composition.controller.proposal()).not.toBeNull();
    expect(composition.controller.state().waitingForVerdict).toBe(true);
    expect(composition.controller.state().verdict).toBeNull();
    composition.controller.markWaitingForVerdict('PASS');
    await composition.controller.emit('JUDGE_VERDICT_RECEIVED');
    expect(composition.controller.state().waitingForVerdict).toBe(false);
  });
  it('P2U2_8 HOLD 运行时边界：非 local-sim（真实/付费）adapter 注入 → fail-closed 抛错', () => {
    expect(() =>
      createSiModelGatewayPort({
        lowCost: { providerName: 'amazon-ads-real', tier: 'LOW_COST', async invoke() { throw new Error('must not run'); } },
        usage: () => usage(),
      }),
    ).toThrow(/SI_MODEL_GATEWAY_REAL_PROVIDER_FORBIDDEN/);
  });

  it('P2U2_9 evidence digest 敏感性：tool audit / gateway audit 任一变化 → evidenceRef 变化', () => {
    const base = {
      taskId: 't1',
      dedupeKey: 'task:recovery:PLATFORM:opp-1',
      organizationId: 'org-1',
      opportunityRef: 'opp-1',
      guardAction: 'evidence.read',
      gatewayAudit: ['gateway.called=true', 'gateway.reason=CALLED'],
      toolAudit: ['tool=recovery.opportunity.read:ok=true'],
    };
    const ref = buildRecoverySiEvidenceRef(base);
    expect(ref).toContain('tool=recovery.opportunity.read:ok=true');
    expect(buildRecoverySiEvidenceRef({ ...base, toolAudit: ['tool=recovery.evidence.read:ok=true'] })).not.toBe(ref);
    expect(buildRecoverySiEvidenceRef({ ...base, gatewayAudit: ['gateway.called=false'] })).not.toBe(ref);
  });

  it('P2U2_10 local-sim provenance：factory PASS；伪装名 / fake REJECT；strong 同样校验', () => {
    const factoryLow = createRsiLocalSimAdapter({ tier: 'LOW_COST', providerName: 'rsi-local-sim-low-cost', resolvePrompt: () => 'p' });
    expect(isRsiLocalSimAdapter(factoryLow)).toBe(true);
    expect(() => createSiModelGatewayPort({ lowCost: factoryLow, usage: () => usage() })).not.toThrow();
    const spoofed = { providerName: 'rsi-local-sim-openai-real', tier: 'LOW_COST' as const, async invoke() { throw new Error('x'); } };
    expect(isRsiLocalSimAdapter(spoofed)).toBe(false);
    expect(() => createSiModelGatewayPort({ lowCost: spoofed, usage: () => usage() })).toThrow(/SI_MODEL_GATEWAY_REAL_PROVIDER_FORBIDDEN/);
    const fakeStrong = { providerName: 'amazon-real', tier: 'STRONG' as const, async invoke() { throw new Error('x'); } };
    expect(() => createSiModelGatewayPort({ lowCost: factoryLow, strong: fakeStrong, usage: () => usage() })).toThrow(/SI_MODEL_GATEWAY_REAL_PROVIDER_FORBIDDEN/);
    const factoryStrong = createRsiLocalSimAdapter({ tier: 'STRONG', providerName: 'rsi-local-sim-strong', resolvePrompt: () => 'p' });
    expect(() => createSiModelGatewayPort({ lowCost: factoryLow, strong: factoryStrong, usage: () => usage() })).not.toThrow();
  });
