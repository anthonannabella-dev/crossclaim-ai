import { cookies } from 'next/headers';
import Link from 'next/link';

import { getServerMessages } from '../../i18n/server';
import ActiveRecovery from '../components/ui/active-recovery';
import { buildActiveFlows } from '../lib/dashboard-view';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

interface RecoveryCaseItem {
  caseId: string;
  title: string;
  statusLabel: string;
}

async function apiGet<T>(path: string): Promise<{ ok: boolean; body: T | null }> {
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    cache: 'no-store',
  });
  if (!response.ok) return { ok: false, body: null };
  return { ok: true, body: (await response.json()) as T };
}

/**
 * CUSTOMER-UI-PRODUCTIZATION-V2 / P5：一级导航「追回进度」的真实路由。
 * 只消费已有事实（goal 的 ADMITTED/RUNNING + 既有 case 的后端标签），
 * 不新增事实源、不做金额计算、不显示 runtime / queue / namespace / provider 内部状态。
 */
export default async function RecoveriesPage() {
  const t = await getServerMessages();
  const me = await apiGet<{ organizationId: string }>('/auth/me');
  if (!me.ok || !me.body) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl bg-slate-50 p-6 sm:p-8">
        <h1 className="text-xl font-semibold text-slate-900">{t.recoveriesPage.signInTitle}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.recoveriesPage.signInBody}</p>
        <Link
          href="/login"
          className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          {t.recoveriesPage.loginCta}
        </Link>
      </div>
    );
  }

  const [goals, money] = await Promise.all([
    apiGet<{ items: Array<{ goalId: string; status: string; intent: string }> }>('/agent-goals'),
    apiGet<{ cases: RecoveryCaseItem[] }>('/recovery-money'),
  ]);
  const flows = buildActiveFlows({ goals: goals.body?.items, cases: money.body?.cases }, t);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{t.recoveriesPage.pageTitle}</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">{t.recoveriesPage.subtitle}</p>
      </div>
      <ActiveRecovery flows={flows} labels={t.activeRecovery} />
      <div className="flex flex-wrap gap-3">
        <Link
          href="/"
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          {t.recoveriesPage.startLink}
        </Link>
        <Link
          href="/money"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
        >
          {t.dashboardPage.moneyLink}
        </Link>
      </div>
    </div>
  );
}
