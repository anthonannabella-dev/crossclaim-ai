import { cookies } from 'next/headers';
import Link from 'next/link';

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

export default async function ConnectionsPage() {
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

  const list = await apiGet<{ items: ConnectionItem[] }>('/connections');
  const forbidden = list.status === 403;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">采集连接</h1>
        <p className="mt-2 text-sm text-slate-600">
          连接管理仅限 OWNER / ADMIN（当前角色：{me.body.role}）。凭据只保存引用名，服务端会拒绝真实密钥。
        </p>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-600 underline">
          返回工作台
        </Link>
      </section>

      {/* PC-04：客户可见的失败 / 恢复状态（连接维度） */}
      <RecoveryBanner scope="CONNECTION" />

      {forbidden ? (
        <section className="rounded-lg border bg-white p-6 text-sm text-slate-600">
          当前角色无权查看或修改连接（403）。
        </section>
      ) : list.ok && list.body ? (
        <ConnectionManager items={list.body.items} />
      ) : (
        <section className="rounded-lg border bg-white p-6 text-sm text-red-600">
          读取连接失败（HTTP {list.status}）。
        </section>
      )}
    </div>
  );
}
