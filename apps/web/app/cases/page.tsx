import { cookies } from 'next/headers';
import Link from 'next/link';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

interface Me {
  organizationId: string;
  role: string;
}

interface CaseItem {
  id: string;
  caseNo: string;
  title: string;
  status: string;
  currency: string;
  claimedAmount: string | null;
  recoveredAmount: string | null;
  createdAt: string;
  claimRounds: number;
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

export default async function CasesPage() {
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

  const cases = await apiGet<{ items: CaseItem[] }>('/cases');

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">案件</h1>
        <p className="mt-2 text-sm text-slate-600">
          案件与证据的可见范围：OWNER / ADMIN / OPS。Claim 正文只在案件详情里单独获取，
          列表接口一律不返回正文。
        </p>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-600 underline">
          返回工作台
        </Link>
      </section>

      {cases.status === 403 ? (
        <section className="rounded-lg border bg-white p-6 text-sm text-slate-600">
          当前角色无权查看案件（403）。
        </section>
      ) : cases.ok && cases.body ? (
        <section className="rounded-lg border bg-white p-6">
          <h2 className="text-lg font-medium">案件列表</h2>
          {cases.body.items.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">暂无案件。</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2">案件号</th>
                  <th>标题</th>
                  <th>状态</th>
                  <th>索赔金额</th>
                  <th>已回收</th>
                  <th>Claim 轮次</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cases.body.items.map((item) => (
                  <tr key={item.id} className="border-t">
                    <td className="py-2 font-mono text-xs">{item.caseNo}</td>
                    <td>{item.title}</td>
                    <td>{item.status}</td>
                    <td>
                      {item.claimedAmount ?? '—'} {item.currency}
                    </td>
                    <td>
                      {item.recoveredAmount ?? '—'} {item.currency}
                    </td>
                    <td>{item.claimRounds}</td>
                    <td>
                      <Link href={`/cases/${item.id}`} className="text-slate-600 underline">
                        详情
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : (
        <section className="rounded-lg border bg-white p-6 text-sm text-red-600">
          读取案件失败（HTTP {cases.status}）。
        </section>
      )}
    </div>
  );
}
