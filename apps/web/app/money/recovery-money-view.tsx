'use client';

import { useEffect, useState } from 'react';

import { formatDateTime } from '../../i18n/business-language';
import type { Locale } from '../../i18n';
import type { Messages } from '../../i18n/dictionaries/zh-CN';
import InlineNotice from '../components/ui/inline-notice';
import SectionCard from '../components/ui/section-card';
import StatusBadge from '../components/ui/status-badge';
import SummaryCards from '../components/ui/summary-cards';
import { buildCurrencySummaries, type MoneyBucket } from '../lib/dashboard-view';

interface CaseMoney {
  caseId: string;
  caseNo: string;
  title: string;
  status: string;
  statusLabel: string;
  currency: string;
  bucket: MoneyBucket;
  timeline: { discoveredAt: string | null; submittedAt: string | null; approvedAt: string | null; receivedAt: string | null };
  lineage: { claimItems: number; settlements: number; ledgerEntries: number; adjustments: number };
}

interface Response {
  organization: { byCurrency: MoneyBucket[]; collection: string; payment: string };
  cases: CaseMoney[];
  feeNote: string;
}

/**
 * UI-6a —— 金额与收益（客户视图）。
 * 客户默认看到：预计可追回 / 追回中 / 已确认 / 已到账（按币种）+ 净收益；
 * 明确「预计 ≠ 已到账」「已计算费用 ≠ 已扣款」；lineage / collection / payment 等内部字段进「高级详情」。
 */
export default function RecoveryMoneyView({ t, locale }: { t: Messages; locale: Locale }) {
  const copy = t.moneyPage;
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/recovery-money', { cache: 'no-store' });
        if (response.status === 401) {
          if (!cancelled) setError(t.common.sessionExpired);
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

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1].map((index) => (
          <div key={index} className="h-36 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
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
  if (!data) return <p className="text-sm text-slate-600">{copy.empty}</p>;

  const summaries = buildCurrencySummaries(data.organization.byCurrency, t);

  return (
    <div className="space-y-4">
      <InlineNotice tone="warn" title={t.dashboardPage.paymentsHold}>
        {copy.realityNote}
      </InlineNotice>

      <SectionCard title={copy.orgSummary} subtitle={t.dashboardPage.metricsSubtitle}>
        <SummaryCards
          summaries={summaries}
          currencyLabel={t.dashboardPage.currencyLabel}
          emptyTitle={copy.noCases}
          emptyBody={t.dashboardPage.metricsEmptyBody}
          emptyAction={{ label: t.dashboardPage.ctaConnect, href: '/connections' }}
          holdNote={copy.paymentDisabled}
          link={{ label: t.dashboardPage.opportunitiesMore, href: '/opportunities' }}
        />
      </SectionCard>

      <SectionCard title={copy.caseDetailTitle}>
        {data.cases.length === 0 ? (
          <p className="text-sm text-slate-600">{copy.noCases}</p>
        ) : (
          <ul className="space-y-3">
            {data.cases.map((row) => (
              <li key={row.caseId} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{row.caseNo}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{row.title}</p>
                  </div>
                  <StatusBadge tone="neutral">
                    {copy.statusWithCode.replace('{label}', row.statusLabel).replace('{code}', '')}
                  </StatusBadge>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-slate-500">{copy.colApproved}</dt>
                    <dd className="mt-0.5 text-sm font-semibold text-slate-900">
                      {row.bucket.approved} {row.currency}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{copy.colRecovered}</dt>
                    <dd className="mt-0.5 text-sm font-semibold text-slate-900">{row.bucket.recovered}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{copy.colNetRecovered}</dt>
                    <dd className="mt-0.5 text-sm font-semibold text-emerald-700">{row.bucket.netRecovered}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{copy.colOutstanding}</dt>
                    <dd className="mt-0.5 text-sm font-semibold text-slate-800">{row.bucket.outstanding}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-[11px] text-slate-600">
                  {copy.timeline
                    .replace('{discovered}', row.timeline.discoveredAt ? formatDateTime(row.timeline.discoveredAt, { locale }) : '—')
                    .replace('{submitted}', row.timeline.submittedAt ? formatDateTime(row.timeline.submittedAt, { locale }) : '—')
                    .replace('{approved}', row.timeline.approvedAt ? formatDateTime(row.timeline.approvedAt, { locale }) : '—')
                    .replace('{received}', row.timeline.receivedAt ? formatDateTime(row.timeline.receivedAt, { locale }) : '—')}
                </p>
                <details className="mt-2 text-[11px] text-slate-500">
                  <summary className="cursor-pointer">{copy.advancedDetails}</summary>
                  <ul className="mt-1 space-y-0.5 font-mono">
                    <li>status={row.status}</li>
                    <li>currency={row.currency}</li>
                    <li>discovered={row.bucket.discovered}</li>
                    <li>expected={row.bucket.expected}</li>
                    <li>adjustments={row.bucket.adjustments}</li>
                    <li>feeCalculated={row.bucket.feeCalculated}</li>
                    <li>feeCollected={row.bucket.feeCollected}</li>
                    <li>claimItems={row.lineage.claimItems}</li>
                    <li>settlements={row.lineage.settlements}</li>
                    <li>ledgerEntries={row.lineage.ledgerEntries}</li>
                    <li>adjustmentEntries={row.lineage.adjustments}</li>
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
        <details className="mt-4 text-[11px] text-slate-500">
          <summary className="cursor-pointer">{copy.advancedDetails}</summary>
          <p className="mt-1">
            {copy.collectionLine
              .replace('{collection}', data.organization.collection)
              .replace('{payment}', data.organization.payment)
              .replace('{feeNote}', data.feeNote)}
          </p>
        </details>
      </SectionCard>
    </div>
  );
}
