import { cookies } from 'next/headers';
import Link from 'next/link';

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
  recoverableAmount: string | null;
  currency: string;
  detectedAt: string;
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
    apiGet<{ items: OpportunityItem[] }>('/opportunities'),
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
        <h2 className="text-lg font-medium">检测到的可追回机会</h2>
        {opportunities.ok && opportunities.body && opportunities.body.items.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2">类型</th>
                <th>状态</th>
                <th>可追回</th>
                <th>检测时间</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.body.items.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="py-2">{item.title || item.id.slice(0, 8)}</td>
                  <td>{item.status}</td>
                  <td>
                    {item.recoverableAmount ?? '-'} {item.currency}
                  </td>
                  <td className="text-slate-500">{new Date(item.detectedAt).toLocaleString('zh-CN')}</td>
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
