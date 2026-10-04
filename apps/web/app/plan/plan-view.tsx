'use client';

import { useEffect, useState } from 'react';

import type { Messages } from '../../i18n/dictionaries/zh-CN';
import InlineNotice from '../components/ui/inline-notice';
import SectionCard from '../components/ui/section-card';
import StatusBadge from '../components/ui/status-badge';

interface Entitlement {
  key: string;
  allowed: boolean;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  usageState: string;
  reason: string;
  available: boolean;
  upgradeRequired: boolean;
  paymentRequired: boolean;
  entry: string;
}

interface Response {
  plan: string;
  planKnown: boolean;
  entitlements: Entitlement[];
  packageUnlock: {
    state: string;
    label: string;
    eligibility: string;
    paymentCompleted: boolean;
    paymentState: string;
    collectionState: string;
    reason: string;
  };
  upgrade: { available: boolean; reason: string; guidance: string };
}

/**
 * UI-6b —— 套餐与解锁（客户视图）：权益改为卡片，金额/额度用客户语言；
 * 内部状态码（usageState / paymentState / collectionState）与升级动作细节折叠进「高级详情」。
 */
export default function PlanView({ t }: { t: Messages }) {
  const copy = t.planPage;
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/entitlements', { cache: 'no-store' });
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

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1].map((index) => (
          <div key={index} className="h-32 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
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

  return (
    <div className="space-y-4">
      <SectionCard
        title={copy.currentPlan.replace('{plan}', data.plan)}
        subtitle={data.planKnown ? undefined : copy.unknownPlan}
      >
        <p className="text-sm text-slate-700">
          {copy.packageUnlockPrefix}
          <strong>{data.packageUnlock.label}</strong>
          {copy.packageUnlockDetail
            .replace('{state}', data.packageUnlock.state)
            .replace('{eligibility}', data.packageUnlock.eligibility)
            .replace('{payment}', data.packageUnlock.paymentCompleted ? copy.yes : copy.no)
            .replace('{paymentState}', data.packageUnlock.paymentState)
            .replace('{collectionState}', data.packageUnlock.collectionState)}
        </p>
      </SectionCard>

      <InlineNotice tone="warn" title={t.dashboardPage.paymentsHold}>
        {t.moneyPage.realityNote}
      </InlineNotice>

      <SectionCard title={copy.capabilities}>
        <ul className="grid gap-3 sm:grid-cols-2">
          {data.entitlements.map((item) => (
            <li key={item.key} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm font-medium text-slate-900">{item.key}</p>
                <StatusBadge tone={item.available ? 'ok' : 'neutral'}>
                  {item.available ? copy.available : copy.unavailable}
                </StatusBadge>
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-slate-500">{copy.colLimit}</dt>
                  <dd className="mt-0.5 font-medium text-slate-800">{item.limit ?? copy.unlimited}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">{copy.colUsed}</dt>
                  <dd className="mt-0.5 font-medium text-slate-800">
                    {item.usageState === 'TRACKED' ? item.used : copy.usageUntracked}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">{copy.colRemaining}</dt>
                  <dd className="mt-0.5 font-medium text-slate-800">
                    {item.usageState === 'TRACKED' ? item.remaining : '—'}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-slate-600">{item.reason}</p>
              <details className="mt-2 text-[11px] text-slate-500">
                <summary className="cursor-pointer">{copy.advancedDetails}</summary>
                <ul className="mt-1 space-y-0.5 font-mono">
                  <li>key={item.key}</li>
                  <li>allowed={String(item.allowed)}</li>
                  <li>usageState={item.usageState}</li>
                  <li>upgradeRequired={String(item.upgradeRequired)}</li>
                  <li>paymentRequired={String(item.paymentRequired)}</li>
                  <li>entry={item.entry}</li>
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title={copy.upgradeTitle}>
        <p className="text-sm text-slate-700">{data.upgrade.guidance}</p>
        <p className="mt-2 text-xs text-slate-600">
          {copy.upgradeAction
            .replace('{state}', data.upgrade.available ? copy.upgradeAvailable : copy.upgradeUnavailable)
            .replace('{reason}', data.upgrade.reason)}
        </p>
        <details className="mt-2 text-[11px] text-slate-500">
          <summary className="cursor-pointer">{copy.advancedDetails}</summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            <li>upgradeAvailable={String(data.upgrade.available)}</li>
            <li>packageUnlockState={data.packageUnlock.state}</li>
            <li>packageUnlockReason={data.packageUnlock.reason}</li>
          </ul>
        </details>
      </SectionCard>
    </div>
  );
}
