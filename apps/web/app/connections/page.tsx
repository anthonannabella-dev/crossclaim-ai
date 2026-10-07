import { cookies } from 'next/headers';
import Link from 'next/link';

import { getServerMessages } from '../../i18n/server';
import ConnectionManager, { type ConnectionItem } from '../components/connection-manager';
import RecoveryBanner from '../components/recovery-banner';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

interface Me {
  userId: string;
  organizationId: string;
  role: string;
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

/** 客户语言：角色码 → 客户可读名称（未知码原样显示，不做猜测）。 */
function roleLabel(t: Awaited<ReturnType<typeof getServerMessages>>, code: string): string {
  const table = t.common as unknown as Record<string, string>;
  const key =
    code === 'OWNER'
      ? 'roleOwner'
      : code === 'ADMIN'
        ? 'roleAdmin'
        : code === 'OPS'
          ? 'roleOps'
          : code === 'FINANCE'
            ? 'roleFinance'
            : code === 'VIEWER'
              ? 'roleViewer'
              : '';
  return key === '' ? code : (table[key] ?? code);
}

export default async function ConnectionsPage() {
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

  const list = await apiGet<{ items: ConnectionItem[] }>('/connections');
  const forbidden = list.status === 403;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.connectionsPage.title}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {t.connectionsPage.description.replace('{role}', roleLabel(t, me.body.role))}
        </p>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-600 underline">
          {t.common.backToDashboard}
        </Link>
      </section>

      {/* PC-04：客户可见的失败 / 恢复状态（连接维度） */}
      <RecoveryBanner scope="CONNECTION" t={t} />

      {forbidden ? (
        <section className="rounded-lg border bg-white p-6 text-sm text-slate-600">
          {t.connectionsPage.noAccess}
        </section>
      ) : list.ok && list.body ? (
        <ConnectionManager items={list.body.items} t={t} />
      ) : (
        <section className="rounded-lg border bg-white p-6 text-sm text-red-600">
          {t.connectionsPage.loadFailed.replace('{status}', String(list.status))}
        </section>
      )}
    </div>
  );
}
