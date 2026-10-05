/**
 * Recovery SI Phase 1 —— MSG-20261005-11（REVISE）的 CHANGE A/B/C 证据
 * FINAL-2 最小证据集合（6 项）逐条覆盖。
 */

import { describe, expect, it } from 'vitest';

import { buildCustomerRecoveryState, type CustomerRecoveryState, type OpportunitySlice } from '../services/intelligence/customer-recovery-state';
import { createRecoveryToolRegistry, type RecoveryTool } from '../services/intelligence/recovery-tool-registry';
import { prioritizeOpportunities } from '../services/intelligence/recovery-prioritizer';
import { planRecovery } from '../services/intelligence/recovery-planner';
import { verifyRecoveryPlan } from '../services/intelligence/recovery-verifier';
import { decideRecoveryAction } from '../services/intelligence/recovery-policy';
import { superviseRecovery } from '../services/intelligence/recovery-supervisor';

const NOW = '2026-10-05T04:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ORG = 'org-revise';

const slice = (over: Partial<OpportunitySlice> = {}): OpportunitySlice => ({
  opportunityRef: 'opp-usd',
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

const tool = (name: string, domain: RecoveryTool['domain'], access: 'READ' | 'PREPARE'): RecoveryTool => ({
  name,
  domain,
  access,
  description: 'revise fixture',
  invoke: async () => ({ ok: true }),
});

const registry = () =>
  createRecoveryToolRegistry([
    tool('carrier.prepare_package', 'CARRIER', 'PREPARE'),
    tool('independent_site.inspect', 'INDEPENDENT_SITE', 'READ'),
  ]);

const capability = [
  { domain: 'CARRIER' as const, readOnlyTools: [], providerApproval: 'READY' as const },
  { domain: 'INDEPENDENT_SITE' as const, readOnlyTools: ['independent_site.inspect'], providerApproval: 'READY' as const },
];

const build = (slices: readonly OpportunitySlice[]) => {
  const built = buildCustomerRecoveryState({ organizationId: ORG, observedAt: NOW, opportunities: slices, capability });
  if (!built.ok) throw new Error('state build failed');
  return built.state;
};

describe('Recovery SI REVISE · CHANGE A（多币种语义）', () => {
  it('CHANGE_A_NO_USD_COST_ON_EUR：EUR 机会不得相减 USD 成本，也不得出现 895 EUR 这类量纲错误', () => {
    const state = build([
      slice({
        opportunityRef: 'opp-eur',
        recoverable: { amount: 900, currency: 'EUR', source: 'CANONICAL_FACT' },
        providerCostUsd: 1,
        expectedOperationalCostUsd: 4,
        riskClass: 'MEDIUM',
      }),
    ]);
    const priority = prioritizeOpportunities(state);
    const scored = priority.ranked[0]!;
    expect(scored.currency).toBe('EUR');
    expect(scored.providerCostUsd).toBe(0);
    expect(scored.operationalCostUsd).toBe(0);
    // MEDIUM 风险 10% → 900 * 0.9 = 810（而不是 900 - 5 = 895）
    expect(scored.expectedRecoveryValue).toBeCloseTo(810, 6);
    expect(scored.expectedRecoveryValueUsd).toBeNull();
    expect(priority.reasonCodes).toContain('USD_COST_EXCLUDED_NO_FX');
  });

  it('CHANGE_A_NO_CROSS_CURRENCY_RANKING：USD 与 EUR 机会不做跨币种金额排序', () => {
    const state = build([
      slice({ opportunityRef: 'opp-usd-big', recoverable: { amount: 5000, currency: 'USD', source: 'CANONICAL_FACT' } }),
      slice({ opportunityRef: 'opp-eur-small', recoverable: { amount: 900, currency: 'EUR', source: 'CANONICAL_FACT' } }),
    ]);
    const priority = prioritizeOpportunities(state);
    // 组间按 currency 升序（EUR 在前），而不是按金额把 5000 USD 排到 900 EUR 之前
    expect(priority.ranked.map((entry) => entry.opportunityRef)).toEqual(['opp-eur-small', 'opp-usd-big']);
    expect(priority.rankByCurrency.EUR).toEqual(['opp-eur-small']);
    expect(priority.rankByCurrency.USD).toEqual(['opp-usd-big']);
    expect(priority.reasonCodes).toContain('MULTI_CURRENCY_NO_FX');
  });
});

describe('Recovery SI REVISE · CHANGE B（Verifier 真 fail-closed）', () => {
  it('CHANGE_B1_FORGED_CROSS_TENANT_STATE：绕过 builder 直接构造污染 state → 整单 halt TENANT_MISMATCH', () => {
    const clean = build([slice()]);
    const polluted: CustomerRecoveryState = {
      ...clean,
      tenantVerified: true,
      opportunities: [{ ...clean.opportunities[0]!, organizationId: 'org-other' }],
    };
    const result = superviseRecovery({ state: polluted, registry: registry(), nowMs: NOW_MS });
    expect(result.halted).toBe('TENANT_MISMATCH');
    expect(result.decisions).toEqual([]);
  });

  it('CHANGE_B2_STALE_OPPORTUNITY：state 新鲜但 opportunity.observedAt 过期 → 该项被拒', () => {
    const state = build([slice({ observedAt: '2026-09-01T00:00:00.000Z' })]);
    const priority = prioritizeOpportunities(state);
    const plan = planRecovery({ state, ranked: priority.ranked, registry: registry(), generatedAt: NOW });
    const verification = verifyRecoveryPlan({
      plan,
      state,
      registry: registry(),
      priority,
      nowMs: NOW_MS,
      maxSnapshotAgeMs: 15 * 60 * 1000,
    });
    expect(verification.ok).toBe(true);
    if (!verification.ok) throw new Error('expected ok-with-rejections');
    expect(verification.rejected.some((entry) => entry.reasonCodes.includes('STALE_OPPORTUNITY'))).toBe(true);
  });

  it('CHANGE_B3_TAMPERED_EXPECTED_RECOVERY：篡改 plan.expectedRecovery → MONEY_DERIVATION_MISMATCH', () => {
    const state = build([slice()]);
    const priority = prioritizeOpportunities(state);
    const plan = planRecovery({ state, ranked: priority.ranked, registry: registry(), generatedAt: NOW });
    const tampered = {
      ...plan,
      actions: plan.actions.map((action) =>
        action.expectedRecovery === null
          ? action
          : { ...action, expectedRecovery: { amount: 999_999_999, currency: action.expectedRecovery.currency } },
      ),
    };
    const verification = verifyRecoveryPlan({
      plan: tampered,
      state,
      registry: registry(),
      priority,
      nowMs: NOW_MS,
      maxSnapshotAgeMs: 15 * 60 * 1000,
    });
    expect(verification.ok).toBe(true);
    if (!verification.ok) throw new Error('expected ok-with-rejections');
    expect(verification.rejected.some((entry) => entry.reasonCodes.includes('MONEY_DERIVATION_MISMATCH'))).toBe(true);
  });
});

describe('Recovery SI REVISE · CHANGE C（执行许可歧义）', () => {
  it('CHANGE_C_READY_IS_NOT_EXECUTION：READY_FOR_EXECUTION 不得输出 allowedForRecoverySi=true/executionAuthorized=true', () => {
    const policy = decideRecoveryAction('READY_FOR_EXECUTION');
    expect(policy.allowedForRecoverySi).toBe(false);
    expect(policy.requiresOwnerApproval).toBe(true);
    expect(policy.reasonCodes).toContain('EXECUTION_NOT_AUTHORIZED_IN_PHASE1');

    const state = build([slice()]);
    const result = superviseRecovery({ state, registry: registry(), nowMs: NOW_MS });
    const ready = result.decisions.filter((decision) => decision.proposedAction === 'READY_FOR_EXECUTION');
    expect(ready.length).toBeGreaterThan(0);
    for (const decision of ready) {
      expect(decision.executionAuthorized).toBe(false);
      expect(decision.allowedForRecoverySi).toBe(false);
      expect(decision.reasonCodes).toContain('EXECUTION_NOT_AUTHORIZED_IN_PHASE1');
    }
    expect(result.boundaries.executionAuthorizedInPhase1).toBe(false);
  });
});
