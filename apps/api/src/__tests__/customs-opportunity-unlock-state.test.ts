// V2-03 — CUSTOMS OPPORTUNITY UNLOCK STATE 回归
// ---------------------------------------------------------------------------
// 覆盖：六态顺序判定 / 无事实与缺证据引导补件（不得转收费检索）/ 资格不通过不展示金额 /
//   非 ESTIMATED 一律不显示金额（不得虚构）/ 多币种分别显示且无跨币种合计 /
//   DUTY_CORRECTION 与 DRAWBACK 分列且同一经济利益不重复计算 / 解锁入口仅在 READY_TO_UNLOCK 可见 /
//   跨租户不泄露信息 / 边界自证。

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_OPPORTUNITY_PROJECTION_BOUNDARY,
  CUSTOMS_OPPORTUNITY_PROJECTION_VERSION,
  projectCustomsOpportunity,
  type CustomsOpportunityProjectionInput,
} from '../services/customs/customs-opportunity-unlock-state';

function input(
  overrides: Partial<CustomsOpportunityProjectionInput> = {},
): CustomsOpportunityProjectionInput {
  const base: CustomsOpportunityProjectionInput = {
    scope: {
      organizationId: 'org-1',
      opportunityId: 'opp-1',
      ownerOrganizationId: 'org-1',
      caseFound: true,
    },
    entryFacts: { factCount: 2, currencies: ['USD'] },
    evidence: { requiredKinds: ['ENTRY_SUMMARY', 'DUTY_LINES'], presentKinds: ['ENTRY_SUMMARY', 'DUTY_LINES'] },
    discrepancy: { reportPresent: true, discrepancyCodes: ['DUTY_RATE_MISMATCH'] },
    eligibility: { status: 'ELIGIBLE', reasonCodes: [] },
    estimate: { status: 'ESTIMATED' },
    amountCandidates: [
      {
        currency: 'USD',
        kind: 'DUTY_CORRECTION',
        lineRef: 'line-1',
        estimatedAmount: '1200.00',
        source: 'ESTIMATE',
      },
    ],
    entitlement: { unlockActive: false, entitlementId: null },
    historicalScan: { candidateCount: 1 },
  };
  return { ...base, ...overrides };
}

describe('V2-03 六态投影 — 顺序与 fail-closed', () => {
  it('跨租户 → NO_DATA 且不泄露金额与入口', () => {
    const result = projectCustomsOpportunity(
      input({
        scope: {
          organizationId: 'org-1',
          opportunityId: 'opp-1',
          ownerOrganizationId: 'org-2',
          caseFound: true,
        },
      }),
    );
    expect(result.state).toBe('NO_DATA');
    expect(result.crossTenantRejected).toBe(true);
    expect(result.reasonCodes).toContain('CROSS_TENANT_REJECTED');
    expect(result.disclosableByCurrency).toEqual([]);
    expect(result.unlockEntryVisible).toBe(false);
  });

  it('机会不存在 → NO_DATA', () => {
    const result = projectCustomsOpportunity(
      input({
        scope: {
          organizationId: 'org-1',
          opportunityId: 'opp-1',
          ownerOrganizationId: 'org-1',
          caseFound: false,
        },
      }),
    );
    expect(result.state).toBe('NO_DATA');
    expect(result.reasonCodes).toContain('OPPORTUNITY_NOT_FOUND');
  });

  it('无 C1 事实 → NO_DATA，且禁止升级为收费检索', () => {
    const result = projectCustomsOpportunity(input({ entryFacts: { factCount: 0, currencies: [] } }));
    expect(result.state).toBe('NO_DATA');
    expect(result.reasonCodes).toContain('NO_ENTRY_FACTS');
    expect(result.reasonCodes).toContain('PAID_ESCALATION_FORBIDDEN');
    expect(result.paidEscalationAllowed).toBe(false);
  });

  it('缺必需证据 → NEEDS_EVIDENCE 并给出补件清单', () => {
    const result = projectCustomsOpportunity(
      input({ evidence: { requiredKinds: ['ENTRY_SUMMARY', 'ENTRY_7501'], presentKinds: ['ENTRY_SUMMARY'] } }),
    );
    expect(result.state).toBe('NEEDS_EVIDENCE');
    expect(result.requiresEvidence).toEqual(['ENTRY_7501']);
    expect(result.disclosableByCurrency).toEqual([]);
  });

  it('未见差异事实 → NEEDS_EVIDENCE', () => {
    const result = projectCustomsOpportunity(input({ discrepancy: { reportPresent: false, discrepancyCodes: [] } }));
    expect(result.state).toBe('NEEDS_EVIDENCE');
    expect(result.reasonCodes).toContain('DISCREPANCY_NOT_OBSERVED');
  });

  it('C4 明确 NOT_ELIGIBLE → NOT_ELIGIBLE，即使存在预估候选也不展示金额', () => {
    const result = projectCustomsOpportunity(
      input({ eligibility: { status: 'NOT_ELIGIBLE', reasonCodes: ['ENTRY_TOO_OLD'] } }),
    );
    expect(result.state).toBe('NOT_ELIGIBLE');
    expect(result.disclosableByCurrency).toEqual([]);
    expect(result.unlockEntryVisible).toBe(false);
  });

  it('C4 缺失 → 不下结论，回到 NEEDS_EVIDENCE', () => {
    const result = projectCustomsOpportunity(input({ eligibility: null }));
    expect(result.state).toBe('NEEDS_EVIDENCE');
    expect(result.reasonCodes).toContain('ELIGIBILITY_INDETERMINATE');
  });

  it('C4 ELIGIBLE + C5 ESTIMATED + 正金额 → READY_TO_UNLOCK（唯一可见解锁入口）', () => {
    const result = projectCustomsOpportunity(input());
    expect(result.state).toBe('READY_TO_UNLOCK');
    expect(result.unlockEntryVisible).toBe(true);
    expect(result.disclosableByCurrency).toEqual([
      { currency: 'USD', dutyCorrection: '1200', drawback: null },
    ]);
  });

  it('C5 非 ESTIMATED → 状态不越过 FREE_ESTIMATED，且金额一律为空（不得虚构）', () => {
    for (const status of ['NOT_ESTIMATED', 'INDETERMINATE'] as const) {
      const result = projectCustomsOpportunity(input({ estimate: { status } }));
      expect(result.state).toBe('NEEDS_EVIDENCE');
      expect(result.disclosableByCurrency).toEqual([]);
      expect(result.reasonCodes).toContain('ESTIMATE_NOT_ESTIMATED');
    }
  });

  it('C4 INDETERMINATE + C5 ESTIMATED → FREE_ESTIMATED，入口不可见且金额必须扣留（CHANGE 01）', () => {
    const result = projectCustomsOpportunity(
      input({ eligibility: { status: 'INDETERMINATE', reasonCodes: ['OTHER_KIND_LINES_PRESENT'] } }),
    );
    expect(result.state).toBe('FREE_ESTIMATED');
    expect(result.unlockEntryVisible).toBe(false);
    expect(result.disclosableByCurrency).toEqual([]);
    expect(result.reasonCodes).toContain('AMOUNT_WITHHELD_PENDING_ELIGIBILITY');
  });

  it('组合矩阵：仅 C4=ELIGIBLE 且 C5=ESTIMATED 才输出金额（C4 三态 × C5 全状态）', () => {
    for (const eligibilityStatus of ['ELIGIBLE', 'INDETERMINATE', 'NOT_ELIGIBLE'] as const) {
      for (const estimateStatus of ['ESTIMATED', 'NOT_ESTIMATED', 'INDETERMINATE'] as const) {
        const result = projectCustomsOpportunity(
          input({
            eligibility: { status: eligibilityStatus, reasonCodes: [] },
            estimate: { status: estimateStatus },
          }),
        );
        const amountsShown = result.disclosableByCurrency.length > 0;
        const expectedAmounts = eligibilityStatus === 'ELIGIBLE' && estimateStatus === 'ESTIMATED';
        expect(amountsShown).toBe(expectedAmounts);
        if (!expectedAmounts) {
          expect(result.unlockEntryVisible).toBe(false);
        }
      }
    }
  });

  it('已取得付费权益 → UNLOCKED', () => {
    const result = projectCustomsOpportunity(
      input({ entitlement: { unlockActive: true, entitlementId: 'ent-1' } }),
    );
    expect(result.state).toBe('UNLOCKED');
    expect(result.reasonCodes).toContain('PAID_ENTITLEMENT_ACTIVE');
  });

  it('权益标记为真但无权益 id → 不进入 UNLOCKED（fail-closed）', () => {
    const result = projectCustomsOpportunity(
      input({ entitlement: { unlockActive: true, entitlementId: null } }),
    );
    expect(result.state).not.toBe('UNLOCKED');
  });
});

describe('V2-03 金额语义 — 多币种 / 类型分离 / 不重复计算', () => {
  it('多币种分别显示，跨币种合计恒为 null 且不做汇率换算', () => {
    const result = projectCustomsOpportunity(
      input({
        amountCandidates: [
          {
            currency: 'USD',
            kind: 'DUTY_CORRECTION',
            lineRef: 'us-1',
            estimatedAmount: '500.00',
            source: 'ESTIMATE',
          },
          {
            currency: 'EUR',
            kind: 'DUTY_CORRECTION',
            lineRef: 'eu-1',
            estimatedAmount: '300.00',
            source: 'ESTIMATE',
          },
        ],
      }),
    );
    expect(result.disclosableByCurrency).toEqual([
      { currency: 'EUR', dutyCorrection: '300', drawback: null },
      { currency: 'USD', dutyCorrection: '500', drawback: null },
    ]);
    expect(result.totalAcrossCurrencies).toBeNull();
    expect(result.appliesFxConversion).toBe(false);
    expect(result.reasonCodes).toContain('NO_CROSS_CURRENCY_TOTAL');
  });

  it('同一 (currency, lineRef) 只计一次，重复项被显式排除', () => {
    const result = projectCustomsOpportunity(
      input({
        amountCandidates: [
          {
            currency: 'USD',
            kind: 'DUTY_CORRECTION',
            lineRef: 'line-1',
            estimatedAmount: '1200.00',
            source: 'ESTIMATE',
          },
          {
            currency: 'USD',
            kind: 'DRAWBACK',
            lineRef: 'line-1',
            estimatedAmount: '1200.00',
            source: 'DRAWBACK_MODEL',
          },
        ],
      }),
    );
    expect(result.disclosableByCurrency).toEqual([
      { currency: 'USD', dutyCorrection: '1200', drawback: null },
    ]);
    expect(result.duplicateBenefitsExcluded).toEqual([
      { currency: 'USD', lineRef: 'line-1', kind: 'DRAWBACK' },
    ]);
    expect(result.reasonCodes).toContain('DUPLICATE_ECONOMIC_BENEFIT_EXCLUDED');
  });

  it('关税纠错与 Duty Drawback 分列展示，不合并', () => {
    const result = projectCustomsOpportunity(
      input({
        amountCandidates: [
          {
            currency: 'USD',
            kind: 'DUTY_CORRECTION',
            lineRef: 'line-1',
            estimatedAmount: '1200.00',
            source: 'ESTIMATE',
          },
          {
            currency: 'USD',
            kind: 'DRAWBACK',
            lineRef: 'line-2',
            estimatedAmount: '400.00',
            source: 'DRAWBACK_MODEL',
          },
        ],
      }),
    );
    expect(result.disclosableByCurrency).toEqual([
      { currency: 'USD', dutyCorrection: '1200', drawback: '400' },
    ]);
  });

  it('零值 / 负值 / 非法金额一律剔除；全部剔除时给出 NO_DISCLOSABLE_AMOUNT', () => {
    const result = projectCustomsOpportunity(
      input({
        amountCandidates: [
          { currency: 'USD', kind: 'DUTY_CORRECTION', lineRef: 'a', estimatedAmount: '0', source: 'ESTIMATE' },
          { currency: 'USD', kind: 'DUTY_CORRECTION', lineRef: 'b', estimatedAmount: '-5', source: 'ESTIMATE' },
          { currency: 'USD', kind: 'DUTY_CORRECTION', lineRef: 'c', estimatedAmount: 'x', source: 'ESTIMATE' },
        ],
      }),
    );
    expect(result.disclosableByCurrency).toEqual([]);
    expect(result.unlockEntryVisible).toBe(false);
    expect(result.state).toBe('FREE_ESTIMATED');
    expect(result.reasonCodes).toContain('NO_DISCLOSABLE_AMOUNT');
  });

  it('金额规范化去尾零，但不做跨币种换算', () => {
    const result = projectCustomsOpportunity(
      input({
        amountCandidates: [
          {
            currency: 'JPY',
            kind: 'DUTY_CORRECTION',
            lineRef: 'jp-1',
            estimatedAmount: '010000.5000',
            source: 'DISCREPANCY',
          },
        ],
      }),
    );
    expect(result.disclosableByCurrency).toEqual([
      { currency: 'JPY', dutyCorrection: '10000.5', drawback: null },
    ]);
  });
});

describe('V2-03 边界自证', () => {
  it('投影永不标记可计费 / 已提交 / 已收款 / 已扣费', () => {
    const result = projectCustomsOpportunity(input());
    expect(result.kind).toBe('CUSTOMS_OPPORTUNITY_PROJECTION');
    expect(result.version).toBe(CUSTOMS_OPPORTUNITY_PROJECTION_VERSION);
    expect(result.billable).toBe(false);
    expect(result.filingPerformed).toBe(false);
    expect(result.paymentPerformed).toBe(false);
    expect(result.chargedFee).toBeNull();
    expect(result.estimateOnly).toBe(true);
    expect(result.productionCredentials).toBe('ABSENT');
  });

  it('CUSTOMS_OPPORTUNITY_PROJECTION_BOUNDARY 声明无外部调用 / 无资金动作', () => {
    expect(CUSTOMS_OPPORTUNITY_PROJECTION_BOUNDARY.externalCallPerformed).toBe(false);
    expect(CUSTOMS_OPPORTUNITY_PROJECTION_BOUNDARY.providerInvoked).toBe(false);
    expect(CUSTOMS_OPPORTUNITY_PROJECTION_BOUNDARY.billable).toBe(false);
    expect(CUSTOMS_OPPORTUNITY_PROJECTION_BOUNDARY.autoCollectionEnabled).toBe(false);
    expect(CUSTOMS_OPPORTUNITY_PROJECTION_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});
