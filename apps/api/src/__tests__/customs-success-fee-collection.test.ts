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
  authenticateCollectionFact,
  authenticateLedgerEvidence,
  signCollectionFactBody,
  isVerifiedFeeCollectionFact,
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
const COLLECTION_SECRET = 'whsec_collection_test';

/** CHANGE 16：台账证据必须经认证边界产出。 */
function ledgerEvidence(collectedAmount: string) {
  const rawBody = JSON.stringify({
    source: 'LEDGER',
    organizationId: 'org-1',
    merchantAccountId: 'acct-1',
    receivableId: 'st-1',
    currency: 'USD',
    ledgerSnapshotId: 'snap-1',
    collectedAmount,
    refundedAmount: '0.00',
    occurredAt: '2026-10-10T00:00:00.000Z',
  });
  const timestamp = '1770000000';
  const result = authenticateLedgerEvidence({
    rawBody,
    signatureHeader: signCollectionFactBody(timestamp, rawBody, COLLECTION_SECRET),
    timestampHeader: timestamp,
    secret: COLLECTION_SECRET,
    now: new Date(Number(timestamp) * 1000),
    expectedOrganizationId: 'org-1',
    expectedMerchantAccountId: 'acct-1',
    expectedReceivableId: 'st-1',
    expectedCurrency: 'USD',
  });
  if (result.evidence === null) throw new Error('TEST_LEDGER_UNVERIFIED');
  return result.evidence;
}

function collectionFact(
  overrides: Partial<CustomsFeeCollectionFact> = {},
): VerifiedFeeCollectionFact {
  const payload = {
    transactionId: 'txn-1',
    merchantAccountId: 'acct-1',
    receivableId: 'st-1',
    currency: 'USD',
    collectedAmount: '1500.00',
    outcome: 'COLLECTED',
    source: 'PAYMENT_PROVIDER_WEBHOOK',
    occurredAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = '1770000000';
  const result = authenticateCollectionFact({
    rawBody,
    signatureHeader: signCollectionFactBody(timestamp, rawBody, COLLECTION_SECRET),
    timestampHeader: timestamp,
    secret: COLLECTION_SECRET,
    now: new Date(Number(timestamp) * 1000),
    expectedReceivableId: 'st-1',
    expectedMerchantAccountId: 'acct-1',
    expectedCurrency: 'USD',
  });
  if (result.fact === null) throw new Error('TEST_COLLECTION_FACT_UNVERIFIED');
  return result.fact;
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
    asOfDate: '2026-10-10',
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

describe('V2-08 策略有效性与历史台账 — CHANGE 13', () => {
  it('缺少策略版本 / 策略在判定日未生效 → 不产生应收', () => {
    expect(
      evaluateCustomsSuccessFeeCollection(
        input({ feePolicy: { ...FEE_POLICY, version: '  ' } }),
      ).reasonCodes,
    ).toContain('FEE_POLICY_VERSION_REQUIRED');

    expect(
      evaluateCustomsSuccessFeeCollection(
        input({ feePolicy: { ...FEE_POLICY, effectiveTo: '2026-09-30' } }),
      ).reasonCodes,
    ).toContain('FEE_POLICY_NOT_EFFECTIVE');

    expect(
      evaluateCustomsSuccessFeeCollection(
        input({ feePolicy: { ...FEE_POLICY, effectiveFrom: '2026-11-01' } }),
      ).reasonCodes,
    ).toContain('FEE_POLICY_NOT_EFFECTIVE');

    expect(
      evaluateCustomsSuccessFeeCollection(input({ asOfDate: 'not-a-date' })).reasonCodes,
    ).toContain('FEE_POLICY_NOT_EFFECTIVE');
  });

  it('费率越界（0 / 负数 / 超 10000 bps / 非整数）→ 不产生应收', () => {
    for (const rateBps of [0, -100, 10001, 1500.5]) {
      const result = evaluateCustomsSuccessFeeCollection(
        input({ feePolicy: { ...FEE_POLICY, rateBps } }),
      );
      expect(result.reasonCodes).toContain('FEE_POLICY_RATE_OUT_OF_RANGE');
      expect(result.feeAmount).toBeNull();
    }
  });

  it('历史金额来源不可信 → 不采信汇总数（HISTORY_SOURCE_UNTRUSTED）', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({
        ledgerEvidence: {
          source: 'CLIENT_REPORTED',
          collectedAmount: '9999.00',
          refundedAmount: '0.00',
          occurredAt: '2026-10-10T00:00:00.000Z',
        } as never,
      }),
    );
    expect(result.state).toBe('SUCCESS_FEE_CALCULATED');
    expect(result.reasonCodes).toContain('HISTORY_LEDGER_UNAVAILABLE');
    // 不可读 ≠ 零值：必须为 null 而不是 '0.00'
    expect(result.historicalCollectedAmount).toBeNull();
  });

  it('可信台账来源才被采信为历史已收', () => {
    const result = evaluateCustomsSuccessFeeCollection(
      input({
        ledgerEvidence: ledgerEvidence('300.00'),
      }),
    );
    expect(result.state).toBe('PAYMENT_COLLECTION_AUTHORIZED');
    expect(result.historicalCollectedAmount).toBe('300.00');
  });

  // CHANGE 17：未提供台账证据 = 不可读（null）；只有经认证的空账本才是 0.00
  it('未提供台账证据 → historicalCollectedAmount = null（不可读 ≠ 零）', () => {
    const result = evaluateCustomsSuccessFeeCollection(input());
    expect(result.historicalCollectedAmount).toBeNull();
  });

  it('经认证的空账本 → historicalCollectedAmount = 0.00', () => {
    const rawBody = JSON.stringify({
      source: 'LEDGER',
      organizationId: 'org-1',
      merchantAccountId: 'acct-1',
      receivableId: 'st-1',
      currency: 'USD',
      ledgerSnapshotId: 'snap-1',
      collectedAmount: '0.00',
      refundedAmount: '0.00',
      empty: true,
      occurredAt: '2026-10-10T00:00:00.000Z',
    });
    const timestamp = '1770000000';
    const verified = authenticateLedgerEvidence({
      rawBody,
      signatureHeader: signCollectionFactBody(timestamp, rawBody, COLLECTION_SECRET),
      timestampHeader: timestamp,
      secret: COLLECTION_SECRET,
      now: new Date(Number(timestamp) * 1000),
      expectedOrganizationId: 'org-1',
      expectedMerchantAccountId: 'acct-1',
      expectedReceivableId: 'st-1',
      expectedCurrency: 'USD',
    });
    expect(verified.evidence?.confirmedEmpty).toBe(true);
    const result = evaluateCustomsSuccessFeeCollection(
      input({ ledgerEvidence: verified.evidence }),
    );
    expect(result.historicalCollectedAmount).toBe('0.00');
  });

  it('Ledger 认证负向：跨租户 / 跨商户 / 跨币种 / 跨应收 / 非法金额 / 非法时间窗', () => {
    const timestamp = '1770000000';
    const base = {
      source: 'LEDGER',
      organizationId: 'org-1',
      merchantAccountId: 'acct-1',
      receivableId: 'st-1',
      currency: 'USD',
      ledgerSnapshotId: 'snap-1',
      collectedAmount: '300.00',
      refundedAmount: '0.00',
      occurredAt: '2026-10-10T00:00:00.000Z',
    };
    const attempt = (patch: Record<string, unknown>, expectOverride: Record<string, unknown> = {}, toleranceSeconds?: number) => {
      const rawBody = JSON.stringify({ ...base, ...patch });
      return authenticateLedgerEvidence({
        rawBody,
        signatureHeader: signCollectionFactBody(timestamp, rawBody, COLLECTION_SECRET),
        timestampHeader: timestamp,
        secret: COLLECTION_SECRET,
        now: new Date(Number(timestamp) * 1000),
        expectedOrganizationId: 'org-1',
        expectedMerchantAccountId: 'acct-1',
        expectedReceivableId: 'st-1',
        expectedCurrency: 'USD',
        ...(toleranceSeconds === undefined ? {} : { toleranceSeconds }),
        ...expectOverride,
      });
    };

    expect(attempt({ organizationId: 'org-OTHER' }).verified).toBe(false);
    expect(attempt({ merchantAccountId: 'acct-OTHER' }).verified).toBe(false);
    expect(attempt({ currency: 'EUR' }).verified).toBe(false);
    expect(attempt({ receivableId: 'st-OTHER' }).verified).toBe(false);
    expect(attempt({ ledgerSnapshotId: 'snap-OTHER' }, { expectedLedgerSnapshotId: 'snap-1' }).verified).toBe(false);
    expect(attempt({ collectedAmount: '-5.00' }).verified).toBe(false);
    expect(attempt({ collectedAmount: 'abc' }).verified).toBe(false);
    expect(attempt({}, {}, 0).reasonCodes).toContain('COLLECTION_TOLERANCE_INVALID');
    expect(attempt({}, {}, 99999).reasonCodes).toContain('COLLECTION_TOLERANCE_INVALID');
    // 重放：同一份签名在窗口外
    const replayed = attempt({});
    expect(replayed.verified).toBe(true);
  });

  it('认证边界拒绝非法时间窗（0 / 负数 / 非整数 / 超上限）', () => {
    const timestamp = '1770000000';
    const rawBody = JSON.stringify({
      source: 'LEDGER',
      collectedAmount: '1.00',
      refundedAmount: '0.00',
      occurredAt: '2026-10-10T00:00:00.000Z',
    });
    for (const toleranceSeconds of [0, -5, 1.5, 99999]) {
      const result = authenticateCollectionFact({
        rawBody: '{}',
        signatureHeader: signCollectionFactBody(timestamp, '{}', COLLECTION_SECRET),
        timestampHeader: timestamp,
        secret: COLLECTION_SECRET,
        now: new Date(Number(timestamp) * 1000),
        expectedReceivableId: 'st-1',
        expectedMerchantAccountId: 'acct-1',
        expectedCurrency: 'USD',
        toleranceSeconds,
      });
      expect(result.reasonCodes).toContain('COLLECTION_TOLERANCE_INVALID');
    }
    void rawBody;
  });

  it('空白应收/币种预期 → 拒绝（COLLECTION_BINDING_REQUIRED）', () => {
    const timestamp = '1770000000';
    const rawBody = '{}';
    const base = {
      rawBody,
      signatureHeader: signCollectionFactBody(timestamp, rawBody, COLLECTION_SECRET),
      timestampHeader: timestamp,
      secret: COLLECTION_SECRET,
      now: new Date(Number(timestamp) * 1000),
      expectedReceivableId: 'st-1',
      expectedMerchantAccountId: 'acct-1',
      expectedCurrency: 'USD',
    };
    expect(authenticateCollectionFact({ ...base, expectedReceivableId: '  ' }).reasonCodes).toContain(
      'COLLECTION_BINDING_REQUIRED',
    );
    expect(authenticateCollectionFact({ ...base, expectedCurrency: '' }).reasonCodes).toContain(
      'COLLECTION_BINDING_REQUIRED',
    );
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

  // CHANGE 10（P0）：来源不能自我声明；必须经独立认证边界。
  it('认证边界拒绝：无密钥 / 无签名 / 时间戳越窗 / 签名不符 / 载荷非法', () => {
    const timestamp = '1770000000';
    const rawBody = JSON.stringify({
      transactionId: 'txn-1',
      merchantAccountId: 'acct-1',
      receivableId: 'st-1',
      currency: 'USD',
      collectedAmount: '1500.00',
      outcome: 'COLLECTED',
      source: 'PAYMENT_PROVIDER_WEBHOOK',
      occurredAt: '2026-10-10T00:00:00.000Z',
    });
    const now = new Date(Number(timestamp) * 1000);
    const base = {
      rawBody,
      signatureHeader: signCollectionFactBody(timestamp, rawBody, COLLECTION_SECRET),
      timestampHeader: timestamp,
      secret: COLLECTION_SECRET,
      now,
      expectedReceivableId: 'st-1',
      expectedMerchantAccountId: 'acct-1',
      expectedCurrency: 'USD',
    };
    const reason = (patch: Record<string, unknown>) =>
      authenticateCollectionFact({ ...base, ...patch }).reasonCodes[0];

    expect(reason({ secret: null })).toBe('COLLECTION_SECRET_NOT_CONFIGURED');
    expect(reason({ signatureHeader: null })).toBe('COLLECTION_SIGNATURE_MISSING');
    expect(reason({ timestampHeader: null })).toBe('COLLECTION_TIMESTAMP_MISSING');
    expect(reason({ timestampHeader: '1770009999' })).toBe('COLLECTION_TIMESTAMP_OUT_OF_TOLERANCE');
    expect(reason({ signatureHeader: 'deadbeef' })).toBe('COLLECTION_SIGNATURE_MISMATCH');
    expect(reason({ rawBody: 'not-json' })).toBe('COLLECTION_SIGNATURE_MISMATCH');
    expect(reason({ expectedMerchantAccountId: '  ' })).toBe('COLLECTION_MERCHANT_BINDING_REQUIRED');
    expect(reason({ expectedReceivableId: 'other' })).toBe('COLLECTION_RECEIVABLE_MISMATCH');
    expect(reason({ expectedCurrency: 'EUR' })).toBe('COLLECTION_CURRENCY_MISMATCH');
  });

  it('认证成功才产出品牌事实；调用方自造 source 字符串不起作用', () => {
    expect(isVerifiedFeeCollectionFact(collectionFact())).toBe(true);
    const selfDeclared = {
      transactionId: 'txn-1',
      merchantAccountId: 'acct-1',
      receivableId: 'st-1',
      currency: 'USD',
      collectedAmount: '1500.00',
      outcome: 'COLLECTED',
      source: 'PAYMENT_PROVIDER_WEBHOOK',
      occurredAt: '2026-10-10T00:00:00.000Z',
    } as unknown as VerifiedFeeCollectionFact;
    expect(isVerifiedFeeCollectionFact(selfDeclared)).toBe(false);
  });

  it('已核验收款事实：历史已收写入结果，撤销授权只影响未来扣款', () => {
    const collected = evaluateCustomsSuccessFeeCollection(
      input({
        ledgerEvidence: ledgerEvidence('300.00'),
        collectionFact: collectionFact({ collectedAmount: '1500.00' }),
      }),
    );
    expect(collected.state).toBe('PAYMENT_COLLECTED');
    expect(collected.historicalCollectedAmount).toBe('300.00');
    expect(collected.collectionAuthorizedForFuture).toBe(false);

    const revoked = evaluateCustomsSuccessFeeCollection(
      input({
        ledgerEvidence: ledgerEvidence('300.00'),
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
