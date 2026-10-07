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

export default async function AuthorizationsPage() {
  const t = await getServerMessages();
  const result = await apiGet<{ items: AuthorizationItem[] }>('/standing-authorizations');

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{t.authorizationPage.pageTitle}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{t.authorizationPage.subtitle}</p>
        <Link href="/connections" className="mt-4 inline-block text-sm text-slate-500 underline hover:text-slate-800">
          {t.authorizationPage.connectionsLink}
        </Link>
      </section>

      {result.ok && result.body ? (
        <AuthorizationList items={result.body.items} t={t} />
      ) : (
        <InlineNotice tone="danger" title={t.authorizationPage.loadFailedTitle}>
          {t.authorizationPage.loadFailed}
        </InlineNotice>
      )}
    </div>
  );
}
