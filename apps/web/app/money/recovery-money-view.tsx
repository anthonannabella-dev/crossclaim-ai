'use client';

import { useEffect, useState } from 'react';

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

export default function RecoveryMoneyView() {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/recovery-money', { cache: 'no-store' });
        if (response.status === 401) {
          if (!cancelled) setError('会话已失效，请重新登录');
          return;
        }
        if (!response.ok) {
          if (!cancelled) setError('无法加载金额数据');
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
  if (error) return <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>;
  if (!data) return <p className="text-sm text-slate-600">无数据</p>;

  if (data.cases.length === 0) {
    return <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">目前还没有案件金额数据。导入账单并建案后会在这里显示。</div>;
  }

  return (
    <div className="space-y-6">
      <section className="rounded border border-slate-200 p-3">
        <h2 className="text-sm font-medium">组织汇总（按币种 / By currency）</h2>
        <table className="mt-2 w-full border-collapse text-xs">
          <thead>
            <tr className="border-b text-left text-slate-600">
              <th className="py-1">币种</th>
              <th className="py-1 text-right">已发现</th>
              <th className="py-1 text-right">追回中</th>
              <th className="py-1 text-right">已追回</th>
              <th className="py-1 text-right">冲减</th>
              <th className="py-1 text-right">净追回</th>
              <th className="py-1 text-right">未追回</th>
              <th className="py-1 text-right">已计算费用</th>
              <th className="py-1 text-right">已收取</th>
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
          收费通道：{data.organization.collection}（Payment = {data.organization.payment}）· {data.feeNote}
        </p>
      </section>

      <section className="rounded border border-slate-200 p-3">
        <h2 className="text-sm font-medium">案件明细（Case money view）</h2>
        <table className="mt-2 w-full border-collapse text-xs">
          <thead>
            <tr className="border-b text-left text-slate-600">
              <th className="py-1">案件</th>
              <th className="py-1">状态</th>
              <th className="py-1 text-right">可追回</th>
              <th className="py-1 text-right">已追回</th>
              <th className="py-1 text-right">净追回</th>
              <th className="py-1 text-right">未追回</th>
              <th className="py-1">时间线</th>
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
                <td className="py-1">{row.statusLabel}（{row.status}）</td>
                <td className="py-1 text-right">{row.bucket.approved} {row.currency}</td>
                <td className="py-1 text-right">{row.bucket.recovered}</td>
                <td className="py-1 text-right font-medium">{row.bucket.netRecovered}</td>
                <td className="py-1 text-right">{row.bucket.outstanding}</td>
                <td className="py-1 text-[11px] text-slate-600">
                  发现 {fmt(row.timeline.discoveredAt)} · 提交 {fmt(row.timeline.submittedAt)} · 获批 {fmt(row.timeline.approvedAt)} · 到账 {fmt(row.timeline.receivedAt)}
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
