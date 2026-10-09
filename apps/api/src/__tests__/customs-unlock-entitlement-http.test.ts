// V2-HANDOFF-04 — 权益只读路由处理器回归

import { describe, expect, it, vi } from 'vitest';

import {
  CUSTOMS_UNLOCK_ENTITLEMENT_HTTP_BOUNDARY,
  handleCustomsUnlockEntitlementRead,
} from '../services/customs/customs-unlock-entitlement-http';
import type {
  CustomsEntitlementReadPort,
  CustomsEntitlementRecord,
} from '../services/customs/customs-unlock-entitlement-read';

const SESSION = { organizationId: 'org-1' };

function portOf(value: CustomsEntitlementRecord | null | Error): CustomsEntitlementReadPort {
  return {
    findLatest: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

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

describe('V2-HANDOFF-04 只读路由 — 鉴权与入参', () => {
  it('无会话 → 401；缺 productSku → 400', async () => {
    const noSession = await handleCustomsUnlockEntitlementRead({
      session: null,
      deps: { port: portOf(null) },
      opportunityId: 'opp-1',
      productSku: 'CUSTOMS_SINGLE_REVIEW',
    });
    expect(noSession.status).toBe(401);

    const noSku = await handleCustomsUnlockEntitlementRead({
      session: SESSION,
      deps: { port: portOf(null) },
      opportunityId: 'opp-1',
      productSku: '   ',
    });
    expect(noSku.status).toBe(400);
    expect(noSku.body.error).toBe('PRODUCT_SKU_REQUIRED');
  });
});

describe('V2-HANDOFF-04 只读路由 — 未知不得冒充"没有权益"', () => {
  it('端口未接线 → 200 + UNKNOWN（不是 404）', async () => {
    const result = await handleCustomsUnlockEntitlementRead({
      session: SESSION,
      deps: { port: null },
      opportunityId: 'opp-1',
      productSku: 'CUSTOMS_SINGLE_REVIEW',
    });
    expect(result.status).toBe(200);
    expect(result.body.state).toBe('UNKNOWN');
    expect(result.body.shouldOfferPurchase).toBe(false);
    expect(result.body.showUnknownNotice).toBe(true);
    expect(result.body.showPurchaseEntry).toBe(false);
  });

  it('读取失败 → 200 + UNKNOWN', async () => {
    const result = await handleCustomsUnlockEntitlementRead({
      session: SESSION,
      deps: { port: portOf(new Error('db down')) },
      opportunityId: 'opp-1',
      productSku: 'CUSTOMS_SINGLE_REVIEW',
    });
    expect(result.status).toBe(200);
    expect(result.body.state).toBe('UNKNOWN');
    expect(result.body.reasonCodes).toEqual(['ENTITLEMENT_READ_FAILED']);
  });
});

describe('V2-HANDOFF-04 只读路由 — 已覆盖 / 可购买 / 跨租户', () => {
  it('有额度 → alreadyCovered=true 且不显示购买入口', async () => {
    const result = await handleCustomsUnlockEntitlementRead({
      session: SESSION,
      deps: { port: portOf(record()) },
      opportunityId: 'opp-1',
      productSku: 'CUSTOMS_SINGLE_REVIEW',
    });
    expect(result.body.state).toBe('ACTIVE_WITH_QUOTA');
    expect(result.body.alreadyCovered).toBe(true);
    expect(result.body.showPurchaseEntry).toBe(false);
    expect(result.body.entitlementId).toBe('ent-quote-1');
  });

  it('明确查无记录 → 可显示购买入口', async () => {
    const result = await handleCustomsUnlockEntitlementRead({
      session: SESSION,
      deps: { port: portOf(null) },
      opportunityId: 'opp-1',
      productSku: 'CUSTOMS_SINGLE_REVIEW',
    });
    expect(result.body.showPurchaseEntry).toBe(true);
    expect(result.body.alreadyCovered).toBe(false);
  });

  it('跨租户权益 → 不泄露 id、不显示购买入口、提示未知态', async () => {
    const result = await handleCustomsUnlockEntitlementRead({
      session: SESSION,
      deps: { port: portOf(record({ organizationId: 'org-OTHER' })) },
      opportunityId: 'opp-1',
      productSku: 'CUSTOMS_SINGLE_REVIEW',
    });
    expect(result.body.state).toBe('TENANT_MISMATCH');
    expect(result.body.entitlementId).toBeNull();
    expect(result.body.showPurchaseEntry).toBe(false);
    expect(result.body.showUnknownNotice).toBe(true);
  });
});

describe('V2-HANDOFF-04 只读路由 — 边界自证', () => {
  it('响应标注只读；处理器不注册路由 / 不写库 / 不产生资金动作', async () => {
    const result = await handleCustomsUnlockEntitlementRead({
      session: SESSION,
      deps: { port: portOf(record()) },
      opportunityId: 'opp-1',
      productSku: 'CUSTOMS_SINGLE_REVIEW',
    });
    expect(result.body.readOnly).toBe(true);
    expect(CUSTOMS_UNLOCK_ENTITLEMENT_HTTP_BOUNDARY.registersRoute).toBe(false);
    expect(CUSTOMS_UNLOCK_ENTITLEMENT_HTTP_BOUNDARY.writesDatabase).toBe(false);
    expect(CUSTOMS_UNLOCK_ENTITLEMENT_HTTP_BOUNDARY.chargesPerformed).toBe(false);
    expect(CUSTOMS_UNLOCK_ENTITLEMENT_HTTP_BOUNDARY.unknownIsNotAbsence).toBe(true);
  });
});
