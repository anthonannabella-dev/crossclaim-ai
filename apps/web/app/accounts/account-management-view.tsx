'use client';

import { useEffect, useState } from 'react';

import { formatDateTime } from '../../i18n/business-language';
import type { Locale } from '../../i18n';
import type { Messages } from '../../i18n/dictionaries/zh-CN';
import InlineNotice from '../components/ui/inline-notice';
import StatusBadge, { type BadgeTone } from '../components/ui/status-badge';

interface Connection {
  id: string;
  label: string;
  kind: string;
  channel: string;
  domain: string;
  status: string;
  lastSyncAt: string | null;
  lastErrorAt: string | null;
  accountState: 'BOUND_ACTIVE' | 'BOUND_INACTIVE' | 'UNBOUND_LEGACY';
  safeHealthNote: string | null;
  actions: {
    reconnect: { available: boolean; reason: string; entry: string };
    rebind: { available: boolean; reason: string; entry: string };
  };
  rebind: { available: boolean; reason: string };
}

interface Account {
  id: string;
  platform: string;
  externalAccountId: string;
  displayName: string;
  identityVersion: string;
  status: string;
  createdAt: string;
  connections: Connection[];
  activeConnectionCount: number;
  navigation: Record<string, { available: boolean; entry: string; reason: string }>;
}

interface Response {
  platforms: Array<{ platform: string; accounts: Account[] }>;
  unboundLegacyConnections: Connection[];
  onboarding: { connectAccountEntry: string; explicitRebindEntry: string; realOAuthState: string };
  legend: Record<string, string>;
}

/**
 * UI-4 —— 账户与平台（客户视图）。
 * 客户默认看到：平台分组 / 账户 / 连接状态（客户语言）/ 最近同步 / 下一步操作；
 * 工程字段（identityVersion / accountState / domain / 原始 status code）收进「高级详情」。
 */
export default function AccountManagementView({ t, locale }: { t: Messages; locale: Locale }) {
  const copy = t.accountsPage;
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/accounts', { cache: 'no-store' });
        if (response.status === 401) {
          if (!cancelled) setError(t.common.sessionExpired);
          return;
        }
        if (response.status === 403) {
          if (!cancelled) setError(copy.forbidden);
          return;
        }
        if (!response.ok) {
          if (!cancelled) setError(copy.loadFailed);
          return;
        }
        const body = (await response.json()) as Response;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setError(t.common.networkError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [copy, t]);

  const statusLabel = (code: string): string => {
    const table = copy as unknown as Record<string, string>;
    switch (code) {
      case 'ACTIVE':
        return table.statusConnected ?? t.status.UNKNOWN;
      case 'NEEDS_AUTH':
        return table.statusNeedsAuth ?? t.status.UNKNOWN;
      case 'PAUSED':
        return table.statusPaused ?? t.status.UNKNOWN;
      case 'ERROR':
        return table.statusError ?? t.status.UNKNOWN;
      case 'REVOKED':
        return table.statusRevoked ?? t.status.UNKNOWN;
      default:
        return t.status.UNKNOWN;
    }
  };

  const statusTone = (code: string): BadgeTone => {
    switch (code) {
      case 'ACTIVE':
        return 'ok';
      case 'NEEDS_AUTH':
      case 'ERROR':
        return 'warn';
      case 'REVOKED':
        return 'danger';
      default:
        return 'neutral';
    }
  };

  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
        {[0, 1].map((index) => (
          <div key={index} className="h-40 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        ))}
        <span className="sr-only">{t.common.loading}</span>
      </div>
    );
  }
  if (error) {
    return (
      <InlineNotice tone="danger" title={t.dashboardPage.loadFailedTitle}>
        {error}
      </InlineNotice>
    );
  }
  if (!data) {
    return (
      <InlineNotice tone="info" title={copy.empty}>
        {copy.emptyNoAccountsSuffix}
      </InlineNotice>
    );
  }

  return (
    <div className="space-y-4">
      {data.platforms.length === 0 ? (
        <InlineNotice tone="info" title={copy.emptyNoAccountsPrefix}>
          {copy.emptyNoAccountsSuffix}
        </InlineNotice>
      ) : null}

      {data.platforms.map((group) => (
        <section key={group.platform} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">
            {copy.groupHeading.replace('{platform}', group.platform).replace('{count}', String(group.accounts.length))}
          </h2>
          <div className="mt-4 space-y-3">
            {group.accounts.map((account) => (
              <article key={account.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{account.displayName}</p>
                    <p className="mt-0.5 font-mono text-xs text-slate-500">{account.externalAccountId}</p>
                  </div>
                  <StatusBadge tone={statusTone(account.status)}>{statusLabel(account.status)}</StatusBadge>
                </div>

                <div className="mt-3 text-[11px] text-slate-600">
                  {copy.activeConnectionsLabel}
                  <span className="ml-1 font-medium text-slate-800">
                    {account.activeConnectionCount}/{account.connections.length}
                  </span>
                </div>

                {account.connections.length === 0 ? (
                  <p className="mt-2 text-xs text-amber-700">{copy.noConnections}</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {account.connections.map((connection) => (
                      <li key={connection.id} className="rounded-lg bg-slate-50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-xs font-medium text-slate-800">{connection.label}</p>
                            <p className="mt-0.5 text-[11px] text-slate-500">
                              {copy.colLastSync}
                              {': '}
                              {connection.lastSyncAt ? formatDateTime(connection.lastSyncAt, { locale }) : copy.never}
                            </p>
                          </div>
                          <StatusBadge tone={statusTone(connection.status)}>
                            {data.legend[connection.accountState] ?? connection.accountState}
                          </StatusBadge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          {connection.actions.reconnect.available ? (
                            <a className="text-blue-700 underline" href={connection.actions.reconnect.entry}>
                              {copy.reconnect}
                            </a>
                          ) : connection.actions.reconnect.reason === 'REAL_OAUTH_EXTERNAL_GATE' ? (
                            <span className="text-slate-500">{copy.reconnectGated}</span>
                          ) : null}
                          {connection.rebind.available ? (
                            <a className="text-blue-700 underline" href={data.onboarding.explicitRebindEntry}>
                              {copy.explicitRebind}
                            </a>
                          ) : (
                            <span className="text-slate-400">{copy.immutable}</span>
                          )}
                        </div>
                        {connection.safeHealthNote ? (
                          <p className="mt-1 text-[11px] text-slate-500">{connection.safeHealthNote}</p>
                        ) : null}
                        <details className="mt-2 text-[11px] text-slate-500">
                          <summary className="cursor-pointer">{copy.advancedDetails}</summary>
                          <ul className="mt-1 space-y-0.5 font-mono">
                            <li>status={connection.status}</li>
                            <li>kind={connection.kind}</li>
                            <li>domain={connection.domain}</li>
                            <li>channel={connection.channel}</li>
                            <li>accountState={connection.accountState}</li>
                          </ul>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}

                <details className="mt-3 text-[11px] text-slate-500">
                  <summary className="cursor-pointer">{copy.advancedDetails}</summary>
                  <ul className="mt-1 space-y-0.5 font-mono">
                    <li>platform={account.platform}</li>
                    <li>identityVersion={account.identityVersion}</li>
                    <li>status={account.status}</li>
                    <li>createdAt={account.createdAt}</li>
                  </ul>
                </details>
              </article>
            ))}
          </div>
        </section>
      ))}

      {data.unboundLegacyConnections.length > 0 ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 sm:p-6">
          <h2 className="text-sm font-semibold">{copy.legacyTitle}</h2>
          <p className="mt-1">{copy.legacyNote}</p>
          <ul className="mt-2 space-y-1">
            {data.unboundLegacyConnections.map((connection) => (
              <li key={connection.id}>
                {copy.legacyItem
                  .replace('{label}', connection.label)
                  .replace('{channel}', connection.channel)
                  .replace('{domain}', connection.domain)
                  .replace('{status}', connection.status)
                  .replace('{note}', connection.safeHealthNote ?? '-')}
              </li>
            ))}
          </ul>
          <a className="mt-2 inline-block text-blue-700 underline" href={data.onboarding.explicitRebindEntry}>
            {copy.goExplicitRebind}
          </a>
        </section>
      ) : null}

      <p className="text-[11px] text-slate-500">
        {copy.realOAuthNote.replace('{state}', data.onboarding.realOAuthState)}
      </p>
    </div>
  );
}
