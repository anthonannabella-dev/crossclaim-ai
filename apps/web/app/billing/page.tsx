import { cookies } from 'next/headers';
import Link from 'next/link';

import BillingActions from '../components/billing-actions';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

interface Me {
  userId: string;
  organizationId: string;
  role: string;
}

interface BillingItem {
  id: string;
  invoiceNo: string;
  status: string;
  caseNo: string | null;
  total: string;
  paidAmount: string;
  currency: string;
  issuedAt: string | null;
  paidAt: string | null;
  reference: string | null;
  serviceFee: string | null;
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

export default async function BillingPage() {
  const me = await apiGet<Me>('/auth/me');
  if (!me.ok || !me.body) {
    return (
      <div className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">需要登录</h1>
        <Link href="/login" className="mt-4 inline-block rounded bg-slate-900 px-4 py-2 text-white">
          前往登录
        </Link>
      </div>
    );
  }

  const billing = await apiGet<{ items: BillingItem[] }>('/billing');

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">账单（服务费）</h1>
        <p className="mt-2 text-sm text-slate-600">
          这里展示的是<strong>我方对客户的服务费账单</strong>（BillingInvoice）。它与
          「第三方赔付给客户的回收款」（Settlement）是<strong>两个不同主体</strong>，金额与状态互不代表。
        </p>
        <p className="mt-1 text-xs text-slate-500">当前角色：{me.body.role}（推进账单：OWNER / ADMIN / FINANCE）</p>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-600 underline">
          返回工作台
        </Link>
      </section>

      {billing.status === 403 ? (
        <section className="rounded-lg border bg-white p-6 text-sm text-slate-600">
          当前角色无权查看账单（403）。
        </section>
      ) : billing.ok && billing.body ? (
        <section className="rounded-lg border bg-white p-6">
          <h2 className="text-lg font-medium">账单列表</h2>
          {billing.body.items.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">暂无账单。</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2">发票号</th>
                  <th>案件</th>
                  <th>状态</th>
                  <th>服务费</th>
                  <th>总额</th>
                  <th>已收</th>
                  <th>开票 / 收款时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {billing.body.items.map((item) => (
                  <tr key={item.id} className="border-t align-top">
                    <td className="py-2 font-mono text-xs">{item.invoiceNo}</td>
                    <td className="font-mono text-xs">{item.caseNo ?? '—'}</td>
                    <td>{item.status}</td>
                    <td>{item.serviceFee ?? '—'}</td>
                    <td>
                      {item.total} {item.currency}
                    </td>
                    <td>
                      {item.paidAmount} {item.currency}
                    </td>
                    <td className="text-xs text-slate-500">
                      {item.issuedAt ? new Date(item.issuedAt).toLocaleString('zh-CN') : '—'} /{' '}
                      {item.paidAt ? new Date(item.paidAt).toLocaleString('zh-CN') : '—'}
                    </td>
                    <td>
                      <BillingActions invoiceId={item.id} status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : (
        <section className="rounded-lg border bg-white p-6 text-sm text-red-600">
          读取账单失败（HTTP {billing.status}）。
        </section>
      )}
    </div>
  );
}
