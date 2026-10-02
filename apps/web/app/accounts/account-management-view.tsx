'use client';

import { useEffect, useState } from 'react';

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
}

interface Response {
  platforms: Array<{ platform: string; accounts: Account[] }>;
  unboundLegacyConnections: Connection[];
  onboarding: { connectAccountEntry: string; explicitRebindEntry: string; realOAuthState: string };
  legend: Record<string, string>;
}

const fmt = (value: string | null) => (value ? value.slice(0, 10) : '—');

export default function AccountManagementView() {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/accounts', { cache: 'no-store' });
        if (response.status === 401) {
          if (!cancelled) setError('会话已失效，请重新登录');
          return;
        }
        if (response.status === 403) {
          if (!cancelled) setError('当前角色无权查看账户管理（需要 OWNER / ADMIN）');
          return;
        }
        if (!response.ok) {
          if (!cancelled) setError('无法加载账户数据');
          return;
        }
        const body = (await response.json()) as Response;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setError('网络错误');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="text-sm text-slate-600">加载中… / Loading…</p>;
  if (error) return <div className="rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">{error}</div>;
  if (!data) return <p className="text-sm text-slate-600">无数据</p>;

  return (
    <div className="space-y-4">
      {data.platforms.length === 0 ? (
        <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          还没有已绑定账户。可先前往{' '}
          <a className="text-blue-700 underline" href={data.onboarding.connectAccountEntry}>
            连接
          </a>{' '}
          页面创建连接并绑定账户。
        </div>
      ) : null}

      {data.platforms.map((group) => (
        <section key={group.platform} className="rounded border border-slate-200 p-3">
          <h2 className="text-sm font-medium">{group.platform}（{group.accounts.length} 个账户）</h2>
          <div className="mt-2 space-y-3">
            {group.accounts.map((account) => (
              <div key={account.id} className="rounded border border-slate-200 p-2 text-xs">
                <div className="font-medium">
                  {account.displayName} · {account.externalAccountId}
                </div>
                <div className="text-slate-600">
                  identity {account.identityVersion} · 状态 {account.status} · 创建 {fmt(account.createdAt)} · 活跃连接{' '}
                  {account.activeConnectionCount}/{account.connections.length}
                </div>
                {account.connections.length === 0 ? (
                  <div className="mt-1 text-amber-700">该账户尚无连接（transport 层未建立）。</div>
                ) : (
                  <table className="mt-1 w-full border-collapse">
                    <thead>
                      <tr className="border-b text-left text-slate-600">
                        <th className="py-1">连接</th>
                        <th className="py-1">渠道 / 域</th>
                        <th className="py-1">状态</th>
                        <th className="py-1">绑定状态</th>
                        <th className="py-1">最近同步</th>
                        <th className="py-1">最近错误</th>
                        <th className="py-1">重绑</th>
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
                            {connection.rebind.available ? (
                              <a className="text-blue-700 underline" href={data.onboarding.explicitRebindEntry}>
                                显式重绑
                              </a>
                            ) : (
                              <span className="text-slate-400">不可变</span>
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
          <h2 className="text-sm font-medium">未绑定连接（legacy，只读冻结）</h2>
          <p className="mt-1">
            这些连接没有绑定账户，系统不会自动猜测归属；请通过显式重绑选择目标账户（同租户、一次性）。
          </p>
          <ul className="mt-2 list-disc pl-5">
            {data.unboundLegacyConnections.map((connection) => (
              <li key={connection.id}>
                {connection.label} · {connection.channel} / {connection.domain} · 状态 {connection.status} · 最近错误{' '}
                {connection.safeHealthNote ?? '—'}
              </li>
            ))}
          </ul>
          <a className="mt-2 inline-block text-blue-700 underline" href={data.onboarding.explicitRebindEntry}>
            前往显式重绑
          </a>
        </section>
      ) : null}

      <p className="text-[11px] text-slate-600">
        真实平台授权（OAuth / API）：{data.onboarding.realOAuthState} —— 本页不发起真实授权，仅指向既有安全入口。
      </p>
    </div>
  );
}
