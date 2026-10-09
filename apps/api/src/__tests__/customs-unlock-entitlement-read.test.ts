// V2-HANDOFF-01 — ENTITLEMENT READ 回归（fail-closed 只读面）

import { describe, expect, it, vi } from 'vitest';

import {
  CUSTOMS_ENTITLEMENT_READ_BOUNDARY,
  CUSTOMS_ENTITLEMENT_READ_VERSION,
  readCustomsUnlockEntitlement,
  resolveUnlockCtaDecision,
  type CustomsEntitlementReadPort,
  type CustomsEntitlementRecord,
} from '../services/customs/customs-unlock-entitlement-read';

function record(overrides: Partial<CustomsEntitlementRecord> = {}): CustomsEntitlementRecord {
  return {
    entitlementId: 'ent-quote-1',
    organizationId: 'org-1',
    opportunityId: 'opp-1',
    productSku: 'CUSTOMS_SINGLE_REVIEW',
    quotaTotal: 1,
    quotaRemaining: 1,
    status: 'ACTIVE',
    ...overrides,
  };
}

function portOf(value: CustomsEntitlementRecord | null | Error): CustomsEntitlementReadPort {
  return {
    findLatest: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

const BASE = { organizationId: 'org-1', opportunityId: 'opp-1', productSku: 'CUSTOMS_SINGLE_REVIEW' };

describe('V2-HANDOFF-01 权益读取 — 未知与没有严格分离', () => {
  it('端口未接线 → UNKNOWN：不诱导购买、也不声称已覆盖', async () => {
    const result = await readCustomsUnlockEntitlement({ ...BASE, port: null });
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasonCodes).toEqual(['ENTITLEMENT_READ_NOT_WIRED']);
    expect(result.shouldOfferPurchase).toBe(false);
    expect(result.purchaseBlocked).toBe(true);
    expect(resolveUnlockCtaDecision(result)).toEqual({
      alreadyCovered: false,
      showPurchaseEntry: false,
      showUnknownNotice: true,
    });
  });

  it('读取抛错 → UNKNOWN（绝不 fallback 成"没有权益"）', async () => {
    const result = await readCustomsUnlockEntitlement({ ...BASE, port: portOf(new Error('db down')) });
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasonCodes).toEqual(['ENTITLEMENT_READ_FAILED']);
    expect(result.shouldOfferPurchase).toBe(false);
  });

  it('明确查无记录 → 可提示购买（唯一允许诱导的情形）', async () => {
    const result = await readCustomsUnlockEntitlement({ ...BASE, port: portOf(null) });
    expect(result.reasonCodes).toEqual(['NO_ENTITLEMENT_ON_RECORD']);
    expect(result.shouldOfferPurchase).toBe(true);
    expect(result.purchaseBlocked).toBe(false);
  });
});

describe('V2-HANDOFF-01 权益读取 — 有效/耗尽/失效/跨租户', () => {
  it('有额度 → ACTIVE_WITH_QUOTA：不重复要求购买', async () => {
    const result = await readCustomsUnlockEntitlement({ ...BASE, port: portOf(record()) });
    expect(result.state).toBe('ACTIVE_WITH_QUOTA');
    expect(result.entitlementId).toBe('ent-quote-1');
    expect(resolveUnlockCtaDecision(result)).toEqual({
      alreadyCovered: true,
      showPurchaseEntry: false,
      showUnknownNotice: false,
    });
  });

  it('额度耗尽 → ACTIVE_EXHAUSTED：可再次购买', async () => {
    const result = await readCustomsUnlockEntitlement({
      ...BASE,
      port: portOf(record({ quotaRemaining: 0 })),
    });
    expect(result.state).toBe('ACTIVE_EXHAUSTED');
    expect(result.shouldOfferPurchase).toBe(true);
  });

  it('撤销 / 过期 / 取消 → 各自状态且可再次购买', async () => {
    for (const status of ['REVOKED', 'EXPIRED', 'CANCELED'] as const) {
      const result = await readCustomsUnlockEntitlement({ ...BASE, port: portOf(record({ status })) });
      expect(result.state).toBe(status);
      expect(result.shouldOfferPurchase).toBe(true);
    }
  });

  it('跨租户 → TENANT_MISMATCH：不展示、不解锁、不诱导购买', async () => {
    const result = await readCustomsUnlockEntitlement({
      ...BASE,
      port: portOf(record({ organizationId: 'org-OTHER' })),
    });
    expect(result.state).toBe('TENANT_MISMATCH');
    expect(result.entitlementId).toBeNull();
    expect(result.purchaseBlocked).toBe(true);
    expect(resolveUnlockCtaDecision(result).showUnknownNotice).toBe(true);
  });
});

describe('V2-HANDOFF-01 权益读取 — 边界自证', () => {
  it('只读面不产生外写 / 资金动作', () => {
    expect(CUSTOMS_ENTITLEMENT_READ_BOUNDARY.readOnly).toBe(true);
    expect(CUSTOMS_ENTITLEMENT_READ_BOUNDARY.externalCallPerformed).toBe(false);
    expect(CUSTOMS_ENTITLEMENT_READ_BOUNDARY.chargesPerformed).toBe(false);
    expect(CUSTOMS_ENTITLEMENT_READ_BOUNDARY.grantsEntitlement).toBe(false);
    expect(CUSTOMS_ENTITLEMENT_READ_BOUNDARY.productionCredentials).toBe('ABSENT');
    expect(CUSTOMS_ENTITLEMENT_READ_VERSION).toBe('customs-unlock-entitlement-read-v2.0.0');
  });
});
