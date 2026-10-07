import { cookies } from 'next/headers';
import Link from 'next/link';

import { formatDateTime } from '../../i18n/business-language';
import { getServerLocale, getServerMessages } from '../../i18n/server';
import BillingActions from '../components/billing-actions';
import InlineNotice from '../components/ui/inline-notice';
import SectionCard from '../components/ui/section-card';
import StatusBadge from '../components/ui/status-badge';

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

/**
 * UI-6b —— 账单与费用（客户视图）：服务费账单卡片 + 客户语言状态；
 * 明确「当前不会自动扣款」；invoice 号 / reference / 原始状态码进「高级详情」。
 */
export default async function BillingPage() {
  const [t, locale] = await Promise.all([getServerMessages(), getServerLocale()]);
  const me = await apiGet<Me>('/auth/me');
  if (!me.ok || !me.body) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <h1 className="text-xl font-semibold text-slate-900">{t.common.loginRequired}</h1>
        <Link href="/login" className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">
          {t.common.goToLogin}
        </Link>
      </div>
    );
  }

  const billing = await apiGet<{ items: BillingItem[] }>('/billing');
  const statusLabel = (code: string): string => {
    const table = t.billingStatus as unknown as Record<string, string>;
    return table[code] ?? t.status.UNKNOWN;
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">{t.billingPage.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{t.billingPage.description}</p>
        <p className="mt-1 text-xs text-slate-500">
          {t.common.role}
          {': '}
          {me.body.role}
          {' · '}
          {t.billingPage.advanceHint}
        </p>
      </header>

      <InlineNotice tone="warn" title={t.dashboardPage.paymentsHold}>
        {t.moneyPage.realityNote}
      </InlineNotice>

      <SectionCard title={t.billingPage.title}>
        {billing.status === 403 ? (
          <p className="text-sm text-slate-600">{t.billingPage.noAccess}</p>
        ) : billing.ok && billing.body ? (
          billing.body.items.length === 0 ? (
            <p className="text-sm text-slate-500">{t.billingPage.empty}</p>
          ) : (
            <ul className="space-y-3">
              {billing.body.items.map((item) => (
                <li key={item.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {item.total} {item.currency}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {t.billingPage.colCase}
                        {': '}
                        {item.caseNo ?? '—'}
                      </p>
                    </div>
                    <StatusBadge tone={item.status === 'PAID' ? 'ok' : item.status === 'ISSUED' ? 'pending' : 'neutral'}>
                      {statusLabel(item.status)}
                    </StatusBadge>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                    <div>
                      <dt className="text-slate-500">{t.billingPage.colFee}</dt>
                      <dd className="mt-0.5 font-medium text-slate-800">{item.serviceFee ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">{t.billingPage.colPaid}</dt>
                      <dd className="mt-0.5 font-medium text-slate-800">{item.paidAmount}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">{t.billingPage.colDates}</dt>
                      <dd className="mt-0.5 text-slate-700">
                        {item.issuedAt ? formatDateTime(item.issuedAt, { locale }) : '—'}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3">
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
                  </div>
                  <details className="mt-3 text-[11px] text-slate-500">
                    <summary className="cursor-pointer">{t.billingPage.advancedDetails}</summary>
                    <ul className="mt-1 space-y-0.5 font-mono">
                      <li>invoiceNo={item.invoiceNo}</li>
                      <li>status={item.status}</li>
                      <li>reference={item.reference ?? '-'}</li>
                      <li>paidAt={item.paidAt ?? '-'}</li>
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-sm text-red-600">{t.common.loadFailed}</p>
        )}
      </SectionCard>
    </div>
  );
}
