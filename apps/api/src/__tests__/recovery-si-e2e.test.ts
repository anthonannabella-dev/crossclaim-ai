/**
 * Recovery SI Phase 1 —— 跨域 E2E（完全内部/模拟客户，零外写）
 * 场景（HOST §12）：
 *   A Carrier        680 USD   证据完整  低风险        → PREPARE_PACKAGE / READY_FOR_EXECUTION
 *   B Amazon         3200 USD  证据完整                → PREPARE_PACKAGE / READY_FOR_EXECUTION
 *   C Customs        18500 USD 缺授权                  → REQUEST_AUTHORIZATION
 *   D Independent    1300 USD  证据不完整              → REQUEST_EVIDENCE
 */

import { describe, expect, it } from 'vitest';

import { buildCustomerRecoveryState, type OpportunitySlice } from '../services/intelligence/customer-recovery-state';
import { createRecoveryToolRegistry, type RecoveryTool } from '../services/intelligence/recovery-tool-registry';
import { superviseRecovery, RECOVERY_SUPERVISOR_BOUNDARY } from '../services/intelligence/recovery-supervisor';

const NOW = '2026-10-05T04:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ORG = 'org-e2e';

const slices: readonly OpportunitySlice[] = [
  {
    opportunityRef: 'opp-carrier',
    domain: 'CARRIER',
    organizationId: ORG,
    recoverable: { amount: 680, currency: 'USD', source: 'CANONICAL_FACT' },
    eligibility: 'ELIGIBLE',
    evidenceComplete: true,
    missingEvidence: [],
    authorizationReady: true,
    deadline: '2026-10-20T00:00:00.000Z',
    providerCostUsd: 1,
    expectedOperationalCostUsd: 4,
    riskClass: 'LOW',
    observedAt: NOW,
  },
  {
    opportunityRef: 'opp-amazon',
    domain: 'PLATFORM',
    organizationId: ORG,
    recoverable: { amount: 3200, currency: 'USD', source: 'PERSISTED_ESTIMATE' },
    eligibility: 'ELIGIBLE',
    evidenceComplete: true,
    missingEvidence: [],
    authorizationReady: true,
    deadline: '2026-10-25T00:00:00.000Z',
    providerCostUsd: 2,
    expectedOperationalCostUsd: 10,
    riskClass: 'MEDIUM',
    observedAt: NOW,
  },
  {
    opportunityRef: 'opp-customs',
    domain: 'CUSTOMS',
    organizationId: ORG,
    recoverable: { amount: 18500, currency: 'USD', source: 'CANONICAL_FACT' },
    eligibility: 'ELIGIBLE',
    evidenceComplete: true,
    missingEvidence: [],
    authorizationReady: false,
    deadline: '2026-12-31T00:00:00.000Z',
    providerCostUsd: 5,
    expectedOperationalCostUsd: 20,
    riskClass: 'MEDIUM',
    observedAt: NOW,
  },
  {
    opportunityRef: 'opp-independent',
    domain: 'INDEPENDENT_SITE',
    organizationId: ORG,
    recoverable: { amount: 1300, currency: 'USD', source: 'CANONICAL_FACT' },
    eligibility: 'ELIGIBLE',
    evidenceComplete: false,
    missingEvidence: ['DISPUTE_EVIDENCE'],
    authorizationReady: true,
    deadline: '2026-11-15T00:00:00.000Z',
    providerCostUsd: 1,
    expectedOperationalCostUsd: 5,
    riskClass: 'MEDIUM',
    observedAt: NOW,
  },
];

const counters = { invoked: 0 };

const tool = (name: string, domain: RecoveryTool['domain'], access: 'READ' | 'PREPARE'): RecoveryTool => ({
  name,
  domain,
  access,
  description: 'e2e fixture tool',
  invoke: async () => {
    counters.invoked += 1;
    return { ok: true };
  },
});

const registry = () =>
  createRecoveryToolRegistry([
    tool('carrier.eligibility', 'CARRIER', 'READ'),
    tool('carrier.prepare_package', 'CARRIER', 'PREPARE'),
    tool('platform.prepare_package', 'PLATFORM', 'PREPARE'),
    tool('customs.authorization.readiness', 'CUSTOMS', 'READ'),
    tool('independent_site.inspect', 'INDEPENDENT_SITE', 'READ'),
  ]);

const state = () => {
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

describe('Recovery SI Phase 1 · cross-domain E2E', () => {
  it('RECOVERY_SI_E2E_CROSS_DOMAIN_PLAN：四域统一状态 → 确定性计划（Carrier/Amazon 可准备，Customs 求授权，Independent 求证据）', () => {
    const result = superviseRecovery({ state: state(), registry: registry(), nowMs: NOW_MS });
    expect(result.halted).toBeNull();
    const actionsFor = (ref: string) =>
      result.plan!.actions.filter((action) => action.opportunityRef === ref).map((action) => action.proposedAction);

    expect(actionsFor('opp-carrier')).toEqual(['PREPARE_PACKAGE', 'READY_FOR_EXECUTION']);
    expect(actionsFor('opp-amazon')).toEqual(['PREPARE_PACKAGE', 'READY_FOR_EXECUTION']);
    expect(actionsFor('opp-customs')).toEqual(['REQUEST_AUTHORIZATION']);
    expect(actionsFor('opp-independent')).toEqual(['REQUEST_EVIDENCE']);

    // 优先级：EV 降序（18500 > 3200 > 1300 > 680，扣除成本与风险罚金后仍同序）
    expect(result.priority.ranked.map((entry) => entry.opportunityRef)).toEqual([
      'opp-customs',
      'opp-amazon',
      'opp-independent',
      'opp-carrier',
    ]);
    expect(Object.keys(result.priority.expectedRecoveryByCurrency)).toEqual(['USD']);
  });

  it('RECOVERY_SI_E2E_ZERO_EXTERNAL_WRITE：全程不调用任何工具执行路径、不产生外写/支付/报关/凭据读取', () => {
    counters.invoked = 0;
    const result = superviseRecovery({ state: state(), registry: registry(), nowMs: NOW_MS });
    expect(counters.invoked).toBe(0); // registry 只做登记，Phase 1 不执行
    expect(result.plan!.actions.every((action) => action.executionMode === 'SIMULATED')).toBe(true);
    expect(result.boundaries).toEqual({
      externalWritePerformed: false,
      paymentPerformed: false,
      productionCredentialsRead: false,
      realClaimSubmitted: false,
      customsFiled: false,
      canonicalFactMutated: false,
      executionAuthorizedInPhase1: false,
    });
    expect(RECOVERY_SUPERVISOR_BOUNDARY.createsSecondRuntime).toBe(false);
    expect(RECOVERY_SUPERVISOR_BOUNDARY.executesTools).toBe(false);
  });

  it('RECOVERY_SI_E2E_DETERMINISTIC_RERUN：同一 snapshot 重跑 → 完全相同的计划与决策', () => {
    const first = superviseRecovery({ state: state(), registry: registry(), nowMs: NOW_MS });
    const second = superviseRecovery({ state: state(), registry: registry(), nowMs: NOW_MS });
    expect(second).toEqual(first);
  });

  it('RECOVERY_SI_E2E_STALE_SNAPSHOT_FAIL_CLOSED：陈旧 snapshot → 停机且零决策', () => {
    const result = superviseRecovery({
      state: state(),
      registry: registry(),
      nowMs: NOW_MS + 60 * 60 * 1000,
      maxSnapshotAgeMs: 15 * 60 * 1000,
    });
    expect(result.halted).toBe('STALE_SNAPSHOT');
    expect(result.decisions).toEqual([]);
  });

  it('RECOVERY_SI_E2E_ACTION_GUARD_CONTRACT：READY_FOR_EXECUTION 显式声明 Action Guard / HITL 前置', () => {
    const result = superviseRecovery({ state: state(), registry: registry(), nowMs: NOW_MS });
    const ready = result.plan!.actions.filter((action) => action.proposedAction === 'READY_FOR_EXECUTION');
    expect(ready.length).toBeGreaterThan(0);
    for (const action of ready) {
      expect(action.prerequisites).toContain('action.guard');
      expect(action.prerequisites).toContain('hitl.or.owner.gate');
      expect(action.reasonCodes).toContain('SIMULATED_ONLY');
    }
    // 决策层：没有一项被标记为已获执行授权
    // Phase 1 动作集合里根本不存在 REAL_SUBMIT（类型层已排除，这里做运行时兜底）
    expect(result.decisions.every((decision) => (decision.proposedAction as string) !== 'REAL_SUBMIT')).toBe(true);
  });
});
