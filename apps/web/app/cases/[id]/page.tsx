import { cookies } from 'next/headers';
import Link from 'next/link';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

interface CaseDetail {
  id: string;
  caseNo: string;
  title: string;
  status: string;
  currency: string;
  claimedAmount: string | null;
  recoveredAmount: string | null;
  opportunities: Array<{ id: string; status: string; title: string }>;
  claims: Array<{ id: string; round: number; status: string; target: string }>;
}

interface EvidenceItem {
  evidenceId: string;
  role: string | null;
  kind: string;
  title: string;
  description: string | null;
  capturedAt: string | null;
  hasFile: boolean;
}

interface ClaimDraft {
  id: string;
  round: number;
  version: number;
  status: string;
  generatedAt: string;
  isFinal: boolean;
  sections: string[];
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

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await apiGet<CaseDetail>(`/cases/${id}`);

  if (!detail.ok || !detail.body) {
    return (
      <div className="rounded-lg border bg-white p-6 text-sm">
        <h1 className="text-xl font-semibold">无法读取案件</h1>
        <p className="mt-2 text-slate-600">
          {detail.status === 403
            ? '当前角色无权查看案件（403）。'
            : `读取失败（HTTP ${detail.status}）。`}
        </p>
        <Link href="/cases" className="mt-4 inline-block text-slate-600 underline">
          返回案件列表
        </Link>
      </div>
    );
  }

  const [evidence, claim] = await Promise.all([
    apiGet<{ items: EvidenceItem[] }>(`/cases/${id}/evidence`),
    apiGet<ClaimDraft>(`/cases/${id}/claim`),
  ]);
  const body = detail.body;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">
          {body.caseNo} · {body.title}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          状态 {body.status} · 索赔 {body.claimedAmount ?? '—'} {body.currency} · 已回收{' '}
          {body.recoveredAmount ?? '—'} {body.currency}
        </p>
        <Link href="/cases" className="mt-4 inline-block text-sm text-slate-600 underline">
          返回案件列表
        </Link>
      </section>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">关联机会</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {body.opportunities.map((item) => (
            <li key={item.id} className="font-mono text-xs">
              {item.id} · {item.status} · {item.title}
            </li>
          ))}
        </ul>
        <h2 className="mt-6 text-lg font-medium">报销/索赔轮次</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {body.claims.map((item) => (
            <li key={item.id}>
              第 {item.round} 轮 · {item.target} · {item.status}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">证据（元数据）</h2>
        {evidence.status === 403 ? (
          <p className="mt-3 text-sm text-slate-600">当前角色无权查看证据（403）。</p>
        ) : evidence.ok && evidence.body ? (
          evidence.body.items.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">暂无证据。</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2">标题</th>
                  <th>类型</th>
                  <th>角色</th>
                  <th>采集时间</th>
                  <th>附件</th>
                </tr>
              </thead>
              <tbody>
                {evidence.body.items.map((item) => (
                  <tr key={item.evidenceId} className="border-t">
                    <td className="py-2">{item.title}</td>
                    <td>{item.kind}</td>
                    <td>{item.role ?? '—'}</td>
                    <td className="text-slate-500">
                      {item.capturedAt ? new Date(item.capturedAt).toLocaleString('zh-CN') : '—'}
                    </td>
                    <td>{item.hasFile ? '有（经签名链接下载）' : '无'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p className="mt-3 text-sm text-red-600">读取证据失败（HTTP {evidence.status}）。</p>
        )}
      </section>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">Claim 正文（仅 OWNER / ADMIN / OPS）</h2>
        {claim.status === 403 ? (
          <p className="mt-3 text-sm text-slate-600">
            当前角色无权查看 Claim 正文（403）。财务与只读角色请改用账单页面查看服务费事实。
          </p>
        ) : claim.ok && claim.body ? (
          <>
            <p className="mt-2 text-xs text-slate-500">
              第 {claim.body.round} 轮 · 版本 {claim.body.version} · 状态 {claim.body.status} ·{' '}
              {claim.body.isFinal ? '最终文本' : '草稿文本'} · {new Date(claim.body.generatedAt).toLocaleString('zh-CN')}
            </p>
            <pre className="mt-3 whitespace-pre-wrap rounded bg-slate-50 p-4 text-xs text-slate-800">
              {claim.body.sections.join('\n')}
            </pre>
          </>
        ) : (
          <p className="mt-3 text-sm text-red-600">读取 Claim 正文失败（HTTP {claim.status}）。</p>
        )}
      </section>
    </div>
  );
}
