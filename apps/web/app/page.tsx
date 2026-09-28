import { cookies } from 'next/headers';
import Link from 'next/link';

import OpportunityActions from './components/opportunity-actions';
import { getServerMessages } from '../i18n/server';

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

function LoginPrompt({ t }: { t: Awaited<ReturnType<typeof getServerMessages>> }) {
  return (
    <div className="rounded-lg border bg-white p-6">
      <h1 className="text-xl font-semibold">{t.common.loginRequired}</h1>
      <p className="mt-2 text-slate-600">{t.footerNote}</p>
      <Link href="/login" className="mt-4 inline-block rounded bg-slate-900 px-4 py-2 text-white">
        {t.common.goToLogin}
      </Link>
    </div>
  );
}

export default async function DashboardPage() {
  const t = await getServerMessages();
  const me = await apiGet<Me>('/auth/me');
  if (!me.ok || !me.body) return <LoginPrompt t={t} />;

  const [imports, opportunities] = await Promise.all([
    apiGet<{ items: ImportBatchItem[] }>('/imports'),
    apiGet<{ items: OpportunityItem[] }>('/opportunities/insights'),
  ]);

  return (
    <div className="space-y-8">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-2xl font-semibold">{t.dashboard.title}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {t.dashboard.organization}{' '}
          <code className="rounded bg-slate-100 px-1">{me.body.organizationId}</code> · {t.common.role}{' '}
          {me.body.role}
        </p>
        <div className="mt-4 flex gap-3">
          <Link href="/upload" className="rounded border px-4 py-2 text-sm">
            {t.nav.upload}
          </Link>
          <Link href="/connections" className="rounded border px-4 py-2 text-sm">
            {t.nav.connections}
          </Link>
          <Link href="/billing" className="rounded border px-4 py-2 text-sm">
            {t.nav.billing}
          </Link>
          <Link href="/cases" className="rounded border px-4 py-2 text-sm">
            {t.nav.cases}
          </Link>
          <form action="/logout" method="post">
            <button className="rounded border px-4 py-2 text-sm" type="submit">
              {t.common.logout}
            </button>
          </form>
        </div>
      </section>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">{t.dashboard.recentImports}</h2>
        {imports.ok && imports.body && imports.body.items.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2">{t.dashboard.colBatch}</th>
                <th>{t.dashboard.colStatus}</th>
                <th>{t.dashboard.colRowsTotal}</th>
                <th>{t.dashboard.colRowsOk}</th>
                <th>{t.dashboard.colRowsFailed}</th>
                <th>{t.dashboard.colStartedAt}</th>
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
          <p className="mt-3 text-sm text-slate-500">{t.dashboard.noImports}</p>
        )}
      </section>

      <section className="rounded-lg border bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">{t.dashboard.opportunities}</h2>
            <p className="mt-1 text-xs text-slate-500">
              {t.dashboard.opportunitiesHint}
            </p>
          </div>
          <a
            href="/api/opportunities/insights.csv"
            className="whitespace-nowrap rounded border px-3 py-1 text-sm"
          >
            {t.dashboard.exportCsv}
          </a>
        </div>
        {opportunities.ok && opportunities.body && opportunities.body.items.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2">{t.dashboard.colInvoiceAndTitle}</th>
                <th>{t.dashboard.colDifference}</th>
                <th>{t.dashboard.colBasis}</th>
                <th>{t.dashboard.colEvidence}</th>
                <th>{t.dashboard.colStatus}</th>
                <th>{t.dashboard.colReview}</th>
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
                      <summary className="cursor-pointer text-slate-500">{t.dashboard.evidenceExpand}</summary>
                      <div className="mt-1 space-y-0.5">
                        <div>
                          {t.dashboard.evidenceInvoice}：{item.calculation.invoiceReference ?? '—'}
                        </div>
                        <div>
                          {t.dashboard.evidenceRuleVersion}：{item.calculation.ruleVersion ?? '—'}
                        </div>
                        <div>
                          {t.dashboard.evidenceRateSource}：{item.calculation.rateSource ?? '—'}
                        </div>
                        <div>
                          {t.dashboard.evidenceDetail}：{item.calculation.calculationDetail ?? '—'}
                        </div>
                        <div>
                          {t.dashboard.evidenceTimestamp}：
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
                      <OpportunityActions
                        opportunityId={item.id}
                        labels={{
                          qualify: t.dashboard.reviewQualify,
                          reject: t.dashboard.reviewReject,
                          reasonLabel: t.dashboard.rejectReason,
                          reasons: t.dashboard.rejectReasons as unknown as Record<string, string>,
                        }}
                      />
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-slate-500">{t.dashboard.noOpportunities}</p>
        )}
      </section>
    </div>
  );
}
