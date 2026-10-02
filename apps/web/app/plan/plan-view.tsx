'use client';

import { useEffect, useState } from 'react';

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

export default function PlanView() {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/entitlements', { cache: 'no-store' });
        if (response.status === 401) {
          if (!cancelled) setError('会话已失效，请重新登录');
          return;
        }
        if (response.status === 403) {
          if (!cancelled) setError('当前角色无权查看套餐信息');
          return;
        }
        if (!response.ok) {
          if (!cancelled) setError('无法加载套餐信息');
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
      <section className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">
          当前套餐：{data.plan}
          {data.planKnown ? '' : '（未知套餐：已按 fail-closed 处理，能力默认全部不可用）'}
        </div>
        <div className="mt-1 text-xs text-slate-600">
          材料包解锁状态：<strong>{data.packageUnlock.label}</strong>（{data.packageUnlock.state}）· 解锁资格{' '}
          {data.packageUnlock.eligibility} · 付款完成 {data.packageUnlock.paymentCompleted ? '是' : '否'}（支付{' '}
          {data.packageUnlock.paymentState} / 收款 {data.packageUnlock.collectionState}）
        </div>
      </section>

      <section className="rounded border border-slate-200 p-3">
        <h2 className="text-sm font-medium">能力与额度</h2>
        <table className="mt-2 w-full border-collapse text-xs">
          <thead>
            <tr className="border-b text-left text-slate-600">
              <th className="py-1">能力</th>
              <th className="py-1">状态</th>
              <th className="py-1 text-right">额度</th>
              <th className="py-1 text-right">已用</th>
              <th className="py-1 text-right">剩余</th>
              <th className="py-1">原因</th>
            </tr>
          </thead>
          <tbody>
            {data.entitlements.map((item) => (
              <tr key={item.key} className="border-b">
                <td className="py-1">{item.key}</td>
                <td className="py-1">{item.available ? '可用' : '不可用'}</td>
                <td className="py-1 text-right">{item.limit ?? '不限'}</td>
                <td className="py-1 text-right">
                  {item.usageState === 'TRACKED' ? item.used : '未跟踪'}
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
        <div className="font-medium">升级说明</div>
        <p className="mt-1">{data.upgrade.guidance}</p>
        <p className="mt-1">
          升级动作当前：{data.upgrade.available ? '可执行' : '不可执行'}（{data.upgrade.reason}）
        </p>
      </section>
    </div>
  );
}
