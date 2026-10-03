/**
 * TRACK A / PC-07 — ENTITLEMENT + PACKAGE UNLOCK（central plan config，单一来源）.
 * ---------------------------------------------------------------
 * 授权：MSG-20261003-92 ⑨（PC-07 ENTITLEMENT + PACKAGE UNLOCK；ACCESS / ENTITLEMENT VISIBILITY +
 * UNLOCK LOGIC，**不是** PAYMENT ACTIVATION）。
 *
 * 冻结规则：
 *   · 这是**唯一** plan → entitlement 矩阵（不复制第三份 plan matrix）。
 *   · 未知 plan / 缺失 config → fail-closed（DENIED），绝不 allow-by-default。
 *   · paymentRequired=true **不等于** payment executable=true；真实付款仍关闭（Payment = 0 / collection = OFF）。
 *
 * 只读配置层：不访问数据库、不修改任何状态。
 */

export type EntitlementKey =
  | 'opportunities.read'
  | 'claim.package.view'
  | 'claim.package.download'
  | 'claim.prepare'
  | 'appeal.package'
  | 'account.count'
  | 'connection.count';

export const ENTITLEMENT_KEYS: readonly EntitlementKey[] = [
  'opportunities.read',
  'claim.package.view',
  'claim.package.download',
  'claim.prepare',
  'appeal.package',
  'account.count',
  'connection.count',
] as const;

export interface EntitlementRule {
  /** null = 不设上限（但仍需 allowed）。 */
  limit: number | null;
  /** 该能力是否被当前套餐包含（与「是否可付款购买」无关）。 */
  allowed: boolean;
  /** 客户可读的锁原因（被限制时给出）。 */
  lockReason?: string;
  /** 该能力是否需要升级套餐才能获得（paymentRequired 另算）。 */
  upgradeRequired?: boolean;
  /** 是否需要付款才能启用（当前真实付款关闭，因此仅用于展示资格）。 */
  paymentRequired?: boolean;
}

/** 已知 plan → entitlement 规则（唯一来源）。 */
export const PLAN_ENTITLEMENTS: Record<string, Record<EntitlementKey, EntitlementRule>> = {
  TRIAL: {
    'opportunities.read': { limit: null, allowed: true },
    'claim.package.view': { limit: null, allowed: true },
    'claim.package.download': {
      limit: null,
      allowed: false,
      lockReason: 'TRIAL_PLAN_EXCLUDES_PACKAGE_DOWNLOAD',
      upgradeRequired: true,
      paymentRequired: true,
    },
    'claim.prepare': {
      limit: null,
      allowed: false,
      lockReason: 'TRIAL_PLAN_EXCLUDES_CLAIM_PREPARE',
      upgradeRequired: true,
      paymentRequired: true,
    },
    'appeal.package': {
      limit: null,
      allowed: false,
      lockReason: 'TRIAL_PLAN_EXCLUDES_APPEAL_PACKAGE',
      upgradeRequired: true,
      paymentRequired: true,
    },
    'account.count': { limit: 3, allowed: true },
    'connection.count': { limit: 5, allowed: true },
  },
  STANDARD: {
    'opportunities.read': { limit: null, allowed: true },
    'claim.package.view': { limit: null, allowed: true },
    'claim.package.download': { limit: null, allowed: true },
    'claim.prepare': { limit: null, allowed: true },
    'appeal.package': { limit: null, allowed: true },
    'account.count': { limit: 10, allowed: true },
    'connection.count': { limit: 25, allowed: true },
  },
};

/** 未知 plan → fail-closed（不返回任何 allowed 能力）。 */
export const DENY_ALL_RULES: Record<EntitlementKey, EntitlementRule> = ENTITLEMENT_KEYS.reduce(
  (accumulator, key) => {
    accumulator[key] = { limit: null, allowed: false, lockReason: 'UNKNOWN_PLAN_FAIL_CLOSED' };
    return accumulator;
  },
  {} as Record<EntitlementKey, EntitlementRule>,
);

export function isKnownPlan(plan: string | null | undefined): boolean {
  return typeof plan === 'string' && Object.prototype.hasOwnProperty.call(PLAN_ENTITLEMENTS, plan);
}

/** 读取 plan 的 entitlement 规则；未知 plan / 缺 config → DENY_ALL（fail-closed）。 */
export function rulesForPlan(plan: string | null | undefined): {
  plan: string;
  known: boolean;
  rules: Record<EntitlementKey, EntitlementRule>;
} {
  if (isKnownPlan(plan)) {
    return { plan: plan as string, known: true, rules: PLAN_ENTITLEMENTS[plan as string] };
  }
  return { plan: typeof plan === 'string' && plan !== '' ? plan : 'UNKNOWN', known: false, rules: DENY_ALL_RULES };
}

/** 真实付款当前关闭：升级动作一律不可执行，只给 guidance。 */
export const PAYMENT_STATE = {
  payment: 'ZERO',
  collection: 'OFF',
  upgradeAvailable: false,
  upgradeReason: 'PAYMENT_NOT_ENABLED',
  upgradeGuidance:
    '升级与付款通道尚未启用（Payment = 0 / collection = OFF）。当前只能查看套餐包含的能力与解锁资格，不会发起任何扣款。',
} as const;
