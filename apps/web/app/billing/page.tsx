import { cookies } from 'next/headers';
import Link from 'next/link';

import BillingActions from '../components/billing-actions';
import { getServerMessages } from '../../i18n/server';

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
  const t = await getServerMessages();
  const me = await apiGet<Me>('/auth/me');
  if (!me.ok || !me.body) {
    return (
      <div className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.common.loginRequired}</h1>
        <Link href="/login" className="mt-4 inline-block rounded bg-slate-900 px-4 py-2 text-white">
          {t.common.goToLogin}
        </Link>
      </div>
    );
  }

  const billing = await apiGet<{ items: BillingItem[] }>('/billing');

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.billingPage.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.billingPage.description}</p>
        <p className="mt-1 text-xs text-slate-500">
          {t.common.role}：{me.body.role}（{t.billingPage.advanceHint}）
        </p>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-600 underline">
          {t.common.backToDashboard}
        </Link>
      </section>

      {billing.status === 403 ? (
        <section className="rounded-lg border bg-white p-6 text-sm text-slate-600">
          {t.billingPage.noAccess}
        </section>
      ) : billing.ok && billing.body ? (
        <section className="rounded-lg border bg-white p-6">
          <h2 className="text-lg font-medium">{t.billingPage.title}</h2>
          {billing.body.items.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">{t.billingPage.empty}</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2">{t.billingPage.colInvoiceNo}</th>
                  <th>{t.billingPage.colCase}</th>
                  <th>{t.billingPage.colStatus}</th>
                  <th>{t.billingPage.colFee}</th>
                  <th>{t.billingPage.colTotal}</th>
                  <th>{t.billingPage.colPaid}</th>
                  <th>{t.billingPage.colDates}</th>
                  <th>{t.billingPage.colActions}</th>
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
                      <BillingActions
                        invoiceId={item.id}
                        status={item.status}
                        labels={{
                          issue: t.billingPage.issue,
                          markPaid: t.billingPage.markPaid,
                          paymentReference: t.billingPage.paymentReference,
                          note: t.billingPage.note,
                          requestFailed: t.common.requestFailed,
                          networkError: t.common.networkError,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : (
        <section className="rounded-lg border bg-white p-6 text-sm text-red-600">
          {t.common.loadFailed}（HTTP {billing.status}）。
        </section>
      )}
    </div>
  );
}
