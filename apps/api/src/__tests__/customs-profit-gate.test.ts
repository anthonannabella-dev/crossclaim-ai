// V2-04 — CUSTOMS PROFIT GATE 回归
// ---------------------------------------------------------------------------
// 覆盖：风险调整后贡献毛利（不得只看追回总额）/ 成功概率必须显式声明为估算且 ∈(0,1] /
//   费率来自既有 CUSTOMS_SUCCESS_15 政策对象（不新建第二套）/ 缺报价·超预算·跨币种·政策失效一律 HOLD /
//   定点 floor 计费（不高估收入）/ 订阅补贴须显式允许 / 边界自证。

import { describe, expect, it } from 'vitest';

import type { FeePolicy } from '../services/commercial/fee-policy';
import {
  CUSTOMS_PROFIT_GATE_BOUNDARY,
  CUSTOMS_PROFIT_GATE_VERSION,
  addDecimalAmounts,
  applyBpsFloorToCent,
  evaluateCustomsProfitGate,
  multiplyFloorToCent,
  ratioToBpsFloor,
  subtractDecimalAmounts,
  type CustomsProfitGateInput,
  type CustomsProfitGatePolicy,
} from '../services/customs/customs-profit-gate';

const AS_OF = '2026-10-09';

const FEE_POLICY: FeePolicy = {
  policyId: 'CUSTOMS_SUCCESS_15',
  policyRef: 'CUSTOMS_SUCCESS',
  policyKind: 'CUSTOMS_SUCCESS',
  version: 'v1',
  rateBps: 1500,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  waiverCapAmount: null,
  currency: null,
  description: '15% customs success fee (test fixture)',
};

const POLICY: CustomsProfitGatePolicy = {
  policyId: 'customs-profit-floor-v1',
  policyVersion: 'v1',
  minContributionMarginByCurrency: { USD: '100.00' },
  minContributionMarginBps: 2000,
  allowSubscriptionSubsidy: false,
};

function input(overrides: Partial<CustomsProfitGateInput> = {}): CustomsProfitGateInput {
  const base: CustomsProfitGateInput = {
    currency: 'USD',
    expectedRecoveredAmount: '10000.00',
    successProbability: '0.4',
    probabilityIsEstimate: true,
    feePolicy: FEE_POLICY,
    asOfDate: AS_OF,
    earnedSubscriptionContribution: '0.00',
    providerQuotedCost: '12.00',
    expectedDirectCost: '3.00',
    maximumPerCheckCost: '25.00',
    tenantRemainingBudget: '500.00',
    policy: POLICY,
  };
  return { ...base, ...overrides };
}

describe('V2-04 盈利判定 — 风险调整后贡献毛利', () => {
  it('正常场景 → PASS，并给出完整的风险调整后测算', () => {
    const result = evaluateCustomsProfitGate(input());
    expect(result.kind).toBe('CUSTOMS_PROFIT_GATE');
    expect(result.version).toBe(CUSTOMS_PROFIT_GATE_VERSION);
    expect(result.decision).toBe('PASS');
    expect(result.projectedSuccessFee).toBe('1500.00'); // 10000 × 15%
    expect(result.riskAdjustedSuccessFee).toBe('600.00'); // × 0.4
    expect(result.subscriptionContributionApplied).toBe('0.00');
    expect(result.expectedRevenue).toBe('600.00');
    expect(result.expectedCost).toBe('15.00');
    expect(result.expectedContributionMargin).toBe('585.00');
    expect(result.expectedContributionMarginBps).toBe(9750);
    expect(result.reasonCodes).toEqual(['PROFIT_GATE_PASS']);
    expect(result.externalCallPerformed).toBe(false);
    expect(result.chargedAmount).toBeNull();
  });

  it('只按追回总额看会误判：追回额极大但成本同样高 → HOLD', () => {
    const result = evaluateCustomsProfitGate(
      input({ providerQuotedCost: '700.00', expectedDirectCost: '0.00' }),
    );
    expect(result.decision).toBe('HOLD');
    expect(result.reasonCodes).toContain('TENANT_BUDGET_EXCEEDED');
    expect(result.reasonCodes).toContain('MARGIN_BELOW_FLOOR');
  });
});

describe('V2-04 费率与概率的证据要求', () => {
  it('缺版本化费率政策 → HOLD（不新建第二套费率）', () => {
    const result = evaluateCustomsProfitGate(input({ feePolicy: null }));
    expect(result.decision).toBe('HOLD');
    expect(result.reasonCodes).toContain('FEE_POLICY_MISSING');
    expect(result.projectedSuccessFee).toBeNull();
  });

  it('费率政策无费率（waiver / micro）→ HOLD', () => {
    const result = evaluateCustomsProfitGate(input({ feePolicy: { ...FEE_POLICY, rateBps: null } }));
    expect(result.reasonCodes).toContain('FEE_POLICY_RATE_MISSING');
  });

  it('费率政策币种与案件币种不一致 → HOLD', () => {
    const result = evaluateCustomsProfitGate(input({ feePolicy: { ...FEE_POLICY, currency: 'EUR' } }));
    expect(result.reasonCodes).toContain('CURRENCY_MISMATCH');
  });

  it('费率政策在判定日未生效 / 已失效 → HOLD', () => {
    const expired = evaluateCustomsProfitGate(
      input({ feePolicy: { ...FEE_POLICY, effectiveTo: '2026-09-30' } }),
    );
    expect(expired.reasonCodes).toContain('FEE_POLICY_INACTIVE_AT_DATE');

    const future = evaluateCustomsProfitGate(
      input({ feePolicy: { ...FEE_POLICY, effectiveFrom: '2026-11-01' } }),
    );
    expect(future.reasonCodes).toContain('FEE_POLICY_INACTIVE_AT_DATE');
  });

  it('缺成功概率 → HOLD（不得默认 100%）', () => {
    const result = evaluateCustomsProfitGate(input({ successProbability: '' }));
    expect(result.reasonCodes).toContain('SUCCESS_PROBABILITY_MISSING');
  });

  it('把未知伪装成确定概率（未声明为估算）→ HOLD', () => {
    const result = evaluateCustomsProfitGate(input({ probabilityIsEstimate: false }));
    expect(result.reasonCodes).toContain('SUCCESS_PROBABILITY_ASSERTED_CERTAIN');
  });

  it('概率越界（0 / 1 / >1）→ HOLD', () => {
    for (const probability of ['0', '1', '1.5']) {
      const result = evaluateCustomsProfitGate(input({ successProbability: probability }));
      expect(result.decision).toBe('HOLD');
      expect(result.reasonCodes).toContain('SUCCESS_PROBABILITY_OUT_OF_RANGE');
    }
  });

  it('预计追回金额非法（0 / 非定点）→ HOLD', () => {
    for (const amount of ['0', 'abc', '-5']) {
      const result = evaluateCustomsProfitGate(input({ expectedRecoveredAmount: amount }));
      expect(result.decision).toBe('HOLD');
      expect(result.reasonCodes).toContain('RECOVERED_AMOUNT_INVALID');
    }
  });
});

describe('V2-04 预算与报价门禁', () => {
  it('缺 provider 报价 → HOLD（不得先调用后补价）', () => {
    const result = evaluateCustomsProfitGate(input({ providerQuotedCost: null }));
    expect(result.reasonCodes).toContain('PROVIDER_QUOTE_MISSING');
  });

  it('报价非法 → HOLD', () => {
    const result = evaluateCustomsProfitGate(input({ providerQuotedCost: '12.34567' }));
    expect(result.reasonCodes).toContain('PROVIDER_QUOTE_INVALID');
  });

  it('超单次上限 → HOLD；超租户预算 → HOLD', () => {
    const perCheck = evaluateCustomsProfitGate(
      input({ providerQuotedCost: '30.00', maximumPerCheckCost: '25.00' }),
    );
    expect(perCheck.reasonCodes).toContain('PER_CHECK_BUDGET_EXCEEDED');

    const tenant = evaluateCustomsProfitGate(
      input({ providerQuotedCost: '12.00', tenantRemainingBudget: '11.99' }),
    );
    expect(tenant.reasonCodes).toContain('TENANT_BUDGET_EXCEEDED');
  });

  it('直接成本非法 → HOLD', () => {
    const result = evaluateCustomsProfitGate(input({ expectedDirectCost: 'x' }));
    expect(result.reasonCodes).toContain('DIRECT_COST_INVALID');
  });
});

describe('V2-04 毛利下限与订阅补贴', () => {
  it('毛利低于绝对下限 → HOLD', () => {
    const result = evaluateCustomsProfitGate(
      input({
        policy: { ...POLICY, minContributionMarginByCurrency: { USD: '600.00' } },
      }),
    );
    expect(result.decision).toBe('HOLD');
    expect(result.reasonCodes).toContain('MARGIN_BELOW_FLOOR');
    expect(result.expectedContributionMargin).toBe('585.00');
  });

  it('毛利低于费率下限 → HOLD', () => {
    const result = evaluateCustomsProfitGate(input({ policy: { ...POLICY, minContributionMarginBps: 9800 } }));
    expect(result.reasonCodes).toContain('MARGIN_RATE_BELOW_FLOOR');
  });

  it('政策未定义该币种下限 → HOLD（fail-closed）', () => {
    const result = evaluateCustomsProfitGate(
      input({ policy: { ...POLICY, minContributionMarginByCurrency: {} } }),
    );
    expect(result.reasonCodes).toContain('MARGIN_BELOW_FLOOR');
  });

  it('提供订阅补贴但政策未允许 → HOLD；允许时计入收入', () => {
    const notAllowed = evaluateCustomsProfitGate(
      input({ earnedSubscriptionContribution: '50.00' }),
    );
    expect(notAllowed.reasonCodes).toContain('SUBSCRIPTION_SUBSIDY_NOT_ALLOWED');

    const allowed = evaluateCustomsProfitGate(
      input({
        earnedSubscriptionContribution: '50.00',
        policy: { ...POLICY, allowSubscriptionSubsidy: true },
      }),
    );
    expect(allowed.decision).toBe('PASS');
    expect(allowed.subscriptionContributionApplied).toBe('50.00');
    expect(allowed.expectedRevenue).toBe('650.00');
    expect(allowed.expectedContributionMargin).toBe('635.00');
  });
});

describe('V2-04 定点数算术（不使用浮点）', () => {
  it('applyBpsFloorToCent 向下取整到分', () => {
    expect(applyBpsFloorToCent('10000.00', 1500)).toBe('1500.00');
    expect(applyBpsFloorToCent('0.01', 1500)).toBe('0.00');
    expect(applyBpsFloorToCent('1.00', 3333)).toBe('0.33');
    expect(applyBpsFloorToCent('abc', 1500)).toBeNull();
    expect(applyBpsFloorToCent('1.00', -1)).toBeNull();
  });

  it('multiplyFloorToCent / add / subtract / ratio', () => {
    expect(multiplyFloorToCent('1500.00', '0.4')).toBe('600.00');
    expect(multiplyFloorToCent('0.01', '0.5')).toBe('0.00');
    expect(addDecimalAmounts('600.00', '50.00')).toBe('650.00');
    expect(subtractDecimalAmounts('650.00', '15.00')).toBe('635.00');
    expect(ratioToBpsFloor('585.00', '600.00')).toBe(9750);
    expect(ratioToBpsFloor('1.00', '0.00')).toBeNull();
    expect(addDecimalAmounts('1.00', 'x')).toBeNull();
  });
});

describe('V2-04 边界自证', () => {
  it('CUSTOMS_PROFIT_GATE_BOUNDARY 声明无外部调用 / 无资金动作 / 无浮点', () => {
    expect(CUSTOMS_PROFIT_GATE_BOUNDARY.externalCallPerformed).toBe(false);
    expect(CUSTOMS_PROFIT_GATE_BOUNDARY.providerInvoked).toBe(false);
    expect(CUSTOMS_PROFIT_GATE_BOUNDARY.chargedAmount).toBeNull();
    expect(CUSTOMS_PROFIT_GATE_BOUNDARY.autoCollectionEnabled).toBe(false);
    expect(CUSTOMS_PROFIT_GATE_BOUNDARY.usesFloatingPoint).toBe(false);
    expect(CUSTOMS_PROFIT_GATE_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});
