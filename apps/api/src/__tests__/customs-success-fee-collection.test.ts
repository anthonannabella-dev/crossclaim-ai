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
  type CustomsFeeCollectionInput,
} from '../services/customs/customs-success-fee-collection';

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
  };
  return { ...base, ...overrides };
}

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
      input({ collectionFact: { outcome: 'COLLECTED', collectedAmount: '1500.00' } }),
    );
    expect(result.state).toBe('PAYMENT_COLLECTED');
    expect(result.reasonCodes).toContain('COLLECTED_VERIFIED');
    expect(result.remainingCollectible).toBe('0.00');
    expect(result.paymentCaptured).toBe(false); // 本模块不执行收款
  });

  it('部分到账 → 保留余额并进入待收状态', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ collectionFact: { outcome: 'COLLECTED', collectedAmount: '500.00' } }),
    );
    expect(result.state).toBe('PAYMENT_COLLECTION_AUTHORIZED');
    expect(result.reasonCodes).toContain('PARTIAL_COLLECTION_PENDING');
    expect(result.remainingCollectible).toBe('1000.00');
    expect(result.adjustments[0]?.kind).toBe('REVERSAL');
  });

  it('到账金额不可信（非法 / 超过应收）→ 不认定已收', () => {
    for (const collectedAmount of ['abc', '0', '9999.00']) {
      const result = evaluateCustomsSuccessFeeCollection(
        input({ collectionFact: { outcome: 'COLLECTED', collectedAmount } }),
      );
      expect(result.state).not.toBe('PAYMENT_COLLECTED');
      expect(result.reasonCodes).toContain('COLLECTION_AMOUNT_UNTRUSTED');
    }
  });

  it('扣款失败 → 回到 HOLD 并按规则等待重试', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({ collectionFact: { outcome: 'FAILED', collectedAmount: null } }),
    );
    expect(result.state).toBe('PAYMENT_COLLECTION_HOLD');
    expect(result.reasonCodes).toContain('COLLECTION_FAILED');
  });

  it('退款 / 争议 → 生成可审计调整记录并把余额清零', () => {
    const refunded = evaluateCustomsSuccessFeeCollection(
      input({ collectionFact: { outcome: 'REFUNDED', collectedAmount: null } }),
    );
    expect(refunded.adjustments[0]).toMatchObject({
      kind: 'REFUND_ADJUSTMENT',
      settlementId: 'st-1',
      signedAmount: '-1500.00',
    });
    expect(refunded.remainingCollectible).toBe('0.00');

    const chargeback = evaluateCustomsSuccessFeeCollection(
      input({ collectionFact: { outcome: 'CHARGEBACK', collectedAmount: null } }),
    );
    expect(chargeback.adjustments[0]?.kind).toBe('CHARGEBACK_ADJUSTMENT');
    expect(chargeback.reasonCodes).toContain('CHARGEBACK_RECORDED');
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
