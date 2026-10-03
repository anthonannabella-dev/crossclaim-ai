/**
 * TRACK A / PC-07 — customer entitlement read projection + package unlock state.
 * ---------------------------------------------------------------
 * 授权：MSG-20261003-92 ⑨。严格只读；不激活付款、不创建 checkout、不扣款。
 *
 * 事实来源：`Organization.plan`（复用，不新建第三份 plan matrix）+ 真实计数事实
 * （PlatformAccount / SourceConnection count）。
 * 无可靠 usage 事实的能力 → `usageState = NOT_TRACKED`（不猜）。
 */

import type { PrismaClient } from '@prisma/client';

import {
  ENTITLEMENT_KEYS,
  PAYMENT_STATE,
  type EntitlementKey,
  type EntitlementRule,
  rulesForPlan,
} from '../entitlements/plan-entitlements';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

export type PackageUnlockState = 'LOCKED' | 'ELIGIBLE' | 'UNLOCKED' | 'EXHAUSTED' | 'NOT_AVAILABLE';

export const PACKAGE_UNLOCK_LABEL: Record<PackageUnlockState, string> = {
  LOCKED: '已锁定（需要升级套餐）',
  ELIGIBLE: '具备解锁资格（付款通道未启用）',
  UNLOCKED: '已包含在当前套餐',
  EXHAUSTED: '额度已用尽',
  NOT_AVAILABLE: '当前不支持',
};

export interface EntitlementView {
  key: EntitlementKey;
  allowed: boolean;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  usageState: 'TRACKED' | 'NOT_TRACKED';
  reason: string;
  source: string;
  available: boolean;
  upgradeRequired: boolean;
  paymentRequired: boolean;
  entry: string;
}

export interface EntitlementProjection {
  plan: string;
  planKnown: boolean;
  entitlements: EntitlementView[];
  packageUnlock: {
    state: PackageUnlockState;
    label: string;
    /** 付款完成与功能资格必须分开表达。 */
    eligibility: 'ELIGIBLE' | 'NOT_ELIGIBLE';
    paymentCompleted: false;
    paymentState: typeof PAYMENT_STATE.payment;
    collectionState: typeof PAYMENT_STATE.collection;
    reason: string;
  };
  upgrade: {
    available: false;
    reason: typeof PAYMENT_STATE.upgradeReason;
    guidance: string;
  };
}

export interface EntitlementActor {
  organizationId: string;
  actorUserId: string;
  role: string;
}

function usageFor(
  key: EntitlementKey,
  counters: { accounts: number; connections: number },
): { used: number | null; usageState: 'TRACKED' | 'NOT_TRACKED' } {
  if (key === 'account.count') return { used: counters.accounts, usageState: 'TRACKED' };
  if (key === 'connection.count') return { used: counters.connections, usageState: 'TRACKED' };
  // 其余能力没有可靠 usage 事实 → 不猜
  return { used: null, usageState: 'NOT_TRACKED' };
}

function project(
  key: EntitlementKey,
  rule: EntitlementRule,
  counters: { accounts: number; connections: number },
): EntitlementView {
  const { used, usageState } = usageFor(key, counters);
  const limit = rule.limit;
  const exhausted = rule.allowed && limit !== null && used !== null && used >= limit;
  const allowed = rule.allowed && !exhausted;
  const remaining = limit === null || used === null ? null : Math.max(limit - used, 0);
  const reason = !rule.allowed
    ? (rule.lockReason ?? 'PLAN_EXCLUDES_ENTITLEMENT')
    : exhausted
      ? 'LIMIT_EXHAUSTED'
      : 'ALLOWED_BY_PLAN';
  return {
    key,
    allowed,
    limit,
    used,
    remaining,
    usageState,
    reason,
    source: 'Organization.plan + plan entitlement config',
    available: allowed,
    upgradeRequired: Boolean(rule.upgradeRequired),
    // paymentRequired 仅表达「是否需要付款才能启用」，**不等于**可执行付款。
    paymentRequired: Boolean(rule.paymentRequired),
    entry: key === 'claim.package.download' ? '/cases' : '/',
  };
}

export async function getEntitlementProjection(
  prisma: PrismaClient,
  actor: EntitlementActor,
): Promise<EntitlementProjection> {
  // 与账单/金额可见性同一口径（OWNER / ADMIN / OPS / FINANCE 可看套餐；VIEWER 不可）。
  assertPermission(actor.role, 'viewBilling');

  const organization = await prisma.organization.findFirst({
    where: { id: actor.organizationId },
    select: { id: true, plan: true },
  });
  if (!organization) throw new WorkflowError('NOT_FOUND', '组织不存在');

  const [accounts, connections] = await Promise.all([
    prisma.platformAccount.count({ where: { organizationId: actor.organizationId } }),
    prisma.sourceConnection.count({ where: { organizationId: actor.organizationId } }),
  ]);

  const { plan, known, rules } = rulesForPlan(organization.plan);
  const entitlements = ENTITLEMENT_KEYS.map((key) => project(key, rules[key], { accounts, connections }));

  const download = entitlements.find((item) => item.key === 'claim.package.download');
  const view = entitlements.find((item) => item.key === 'claim.package.view');
  const state: PackageUnlockState = !view?.available
    ? 'NOT_AVAILABLE'
    : download?.remaining !== null && download?.remaining === 0
      ? 'EXHAUSTED'
      : download?.available
        ? 'UNLOCKED'
        : download?.upgradeRequired
          ? 'LOCKED'
          : 'NOT_AVAILABLE';

  return {
    plan,
    planKnown: known,
    entitlements,
    packageUnlock: {
      state,
      label: PACKAGE_UNLOCK_LABEL[state],
      // 资格与付款完成分开表达：当前付款通道关闭，因此绝不写「已付款解锁」。
      eligibility: download?.available || download?.upgradeRequired ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
      paymentCompleted: false,
      paymentState: PAYMENT_STATE.payment,
      collectionState: PAYMENT_STATE.collection,
      reason: download?.available ? 'INCLUDED_IN_CURRENT_PLAN' : (download?.reason ?? 'NOT_AVAILABLE'),
    },
    upgrade: {
      available: PAYMENT_STATE.upgradeAvailable,
      reason: PAYMENT_STATE.upgradeReason,
      guidance: PAYMENT_STATE.upgradeGuidance,
    },
  };
}

/**
 * PC-07 ⑦：package 下载的 server-side entitlement guard。
 * 只有当前套餐包含 `claim.package.download` 时才放行；否则 fail-closed。
 * 该 guard 是「服务端判定」，CLI / API / UI 都不得只靠隐藏按钮。
 */
export async function assertPackageDownloadEntitled(
  prisma: PrismaClient,
  actor: EntitlementActor,
): Promise<void> {
  const projection = await getEntitlementProjection(prisma, actor);
  const download = projection.entitlements.find((item) => item.key === 'claim.package.download');
  if (!download?.available) {
    throw new WorkflowError(
      'FORBIDDEN',
      '当前套餐未包含材料包下载（' + (download?.reason ?? 'NOT_AVAILABLE') + '）',
    );
  }
}
