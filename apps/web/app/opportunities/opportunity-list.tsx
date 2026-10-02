'use client';

import { useCallback, useEffect, useState } from 'react';

interface OpportunityItem {
  id: string;
  status: string;
  customerStatus: { code: string; label: string };
  opportunityType: string;
  title: string;
  description: string | null;
  recoverableAmount: string | null;
  currency: string;
  confidence: number | null;
  claimDeadline: string | null;
  detectedAt: string;
  channel: string;
  domain: string;
  accountState: 'ATTRIBUTED' | 'LEGACY_UNATTRIBUTED';
  account: { id: string; platform: string; externalAccountId: string; displayName: string } | null;
  actions: { canQualify: boolean; canReject: boolean; canCreateCase: boolean };
}

interface ListResponse {
  items: OpportunityItem[];
  nextCursor: string | null;
  hasMore: boolean;
  pageSize: number;
}

const STATUS_OPTIONS = ['DETECTED', 'QUALIFIED', 'REJECTED', 'CONVERTED', 'EXPIRED'];

/**
 * PC-02 客户可见机会列表。
 * loading / no opportunities / filtered no results / API error 四种状态分别呈现。
 */
export default function OpportunityList() {
  const [items, setItems] = useState<OpportunityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState('');
  const [domain, setDomain] = useState('');
  const [channel, setChannel] = useState('');
  const [accountId, setAccountId] = useState('');
  const [minRecoverable, setMinRecoverable] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtered, setFiltered] = useState(false);

  const load = useCallback(
    async (mode: 'reset' | 'more', nextPageCursor?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        if (domain) params.set('domain', domain);
        if (channel) params.set('channel', channel);
        if (accountId) params.set('accountId', accountId);
        if (minRecoverable) params.set('minRecoverable', minRecoverable);
        if (mode === 'more' && nextPageCursor) params.set('cursor', nextPageCursor);
        const response = await fetch('/api/opportunities?' + params.toString(), { cache: 'no-store' });
        if (response.status === 401) {
          setError('会话已失效，请重新登录 / Session expired');
          setItems([]);
          return;
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? 'API error');
          return;
        }
        const body = (await response.json()) as ListResponse;
        setItems((previous) => (mode === 'more' ? [...previous, ...body.items] : body.items));
        setNextCursor(body.nextCursor);
        setHasMore(body.hasMore);
        setFiltered(
          Boolean(status || domain || channel || accountId || minRecoverable),
        );
      } catch {
        setError('网络错误 / Network error');
      } finally {
        setLoading(false);
      }
    },
    [status, domain, channel, accountId, minRecoverable],
  );

  useEffect(() => {
    void load('reset');
  }, [load]);

  const resetAndLoad = () => {
    setCursor(null);
    void load('reset');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded border border-slate-200 p-3">
        <label className="text-sm">
          <span className="block text-slate-700">状态</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="mt-1 rounded border px-2 py-1">
            <option value="">全部</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-slate-700">domain</span>
          <input value={domain} onChange={(event) => setDomain(event.target.value)} className="mt-1 w-32 rounded border px-2 py-1" />
        </label>
        <label className="text-sm">
          <span className="block text-slate-700">channel</span>
          <input value={channel} onChange={(event) => setChannel(event.target.value)} className="mt-1 w-32 rounded border px-2 py-1" />
        </label>
        <label className="text-sm">
          <span className="block text-slate-700">accountId</span>
          <input value={accountId} onChange={(event) => setAccountId(event.target.value)} className="mt-1 w-56 rounded border px-2 py-1" />
        </label>
        <label className="text-sm">
          <span className="block text-slate-700">最低可追回金额</span>
          <input
            value={minRecoverable}
            onChange={(event) => setMinRecoverable(event.target.value)}
            inputMode="decimal"
            className="mt-1 w-32 rounded border px-2 py-1"
          />
        </label>
        <button type="button" onClick={resetAndLoad} className="rounded bg-slate-900 px-3 py-2 text-sm text-white">
          应用筛选
        </button>
      </div>

      {error ? (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          加载失败：{error}
        </div>
      ) : null}

      {loading && items.length === 0 ? <p className="text-sm text-slate-600">加载中… / Loading…</p> : null}

      {!loading && !error && items.length === 0 && !filtered ? (
        <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          目前还没有可追回机会。导入账单后系统会自动检测。
        </div>
      ) : null}

      {!loading && !error && items.length === 0 && filtered ? (
        <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          当前筛选条件下没有结果。 / No results for the current filters.
        </div>
      ) : null}

      {items.length > 0 ? (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-slate-600">
              <th className="py-2">机会</th>
              <th className="py-2">状态</th>
              <th className="py-2">账户</th>
              <th className="py-2 text-right">预计可追回</th>
              <th className="py-2">检测时间</th>
              <th className="py-2">入口</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b align-top">
                <td className="py-2">
                  <div className="font-medium">{item.title}</div>
                  <div className="text-xs text-slate-500">
                    {item.opportunityType} · {item.domain} / {item.channel}
                  </div>
                  {item.description ? <div className="text-xs text-slate-500">{item.description}</div> : null}
                </td>
                <td className="py-2">
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                    {item.customerStatus.label}（{item.customerStatus.code}）
                  </span>
                </td>
                <td className="py-2 text-xs">
                  {item.account ? (
                    <>
                      <div>{item.account.displayName}</div>
                      <div className="text-slate-500">
                        {item.account.platform} · {item.account.externalAccountId}
                      </div>
                    </>
                  ) : (
                    <span className="text-amber-700">未归因（legacy）</span>
                  )}
                </td>
                <td className="py-2 text-right">
                  {item.recoverableAmount ? item.recoverableAmount + ' ' + item.currency : '—'}
                </td>
                <td className="py-2 text-xs text-slate-600">{item.detectedAt.slice(0, 10)}</td>
                <td className="py-2 text-xs">
                  {item.actions.canQualify ? <a className="text-blue-700" href={'/cases?opportunity=' + item.id}>进入复核</a> : null}
                  {item.actions.canCreateCase ? <a className="text-blue-700" href={'/cases?opportunity=' + item.id}>建案</a> : null}
                  {!item.actions.canQualify && !item.actions.canCreateCase ? <span className="text-slate-400">—</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {hasMore ? (
        <button
          type="button"
          onClick={() => {
            setCursor(nextCursor);
            void load('more', nextCursor);
          }}
          disabled={loading}
          className="rounded border px-3 py-2 text-sm"
        >
          {loading ? '加载中…' : '加载更多 / Load more'}
        </button>
      ) : null}
      {cursor ? <p className="text-xs text-slate-500">已加载 {items.length} 条</p> : null}
    </div>
  );
}
