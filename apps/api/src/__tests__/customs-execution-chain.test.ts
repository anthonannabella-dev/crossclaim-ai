// V2-07 — CUSTOMS EXECUTION CHAIN 回归
// ---------------------------------------------------------------------------
// 覆盖：点击≠付款 / 付款≠有授权 / 领取前后复查 / Profit Gate 先于 Provider /
//   外写需 Action Guard + 外写授权 / 结算必须有可信事实 / 同一结算不重复计费 /
//   争议·超时·Kill Switch 一律 HOLD / 自动收款恒 HOLD。

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_EXECUTION_CHAIN_BOUNDARY,
  CUSTOMS_EXECUTION_CHAIN_VERSION,
  evaluateCustomsExecutionChain,
  isCustomsExecutionHolding,
  type CustomsExecutionFacts,
} from '../services/customs/customs-execution-chain';

function facts(overrides: Partial<CustomsExecutionFacts> = {}): CustomsExecutionFacts {
  const base: CustomsExecutionFacts = {
    organizationId: 'org-1',
    opportunity: { caseFound: true, ownerOrganizationId: 'org-1' },
    customerDecision: { started: true },
    payment: { verifiedPaid: true, entitlementActive: true, quotaRemaining: 1 },
    claim: { taskClaimed: true, recheckedAfterClaim: true },
    authorization: {
      standingAuthorizationValid: true,
      externalWriteAuthorized: true,
      actionGuardApproved: true,
    },
    profitGate: { decision: 'PASS' },
    provider: { available: true, quotedCost: '12.00' },
    evidence: { verified: true },
    settlement: {
      verifiedActualRecovery: true,
      settlementId: 'st-1',
      amount: '10000.00',
      currency: 'USD',
    },
    disputes: { revokedOrRefunded: false },
    killSwitch: { engaged: false },
    timeouts: { timedOut: false },
    billedSettlementIds: new Set<string>(),
  };
  return { ...base, ...overrides };
}

describe('V2-07 执行链 — 全局安全闸门', () => {
  it('跨租户 → FREE_DISCOVERY 且不放行任何后续状态', () => {
    const result = evaluateCustomsExecutionChain(
      facts({ opportunity: { caseFound: true, ownerOrganizationId: 'org-2' } }),
    );
    expect(result.state).toBe('FREE_DISCOVERY');
    expect(result.holdReasons).toEqual(['CROSS_TENANT_REJECTED']);
    expect(result.externalWritePermitted).toBe(false);
    expect(result.successFee.state).toBe('NONE');
  });

  it('机会不存在 / Kill Switch / 超时 → 明确 HOLD', () => {
    expect(
      evaluateCustomsExecutionChain(
        facts({ opportunity: { caseFound: false, ownerOrganizationId: null } }),
      ).holdReasons,
    ).toEqual(['OPPORTUNITY_NOT_FOUND']);
    expect(
      evaluateCustomsExecutionChain(facts({ killSwitch: { engaged: true } })).holdReasons,
    ).toEqual(['KILL_SWITCH_ENGAGED']);
    expect(
      evaluateCustomsExecutionChain(facts({ timeouts: { timedOut: true } })).holdReasons,
    ).toEqual(['TIMEOUT_HOLD']);
  });
});

describe('V2-07 执行链 — 客户启动 / 付款 / 权益是三个独立门禁', () => {
  it('客户未点击启动 → WAITING_CUSTOMER_START', () => {
    const result = evaluateCustomsExecutionChain(facts({ customerDecision: { started: false } }));
    expect(result.state).toBe('WAITING_CUSTOMER_START');
    expect(result.holdReasons).toEqual(['CUSTOMER_START_REQUIRED']);
    expect(result.nextAllowedState).toBe('WAITING_VERIFIED_PAYMENT');
  });

  it('客户已点击但未真实付款 → 停在 WAITING_VERIFIED_PAYMENT（点击 ≠ 付款）', () => {
    const result = evaluateCustomsExecutionChain(
      facts({ payment: { verifiedPaid: false, entitlementActive: false, quotaRemaining: 0 } }),
    );
    expect(result.state).toBe('WAITING_VERIFIED_PAYMENT');
    expect(result.holdReasons).toEqual(['VERIFIED_PAYMENT_REQUIRED', 'ENTITLEMENT_REQUIRED']);
  });

  it('已付款但无有效权益 / 额度耗尽 → 不得进入领取环节', () => {
    expect(
      evaluateCustomsExecutionChain(
        facts({ payment: { verifiedPaid: true, entitlementActive: false, quotaRemaining: 1 } }),
      ).holdReasons,
    ).toEqual(['ENTITLEMENT_REQUIRED']);
    expect(
      evaluateCustomsExecutionChain(
        facts({ payment: { verifiedPaid: true, entitlementActive: true, quotaRemaining: 0 } }),
      ).holdReasons,
    ).toEqual(['QUOTA_EXHAUSTED']);
  });
});

describe('V2-07 执行链 — 领取与领取后复查', () => {
  it('未领取 → TASK_CLAIMED', () => {
    const result = evaluateCustomsExecutionChain(
      facts({ claim: { taskClaimed: false, recheckedAfterClaim: false } }),
    );
    expect(result.state).toBe('TASK_CLAIMED');
    expect(result.holdReasons).toEqual(['TASK_NOT_CLAIMED']);
  });

  it('领取后未复查 → RECHECK_ENTITLEMENT_AND_AUTHORIZATION', () => {
    const result = evaluateCustomsExecutionChain(
      facts({ claim: { taskClaimed: true, recheckedAfterClaim: false } }),
    );
    expect(result.state).toBe('RECHECK_ENTITLEMENT_AND_AUTHORIZATION');
    expect(result.holdReasons).toEqual(['POST_CLAIM_RECHECK_REQUIRED']);
  });

  it('复查时 Standing Authorization 失效 → HOLD', () => {
    const result = evaluateCustomsExecutionChain(
      facts({
        authorization: {
          standingAuthorizationValid: false,
          externalWriteAuthorized: true,
          actionGuardApproved: true,
        },
      }),
    );
    expect(result.holdReasons).toEqual(['STANDING_AUTHORIZATION_INVALID']);
  });
});

describe('V2-07 执行链 — Profit Gate 先于 Provider，外写需共享门禁', () => {
  it('Profit Gate 未通过 → 停在 PROFIT_GATE，不进入 Provider', () => {
    const result = evaluateCustomsExecutionChain(facts({ profitGate: { decision: 'HOLD' } }));
    expect(result.state).toBe('PROFIT_GATE');
    expect(result.holdReasons).toEqual(['PROFIT_GATE_HOLD']);
    expect(result.externalWritePermitted).toBe(false);
  });

  it('Provider 不可用 / 缺报价 → 停在 PROVIDER_READY 且不放行外写', () => {
    const unavailable = evaluateCustomsExecutionChain(
      facts({ provider: { available: false, quotedCost: '12.00' } }),
    );
    expect(unavailable.state).toBe('PROVIDER_READY');
    expect(unavailable.holdReasons).toEqual(['PROVIDER_NOT_READY']);

    const noQuote = evaluateCustomsExecutionChain(
      facts({ provider: { available: true, quotedCost: null } }),
    );
    expect(noQuote.holdReasons).toEqual(['PROVIDER_QUOTE_MISSING']);
  });

  it('缺 Action Guard 审批 / 缺外写授权 → 外写不放行', () => {
    const noGuard = evaluateCustomsExecutionChain(
      facts({
        authorization: {
          standingAuthorizationValid: true,
          externalWriteAuthorized: true,
          actionGuardApproved: false,
        },
      }),
    );
    expect(noGuard.holdReasons).toEqual(['ACTION_GUARD_APPROVAL_REQUIRED']);
    expect(noGuard.externalWritePermitted).toBe(false);

    const noExternalWrite = evaluateCustomsExecutionChain(
      facts({
        authorization: {
          standingAuthorizationValid: true,
          externalWriteAuthorized: false,
          actionGuardApproved: true,
        },
      }),
    );
    expect(noExternalWrite.holdReasons).toEqual(['EXTERNAL_WRITE_NOT_AUTHORIZED']);
    expect(noExternalWrite.externalWritePermitted).toBe(false);
  });
});

describe('V2-07 执行链 — 证据、结算与 15% 成功费', () => {
  it('证据未核验 → EVIDENCE_VERIFICATION', () => {
    const result = evaluateCustomsExecutionChain(facts({ evidence: { verified: false } }));
    expect(result.state).toBe('EVIDENCE_VERIFICATION');
    expect(result.holdReasons).toEqual(['EVIDENCE_NOT_VERIFIED']);
  });

  it('争议 / 冲正 → 停在 CASE_PROGRESS，不产生成功费', () => {
    const result = evaluateCustomsExecutionChain(facts({ disputes: { revokedOrRefunded: true } }));
    expect(result.state).toBe('CASE_PROGRESS');
    expect(result.holdReasons).toEqual(['DISPUTE_OR_REFUND_OPEN']);
    expect(result.successFee.state).toBe('NONE');
  });

  it('结算未获证实 / 缺结算号 / 金额非法 → 不产生成功费', () => {
    expect(
      evaluateCustomsExecutionChain(
        facts({
          settlement: {
            verifiedActualRecovery: false,
            settlementId: 'st-1',
            amount: '10000.00',
            currency: 'USD',
          },
        }),
      ).holdReasons,
    ).toContain('SETTLEMENT_NOT_VERIFIED');
    expect(
      evaluateCustomsExecutionChain(
        facts({
          settlement: { verifiedActualRecovery: true, settlementId: null, amount: '10.00', currency: 'USD' },
        }),
      ).holdReasons,
    ).toContain('SETTLEMENT_REFERENCE_MISSING');
    const zero = evaluateCustomsExecutionChain(
      facts({
        settlement: { verifiedActualRecovery: true, settlementId: 'st-1', amount: '0', currency: 'USD' },
      }),
    );
    expect(zero.holdReasons).toContain('SETTLEMENT_AMOUNT_INVALID');
    expect(zero.successFee.state).toBe('NONE');
  });

  it('已验证实际回款 10000 → SUCCESS_FEE_RECEIVABLE 1500.00，且自动收款仍 HOLD', () => {
    const result = evaluateCustomsExecutionChain(facts());
    expect(result.state).toBe('SUCCESS_FEE_RECEIVABLE');
    expect(result.holding).toBe(false);
    expect(result.holdReasons).toEqual([]);
    expect(result.successFee.state).toBe('RECEIVABLE');
    expect(result.successFee.amount).toBe('1500.00');
    expect(result.successFee.basisSettlementId).toBe('st-1');
    expect(result.successFee.rateBps).toBe(1500);
    expect(result.autoCollection).toBe('HOLD');
    expect(result.externalWritePerformed).toBe(false);
    expect(result.chargedAmount).toBeNull();
  });

  it('同一结算重复出现 → 抑制成功费（不重复计费）', () => {
    const result = evaluateCustomsExecutionChain(
      facts({ billedSettlementIds: new Set<string>(['st-1']) }),
    );
    expect(result.state).toBe('VERIFIED_SETTLEMENT');
    expect(result.holdReasons).toEqual(['DUPLICATE_SUCCESS_FEE_SUPPRESSED']);
    expect(result.successFee.state).toBe('NONE');
  });

  it('部分回款按各自结算单独计费（示例：2000/3000/5000 → 300/450/750）', () => {
    const fees = ['2000.00', '3000.00', '5000.00'].map(
      (amount, index) =>
        evaluateCustomsExecutionChain(
          facts({
            settlement: {
              verifiedActualRecovery: true,
              settlementId: `st-${index + 1}`,
              amount,
              currency: 'USD',
            },
          }),
        ).successFee.amount,
    );
    expect(fees).toEqual(['300.00', '450.00', '750.00']);
  });

  it('isCustomsExecutionHolding 与 holding 标志一致', () => {
    expect(isCustomsExecutionHolding(evaluateCustomsExecutionChain(facts()))).toBe(false);
    expect(
      isCustomsExecutionHolding(evaluateCustomsExecutionChain(facts({ evidence: { verified: false } }))),
    ).toBe(true);
  });
});

describe('V2-07 执行链 — 边界自证', () => {
  it('CUSTOMS_EXECUTION_CHAIN_BOUNDARY 不创建运行时 / 不自动收款', () => {
    expect(CUSTOMS_EXECUTION_CHAIN_BOUNDARY.createsRuntime).toBe(false);
    expect(CUSTOMS_EXECUTION_CHAIN_BOUNDARY.createsScheduler).toBe(false);
    expect(CUSTOMS_EXECUTION_CHAIN_BOUNDARY.externalWritePerformed).toBe(false);
    expect(CUSTOMS_EXECUTION_CHAIN_BOUNDARY.autoCollection).toBe('HOLD');
    expect(CUSTOMS_EXECUTION_CHAIN_BOUNDARY.productionCredentials).toBe('ABSENT');
    expect(CUSTOMS_EXECUTION_CHAIN_VERSION).toBe('customs-execution-chain-v2.0.0');
  });
});
