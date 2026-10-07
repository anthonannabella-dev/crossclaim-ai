import Link from 'next/link';
import { cookies } from 'next/headers';

import { getServerMessages } from '../../i18n/server';
import InlineNotice from '../components/ui/inline-notice';
import AuthorizationList, { type AuthorizationItem } from './authorization-list';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

async function apiGet<T>(path: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();
  const response = await fetch(`${API_BASE}${path}`, { headers: cookie ? { cookie } : {}, cache: 'no-store' });
  if (!response.ok) return { ok: false, status: response.status, body: null };
  return { ok: true, status: response.status, body: (await response.json()) as T };
}

/**
 * CUSTOMER-UI-PRODUCTIZATION-V2 / P7：授权中心产品化。
 * 只改客户表达：先说「CrossClaim 可以替你做什么」，再说「以下情况仍会先问你」，
 * 然后才是既有授权列表与撤销入口；技术审计数据留在每张卡的「授权详情」折叠里。
 * Standing Authorization 后端事实与语义完全不变。
 */
export default async function AuthorizationsPage() {
  const t = await getServerMessages();
  const labels = t.authorizationPage;
  const result = await apiGet<{ items: AuthorizationItem[] }>('/standing-authorizations');
  const capabilities = [labels.capability1, labels.capability2, labels.capability3, labels.capability4, labels.capability5];
  const alwaysAsk = [
    labels.alwaysAsk1,
    labels.alwaysAsk2,
    labels.alwaysAsk3,
    labels.alwaysAsk4,
    labels.alwaysAsk5,
    labels.alwaysAsk6,
  ];

  return (
    <div className="space-y-8">
      <section className="rounded-2xl bg-slate-50 p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t.customerShell.navAuthorizations}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{labels.capabilitiesTitle}</h1>
        <p className="mt-3 max-w-3xl text-sm text-slate-600">{labels.subtitle}</p>
        <ul className="mt-4 space-y-1.5 text-sm text-slate-700">
          {capabilities.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm font-semibold text-slate-900">{labels.alwaysAskTitle}</p>
          <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
            {alwaysAsk.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="mt-4 flex flex-wrap gap-4">
          <Link href="/connections" className="text-sm text-slate-500 underline hover:text-slate-800">
            {labels.connectionsLink}
          </Link>
          <Link href="/customs/authorization" className="text-sm text-slate-500 underline hover:text-slate-800">
            {labels.customsReuseCta}
          </Link>
        </div>
        <p className="mt-3 max-w-3xl text-xs text-slate-500">{labels.customsReuseBody}</p>
      </section>

      {result.ok && result.body ? (
        <AuthorizationList items={result.body.items} t={t} />
      ) : (
        <InlineNotice tone="danger" title={labels.loadFailedTitle}>
          {labels.loadFailed}
        </InlineNotice>
      )}
    </div>
  );
}
