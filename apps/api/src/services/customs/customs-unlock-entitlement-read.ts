/**
 * V2-HANDOFF-01 — CUSTOMS UNLOCK ENTITLEMENT READ（权益只读面 · fail-closed）
 * ---------------------------------------------------------------
 * 授权：审计 `MSG-20261010-57` 的 `NEXT_AUTHORIZED = V2_HOST_HANDOFF_AND_EXTERNAL_ENABLEMENT_PREPARATION`
 *   （该裁决明确指出 `ENTITLEMENT_AWARE_CTA` "并不是单纯等待外部服务自动解决的事项，仍需要实际实现"）。
 *
 * 背景：V2-06 的解锁页此前以 `alreadyCovered = false` **硬编码**渲染，
 *   这等于向客户宣称"你没有权益"。本模块建立真实的**只读**权益读取面，
 *   并把"未知"与"没有"严格分开——未知时不得显示购买诱导，也不得声称已有权益。
 *
 * 状态（互斥、由服务端事实推导）：
 *   ACTIVE_WITH_QUOTA  —— 有有效权益且额度 > 0（不应再提示购买）
 *   ACTIVE_EXHAUSTED   —— 有有效权益但额度耗尽（可再次购买）
 *   REVOKED / EXPIRED / CANCELED —— 已失效（可再次购买）
 *   TENANT_MISMATCH    —— 权益属于其他租户（一律不展示，且不得据此解锁）
 *   UNKNOWN            —— 存储未接线 / 读取失败 / 无记录（**不可**解释为"没有权益"）
 */

export const CUSTOMS_ENTITLEMENT_READ_VERSION = 'customs-unlock-entitlement-read-v2.0.0';

export const CUSTOMS_ENTITLEMENT_READ_STATES = [
  'ACTIVE_WITH_QUOTA',
  'ACTIVE_EXHAUSTED',
  'REVOKED',
  'EXPIRED',
  'CANCELED',
  'TENANT_MISMATCH',
  'UNKNOWN',
] as const;
export type CustomsEntitlementReadState = (typeof CUSTOMS_ENTITLEMENT_READ_STATES)[number];

export interface CustomsEntitlementRecord {
  entitlementId: string;
  organizationId: string;
  opportunityId: string;
  productSku: string;
  quotaTotal: number;
  quotaRemaining: number;
  status: 'ACTIVE' | 'REVOKED' | 'CANCELED' | 'EXPIRED';
}

/** 只读端口；未接线时必须返回 null（**不得**用空数组冒充"无权益"）。 */
export interface CustomsEntitlementReadPort {
  findLatest(args: {
    organizationId: string;
    opportunityId: string | null;
    productSku: string;
  }): Promise<CustomsEntitlementRecord | null>;
}

export interface CustomsEntitlementReadInput {
  /** 未接线 / 不可用时传 null → 一律 UNKNOWN。 */
  port: CustomsEntitlementReadPort | null;
  organizationId: string;
  opportunityId: string | null;
  productSku: string;
}

export interface CustomsEntitlementReadResult {
  kind: 'CUSTOMS_ENTITLEMENT_READ';
  version: string;
  state: CustomsEntitlementReadState;
  reasonCodes: readonly string[];
  /** 仅 ACTIVE_WITH_QUOTA / ACTIVE_EXHAUSTED 时非空。 */
  entitlementId: string | null;
  quotaRemaining: number | null;
  /** 是否应提示客户购买：**只有明确知道没有可用权益**时才为 true。 */
  shouldOfferPurchase: boolean;
  /** 页面是否应阻止购买入口（未知 / 已覆盖 / 跨租户）。 */
  purchaseBlocked: boolean;
  /** 本模块永不发起支付或外写。 */
  externalCallPerformed: false;
  chargesPerformed: false;
  productionCredentials: 'ABSENT';
}

export async function readCustomsUnlockEntitlement(
  input: CustomsEntitlementReadInput,
): Promise<CustomsEntitlementReadResult> {
  const base = {
    kind: 'CUSTOMS_ENTITLEMENT_READ' as const,
    version: CUSTOMS_ENTITLEMENT_READ_VERSION,
    externalCallPerformed: false as const,
    chargesPerformed: false as const,
    productionCredentials: 'ABSENT' as const,
  };
  const unknown = (reason: string): CustomsEntitlementReadResult => ({
    ...base,
    state: 'UNKNOWN',
    reasonCodes: [reason],
    entitlementId: null,
    quotaRemaining: null,
    // 未知 ≠ 没有权益：既不能诱导购买，也不能声称已覆盖
    shouldOfferPurchase: false,
    purchaseBlocked: true,
  });

  if (input.port === null) return unknown('ENTITLEMENT_READ_NOT_WIRED');

  let record: CustomsEntitlementRecord | null;
  try {
    record = await input.port.findLatest({
      organizationId: input.organizationId,
      opportunityId: input.opportunityId,
      productSku: input.productSku,
    });
  } catch {
    // 读取失败 → 未知（绝不 fallback 成"没有权益"）
    return unknown('ENTITLEMENT_READ_FAILED');
  }

  if (record === null) {
    // 端口可用且明确"查无记录"——这是唯一可以提示购买的可靠结论
    return {
      ...base,
      state: 'ACTIVE_EXHAUSTED',
      reasonCodes: ['NO_ENTITLEMENT_ON_RECORD'],
      entitlementId: null,
      quotaRemaining: 0,
      shouldOfferPurchase: true,
      purchaseBlocked: false,
    };
  }

  if (record.organizationId !== input.organizationId) {
    // 跨租户：不展示、不解锁、不诱导购买
    return {
      ...base,
      state: 'TENANT_MISMATCH',
      reasonCodes: ['ENTITLEMENT_TENANT_MISMATCH'],
      entitlementId: null,
      quotaRemaining: null,
      shouldOfferPurchase: false,
      purchaseBlocked: true,
    };
  }

  if (record.status === 'REVOKED' || record.status === 'EXPIRED' || record.status === 'CANCELED') {
    return {
      ...base,
      state: record.status,
      reasonCodes: ['ENTITLEMENT_NOT_ACTIVE'],
      entitlementId: record.entitlementId,
      quotaRemaining: 0,
      shouldOfferPurchase: true,
      purchaseBlocked: false,
    };
  }

  return {
    ...base,
    state: record.quotaRemaining > 0 ? 'ACTIVE_WITH_QUOTA' : 'ACTIVE_EXHAUSTED',
    reasonCodes: [record.quotaRemaining > 0 ? 'ENTITLEMENT_ACTIVE_WITH_QUOTA' : 'ENTITLEMENT_EXHAUSTED'],
    entitlementId: record.entitlementId,
    quotaRemaining: record.quotaRemaining,
    shouldOfferPurchase: record.quotaRemaining <= 0,
    purchaseBlocked: record.quotaRemaining > 0,
  };
}

/** 页面用：把读取结果折算为 CTA 决策（未知一律不改写为"未覆盖"）。 */
export function resolveUnlockCtaDecision(result: CustomsEntitlementReadResult): {
  alreadyCovered: boolean;
  showPurchaseEntry: boolean;
  showUnknownNotice: boolean;
} {
  if (result.state === 'UNKNOWN' || result.state === 'TENANT_MISMATCH') {
    return { alreadyCovered: false, showPurchaseEntry: false, showUnknownNotice: true };
  }
  if (result.state === 'ACTIVE_WITH_QUOTA') {
    return { alreadyCovered: true, showPurchaseEntry: false, showUnknownNotice: false };
  }
  return { alreadyCovered: false, showPurchaseEntry: result.shouldOfferPurchase, showUnknownNotice: false };
}

/** 边界自证：只读面不产生外写 / 资金动作。 */
export const CUSTOMS_ENTITLEMENT_READ_BOUNDARY = {
  readOnly: true,
  externalCallPerformed: false,
  chargesPerformed: false,
  grantsEntitlement: false,
  autoCollectionEnabled: false,
  productionCredentials: 'ABSENT',
} as const;
