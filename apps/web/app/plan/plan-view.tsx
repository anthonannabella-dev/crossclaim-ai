'use client';

import { useEffect, useState } from 'react';

import type { Messages } from '../../i18n/dictionaries/zh-CN';

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

  if (loading) return <p className="text-sm text-slate-600">{t.common.loading}</p>;
  if (error) return <div className="rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">{error}</div>;
  if (!data) return <p className="text-sm text-slate-600">{copy.empty}</p>;

  return (
    <div className="space-y-4">
      <section className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">
          {copy.currentPlan.replace('{plan}', data.plan)}
          {data.planKnown ? '' : copy.unknownPlan}
        </div>
        <div className="mt-1 text-xs text-slate-600">
          {copy.packageUnlockPrefix}
          <strong>{data.packageUnlock.label}</strong>
          {copy.packageUnlockDetail
            .replace('{state}', data.packageUnlock.state)
            .replace('{eligibility}', data.packageUnlock.eligibility)
            .replace('{payment}', data.packageUnlock.paymentCompleted ? copy.yes : copy.no)
            .replace('{paymentState}', data.packageUnlock.paymentState)
            .replace('{collectionState}', data.packageUnlock.collectionState)}
        </div>
      </section>

      <section className="rounded border border-slate-200 p-3">
        <h2 className="text-sm font-medium">{copy.capabilities}</h2>
        <table className="mt-2 w-full border-collapse text-xs">
          <thead>
            <tr className="border-b text-left text-slate-600">
              <th className="py-1">{copy.colCapability}</th>
              <th className="py-1">{copy.colState}</th>
              <th className="py-1 text-right">{copy.colLimit}</th>
              <th className="py-1 text-right">{copy.colUsed}</th>
              <th className="py-1 text-right">{copy.colRemaining}</th>
              <th className="py-1">{copy.colReason}</th>
            </tr>
          </thead>
          <tbody>
            {data.entitlements.map((item) => (
              <tr key={item.key} className="border-b">
                <td className="py-1">{item.key}</td>
                <td className="py-1">{item.available ? copy.available : copy.unavailable}</td>
                <td className="py-1 text-right">{item.limit ?? copy.unlimited}</td>
                <td className="py-1 text-right">
                  {item.usageState === 'TRACKED' ? item.used : copy.usageUntracked}
                </td>
                <td className="py-1 text-right">
                  {item.usageState === 'TRACKED' ? item.remaining : '—'}
                </td>
                <td className="py-1 text-[11px] text-slate-600">{item.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
        <div className="font-medium">{copy.upgradeTitle}</div>
        <p className="mt-1">{data.upgrade.guidance}</p>
        <p className="mt-1">
          {copy.upgradeAction
            .replace('{state}', data.upgrade.available ? copy.upgradeAvailable : copy.upgradeUnavailable)
            .replace('{reason}', data.upgrade.reason)}
        </p>
      </section>
    </div>
  );
}
