// V2-08 — CUSTOMS SUCCESS FEE COLLECTION 回归
// ---------------------------------------------------------------------------
// 覆盖：五态互不混用 / 无真实回款不计费 / 重复通知不重复计费 / 客户撤销授权即停 /
//   自动收款未开闸 → 应收账单路径 / 门禁全开才 AUTHORIZED / 实际到账才算 COLLECTED /
//   部分到账保留余额 / 退款与冲正留下可审计调整 / 跨币种不求和 / 边界自证。

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_FEE_COLLECTION_BOUNDARY,
  CUSTOMS_FEE_COLLECTION_VERSION,
  evaluateCustomsSuccessFeeCollection,
  sumReceivablesSameCurrency,
  verifyFeeCollectionFact,
  type CustomsFeeCollectionFact,
  type CustomsFeeCollectionInput,
  type VerifiedFeeCollectionFact,
} from '../services/customs/customs-success-fee-collection';
import type { FeePolicy } from '../services/commercial/fee-policy';

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
  description: 'test fixture',
};

/** CHANGE 03：收款事实必须经核验（品牌类型），测试走同一条核验路径。 */
function collectionFact(
  overrides: Partial<CustomsFeeCollectionFact> = {},
): VerifiedFeeCollectionFact {
  const verified = verifyFeeCollectionFact({
    fact: {
      transactionId: 'txn-1',
      merchantAccountId: 'acct-1',
      receivableId: 'st-1',
      collectedAmount: '1500.00',
      outcome: 'COLLECTED',
      source: 'PAYMENT_PROVIDER_WEBHOOK',
      occurredAt: '2026-10-10T00:00:00.000Z',
      ...overrides,
    },
    expectedReceivableId: 'st-1',
    expectedMerchantAccountId: 'acct-1',
  });
  if (verified === null) throw new Error('TEST_COLLECTION_FACT_UNVERIFIED');
  return verified;
}

function input(overrides: Partial<CustomsFeeCollectionInput> = {}): CustomsFeeCollectionInput {
  const base: CustomsFeeCollectionInput = {
    settlement: {
      settlementId: 'st-1',
      organizationId: 'org-1',
      currency: 'USD',
      verifiedAmount: '10000.00',
      verified: true,
    },
    authorization: {
      active: true,
      revoked: false,
      paymentMethodSupportsAutoCollection: true,
      hostAutoCollectionEnabled: true,
    },
    killSwitch: { engaged: false },
    billedSettlementIds: new Set<string>(),
    feePolicy: FEE_POLICY,
  };
  return { ...base, ...overrides };
}

describe('V2-08 费率来源 — CHANGE 07', () => {
  it('缺少版本化费率策略 → 不产生应收（FEE_POLICY_MISSING）', () => {
    const result = evaluateCustomsSuccessFeeCollection(input({ feePolicy: null }));
    expect(result.state).toBe('SUCCESS_FEE_CALCULATED');
    expect(result.reasonCodes).toContain('FEE_POLICY_MISSING');
    expect(result.feeAmount).toBeNull();
  });

  it('策略无费率（waiver / micro）→ 不产生应收（FEE_POLICY_RATE_MISSING）', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ feePolicy: { ...FEE_POLICY, rateBps: null } }),
    );
    expect(result.reasonCodes).toContain('FEE_POLICY_RATE_MISSING');
  });

  it('策略币种与结算币种不一致 → 不产生应收（CURRENCY_MISMATCH）', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ feePolicy: { ...FEE_POLICY, currency: 'EUR' } }),
    );
    expect(result.reasonCodes).toContain('CURRENCY_MISMATCH');
  });

  it('费率只能来自策略：结果中的 rateBps 等于策略费率', () => {
    const fromPolicy = evaluateCustomsSuccessFeeCollection(input());
    expect(fromPolicy.rateBps).toBe(1500);
    const customPolicy = evaluateCustomsSuccessFeeCollection(
      input({ feePolicy: { ...FEE_POLICY, rateBps: 2000 } }),
    );
    expect(customPolicy.rateBps).toBe(2000);
    expect(customPolicy.feeAmount).toBe('2000.00');
  });
});

describe('V2-08 计费基础 — 无真实回款不计费', () => {
  it('结算未获证实 → SUCCESS_FEE_CALCULATED，不构成应收', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ settlement: { settlementId: 'st-1', organizationId: 'org-1', currency: 'USD', verifiedAmount: '10000.00', verified: false } }),
    );
    expect(result.state).toBe('SUCCESS_FEE_CALCULATED');
    expect(result.reasonCodes).toContain('SETTLEMENT_NOT_VERIFIED');
    expect(result.remainingCollectible).toBeNull();
    expect(result.collectionInitiated).toBe(false);
  });

  it('缺结算号 / 金额为 0 或非法 / 缺币种 → 不构成应收', () => {
    const noRef = evaluateCustomsSuccessFeeCollection(
      input({ settlement: { settlementId: null, organizationId: 'org-1', currency: 'USD', verifiedAmount: '10.00', verified: true } }),
    );
    expect(noRef.reasonCodes).toContain('SETTLEMENT_REFERENCE_MISSING');

    const zero = evaluateCustomsSuccessFeeCollection(
      input({ settlement: { settlementId: 'st-1', organizationId: 'org-1', currency: 'USD', verifiedAmount: '0', verified: true } }),
    );
    expect(zero.reasonCodes).toContain('SETTLEMENT_AMOUNT_INVALID');

    const noCurrency = evaluateCustomsSuccessFeeCollection(
      input({ settlement: { settlementId: 'st-1', organizationId: 'org-1', currency: null, verifiedAmount: '10.00', verified: true } }),
    );
    expect(noCurrency.reasonCodes).toContain('CURRENCY_MISMATCH');
  });

  it('同一结算重复通知 → 抑制计费（幂等键 = settlementId）', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ billedSettlementIds: new Set<string>(['st-1']) }),
    );
    expect(result.state).toBe('SUCCESS_FEE_CALCULATED');
    expect(result.reasonCodes).toEqual(['DUPLICATE_FEE_SUPPRESSED']);
    expect(result.remainingCollectible).toBeNull();
  });

  it('15% 定点向下取整到分', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({
        settlement: { settlementId: 'st-1', organizationId: 'org-1', currency: 'USD', verifiedAmount: '1.00', verified: true },
      }),
    );
    expect(result.feeAmount).toBe('0.15');
    expect(result.rateBps).toBe(1500);
  });
});

describe('V2-08 收款门禁 — HOLD 与应收账单两条路径', () => {
  it('不具备自动收款能力 → SUCCESS_FEE_RECEIVABLE（生成应收账单，不假装扣款）', () => {
    const noHost = evaluateCustomsSuccessFeeCollection(
      input({ authorization: { active: true, revoked: false, paymentMethodSupportsAutoCollection: true, hostAutoCollectionEnabled: false } }),
    );
    expect(noHost.state).toBe('SUCCESS_FEE_RECEIVABLE');
    expect(noHost.reasonCodes).toContain('AUTO_COLLECTION_NOT_ENABLED');
    expect(noHost.autoCollection).toBe('HOLD');
    expect(noHost.paymentCaptured).toBe(false);

    const noMethod = evaluateCustomsSuccessFeeCollection(
      input({ authorization: { active: true, revoked: false, paymentMethodSupportsAutoCollection: false, hostAutoCollectionEnabled: true } }),
    );
    expect(noMethod.state).toBe('SUCCESS_FEE_RECEIVABLE');
    expect(noMethod.reasonCodes).toContain('PAYMENT_METHOD_NOT_SUPPORTED');
  });

  it('能力具备但客户撤销授权 → PAYMENT_COLLECTION_HOLD（不得继续划扣）', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ authorization: { active: true, revoked: true, paymentMethodSupportsAutoCollection: true, hostAutoCollectionEnabled: true } }),
    );
    expect(result.state).toBe('PAYMENT_COLLECTION_HOLD');
    expect(result.reasonCodes).toContain('CUSTOMER_AUTHORIZATION_REVOKED');
    expect(result.collectionInitiated).toBe(false);
  });

  it('客户未授权 / Kill Switch 触发 → PAYMENT_COLLECTION_HOLD', () => {
    expect(
      evaluateCustomsSuccessFeeCollection(
        input({ authorization: { active: false, revoked: false, paymentMethodSupportsAutoCollection: true, hostAutoCollectionEnabled: true } }),
      ).reasonCodes,
    ).toContain('CUSTOMER_AUTHORIZATION_MISSING');
    expect(
      evaluateCustomsSuccessFeeCollection(input({ killSwitch: { engaged: true } })).reasonCodes,
    ).toContain('KILL_SWITCH_ENGAGED');
  });

  it('门禁全开且无收款事实 → PAYMENT_COLLECTION_AUTHORIZED（仍未发起）', () => {
    const result = evaluateCustomsSuccessFeeCollection(input());
    expect(result.state).toBe('PAYMENT_COLLECTION_AUTHORIZED');
    expect(result.autoCollection).toBe('AUTHORIZED');
    expect(result.remainingCollectible).toBe('1500.00');
    expect(result.collectionInitiated).toBe(false);
    expect(result.chargedAmount).toBeNull();
  });
});

describe('V2-08 收款结果 — 到账 / 失败 / 部分 / 退款 / 争议', () => {
  it('可信事实确认全额到账 → PAYMENT_COLLECTED', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ collectionFact: collectionFact() }),
    );
    expect(result.state).toBe('PAYMENT_COLLECTED');
    expect(result.reasonCodes).toContain('COLLECTED_VERIFIED');
    expect(result.remainingCollectible).toBe('0.00');
    expect(result.paymentCaptured).toBe(false); // 本模块不执行收款
  });

  it('部分到账 → 保留余额并进入待收状态', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ collectionFact: collectionFact({ collectedAmount: '500.00' }) }),
    );
    expect(result.state).toBe('PAYMENT_COLLECTION_AUTHORIZED');
    expect(result.reasonCodes).toContain('PARTIAL_COLLECTION_PENDING');
    expect(result.remainingCollectible).toBe('1000.00');
    expect(result.adjustments[0]?.kind).toBe('PARTIAL_COLLECTION');
  });

  it('到账金额不可信（非法 / 超过应收）→ 不认定已收', () => {
    for (const collectedAmount of ['abc', '0', '9999.00']) {
      const result = evaluateCustomsSuccessFeeCollection(
        input({ collectionFact: collectionFact({ collectedAmount }) }),
      );
      expect(result.state).not.toBe('PAYMENT_COLLECTED');
      expect(result.reasonCodes).toContain('COLLECTION_AMOUNT_UNTRUSTED');
    }
  });

  it('扣款失败 → 回到 HOLD 并按规则等待重试', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ collectionFact: collectionFact({ outcome: 'FAILED', collectedAmount: null }) }),
    );
    expect(result.state).toBe('PAYMENT_COLLECTION_HOLD');
    expect(result.reasonCodes).toContain('COLLECTION_FAILED');
  });

  it('退款 / 争议 → 生成可审计调整记录并把余额清零', () => {
    const refunded = evaluateCustomsSuccessFeeCollection(
      input({ collectionFact: collectionFact({ outcome: 'REFUNDED', collectedAmount: null }) }),
    );
    expect(refunded.adjustments[0]).toMatchObject({
      kind: 'REFUND_ADJUSTMENT',
      settlementId: 'st-1',
      signedAmount: '-1500.00',
    });
    expect(refunded.remainingCollectible).toBe('0.00');

    const chargeback = evaluateCustomsSuccessFeeCollection(
      input({ collectionFact: collectionFact({ outcome: 'CHARGEBACK', collectedAmount: null }) }),
    );
    expect(chargeback.adjustments[0]?.kind).toBe('CHARGEBACK_ADJUSTMENT');
    expect(chargeback.reasonCodes).toContain('CHARGEBACK_RECORDED');
  });

  // CHANGE 03（P0）：收款事实必须可核验，且历史已收不受撤销授权影响。
  it('自行构造的收款事实冒充可信事实 → 不得认定已收', () => {
    const forged = {
      transactionId: 'txn-x',
      merchantAccountId: 'acct-1',
      receivableId: 'st-1',
      collectedAmount: '1500.00',
      outcome: 'COLLECTED',
      source: 'PAYMENT_PROVIDER_WEBHOOK',
      occurredAt: '2026-10-10T00:00:00.000Z',
    } as unknown as VerifiedFeeCollectionFact;
    const result = evaluateCustomsSuccessFeeCollection(input({ collectionFact: forged }));
    expect(result.state).not.toBe('PAYMENT_COLLECTED');
    expect(result.reasonCodes).toContain('COLLECTION_FACT_UNTRUSTED');
  });

  it('核验期拒绝：交易号缺失 / 应收不匹配 / 商户不匹配 / 来源不可信', () => {
    const base = {
      transactionId: 'txn-1',
      merchantAccountId: 'acct-1',
      receivableId: 'st-1',
      collectedAmount: '1500.00',
      outcome: 'COLLECTED' as const,
      source: 'PAYMENT_PROVIDER_WEBHOOK',
      occurredAt: '2026-10-10T00:00:00.000Z',
    };
    const expectRejected = (fact: CustomsFeeCollectionFact) =>
      expect(
        verifyFeeCollectionFact({
          fact,
          expectedReceivableId: 'st-1',
          expectedMerchantAccountId: 'acct-1',
        }),
      ).toBeNull();
    expectRejected({ ...base, transactionId: null });
    expectRejected({ ...base, receivableId: 'other' });
    expectRejected({ ...base, merchantAccountId: 'acct-2' });
    expectRejected({ ...base, source: 'CLIENT_REPORTED' });
  });

  it('已核验收款事实：历史已收写入结果，撤销授权只影响未来扣款', () => {
    const collected = evaluateCustomsSuccessFeeCollection(
      input({
        history: { collectedAmount: '300.00', refundedAmount: '0.00' },
        collectionFact: collectionFact({ collectedAmount: '1500.00' }),
      }),
    );
    expect(collected.state).toBe('PAYMENT_COLLECTED');
    expect(collected.historicalCollectedAmount).toBe('300.00');
    expect(collected.collectionAuthorizedForFuture).toBe(false);

    const revoked = evaluateCustomsSuccessFeeCollection(
      input({
        history: { collectedAmount: '300.00', refundedAmount: '0.00' },
        authorization: {
          active: true,
          revoked: true,
          paymentMethodSupportsAutoCollection: true,
          hostAutoCollectionEnabled: true,
        },
      }),
    );
    expect(revoked.state).toBe('PAYMENT_COLLECTION_HOLD');
    expect(revoked.reasonCodes).toContain('CUSTOMER_AUTHORIZATION_REVOKED');
    // 历史已收不被抹除；但未来自动扣款不再授权
    expect(revoked.historicalCollectedAmount).toBe('300.00');
    expect(revoked.collectionAuthorizedForFuture).toBe(false);
  });
});

describe('V2-08 汇总 — 跨币种不求和', () => {
  it('同币种相加；跨币种返回 null（不做汇率换算）', () => {
    expect(
      sumReceivablesSameCurrency([
        { currency: 'USD', feeAmount: '300.00' },
        { currency: 'USD', feeAmount: '450.00' },
      ]),
    ).toBe('750.00');
    expect(
      sumReceivablesSameCurrency([
        { currency: 'USD', feeAmount: '300.00' },
        { currency: 'EUR', feeAmount: '450.00' },
      ]),
    ).toBeNull();
    expect(sumReceivablesSameCurrency([{ currency: null, feeAmount: '1.00' }])).toBeNull();
  });
});

describe('V2-08 边界自证', () => {
  it('CUSTOMS_FEE_COLLECTION_BOUNDARY 不持卡 / 不发起扣款 / 默认不自动收款', () => {
    expect(CUSTOMS_FEE_COLLECTION_BOUNDARY.storesCardData).toBe(false);
    expect(CUSTOMS_FEE_COLLECTION_BOUNDARY.initiatesCharge).toBe(false);
    expect(CUSTOMS_FEE_COLLECTION_BOUNDARY.collectionInitiated).toBe(false);
    expect(CUSTOMS_FEE_COLLECTION_BOUNDARY.paymentCaptured).toBe(false);
    expect(CUSTOMS_FEE_COLLECTION_BOUNDARY.autoCollectionDefault).toBe('HOLD');
    expect(CUSTOMS_FEE_COLLECTION_BOUNDARY.productionCredentials).toBe('ABSENT');
    expect(CUSTOMS_FEE_COLLECTION_VERSION).toBe('customs-success-fee-collection-v2.0.0');
  });
});
