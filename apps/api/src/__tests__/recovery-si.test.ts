/** Recovery SI Phase 1 —— 单元验收（state / registry / prioritizer / planner / verifier / policy） */

import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_RECOVERY_STATE_BOUNDARY,
  buildCustomerRecoveryState,
  type OpportunitySlice,
} from '../services/intelligence/customer-recovery-state';
import {
  RECOVERY_TOOL_REGISTRY_BOUNDARY,
  createRecoveryToolRegistry,
  type RecoveryTool,
} from '../services/intelligence/recovery-tool-registry';
import { prioritizeOpportunities } from '../services/intelligence/recovery-prioritizer';
import { planRecovery } from '../services/intelligence/recovery-planner';
import { verifyRecoveryPlan } from '../services/intelligence/recovery-verifier';
import {
  RECOVERY_POLICY_BOUNDARY,
  decideRecoveryAction,
  decideRecoveryExecutionRequest,
} from '../services/intelligence/recovery-policy';

const NOW = '2026-10-05T04:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ORG = 'org-1';

const opportunity = (over: Partial<OpportunitySlice> = {}): OpportunitySlice => ({
  opportunityRef: 'opp-1',
  domain: 'CARRIER',
  organizationId: ORG,
  recoverable: { amount: 680, currency: 'USD', source: 'CANONICAL_FACT' },
  eligibility: 'ELIGIBLE',
  evidenceComplete: true,
  missingEvidence: [],
  authorizationReady: true,
  deadline: '2026-11-01T00:00:00.000Z',
  providerCostUsd: 1,
  expectedOperationalCostUsd: 4,
  riskClass: 'LOW',
  observedAt: NOW,
  ...over,
});

const readTool = (name: string, domain: RecoveryTool['domain']): RecoveryTool => ({
  name,
  domain,
  access: 'READ',
  description: 'read-only fixture tool',
  invoke: async () => ({ ok: true }),
});

const prepareTool = (name: string, domain: RecoveryTool['domain']): RecoveryTool => ({
  name,
  domain,
  access: 'PREPARE',
  description: 'prepare package fixture tool',
  invoke: async () => ({ prepared: true }),
});

const registry = () =>
  createRecoveryToolRegistry([
    readTool('carrier.eligibility', 'CARRIER'),
    prepareTool('carrier.prepare_package', 'CARRIER'),
    prepareTool('platform.prepare_package', 'PLATFORM'),
    readTool('customs.authorization.readiness', 'CUSTOMS'),
    readTool('independent_site.inspect', 'INDEPENDENT_SITE'),
  ]);

describe('Recovery SI · customer recovery state', () => {
  it('RECOVERY_SI_STATE_TENANT_ISOLATION：跨租户切片 → TENANT_MISMATCH（fail-closed）', () => {
    const result = buildCustomerRecoveryState({
      organizationId: ORG,
      observedAt: NOW,
      opportunities: [opportunity(), opportunity({ opportunityRef: 'opp-x', organizationId: 'org-2' })],
      capability: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('TENANT_MISMATCH');
    expect(result.offendingRef).toBe('opp-x');
  });

  it('RECOVERY_SI_STATE_MONEY_MUST_COME_FROM_FACT：来源不明金额被丢弃而不用估算补位', () => {
    const result = buildCustomerRecoveryState({
      organizationId: ORG,
      observedAt: NOW,
      opportunities: [
        opportunity(),
        opportunity({
          opportunityRef: 'opp-suspect',
          recoverable: { amount: 9999, currency: 'USD', source: 'UNKNOWN' },
        }),
      ],
      capability: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.state.droppedMoneyRefs).toEqual(['opp-suspect']);
    expect(result.state.opportunities.find((slice) => slice.opportunityRef === 'opp-suspect')?.recoverable).toBeNull();
    expect(CUSTOMER_RECOVERY_STATE_BOUNDARY.moneyMustComeFromPersistedFact).toBe(true);
    expect(CUSTOMER_RECOVERY_STATE_BOUNDARY.mutatesCanonicalFact).toBe(false);
  });
});

describe('Recovery SI · tool registry', () => {
  it('RECOVERY_SI_TOOL_UNKNOWN_FAIL_CLOSED：未登记工具拒绝；执行类名字不得登记', async () => {
    const reg = registry();
    const unknown = await reg.invoke('carrier.submit_claim', {}, { organizationId: ORG });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error('expected rejection');
    expect(unknown.reason).toBe('TOOL_NOT_REGISTERED');

    const withForbidden = createRecoveryToolRegistry([readTool('customs.file_entry', 'CUSTOMS')]);
    expect(withForbidden.registrationErrors).toEqual([{ name: 'customs.file_entry', reason: 'TOOL_NAME_FORBIDDEN' }]);
    expect(withForbidden.has('customs.file_entry')).toBe(false);

    const noTenant = await reg.invoke('carrier.eligibility', {}, { organizationId: '' });
    expect(noTenant.ok).toBe(false);
    if (noTenant.ok) throw new Error('expected rejection');
    expect(noTenant.reason).toBe('TENANT_CONTEXT_REQUIRED');
    expect(RECOVERY_TOOL_REGISTRY_BOUNDARY.unknownToolFailsClosed).toBe(true);
    expect(RECOVERY_TOOL_REGISTRY_BOUNDARY.directDatabaseMutation).toBe(false);
  });

  it('RECOVERY_SI_TOOL_FORBIDDEN_OUTPUT：工具返回 secret 字段 → 拒绝', async () => {
    const reg = createRecoveryToolRegistry([
      {
        name: 'carrier.eligibility',
        domain: 'CARRIER',
        access: 'READ',
        description: 'leaky fixture',
        invoke: async () => ({ apiKey: 'sk-should-not-leak' }),
      },
    ]);
    const result = await reg.invoke('carrier.eligibility', {}, { organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('FORBIDDEN_TOOL_OUTPUT');
  });
});

describe('Recovery SI · prioritizer', () => {
  it('RECOVERY_SI_PRIORITIZER_DETERMINISTIC：EV 降序 + 期限升序 + 引用升序（确定性）', () => {
    const state = buildCustomerRecoveryState({
      organizationId: ORG,
      observedAt: NOW,
      opportunities: [
        opportunity({ opportunityRef: 'opp-small', recoverable: { amount: 100, currency: 'USD', source: 'CANONICAL_FACT' } }),
        opportunity({ opportunityRef: 'opp-big', recoverable: { amount: 5000, currency: 'USD', source: 'CANONICAL_FACT' } }),
      ],
      capability: [],
    });
    if (!state.ok) throw new Error('state build failed');
    const first = prioritizeOpportunities(state.state);
    const second = prioritizeOpportunities(state.state);
    expect(first.ranked.map((entry) => entry.opportunityRef)).toEqual(['opp-big', 'opp-small']);
    expect(second).toEqual(first);
    expect(first.ranked[0]!.expectedRecoveryValueUsd).toBeCloseTo(5000 - 1 - 4, 6);
  });

  it('RECOVERY_SI_PRIORITIZER_MULTI_CURRENCY_NO_FAKE_SUM：多币种不相加，按币种分组', () => {
    const state = buildCustomerRecoveryState({
      organizationId: ORG,
      observedAt: NOW,
      opportunities: [
        opportunity({ opportunityRef: 'opp-usd', recoverable: { amount: 680, currency: 'USD', source: 'CANONICAL_FACT' } }),
        opportunity({ opportunityRef: 'opp-eur', recoverable: { amount: 900, currency: 'EUR', source: 'CANONICAL_FACT' } }),
      ],
      capability: [],
    });
    if (!state.ok) throw new Error('state build failed');
    const result = prioritizeOpportunities(state.state);
    expect(result.reasonCodes).toContain('MULTI_CURRENCY_NO_FX');
    expect(Object.keys(result.expectedRecoveryByCurrency).sort()).toEqual(['EUR', 'USD']);
    expect(result.expectedRecoveryByCurrency.USD).toBeCloseTo(675, 6);
    // CHANGE A（MSG-20261005-11）：EUR 机会不得相减 USD 成本 —— 该切片 riskClass=LOW（罚金 0），
    // 因此应为 900 EUR 而不是旧的 900 - 1 - 4 = 895 EUR
    expect(result.expectedRecoveryByCurrency.EUR).toBeCloseTo(900, 6);
  });
});

describe('Recovery SI · planner / verifier', () => {
  const buildState = (slices: readonly OpportunitySlice[]) => {
    const built = buildCustomerRecoveryState({
      organizationId: ORG,
      observedAt: NOW,
      opportunities: slices,
      capability: [
        { domain: 'CARRIER', readOnlyTools: ['carrier.eligibility'], providerApproval: 'READY' },
        { domain: 'PLATFORM', readOnlyTools: [], providerApproval: 'READY' },
        { domain: 'CUSTOMS', readOnlyTools: ['customs.authorization.readiness'], providerApproval: 'HOLD' },
        { domain: 'INDEPENDENT_SITE', readOnlyTools: ['independent_site.inspect'], providerApproval: 'HOLD' },
      ],
    });
    if (!built.ok) throw new Error('state build failed: ' + built.reason);
    return built.state;
  };

  it('RECOVERY_SI_PLANNER_MISSING_EVIDENCE / MISSING_AUTHORIZATION：缺口 → 请求而非猜测', () => {
    const reg = registry();
    const state = buildState([
      opportunity({ opportunityRef: 'opp-evidence', evidenceComplete: false, missingEvidence: ['POD'] }),
      opportunity({ opportunityRef: 'opp-auth', authorizationReady: false }),
    ]);
    const plan = planRecovery({
      state,
      ranked: prioritizeOpportunities(state).ranked,
      registry: reg,
      generatedAt: NOW,
    });
    const byRef = new Map(plan.actions.map((action) => [action.opportunityRef, action]));
    expect(byRef.get('opp-evidence')?.proposedAction).toBe('REQUEST_EVIDENCE');
    expect(byRef.get('opp-evidence')?.missingEvidence).toEqual(['POD']);
    expect(byRef.get('opp-auth')?.proposedAction).toBe('REQUEST_AUTHORIZATION');
    expect(byRef.get('opp-auth')?.authorizationRequired).toBe(true);
  });

  it('RECOVERY_SI_VERIFIER_STALE_STATE：陈旧 snapshot → 整份 plan 拒绝', () => {
    const reg = registry();
    const state = buildState([opportunity()]);
    const plan = planRecovery({ state, ranked: prioritizeOpportunities(state).ranked, registry: reg, generatedAt: NOW });
    const verification = verifyRecoveryPlan({
      plan,
      state,
      registry: reg,
      nowMs: NOW_MS + 60 * 60 * 1000,
      maxSnapshotAgeMs: 15 * 60 * 1000,
    });
    expect(verification.ok).toBe(false);
    if (verification.ok) throw new Error('expected stale rejection');
    expect(verification.reason).toBe('STALE_SNAPSHOT');
  });

  it('RECOVERY_SI_VERIFIER_NONEXISTENT_REFERENCE：plan 引用不存在的 opportunity → 被拒', () => {
    const reg = registry();
    const state = buildState([opportunity()]);
    const plan = planRecovery({ state, ranked: prioritizeOpportunities(state).ranked, registry: reg, generatedAt: NOW });
    const tampered = { ...plan, actions: [...plan.actions, { ...plan.actions[0]!, opportunityRef: 'ghost-ref' }] };
    const verification = verifyRecoveryPlan({
      plan: tampered,
      state,
      registry: reg,
      nowMs: NOW_MS,
      maxSnapshotAgeMs: 15 * 60 * 1000,
    });
    expect(verification.ok).toBe(true);
    if (!verification.ok) throw new Error('expected ok with rejections');
    expect(verification.rejected.some((entry) => entry.reasonCodes.includes('REFERENCE_NOT_FOUND'))).toBe(true);
    expect(verification.executionAuthorizedInPhase1).toBe(false);
  });
});

describe('Recovery SI · policy（L5 不放宽）', () => {
  it('RECOVERY_SI_L5_ACTION_REFUSAL：外写/支付/报关/凭据请求一律永久禁止', () => {
    for (const action of ['EXTERNAL_WRITE', 'PAYMENT', 'CUSTOMS_FILING', 'PRODUCTION_CREDENTIALS', 'REAL_CLAIM_SUBMIT']) {
      const decision = decideRecoveryExecutionRequest(action);
      expect(decision.allowedForRsi).toBe(false);
      expect(decision.permanentlyForbidden).toBe(true);
    }
    expect(RECOVERY_POLICY_BOUNDARY.relaxesL5).toBe(false);
    expect(RECOVERY_POLICY_BOUNDARY.singlePolicySource).toBe('services/autonomy/rsi-policy-engine.ts');
  });

  it('RECOVERY_SI_PLAN_ACTION_POLICY：读/规划类动作放行，且 READY_FOR_EXECUTION 不等于执行授权', () => {
    expect(decideRecoveryAction('EXECUTE_READ_ONLY_CHECK').allowedForRecoverySi).toBe(true);
    expect(decideRecoveryAction('PREPARE_PACKAGE').allowedForRecoverySi).toBe(true);
    const ready = decideRecoveryAction('READY_FOR_EXECUTION');
    // CHANGE C（MSG-20261005-11）：READY 是决策标记，不是执行许可
    expect(ready.allowedForRecoverySi).toBe(false);
    expect(ready.reasonCodes).toContain('EXECUTION_NOT_AUTHORIZED_IN_PHASE1');
    expect(ready.permanentlyForbidden).toBe(false);
    expect(RECOVERY_POLICY_BOUNDARY.readyForExecutionIsExecution).toBe(false);
  });
});
