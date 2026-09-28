import { cookies } from 'next/headers';
import Link from 'next/link';

import OpportunityActions from './components/opportunity-actions';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

interface Me {
  userId: string;
  organizationId: string;
  role: string;
}

interface ImportBatchItem {
  id: string;
  status: string;
  rowsTotal: number;
  rowsOk: number;
  rowsFailed: number;
  startedAt: string;
}

interface OpportunityItem {
  id: string;
  status: string;
  title: string;
  currency: string;
  amountExpected: string | null;
  amountActual: string | null;
  recoverableAmount: string | null;
  summary: {
    invoiceReference: string | null;
    amountDifference: string | null;
    basis: string;
  };
  calculation: {
    invoiceReference: string | null;
    ruleVersion: string | null;
    rateSource: string | null;
    calculationDetail: string | null;
    calculationTimestamp: string | null;
  };
}

async function apiGet<T>(path: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    cache: 'no-store',
  });
  if (!response.ok) return { ok: false, status: response.status, body: null };
  return { ok: true, status: response.status, body: (await response.json()) as T };
}

function LoginPrompt() {
  return (
    <div className="rounded-lg border bg-white p-6">
      <h1 className="text-xl font-semibold">需要登录</h1>
      <p className="mt-2 text-slate-600">请先使用组织发给你的账号登录。</p>
      <Link href="/login" className="mt-4 inline-block rounded bg-slate-900 px-4 py-2 text-white">
        前往登录
      </Link>
    </div>
  );
}

export default async function DashboardPage() {
  const me = await apiGet<Me>('/auth/me');
  if (!me.ok || !me.body) return <LoginPrompt />;

  const [imports, opportunities] = await Promise.all([
    apiGet<{ items: ImportBatchItem[] }>('/imports'),
    apiGet<{ items: OpportunityItem[] }>('/opportunities/insights'),
  ]);

  return (
    <div className="space-y-8">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-2xl font-semibold">工作台</h1>
        <p className="mt-2 text-sm text-slate-600">
          组织 <code className="rounded bg-slate-100 px-1">{me.body.organizationId}</code> · 角色{' '}
          {me.body.role}
        </p>
        <div className="mt-4 flex gap-3">
          <Link href="/upload" className="rounded border px-4 py-2 text-sm">
            上传账单
          </Link>
          <Link href="/connections" className="rounded border px-4 py-2 text-sm">
            采集连接
          </Link>
          <Link href="/billing" className="rounded border px-4 py-2 text-sm">
            账单（服务费）
          </Link>
          <Link href="/cases" className="rounded border px-4 py-2 text-sm">
            案件
          </Link>
          <form action="/logout" method="post">
            <button className="rounded border px-4 py-2 text-sm" type="submit">
              退出登录
            </button>
          </form>
        </div>
      </section>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">最近导入批次</h2>
        {imports.ok && imports.body && imports.body.items.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2">批次</th>
                <th>状态</th>
                <th>总行数</th>
                <th>成功</th>
                <th>失败</th>
                <th>开始时间</th>
              </tr>
            </thead>
            <tbody>
              {imports.body.items.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="py-2 font-mono text-xs">{item.id.slice(0, 8)}…</td>
                  <td>{item.status}</td>
                  <td>{item.rowsTotal}</td>
                  <td>{item.rowsOk}</td>
                  <td>{item.rowsFailed}</td>
                  <td className="text-slate-500">{new Date(item.startedAt).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-slate-500">暂无导入记录。</p>
        )}
      </section>

      <section className="rounded-lg border bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">检测到的可追回机会</h2>
            <p className="mt-1 text-xs text-slate-500">
              每条机会给出「哪张发票 / 差多少钱 / 依据是什么」，并附可复核的复算证据（发票 · 规则版本 · 费率来源 · 计算细节 · 计算时间）。
            </p>
          </div>
          <a
            href="/api/opportunities/insights.csv"
            className="whitespace-nowrap rounded border px-3 py-1 text-sm"
          >
            导出清单（CSV）
          </a>
        </div>
        {opportunities.ok && opportunities.body && opportunities.body.items.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2">发票 / 摘要</th>
                <th>差额</th>
                <th>依据</th>
                <th>复算证据</th>
                <th>状态</th>
                <th>复核</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.body.items.map((item) => (
                <tr key={item.id} className="border-t align-top">
                  <td className="py-2">
                    <div className="font-mono text-xs">{item.calculation.invoiceReference ?? '—'}</div>
                    <div className="text-xs text-slate-500">{item.title || item.id.slice(0, 8)}</div>
                  </td>
                  <td>
                    {item.summary.amountDifference ?? item.recoverableAmount ?? '—'} {item.currency}
                  </td>
                  <td className="text-xs">{item.summary.basis}</td>
                  <td className="text-xs text-slate-600">
                    <details>
                      <summary className="cursor-pointer text-slate-500">展开</summary>
                      <div className="mt-1 space-y-0.5">
                        <div>发票：{item.calculation.invoiceReference ?? '—'}</div>
                        <div>规则版本：{item.calculation.ruleVersion ?? '—'}</div>
                        <div>费率来源：{item.calculation.rateSource ?? '—'}</div>
                        <div>计算细节：{item.calculation.calculationDetail ?? '—'}</div>
                        <div>
                          计算时间：
                          {item.calculation.calculationTimestamp
                            ? new Date(item.calculation.calculationTimestamp).toLocaleString('zh-CN')
                            : '—'}
                        </div>
                      </div>
                    </details>
                  </td>
                  <td>{item.status}</td>
                  <td>
                    {item.status === 'DETECTED' ? (
                      <OpportunityActions opportunityId={item.id} />
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-slate-500">暂无检测结果。</p>
        )}
      </section>
    </div>
  );
}
