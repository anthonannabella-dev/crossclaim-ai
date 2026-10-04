'use client';

import { useCallback, useEffect, useState } from 'react';

import type { Messages } from '../../i18n/dictionaries/zh-CN';
import OpportunityActions from '../components/opportunity-actions';
import OpportunityCard from '../components/opportunity-card';
import EmptyState from '../components/ui/empty-state';
import InlineNotice from '../components/ui/inline-notice';
import { buildOpportunityView, type OpportunityApiItem } from '../lib/dashboard-view';

interface ListResponse {
  items: OpportunityApiItem[];
  nextCursor: string | null;
  hasMore: boolean;
  pageSize: number;
}

const STATUS_OPTIONS = ['DETECTED', 'QUALIFIED', 'REJECTED', 'CONVERTED', 'EXPIRED'] as const;

/**
 * UI-3 —— 机会发现页（客户视图）。
 * 默认：客户语言状态筛选 + 机会卡片（来源 / 问题 / 预计可追回 / 可信度 / 截止时间 / 下一步）。
 * 工程筛选（domain / channel / accountId / 最低金额）收进「高级筛选」；loading / empty / filtered-empty / error 分别呈现。
 */
export default function OpportunityList({ t }: { t: Messages }) {
  const copy = t.opportunitiesPage;
  const [items, setItems] = useState<OpportunityApiItem[]>([]);
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
          setError(t.common.sessionExpired);
          setItems([]);
          return;
        }
        if (response.status === 403) {
          setError(t.common.permissionDenied);
          setItems([]);
          return;
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? 'API error');
          setItems([]);
          return;
        }
        const body = (await response.json()) as ListResponse;
        setItems((previous) => (mode === 'more' ? [...previous, ...body.items] : body.items));
        setNextCursor(body.nextCursor);
        setHasMore(body.hasMore);
        setFiltered(Boolean(status || domain || channel || accountId || minRecoverable));
      } catch {
        setError(t.common.networkError);
      } finally {
        setLoading(false);
      }
    },
    [status, domain, channel, accountId, minRecoverable, t],
  );

  useEffect(() => {
    void load('reset');
  }, [load]);

  const applyFilters = () => void load('reset');
  const clearFilters = () => {
    setStatus('');
    setDomain('');
    setChannel('');
    setAccountId('');
    setMinRecoverable('');
  };

  const statusLabel = (code: string): string => {
    const table = t.status as unknown as Record<string, string>;
    return table[code] ?? code;
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-slate-700">{copy.filterStatus}</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="mt-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">{copy.filterAll}</option>
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {statusLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={applyFilters}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            {copy.applyFilters}
          </button>
          {filtered || status ? (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              {copy.clearFilters}
            </button>
          ) : null}
          <span className="text-xs text-slate-500">{copy.matchesCount.replace('{count}', String(items.length))}</span>
        </div>

        <details className="mt-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium">{copy.advancedFilters}</summary>
          <p className="mt-1 text-slate-500">{copy.advancedHint}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm">
              <span className="block text-slate-700">domain</span>
              <input
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block text-slate-700">channel</span>
              <input
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block text-slate-700">accountId</span>
              <input
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="block text-slate-700">{copy.filterMinRecoverable}</span>
              <input
                value={minRecoverable}
                onChange={(event) => setMinRecoverable(event.target.value)}
                inputMode="decimal"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
        </details>
      </div>

      {error ? (
        <InlineNotice tone="danger" title={t.dashboardPage.loadFailedTitle}>
          {copy.loadFailed.replace('{message}', error)}
        </InlineNotice>
      ) : null}

      {loading && items.length === 0 ? (
        <div className="grid gap-3 lg:grid-cols-2" aria-busy="true">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="h-36 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
          ))}
          <span className="sr-only">{t.common.loading}</span>
        </div>
      ) : null}

      {!loading && !error && items.length === 0 && !filtered && !status ? (
        <EmptyState
          title={copy.noItems}
          body={copy.emptyBody}
          action={{ label: t.dashboardPage.ctaConnect, href: '/connections' }}
        />
      ) : null}

      {!loading && !error && items.length === 0 && (filtered || status) ? (
        <div className="space-y-3">
          <EmptyState title={copy.noFilteredResults} />
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            {copy.clearFilters}
          </button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((item) => (
            <OpportunityCard
              key={item.id}
              view={buildOpportunityView(item, t)}
              labels={{
                estimated: t.dashboardPage.opportunityEstimated,
                confidence: t.dashboardPage.opportunityConfidence,
                deadline: t.dashboardPage.opportunityDeadline,
                noDeadline: t.dashboardPage.opportunityNoDeadline,
                nextStep: t.dashboardPage.opportunityNextStep,
                openDetails: t.dashboardPage.opportunityAdvanced,
                advanced: t.dashboardPage.opportunityAdvancedFields,
                createCase: t.dashboardPage.opportunityCreateCase,
                unattributed: copy.unattributed,
              }}
              actions={
                item.status === 'DETECTED' ? (
                  <OpportunityActions
                    opportunityId={item.id}
                    labels={{
                      qualify: t.dashboard.reviewQualify,
                      reject: t.dashboard.reviewReject,
                      reasonLabel: t.dashboard.rejectReason,
                      reasons: t.dashboard.rejectReasons as unknown as Record<string, string>,
                      requestFailed: t.common.requestFailed,
                      networkError: t.common.networkError,
                    }}
                  />
                ) : null
              }
            />
          ))}
        </div>
      ) : null}

      {hasMore ? (
        <button
          type="button"
          onClick={() => {
            void load('more', nextCursor);
          }}
          disabled={loading}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {loading ? t.common.loading : copy.loadMore}
        </button>
      ) : null}
      {nextCursor ? (
        <p className="text-xs text-slate-500">{copy.loadedCount.replace('{count}', String(items.length))}</p>
      ) : null}
    </div>
  );
}
