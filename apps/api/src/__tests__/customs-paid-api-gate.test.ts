// V2-01 — PAID_CUSTOMS_API_GATE 单元回归
// ---------------------------------------------------------------------------
// 覆盖：免费路径绝不触达收费调用 / 完整证据才 ALLOW / 权益·额度·归属·授权·Provider·
//   报价·预算·利润门·Kill Switch·支付开关 全部 fail-closed / 定点数比较不做浮点 /
//   包装器为唯一收费通道（HOLD 时抛错且不触达底层）/ FREE_CUSTOMS_PAID_API_CALL_COUNT = 0。

import { describe, expect, it, vi } from 'vitest';

import {
  CUSTOMS_PAID_API_GATE_BOUNDARY,
  CustomsPaidApiGateError,
  PAID_CUSTOMS_API_GATE_VERSION,
  assertNoFreeCustomsPaidApiCalls,
  compareDecimalAmounts,
  createPaidCustomsCallCounter,
  evaluatePaidCustomsApiGate,
  normalizeDecimalAmount,
  operationMethodName,
  wrapPaidCustomsProvider,
  type PaidCustomsApiGateInput,
  type PaidCustomsGateContext,
} from '../services/customs/customs-paid-api-gate';

const NOW = new Date('2026-10-09T12:00:00.000Z');

function context(overrides: Partial<PaidCustomsGateContext> = {}): PaidCustomsGateContext {
  const base: PaidCustomsGateContext = {
    callerPath: 'CUSTOMER_PAID',
    scope: {
      organizationId: 'org-1',
      opportunityId: 'opp-1',
      ownerOrganizationId: 'org-1',
      caseFound: true,
    },
    entitlement: { active: true, entitlementId: 'ent-1', remainingQuota: 3 },
    authorization: { standingAuthorizationValid: true, externalWriteAuthorized: true },
    provider: {
      providerId: 'provider-sandbox',
      available: true,
      quotedCost: '12.00',
      quoteCurrency: 'USD',
      quoteValidUntil: '2026-10-09T18:00:00.000Z',
    },
    budget: { maximumPerCheckCost: '25.00', tenantRemainingBudget: '500.00', currency: 'USD' },
    profitGate: { decision: 'PASS', reasonCode: null },
    killSwitch: { engaged: false },
    payment: { paymentsEnabled: true, productionPaymentEnabled: true },
  };
  return { ...base, ...overrides };
}

function input(overrides: Partial<PaidCustomsApiGateInput> = {}): PaidCustomsApiGateInput {
  return { ...context(), operation: 'STATUS_READ', now: NOW, ...overrides };
}

describe('V2-01 PAID_CUSTOMS_API_GATE — 免费/付费调用边界', () => {
  it('免费路径 + 收费操作 → HOLD，且标记 freePathPaidAttempt', () => {
    const result = evaluatePaidCustomsApiGate(input({ callerPath: 'FREE_SCAN' }));
    expect(result.kind).toBe('PAID_CUSTOMS_API_GATE');
    expect(result.version).toBe(PAID_CUSTOMS_API_GATE_VERSION);
    expect(result.decision).toBe('HOLD');
    expect(result.reasonCodes).toEqual(['FREE_PATH_CANNOT_CALL_PAID_OPERATION']);
    expect(result.freePathPaidAttempt).toBe(true);
    expect(result.paidApiCallPermitted).toBe(false);
    expect(result.externalCallPerformed).toBe(false);
    expect(result.chargedAmount).toBeNull();
    expect(result.evaluatedAt).toBe(NOW.toISOString());
  });

  it('免费路径即使其他证据全部齐备也一律 HOLD', () => {
    const result = evaluatePaidCustomsApiGate(input({ callerPath: 'FREE_SCAN', operation: 'DATA_READ' }));
    expect(result.decision).toBe('HOLD');
    expect(result.reasonCodes).not.toContain('NO_ACTIVE_PAID_ENTITLEMENT');
  });

  it('付费客户 + 全部证据齐备 → ALLOW', () => {
    const result = evaluatePaidCustomsApiGate(input());
    expect(result.decision).toBe('ALLOW');
    expect(result.reasonCodes).toEqual([]);
    expect(result.paidApiCallPermitted).toBe(true);
    expect(result.freePathPaidAttempt).toBe(false);
  });

  it('运营路径 OPERATOR_APPROVED 与付费客户同规则', () => {
    const result = evaluatePaidCustomsApiGate(input({ callerPath: 'OPERATOR_APPROVED' }));
    expect(result.decision).toBe('ALLOW');
  });
});

describe('V2-01 PAID_CUSTOMS_API_GATE — 缺失证据一律 fail-closed', () => {
  it('无有效付费权益 → HOLD', () => {
    const result = evaluatePaidCustomsApiGate(
      input({ entitlement: { active: false, entitlementId: null, remainingQuota: 3 } }),
    );
    expect(result.decision).toBe('HOLD');
    expect(result.reasonCodes).toContain('NO_ACTIVE_PAID_ENTITLEMENT');
  });

  it('权益有效但额度耗尽 → HOLD', () => {
    const result = evaluatePaidCustomsApiGate(
      input({ entitlement: { active: true, entitlementId: 'ent-1', remainingQuota: 0 } }),
    );
    expect(result.reasonCodes).toContain('INSUFFICIENT_VERIFICATION_QUOTA');
  });

  it('跨租户机会 → HOLD（OPPORTUNITY_NOT_OWNED）', () => {
    const result = evaluatePaidCustomsApiGate(
      input({
        scope: {
          organizationId: 'org-1',
          opportunityId: 'opp-1',
          ownerOrganizationId: 'org-2',
          caseFound: true,
        },
      }),
    );
    expect(result.reasonCodes).toContain('OPPORTUNITY_NOT_OWNED');
  });

  it('机会不存在 → HOLD（OPPORTUNITY_NOT_FOUND）', () => {
    const result = evaluatePaidCustomsApiGate(
      input({
        scope: {
          organizationId: 'org-1',
          opportunityId: 'opp-1',
          ownerOrganizationId: 'org-1',
          caseFound: false,
        },
      }),
    );
    expect(result.reasonCodes).toContain('OPPORTUNITY_NOT_FOUND');
  });

  it('Standing Authorization 失效 → HOLD', () => {
    const result = evaluatePaidCustomsApiGate(
      input({ authorization: { standingAuthorizationValid: false, externalWriteAuthorized: true } }),
    );
    expect(result.reasonCodes).toContain('STANDING_AUTHORIZATION_INVALID');
  });

  it('生产 / 外部写门禁未授权 → HOLD', () => {
    const result = evaluatePaidCustomsApiGate(
      input({ authorization: { standingAuthorizationValid: true, externalWriteAuthorized: false } }),
    );
    expect(result.reasonCodes).toContain('EXTERNAL_WRITE_NOT_AUTHORIZED');
  });

  it('Provider 不可用 / providerId 缺失 → HOLD', () => {
    expect(
      evaluatePaidCustomsApiGate(
        input({
          provider: {
            providerId: 'p',
            available: false,
            quotedCost: '12.00',
            quoteCurrency: 'USD',
            quoteValidUntil: null,
          },
        }),
      ).reasonCodes,
    ).toContain('PROVIDER_NOT_AVAILABLE');

    expect(
      evaluatePaidCustomsApiGate(
        input({
          provider: {
            providerId: null,
            available: true,
            quotedCost: '12.00',
            quoteCurrency: 'USD',
            quoteValidUntil: null,
          },
        }),
      ).reasonCodes,
    ).toContain('PROVIDER_NOT_AVAILABLE');
  });

  it('缺报价 → HOLD（禁止先调用后补价）', () => {
    const result = evaluatePaidCustomsApiGate(
      input({
        provider: {
          providerId: 'p',
          available: true,
          quotedCost: null,
          quoteCurrency: 'USD',
          quoteValidUntil: null,
        },
      }),
    );
    expect(result.reasonCodes).toContain('PROVIDER_QUOTE_MISSING');
  });

  it('报价非法（非定点 / 超 4 位小数 / 负数）→ HOLD', () => {
    for (const bad of ['abc', '1.23456', '-3', '1e3', '']) {
      const result = evaluatePaidCustomsApiGate(
        input({
          provider: {
            providerId: 'p',
            available: true,
            quotedCost: bad,
            quoteCurrency: 'USD',
            quoteValidUntil: null,
          },
        }),
      );
      expect(result.decision).toBe('HOLD');
      expect(result.reasonCodes).toContain('PROVIDER_QUOTE_INVALID');
    }
  });

  it('报价币种与预算币种不一致 → HOLD', () => {
    const result = evaluatePaidCustomsApiGate(
      input({
        provider: {
          providerId: 'p',
          available: true,
          quotedCost: '12.00',
          quoteCurrency: 'EUR',
          quoteValidUntil: null,
        },
      }),
    );
    expect(result.reasonCodes).toContain('PROVIDER_QUOTE_CURRENCY_MISMATCH');
  });

  it('报价过期（含不可解析时间）→ HOLD', () => {
    for (const until of ['2026-10-09T11:59:59.000Z', 'not-a-date']) {
      const result = evaluatePaidCustomsApiGate(
        input({
          provider: {
            providerId: 'p',
            available: true,
            quotedCost: '12.00',
            quoteCurrency: 'USD',
            quoteValidUntil: until,
          },
        }),
      );
      expect(result.reasonCodes).toContain('PROVIDER_QUOTE_EXPIRED');
    }
  });

  it('超单次核验上限 → HOLD；等于上限 → ALLOW', () => {
    const over = evaluatePaidCustomsApiGate(
      input({
        budget: { maximumPerCheckCost: '10.00', tenantRemainingBudget: '500.00', currency: 'USD' },
      }),
    );
    expect(over.reasonCodes).toContain('PER_CHECK_BUDGET_EXCEEDED');

    const equal = evaluatePaidCustomsApiGate(
      input({
        budget: { maximumPerCheckCost: '12.00', tenantRemainingBudget: '500.00', currency: 'USD' },
      }),
    );
    expect(equal.decision).toBe('ALLOW');
  });

  it('超租户剩余预算 → HOLD', () => {
    const result = evaluatePaidCustomsApiGate(
      input({
        budget: { maximumPerCheckCost: '25.00', tenantRemainingBudget: '11.99', currency: 'USD' },
      }),
    );
    expect(result.reasonCodes).toContain('TENANT_BUDGET_EXCEEDED');
  });

  it('利润门未通过 → HOLD（不得只按预计追回总额判定）', () => {
    const result = evaluatePaidCustomsApiGate(
      input({ profitGate: { decision: 'HOLD', reasonCode: 'MARGIN_BELOW_FLOOR' } }),
    );
    expect(result.reasonCodes).toContain('PROFIT_GATE_HOLD');
  });

  it('Kill Switch 触发 → HOLD', () => {
    const result = evaluatePaidCustomsApiGate(input({ killSwitch: { engaged: true } }));
    expect(result.reasonCodes).toContain('KILL_SWITCH_ENGAGED');
  });

  it('支付 / 生产支付开关未开启 → HOLD', () => {
    expect(
      evaluatePaidCustomsApiGate(
        input({ payment: { paymentsEnabled: false, productionPaymentEnabled: true } }),
      ).reasonCodes,
    ).toContain('PAYMENTS_NOT_ENABLED');

    expect(
      evaluatePaidCustomsApiGate(
        input({ payment: { paymentsEnabled: true, productionPaymentEnabled: false } }),
      ).reasonCodes,
    ).toContain('PRODUCTION_PAYMENT_NOT_ENABLED');
  });

  it('多项缺失时累积全部原因码', () => {
    const result = evaluatePaidCustomsApiGate(
      input({
        entitlement: { active: false, entitlementId: null, remainingQuota: 0 },
        killSwitch: { engaged: true },
        profitGate: { decision: 'HOLD', reasonCode: 'X' },
      }),
    );
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        'NO_ACTIVE_PAID_ENTITLEMENT',
        'KILL_SWITCH_ENGAGED',
        'PROFIT_GATE_HOLD',
      ]),
    );
  });
});

describe('V2-01 定点数工具 — 不使用浮点', () => {
  it('normalizeDecimalAmount 规范化并拒绝非法值', () => {
    expect(normalizeDecimalAmount('010.5000')).toBe('10.5');
    expect(normalizeDecimalAmount('0.0000')).toBe('0');
    expect(normalizeDecimalAmount('12')).toBe('12');
    expect(normalizeDecimalAmount('1.23456')).toBeNull();
    expect(normalizeDecimalAmount('-1')).toBeNull();
    expect(normalizeDecimalAmount('1e3')).toBeNull();
    expect(normalizeDecimalAmount('')).toBeNull();
    expect(normalizeDecimalAmount(12)).toBeNull();
  });

  it('compareDecimalAmounts 精确比较', () => {
    expect(compareDecimalAmounts('10', '9.99')).toBe(1);
    expect(compareDecimalAmounts('0.10', '0.1')).toBe(0);
    expect(compareDecimalAmounts('1.05', '1.5')).toBe(-1);
    expect(compareDecimalAmounts('0.1', '0.0999')).toBe(1);
    expect(compareDecimalAmounts('x', '1')).toBeNull();
  });
});

describe('V2-01 唯一收费通道 — provider 包装器', () => {
  function makeProvider() {
    return {
      providerId: 'provider-sandbox',
      capabilities: { STATUS_READ: true },
      createSubmission: vi.fn(async (_input: unknown) => ({ providerSubmissionId: 's-1' })),
      getSubmissionStatus: vi.fn(async (_input: unknown) => ({ status: 'ACCEPTED' })),
      getRefundStatus: vi.fn(async (_input: unknown) => ({ refundStatus: 'NONE' })),
    };
  }

  it('免费路径调用收费方法 → 抛 CustomsPaidApiGateError，底层 provider 未被触达', async () => {
    const provider = makeProvider();
    const counter = createPaidCustomsCallCounter();
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter,
      resolveContext: () => context({ callerPath: 'FREE_SCAN' }),
      now: () => NOW,
    });

    await expect(wrapped.getSubmissionStatus({ organizationId: 'org-1' })).rejects.toBeInstanceOf(
      CustomsPaidApiGateError,
    );
    expect(provider.getSubmissionStatus).not.toHaveBeenCalled();
    const snapshot = counter.snapshot();
    expect(snapshot.freeCustomsPaidApiCallCount).toBe(1);
    expect(snapshot.blockedPaidCallCount).toBe(1);
    expect(snapshot.permittedPaidCallCount).toBe(0);
  });

  it('付费路径证据齐备 → 委派一次并计入 permitted', async () => {
    const provider = makeProvider();
    const counter = createPaidCustomsCallCounter();
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter,
      resolveContext: () => context(),
      now: () => NOW,
    });

    const result = await wrapped.getSubmissionStatus({ organizationId: 'org-1' });
    expect(result).toEqual({ status: 'ACCEPTED' });
    expect(provider.getSubmissionStatus).toHaveBeenCalledTimes(1);
    const snapshot = counter.snapshot();
    expect(snapshot.permittedPaidCallCount).toBe(1);
    expect(snapshot.permittedOperations).toEqual(['STATUS_READ']);
    expect(snapshot.freeCustomsPaidApiCallCount).toBe(0);
  });

  it('上下文缺失（null）→ HOLD 且不触达底层', async () => {
    const provider = makeProvider();
    const counter = createPaidCustomsCallCounter();
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter,
      resolveContext: () => null,
      now: () => NOW,
    });

    await expect(wrapped.getRefundStatus({ organizationId: 'org-1' })).rejects.toBeInstanceOf(
      CustomsPaidApiGateError,
    );
    expect(provider.getRefundStatus).not.toHaveBeenCalled();
    expect(counter.snapshot().blockedPaidCallCount).toBe(1);
  });

  it('包装器不改变 provider 标识与未包装方法', () => {
    const provider = makeProvider();
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    });
    expect(wrapped.providerId).toBe('provider-sandbox');
    expect(wrapped.capabilities).toEqual({ STATUS_READ: true });
  });

  it('operation → 方法名映射覆盖全部收费操作', () => {
    const mapped = [
      operationMethodName('DATA_READ'),
      operationMethodName('RATE_LOOKUP'),
      operationMethodName('FILING_CREATE'),
      operationMethodName('DOCUMENT_UPLOAD'),
      operationMethodName('STATUS_READ'),
      operationMethodName('RFI_READ'),
      operationMethodName('RFI_RESPOND'),
      operationMethodName('REFUND_STATUS'),
    ];
    expect(new Set(mapped).size).toBe(8);
    expect(mapped).toContain('createSubmission');
  });
});

describe('V2-01 验收指标 — FREE_CUSTOMS_PAID_API_CALL_COUNT = 0', () => {
  it('纯免费流程（不尝试收费调用）→ 断言通过且计数为 0', () => {
    const counter = createPaidCustomsCallCounter();
    const snapshot = assertNoFreeCustomsPaidApiCalls(counter);
    expect(snapshot.freeCustomsPaidApiCallCount).toBe(0);
    expect(snapshot.permittedPaidCallCount).toBe(0);
  });

  it('免费流程曾触达收费调用 → 验收断言必须失败', async () => {
    const provider = {
      providerId: 'p',
      capabilities: {},
      getSubmissionStatus: vi.fn(async (_input: unknown) => ({ status: 'ACCEPTED' })),
    };
    const counter = createPaidCustomsCallCounter();
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter,
      resolveContext: () => context({ callerPath: 'FREE_SCAN' }),
      now: () => NOW,
    });

    await wrapped.getSubmissionStatus({ organizationId: 'org-1' }).catch(() => undefined);
    expect(() => assertNoFreeCustomsPaidApiCalls(counter)).toThrow(
      /FREE_CUSTOMS_PAID_API_CALL_COUNT=1/,
    );
    expect(provider.getSubmissionStatus).not.toHaveBeenCalled();
  });

  it('收费调用被 HOLD 不计入 freeCustomsPaidApiCallCount', async () => {
    const provider = {
      providerId: 'p',
      capabilities: {},
      getSubmissionStatus: vi.fn(async (_input: unknown) => ({ status: 'ACCEPTED' })),
    };
    const counter = createPaidCustomsCallCounter();
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter,
      resolveContext: () =>
        context({ killSwitch: { engaged: true } }),
      now: () => NOW,
    });

    await wrapped.getSubmissionStatus({ organizationId: 'org-1' }).catch(() => undefined);
    expect(assertNoFreeCustomsPaidApiCalls(counter).freeCustomsPaidApiCallCount).toBe(0);
    expect(counter.snapshot().blockedPaidCallCount).toBe(1);
  });
});

describe('V2-01 边界自证', () => {
  it('CUSTOMS_PAID_API_GATE_BOUNDARY 声明无外部调用 / 无资金动作', () => {
    expect(CUSTOMS_PAID_API_GATE_BOUNDARY.externalCallPerformed).toBe(false);
    expect(CUSTOMS_PAID_API_GATE_BOUNDARY.providerInvoked).toBe(false);
    expect(CUSTOMS_PAID_API_GATE_BOUNDARY.chargedAmount).toBeNull();
    expect(CUSTOMS_PAID_API_GATE_BOUNDARY.autoCollectionEnabled).toBe(false);
    expect(CUSTOMS_PAID_API_GATE_BOUNDARY.successFeeCalculated).toBe(false);
    expect(CUSTOMS_PAID_API_GATE_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});
