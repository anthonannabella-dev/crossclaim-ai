'use client';

import { useEffect, useState } from 'react';

import type { Messages } from '../../i18n/dictionaries/zh-CN';

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

const fmt = (value: string | null) => (value ? value.slice(0, 10) : '—');

export default function AccountManagementView({ t }: { t: Messages }) {
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

  if (loading) return <p className="text-sm text-slate-600">{t.common.loading}</p>;
  if (error) return <div className="rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">{error}</div>;
  if (!data) return <p className="text-sm text-slate-600">{copy.empty}</p>;

  return (
    <div className="space-y-4">
      {data.platforms.length === 0 ? (
        <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          {copy.emptyNoAccountsPrefix}{' '}
          <a className="text-blue-700 underline" href={data.onboarding.connectAccountEntry}>
            {copy.linkConnections}
          </a>{' '}
          {copy.emptyNoAccountsSuffix}
        </div>
      ) : null}

      {data.platforms.map((group) => (
        <section key={group.platform} className="rounded border border-slate-200 p-3">
          <h2 className="text-sm font-medium">
            {copy.groupHeading
              .replace('{platform}', group.platform)
              .replace('{count}', String(group.accounts.length))}
          </h2>
          <div className="mt-2 space-y-3">
            {group.accounts.map((account) => (
              <div key={account.id} className="rounded border border-slate-200 p-2 text-xs">
                <div className="font-medium">
                  {account.displayName} · {account.externalAccountId}
                </div>
                <div className="text-slate-600">
                  {copy.accountMeta
                    .replace('{identityVersion}', account.identityVersion)
                    .replace('{status}', account.status)
                    .replace('{created}', fmt(account.createdAt))
                    .replace('{active}', String(account.activeConnectionCount))
                    .replace('{total}', String(account.connections.length))}
                </div>
                <div className="mt-1 text-[11px] text-slate-600">
                  {copy.downstreamEntries}
                  {account.navigation.opportunities.available ? (
                    <a className="text-blue-700 underline" href={account.navigation.opportunities.entry}>
                      {copy.navOpportunities}
                    </a>
                  ) : null}
                  {!account.navigation.recoveryMoney.available ? (
                    <span className="text-slate-500">
                      {copy.moneyFilterUnavailable.replace('{reason}', account.navigation.recoveryMoney.reason)}
                    </span>
                  ) : null}
                </div>
                {account.connections.length === 0 ? (
                  <div className="mt-1 text-amber-700">{copy.noConnections}</div>
                ) : (
                  <table className="mt-1 w-full border-collapse">
                    <thead>
                      <tr className="border-b text-left text-slate-600">
                        <th className="py-1">{copy.colConnection}</th>
                        <th className="py-1">{copy.colChannelDomain}</th>
                        <th className="py-1">{copy.colStatus}</th>
                        <th className="py-1">{copy.colBindingState}</th>
                        <th className="py-1">{copy.colLastSync}</th>
                        <th className="py-1">{copy.colLastError}</th>
                        <th className="py-1">{copy.colRebind}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {account.connections.map((connection) => (
                        <tr key={connection.id} className="border-b">
                          <td className="py-1">{connection.label}</td>
                          <td className="py-1">{connection.channel} / {connection.domain}</td>
                          <td className="py-1">{connection.status}</td>
                          <td className="py-1">{data.legend[connection.accountState] ?? connection.accountState}</td>
                          <td className="py-1">{fmt(connection.lastSyncAt)}</td>
                          <td className="py-1">{connection.safeHealthNote ?? '—'}</td>
                          <td className="py-1">
                            {connection.actions.reconnect.available ? (
                              <a className="mr-1 text-blue-700 underline" href={connection.actions.reconnect.entry}>
                                {copy.reconnect}
                              </a>
                            ) : connection.actions.reconnect.reason === 'REAL_OAUTH_EXTERNAL_GATE' ? (
                              <span className="mr-1 text-slate-500">{copy.reconnectGated}</span>
                            ) : null}
                            {connection.rebind.available ? (
                              <a className="text-blue-700 underline" href={data.onboarding.explicitRebindEntry}>
                                {copy.explicitRebind}
                              </a>
                            ) : (
                              <span className="text-slate-400">{copy.immutable}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      {data.unboundLegacyConnections.length > 0 ? (
        <section className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <h2 className="text-sm font-medium">{copy.legacyTitle}</h2>
          <p className="mt-1">{copy.legacyNote}</p>
          <ul className="mt-2 list-disc pl-5">
            {data.unboundLegacyConnections.map((connection) => (
              <li key={connection.id}>
                {copy.legacyItem
                  .replace('{label}', connection.label)
                  .replace('{channel}', connection.channel)
                  .replace('{domain}', connection.domain)
                  .replace('{status}', connection.status)
                  .replace('{note}', connection.safeHealthNote ?? '—')}
              </li>
            ))}
          </ul>
          <a className="mt-2 inline-block text-blue-700 underline" href={data.onboarding.explicitRebindEntry}>
            {copy.goExplicitRebind}
          </a>
        </section>
      ) : null}

      <p className="text-[11px] text-slate-600">
        {copy.realOAuthNote.replace('{state}', data.onboarding.realOAuthState)}
      </p>
    </div>
  );
}
