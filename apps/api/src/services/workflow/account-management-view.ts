/**
 * TRACK A / PC-06 — ACCOUNT MANAGEMENT（customer-visible account projection）.
 * ---------------------------------------------------------------
 * 授权：MSG-20261003-89 ⑭（PC-06 ACCOUNT MANAGEMENT）。
 *
 * 冻结规则（架构方明确）：
 *   1. 继续保持模型分离：PlatformAccount = business identity；SourceConnection = transport / auth lifecycle。
 *      **绝不能**重新混成一个模型。
 *   2. 多账户分组：UI 必须支持「一个 platform 下的多个 account」，**不得**重新引入 provider singleton 假设。
 *   3. Connection 可见性只返回安全字段；**禁止**返回 credentialRef / config secret / token / OAuth payload。
 *   4. bound / unbound 语义必须明确：BOUND_ACTIVE / BOUND_INACTIVE / UNBOUND_LEGACY；
 *      legacy unbound 不可自动猜 account，沿用 Track B 的 explicit bind/rebind policy。
 *   5. onboarding 只能指向既有安全 capability（本批**不接**真实 provider OAuth；real OAuth/API 仍 EXTERNAL INTEGRATION GATE）。
 *
 * 只读投影：不写入、不绑定、不重绑、不触发外写。
 * 边界：NO platform write · Payment = 0 · TRANSPORT=false · 无生产凭据。
 */

import type { PrismaClient } from '@prisma/client';

import { assertPermission } from './permissions';

export type ConnectionAccountState = 'BOUND_ACTIVE' | 'BOUND_INACTIVE' | 'UNBOUND_LEGACY';

export interface ManagedConnectionView {
  id: string;
  label: string;
  kind: string;
  channel: string;
  domain: string;
  status: string;
  lastSyncAt: string | null;
  lastErrorAt: string | null;
  accountState: ConnectionAccountState;
  /** 安全摘要：只说明「最近一次同步失败」，绝不返回原始错误文本。 */
  safeHealthNote: string | null;
  rebind: { available: boolean; reason: string };
}

export interface ManagedAccountView {
  id: string;
  platform: string;
  externalAccountId: string;
  displayName: string;
  identityVersion: string;
  status: string;
  createdAt: string;
  connections: ManagedConnectionView[];
  activeConnectionCount: number;
}

export interface AccountManagementView {
  organizationId: string;
  platforms: Array<{ platform: string; accounts: ManagedAccountView[] }>;
  unboundLegacyConnections: ManagedConnectionView[];
  onboarding: {
    /** 只能指向既有安全入口（连接/重绑），本批不接真实 OAuth。 */
    connectAccountEntry: string;
    explicitRebindEntry: string;
    realOAuthState: 'EXTERNAL_INTEGRATION_GATE';
  };
  legend: Record<ConnectionAccountState, string>;
}

export const ACCOUNT_STATE_LEGEND: Record<ConnectionAccountState, string> = {
  BOUND_ACTIVE: '已绑定并可同步',
  BOUND_INACTIVE: '已绑定但未启用',
  UNBOUND_LEGACY: '未绑定（legacy，需显式绑定，不会自动猜测账户）',
};

export interface AccountManagementActor {
  organizationId: string;
  actorUserId: string;
  role: string;
}

function connectionState(input: { status: string; platformAccountId: string | null }): ConnectionAccountState {
  if (input.platformAccountId === null) return 'UNBOUND_LEGACY';
  return input.status === 'ACTIVE' ? 'BOUND_ACTIVE' : 'BOUND_INACTIVE';
}

export async function getAccountManagementView(
  prisma: PrismaClient,
  actor: AccountManagementActor,
): Promise<AccountManagementView> {
  // 与连接管理同一权限口径（OWNER / ADMIN）；未知角色 fail-closed。
  assertPermission(actor.role, 'manageConnections');

  const accounts = await prisma.platformAccount.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: [{ platform: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      platform: true,
      externalAccountId: true,
      displayName: true,
      identityVersion: true,
      status: true,
      createdAt: true,
    },
  });

  const connections = await prisma.sourceConnection.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      label: true,
      kind: true,
      channel: true,
      domain: true,
      status: true,
      lastSyncAt: true,
      lastErrorAt: true,
      platformAccountId: true,
      // 安全字段：不读取 credentialRef / config。
    },
  });

  const toView = (connection: (typeof connections)[number]): ManagedConnectionView => {
    const state = connectionState(connection);
    return {
      id: connection.id,
      label: connection.label,
      kind: connection.kind,
      channel: connection.channel,
      domain: connection.domain,
      status: connection.status,
      lastSyncAt: connection.lastSyncAt ? connection.lastSyncAt.toISOString() : null,
      lastErrorAt: connection.lastErrorAt ? connection.lastErrorAt.toISOString() : null,
      accountState: state,
      safeHealthNote: connection.lastErrorAt ? '最近一次同步失败（详细信息仅内部可见）。' : null,
      rebind:
        state === 'UNBOUND_LEGACY'
          ? { available: true, reason: 'LEGACY_UNBOUND_EXPLICIT_REBIND' }
          : { available: false, reason: 'ALREADY_BOUND_IMMUTABLE' },
    };
  };

  const byAccount = new Map<string, ManagedConnectionView[]>();
  const unboundLegacyConnections: ManagedConnectionView[] = [];
  for (const connection of connections) {
    const view = toView(connection);
    if (connection.platformAccountId === null) {
      unboundLegacyConnections.push(view);
      continue;
    }
    const list = byAccount.get(connection.platformAccountId) ?? [];
    list.push(view);
    byAccount.set(connection.platformAccountId, list);
  }

  const platformGroups = new Map<string, ManagedAccountView[]>();
  for (const account of accounts) {
    const accountConnections = byAccount.get(account.id) ?? [];
    const view: ManagedAccountView = {
      id: account.id,
      platform: account.platform,
      externalAccountId: account.externalAccountId,
      displayName: account.displayName,
      identityVersion: account.identityVersion,
      status: account.status,
      createdAt: account.createdAt.toISOString(),
      connections: accountConnections,
      activeConnectionCount: accountConnections.filter((item) => item.status === 'ACTIVE').length,
    };
    const list = platformGroups.get(account.platform) ?? [];
    list.push(view);
    platformGroups.set(account.platform, list);
  }

  return {
    organizationId: actor.organizationId,
    // 多账户分组：同一 platform 下可以并列多个 account（不引入 provider singleton 假设）。
    platforms: [...platformGroups.entries()].map(([platform, grouped]) => ({ platform, accounts: grouped })),
    unboundLegacyConnections,
    onboarding: {
      connectAccountEntry: '/connections',
      explicitRebindEntry: '/connections',
      realOAuthState: 'EXTERNAL_INTEGRATION_GATE',
    },
    legend: ACCOUNT_STATE_LEGEND,
  };
}
