'use client';

import { useEffect, useState } from 'react';

import type { Messages } from '../../i18n/dictionaries/zh-CN';

interface Bucket {
  currency: string;
  discovered: string;
  expected: string;
  claimed: string;
  approved: string;
  recovered: string;
  disputed: string;
  adjustments: string;
  netRecovered: string;
  outstanding: string;
  feeCalculated: string;
  feeCollected: string;
}

interface CaseMoney {
  caseId: string;
  caseNo: string;
  title: string;
  status: string;
  statusLabel: string;
  currency: string;
  bucket: Bucket;
  timeline: { discoveredAt: string | null; submittedAt: string | null; approvedAt: string | null; receivedAt: string | null };
  lineage: { claimItems: number; settlements: number; ledgerEntries: number; adjustments: number };
}

interface Response {
  organization: { byCurrency: Bucket[]; collection: string; payment: string };
  cases: CaseMoney[];
  feeNote: string;
}

const fmt = (value: string | null) => (value ? value.slice(0, 10) : '—');

export default function RecoveryMoneyView({ t }: { t: Messages }) {
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

  if (loading) return <p className="text-sm text-slate-600">{t.common.loading}</p>;
  if (error) return <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>;
  if (!data) return <p className="text-sm text-slate-600">{copy.empty}</p>;

  if (data.cases.length === 0) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">{copy.noCases}</div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded border border-slate-200 p-3">
        <h2 className="text-sm font-medium">{copy.orgSummary}</h2>
        <table className="mt-2 w-full border-collapse text-xs">
          <thead>
            <tr className="border-b text-left text-slate-600">
              <th className="py-1">{copy.colCurrency}</th>
              <th className="py-1 text-right">{copy.colDiscovered}</th>
              <th className="py-1 text-right">{copy.colExpected}</th>
              <th className="py-1 text-right">{copy.colRecovered}</th>
              <th className="py-1 text-right">{copy.colAdjustments}</th>
              <th className="py-1 text-right">{copy.colNetRecovered}</th>
              <th className="py-1 text-right">{copy.colOutstanding}</th>
              <th className="py-1 text-right">{copy.colFeeCalculated}</th>
              <th className="py-1 text-right">{copy.colFeeCollected}</th>
            </tr>
          </thead>
          <tbody>
            {data.organization.byCurrency.map((bucket) => (
              <tr key={bucket.currency} className="border-b">
                <td className="py-1">{bucket.currency}</td>
                <td className="py-1 text-right">{bucket.discovered}</td>
                <td className="py-1 text-right">{bucket.expected}</td>
                <td className="py-1 text-right">{bucket.recovered}</td>
                <td className="py-1 text-right">{bucket.adjustments}</td>
                <td className="py-1 text-right font-medium">{bucket.netRecovered}</td>
                <td className="py-1 text-right">{bucket.outstanding}</td>
                <td className="py-1 text-right">{bucket.feeCalculated}</td>
                <td className="py-1 text-right">{bucket.feeCollected}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-slate-600">
          {copy.collectionLine
            .replace('{collection}', data.organization.collection)
            .replace('{payment}', data.organization.payment)
            .replace('{feeNote}', data.feeNote)}
        </p>
      </section>

      <section className="rounded border border-slate-200 p-3">
        <h2 className="text-sm font-medium">{copy.caseDetailTitle}</h2>
        <table className="mt-2 w-full border-collapse text-xs">
          <thead>
            <tr className="border-b text-left text-slate-600">
              <th className="py-1">{copy.colCase}</th>
              <th className="py-1">{copy.colStatus}</th>
              <th className="py-1 text-right">{copy.colApproved}</th>
              <th className="py-1 text-right">{copy.colRecovered}</th>
              <th className="py-1 text-right">{copy.colNetRecovered}</th>
              <th className="py-1 text-right">{copy.colOutstanding}</th>
              <th className="py-1">{copy.colTimeline}</th>
              <th className="py-1">lineage</th>
            </tr>
          </thead>
          <tbody>
            {data.cases.map((row) => (
              <tr key={row.caseId} className="border-b align-top">
                <td className="py-1">
                  <a className="text-blue-700" href={'/cases/' + row.caseId}>
                    {row.caseNo}
                  </a>
                  <div className="text-[11px] text-slate-500">{row.title}</div>
                </td>
                <td className="py-1">
                  {copy.statusWithCode.replace('{label}', row.statusLabel).replace('{code}', row.status)}
                </td>
                <td className="py-1 text-right">{row.bucket.approved} {row.currency}</td>
                <td className="py-1 text-right">{row.bucket.recovered}</td>
                <td className="py-1 text-right font-medium">{row.bucket.netRecovered}</td>
                <td className="py-1 text-right">{row.bucket.outstanding}</td>
                <td className="py-1 text-[11px] text-slate-600">
                  {copy.timeline
                    .replace('{discovered}', fmt(row.timeline.discoveredAt))
                    .replace('{submitted}', fmt(row.timeline.submittedAt))
                    .replace('{approved}', fmt(row.timeline.approvedAt))
                    .replace('{received}', fmt(row.timeline.receivedAt))}
                </td>
                <td className="py-1 text-[11px] text-slate-600">
                  claim {row.lineage.claimItems} · settlement {row.lineage.settlements} · ledger {row.lineage.ledgerEntries} · adj {row.lineage.adjustments}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
