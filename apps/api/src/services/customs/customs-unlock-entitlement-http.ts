/**
 * V2-HANDOFF-04 — 权益只读路由处理器（GET /customs/unlock/entitlement）
 * ---------------------------------------------------------------
 * 授权：审计 `MSG-20261010-57` 的 `V2_HOST_HANDOFF_AND_EXTERNAL_ENABLEMENT_PREPARATION`
 *   （`ENTITLEMENT_AWARE_CTA` 需实际实现；前端已就位，缺只读路由）。
 *
 * 设计要点：
 *  1. 本模块是**纯处理器**（不注册路由、不碰 server/router），按项目既有只读投影风格返回 `{status, body}`。
 *  2. 端口未接线 / 读取失败 → **200 + state=UNKNOWN**，绝不返回 404 冒充"没有权益"。
 *     （404 会让前端与调用方把"不知道"读成"确实没有"，进而诱导重复购买。）
 *  3. 缺会话 → 401；缺/非法 productSku → 400。
 *  4. 响应只含展示所需字段与原因码；不返回任何密钥、连接串或跨租户数据。
 *
 * 接线说明（未在本轮执行，因需同时改两处且属高风险编辑）：
 *   · `apps/api/src/services/workflow/http-routes.ts`：把 `unlock-entitlement` 加入
 *     `customs-opportunities/[^/]+/(…)` 这一组分支，并在 deps 里传 `customsUnlockEntitlementPort`；
 *   · `apps/api/src/server.ts` 第 ~157 行的**路径允许清单正则**必须同时放行该路径，否则请求会被前置拒绝。
 */

import {
  readCustomsUnlockEntitlement,
  resolveUnlockCtaDecision,
  type CustomsEntitlementReadPort,
} from './customs-unlock-entitlement-read';

export const CUSTOMS_UNLOCK_ENTITLEMENT_ROUTE = '/customs/unlock/entitlement';

export interface CustomsUnlockEntitlementHttpSession {
  organizationId: string;
}

export interface CustomsUnlockEntitlementHttpDeps {
  /** 未接线时为 null → 一律 UNKNOWN（不冒充"没有权益"）。 */
  port: CustomsEntitlementReadPort | null;
}

export interface CustomsUnlockEntitlementHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleCustomsUnlockEntitlementRead(input: {
  session: CustomsUnlockEntitlementHttpSession | null;
  deps: CustomsUnlockEntitlementHttpDeps;
  opportunityId: string | null;
  productSku: string | null;
}): Promise<CustomsUnlockEntitlementHttpResult> {
  if (input.session === null || input.session.organizationId.trim().length === 0) {
    return { status: 401, body: { error: 'UNAUTHENTICATED' } };
  }
  const productSku = input.productSku ?? '';
  if (productSku.trim().length === 0) {
    return { status: 400, body: { error: 'PRODUCT_SKU_REQUIRED' } };
  }

  const result = await readCustomsUnlockEntitlement({
    port: input.deps.port,
    organizationId: input.session.organizationId,
    opportunityId: input.opportunityId,
    productSku,
  });
  const decision = resolveUnlockCtaDecision(result);

  return {
    status: 200,
    body: {
      state: result.state,
      shouldOfferPurchase: result.shouldOfferPurchase,
      purchaseBlocked: result.purchaseBlocked,
      alreadyCovered: decision.alreadyCovered,
      showPurchaseEntry: decision.showPurchaseEntry,
      showUnknownNotice: decision.showUnknownNotice,
      entitlementId: result.entitlementId,
      quotaRemaining: result.quotaRemaining,
      reasonCodes: result.reasonCodes,
      /** 只读面自证：永不含资金动作。 */
      readOnly: true,
    },
  };
}

/** 边界自证：处理器不写库、不发起外部调用、不产生资金动作。 */
export const CUSTOMS_UNLOCK_ENTITLEMENT_HTTP_BOUNDARY = {
  registersRoute: false,
  writesDatabase: false,
  externalCallPerformed: false,
  chargesPerformed: false,
  unknownIsNotAbsence: true,
  productionCredentials: 'ABSENT',
} as const;
