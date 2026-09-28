import { cookies } from 'next/headers';
import Link from 'next/link';

import { getServerMessages } from '../../../i18n/server';

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
  const t = await getServerMessages();
  const detail = await apiGet<CaseDetail>(`/cases/${id}`);

  if (!detail.ok || !detail.body) {
    return (
      <div className="rounded-lg border bg-white p-6 text-sm">
        <h1 className="text-xl font-semibold">{t.caseDetail.unreadable}</h1>
        <p className="mt-2 text-slate-600">
          {detail.status === 403
            ? t.casesPage.noAccess
            : `${t.common.loadFailed}（HTTP ${detail.status}）。`}
        </p>
        <Link href="/cases" className="mt-4 inline-block text-slate-600 underline">
          {t.common.backToDashboard}
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
          {t.dashboard.colStatus} {body.status} · {t.casesPage.colClaimed} {body.claimedAmount ?? '—'}{' '}
          {body.currency} · {t.casesPage.colRecovered} {body.recoveredAmount ?? '—'} {body.currency}
        </p>
        <Link href="/cases" className="mt-4 inline-block text-sm text-slate-600 underline">
          {t.casesPage.title}
        </Link>
      </section>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">{t.caseDetail.opportunities}</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {body.opportunities.map((item) => (
            <li key={item.id} className="font-mono text-xs">
              {item.id} · {item.status} · {item.title}
            </li>
          ))}
        </ul>
        <h2 className="mt-6 text-lg font-medium">{t.caseDetail.claimRounds}</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {body.claims.map((item) => (
            <li key={item.id}>
              第 {item.round} 轮 · {item.target} · {item.status}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">{t.caseDetail.evidence}</h2>
        {evidence.status === 403 ? (
          <p className="mt-3 text-sm text-slate-600">{t.common.permissionDenied}</p>
        ) : evidence.ok && evidence.body ? (
          evidence.body.items.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">{t.caseDetail.noEvidence}</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2">{t.caseDetail.colEvidenceTitle}</th>
                  <th>{t.caseDetail.colEvidenceKind}</th>
                  <th>{t.caseDetail.colEvidenceRole}</th>
                  <th>{t.caseDetail.colEvidenceCaptured}</th>
                  <th>{t.caseDetail.colEvidenceFile}</th>
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
                    <td>{item.hasFile ? t.caseDetail.hasFile : t.caseDetail.noFile}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p className="mt-3 text-sm text-red-600">
            {t.common.loadFailed}（HTTP {evidence.status}）。
          </p>
        )}
      </section>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">{t.caseDetail.claimText}</h2>
        {claim.status === 403 ? (
          <p className="mt-3 text-sm text-slate-600">{t.caseDetail.claimDenied}</p>
        ) : claim.ok && claim.body ? (
          <>
            <p className="mt-2 text-xs text-slate-500">
              第 {claim.body.round} 轮 · 版本 {claim.body.version} · 状态 {claim.body.status} ·{' '}
              {claim.body.isFinal ? t.caseDetail.claimFinal : t.caseDetail.claimDraft} ·{' '}
              {new Date(claim.body.generatedAt).toLocaleString('zh-CN')}
            </p>
            <pre className="mt-3 whitespace-pre-wrap rounded bg-slate-50 p-4 text-xs text-slate-800">
              {claim.body.sections.join('\n')}
            </pre>
          </>
        ) : (
          <p className="mt-3 text-sm text-red-600">
            {t.common.loadFailed}（HTTP {claim.status}）。
          </p>
        )}
      </section>
    </div>
  );
}
