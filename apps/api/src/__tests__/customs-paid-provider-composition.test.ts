// V2-02 — CUSTOMS PAID PROVIDER COMPOSITION 回归
// ---------------------------------------------------------------------------
// 覆盖：唯一 composition 点 / 全出口 Gate 覆盖（含 V2-01 漏掉的 getSubmission）/ 漏包即抛错 /
//   组合结果冻结 / 免费路径 7 个出站方法全部无法触达底层 / 生产代码中不存在绕过 Gate 的直接调用。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CUSTOMS_FILING_PROVIDER_OUTBOUND_METHODS,
  CustomsPaidApiGateError,
  CustomsProviderUndeclaredExitError,
  CustomsProviderUngatedExitError,
  PAID_CUSTOMS_API_GATE_VERSION,
  assertProviderFullyGated,
  collectProviderFunctionExits,
  createPaidCustomsCallCounter,
  wrapPaidCustomsProvider,
  type PaidCustomsGateContext,
} from '../services/customs/customs-paid-api-gate';
import {
  CUSTOMS_PROVIDER_COMPOSITION_BOUNDARY,
  composeGatedCustomsFilingProvider,
} from '../services/customs/customs-paid-provider-composition';

const NOW = new Date('2026-10-09T12:30:00.000Z');
const API_SRC = join(process.cwd(), 'src');
const C15_OUTBOUND_METHODS = [
  'createSubmission',
  'uploadEvidence',
  'getSubmission',
  'getSubmissionStatus',
  'listRequestsForInformation',
  'respondToRequest',
  'getRefundStatus',
] as const;

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

function makeSandboxLikeProvider() {
  return {
    providerId: 'provider-sandbox',
    displayName: 'Sandbox',
    capabilities: { FILING_CREATE: true, STATUS_READ: true },
    createSubmission: vi.fn(async (_input: unknown) => ({ providerSubmissionId: 's-1' })),
    uploadEvidence: vi.fn(async (_input: unknown) => ({ ok: true, providerReference: 'r-1' })),
    getSubmission: vi.fn(async (_input: unknown) => ({ submissionStatus: 'ACCEPTED' })),
    getSubmissionStatus: vi.fn(async (_input: unknown) => ({ status: 'ACCEPTED' })),
    listRequestsForInformation: vi.fn(async (_input: unknown) => ({ requests: [] })),
    respondToRequest: vi.fn(async (_input: unknown) => ({ ok: true, providerReference: 'r-2' })),
    getRefundStatus: vi.fn(async (_input: unknown) => ({ refundStatus: 'NONE' })),
  };
}

type AnyMethodRecord = Record<string, (input: unknown) => Promise<unknown>>;

describe('V2-02 唯一 composition 点', () => {
  it('provider 为 null → gated=false，不构造任何 provider', () => {
    const composed = composeGatedCustomsFilingProvider({
      provider: null,
      resolveContext: () => context(),
      now: () => NOW,
    });
    expect(composed.provider).toBeNull();
    expect(composed.gated).toBe(false);
    expect(composed.outboundMethods).toEqual([]);
    expect(composed.gateVersion).toBe(PAID_CUSTOMS_API_GATE_VERSION);
    expect(composed.externalCallPerformed).toBe(false);
    expect(composed.productionCredentials).toBe('ABSENT');
  });

  it('provider 非 null → 全出口覆盖且结果被冻结', () => {
    const provider = makeSandboxLikeProvider();
    const composed = composeGatedCustomsFilingProvider({
      provider,
      resolveContext: () => context(),
      now: () => NOW,
    });
    expect(composed.gated).toBe(true);
    expect(composed.provider).not.toBeNull();
    expect(Object.isFrozen(composed.provider)).toBe(true);
    for (const method of C15_OUTBOUND_METHODS) {
      expect(composed.outboundMethods).toContain(method as never);
    }
    expect(composed.outboundMethods).toEqual(
      expect.arrayContaining([...CUSTOMS_FILING_PROVIDER_OUTBOUND_METHODS]),
    );
  });

  it('冻结的 provider 不允许事后挂回原始方法', () => {
    const provider = makeSandboxLikeProvider();
    const composed = composeGatedCustomsFilingProvider({
      provider,
      resolveContext: () => context(),
      now: () => NOW,
    });
    expect(() => {
      (composed.provider as unknown as Record<string, unknown>).createSubmission =
        provider.createSubmission;
    }).toThrow(TypeError);
  });
});

describe('V2-02 全出口覆盖 — 免费路径无法触达任何 provider 方法', () => {
  it('FREE_SCAN 对全部 7 个出站方法一律拒绝，且底层 provider 零调用', async () => {
    const provider = makeSandboxLikeProvider();
    const composed = composeGatedCustomsFilingProvider({
      provider,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context({ callerPath: 'FREE_SCAN' }),
      now: () => NOW,
    });
    const gatedProvider = composed.provider as unknown as AnyMethodRecord;

    for (const method of C15_OUTBOUND_METHODS) {
      await expect(gatedProvider[method]({ organizationId: 'org-1' })).rejects.toBeInstanceOf(
        CustomsPaidApiGateError,
      );
    }

    for (const method of C15_OUTBOUND_METHODS) {
      expect(provider[method]).not.toHaveBeenCalled();
    }
    const snapshot = composed.counter.snapshot();
    expect(snapshot.blockedPaidCallCount).toBe(C15_OUTBOUND_METHODS.length);
    expect(snapshot.permittedPaidCallCount).toBe(0);
  });

  it('付费路径全出口委派，计数与操作集合可审计', async () => {
    const provider = makeSandboxLikeProvider();
    const composed = composeGatedCustomsFilingProvider({
      provider,
      resolveContext: () => context(),
      now: () => NOW,
    });
    const gatedProvider = composed.provider as unknown as AnyMethodRecord;

    for (const method of C15_OUTBOUND_METHODS) {
      await gatedProvider[method]({ organizationId: 'org-1' });
    }
    for (const method of C15_OUTBOUND_METHODS) {
      expect(provider[method]).toHaveBeenCalledTimes(1);
    }
    const snapshot = composed.counter.snapshot();
    expect(snapshot.permittedPaidCallCount).toBe(C15_OUTBOUND_METHODS.length);
    expect(snapshot.freeCustomsPaidApiCallCount).toBe(0);
    expect(snapshot.permittedOperations).toEqual([
      'FILING_CREATE',
      'DOCUMENT_UPLOAD',
      'SUBMISSION_READ',
      'STATUS_READ',
      'RFI_READ',
      'RFI_RESPOND',
      'REFUND_STATUS',
    ]);
  });
});

describe('V2-02 漏包检测', () => {
  it('assertProviderFullyGated 检出未被包装的出站方法', () => {
    const provider = makeSandboxLikeProvider();
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    }) as unknown as Record<string, unknown>;

    expect(() => assertProviderFullyGated(provider, wrapped as never)).not.toThrow();

    // 人为还原一个出口 → 必须被检出
    wrapped.getSubmission = provider.getSubmission;
    expect(() => assertProviderFullyGated(provider, wrapped as never)).toThrow(
      CustomsProviderUngatedExitError,
    );
  });

  it('未实现的方法不产生假阳性', () => {
    const provider = { providerId: 'p', capabilities: {} };
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    });
    expect(() => assertProviderFullyGated(provider, wrapped)).not.toThrow();
  });

  // V2-R1 / CHANGE 04：结构性封闭
  it('包装结果不再通过原型链暴露原始 provider', () => {
    const provider = makeSandboxLikeProvider();
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    });
    expect(Object.getPrototypeOf(wrapped)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(wrapped)).not.toBe(provider);
    expect((wrapped as { providerId?: string }).providerId).toBe('provider-sandbox');
  });

  it('未声明的额外出口（自有方法 / 符号方法）→ 结构性封闭失败', () => {
    const withExtra = {
      ...makeSandboxLikeProvider(),
      debugDump: () => 'raw',
    };
    const wrappedExtra = wrapPaidCustomsProvider({
      provider: withExtra,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    });
    expect(() => assertProviderFullyGated(withExtra, wrappedExtra as never)).toThrow(
      CustomsProviderUndeclaredExitError,
    );

    const symbolExit = {
      ...makeSandboxLikeProvider(),
      [Symbol('escape')]: () => 'raw',
    };
    const wrappedSymbol = wrapPaidCustomsProvider({
      provider: symbolExit,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    });
    expect(collectProviderFunctionExits(symbolExit)).toContain('Symbol(escape)');
    expect(() => assertProviderFullyGated(symbolExit, wrappedSymbol as never)).toThrow(
      CustomsProviderUndeclaredExitError,
    );
  });

  it('显式声明的额外出口可被容忍，但**不会**出现在最小权限包装上', () => {
    const withExtra = {
      ...makeSandboxLikeProvider(),
      debugDump: () => 'raw',
    };
    const wrapped = wrapPaidCustomsProvider({
      provider: withExtra,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    });
    expect(() =>
      assertProviderFullyGated(withExtra, wrapped as never, { allowExtraExits: ['debugDump'] }),
    ).not.toThrow();
    expect((wrapped as Record<string, unknown>).debugDump).toBeUndefined();
  });

  it('组合点对含有未声明出口的 provider 直接抛错（不返回半成品）', () => {
    const withExtra = { ...makeSandboxLikeProvider(), debugDump: () => 'raw' };
    expect(() =>
      composeGatedCustomsFilingProvider({
        provider: withExtra,
        resolveContext: () => context(),
        now: () => NOW,
      }),
    ).toThrow(CustomsProviderUndeclaredExitError);
  });

  // V2-R2 / CHANGE 11：只允许显式白名单的安全元数据
  it('不再复制内部对象属性（HTTP client 等）', () => {
    const provider = {
      ...makeSandboxLikeProvider(),
      httpClient: { post: () => 'raw' },
      transport: { send: () => 'raw' },
    };
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    }) as Record<string, unknown>;
    expect(wrapped.httpClient).toBeUndefined();
    expect(wrapped.transport).toBeUndefined();
    expect(wrapped.providerId).toBe('provider-sandbox');
  });

  it('getter 属性既不复制、也不被读取（不触发副作用）', () => {
    let getterCalls = 0;
    const provider = makeSandboxLikeProvider() as Record<string, unknown>;
    Object.defineProperty(provider, 'secretToken', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return 'leaked';
      },
    });
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    }) as Record<string, unknown>;
    expect(wrapped.secretToken).toBeUndefined();
    expect(getterCalls).toBe(0);
  });

  it('capabilities 只保留显式 true 并复制为新对象（不交原始引用）', () => {
    const capabilities = { FILING_CREATE: true, STATUS_READ: false, extra: 'x' };
    const provider = { ...makeSandboxLikeProvider(), capabilities };
    const wrapped = wrapPaidCustomsProvider({
      provider,
      counter: createPaidCustomsCallCounter(),
      resolveContext: () => context(),
      now: () => NOW,
    }) as Record<string, unknown>;
    expect(wrapped.capabilities).toEqual({ FILING_CREATE: true });
    expect(wrapped.capabilities).not.toBe(capabilities);
    expect(Object.isFrozen(wrapped.capabilities)).toBe(true);
  });
});

describe('V2-02 绕过 Gate 的静态扫描', () => {
  const CALL_PATTERN =
    /\b\w*[Pp]rovider\s*(?:\.\s*|\[\s*['"`])(?:readData|lookupRate|createSubmission|uploadEvidence|getSubmission|getSubmissionStatus|listRequestsForInformation|respondToRequest|getRefundStatus)/g;

  function scanSourceText(text: string): number {
    return text.match(CALL_PATTERN)?.length ?? 0;
  }

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, out);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('生产代码（非 __tests__）不存在直接调用 provider 出站方法的路径', () => {
    const offenders: string[] = [];
    for (const file of walk(API_SRC)) {
      const rel = relative(API_SRC, file);
      if (rel.includes('__tests__')) continue;
      const hits = scanSourceText(readFileSync(file, 'utf8'));
      if (hits > 0) offenders.push(`${rel} (${hits})`);
    }
    expect(offenders).toEqual([]);
  });

  it('扫描器本身能检出合成违例（防止空扫描假通过）', () => {
    expect(scanSourceText('await customsFilingProvider.createSubmission(input);')).toBe(1);
    expect(scanSourceText('provider.getSubmission({ id });')).toBe(1);
    expect(scanSourceText("provider['createSubmission'](input);")).toBe(1);
    expect(scanSourceText('provider["getRefundStatus"]({ id });')).toBe(1);
    expect(scanSourceText('const x = resolveCustomsExecutionRoute(provider);')).toBe(0);
  });
});

describe('V2-02 边界自证', () => {
  it('CUSTOMS_PROVIDER_COMPOSITION_BOUNDARY 声明无外部调用 / 无资金动作', () => {
    expect(CUSTOMS_PROVIDER_COMPOSITION_BOUNDARY.externalCallPerformed).toBe(false);
    expect(CUSTOMS_PROVIDER_COMPOSITION_BOUNDARY.providerInvoked).toBe(false);
    expect(CUSTOMS_PROVIDER_COMPOSITION_BOUNDARY.chargedAmount).toBeNull();
    expect(CUSTOMS_PROVIDER_COMPOSITION_BOUNDARY.autoCollectionEnabled).toBe(false);
    expect(CUSTOMS_PROVIDER_COMPOSITION_BOUNDARY.productionCredentials).toBe('ABSENT');
  });
});
