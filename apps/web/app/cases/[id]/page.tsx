import { cookies } from 'next/headers';
import Link from 'next/link';

import { formatDateTime } from '../../../i18n/business-language';
import { getServerLocale, getServerMessages } from '../../../i18n/server';
import InlineNotice from '../../components/ui/inline-notice';
import RecoveryPipeline from '../../components/ui/recovery-pipeline';
import SectionCard from '../../components/ui/section-card';
import StatusBadge from '../../components/ui/status-badge';
import { buildRecoveryPipeline, caseStatusLabel, pipelineStateLabel } from '../../lib/case-view';

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

interface AppealPackageState {
  caseId: string;
  caseNo: string;
  deliverable: { kind: string; state: string; reason: string; unlockAvailable: boolean; note: string };
  customerDataAccess: { rawFiles: string; evidenceChain: string; auditTrail: string; note: string };
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

/**
 * UI-5 —— 案件详情（客户视图）：围绕「这笔钱现在进行到哪一步」。
 * 管线阶段由后端持久化状态推导；提交阶段明确标注「需要人工提交」（External Write = HOLD）。
 * 关联机会 / 轮次 / 版本 / 目标等工程字段折叠进「高级详情」。
 */
export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [t, locale] = await Promise.all([getServerMessages(), getServerLocale()]);
  const detail = await apiGet<CaseDetail>(`/cases/${id}`);

  if (!detail.ok || !detail.body) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm">
        <h1 className="text-xl font-semibold text-slate-900">{t.caseDetail.unreadable}</h1>
        <p className="mt-2 text-slate-600">
          {detail.status === 403 ? t.casesPage.noAccess : t.common.loadFailed}
        </p>
        <Link href="/cases" className="mt-4 inline-block text-slate-600 underline">
          {t.casesPage.title}
        </Link>
      </div>
    );
  }

  const [evidence, claim, appealPackage] = await Promise.all([
    apiGet<{ items: EvidenceItem[] }>(`/cases/${id}/evidence`),
    apiGet<ClaimDraft>(`/cases/${id}/claim`),
    apiGet<AppealPackageState>(`/cases/${id}/appeal-package`),
  ]);
  const body = detail.body;
  const evidenceItems = evidence.body?.items ?? [];
  const claimBody = claim.body;

  const pipeline = buildRecoveryPipeline(
    {
      domain: 'PLATFORM',
      caseStatus: body.status,
      claimStatus: claimBody?.status ?? null,
      opportunityStatuses: body.opportunities.map((item) => item.status),
      evidenceCount: evidenceItems.length,
      recoveredAmount: body.recoveredAmount,
    },
    t,
  );
  const submitted = claimBody ? claimBody.status !== 'DRAFT' : false;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <p className="text-xs text-slate-500">
          <Link href="/cases" className="underline">
            {t.casesPage.title}
          </Link>
        </p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              {body.caseNo} · {body.title}
            </h1>
          </div>
          <StatusBadge tone="neutral">{caseStatusLabel(body.status, t)}</StatusBadge>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">{t.casesPage.colClaimed}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900">
              {body.claimedAmount ?? '—'} {body.currency}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t.casesPage.colRecovered}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-emerald-700">
              {body.recoveredAmount ?? '—'} {body.currency}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t.caseDetail.claimRounds}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900">{body.claims.length}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{t.caseDetail.evidence}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900">{evidenceItems.length}</dd>
          </div>
        </dl>
      </section>

      {!submitted ? (
        <InlineNotice tone="warn" title={t.casePipeline.submissionTitle}>
          {t.casePipeline.submissionHold}
        </InlineNotice>
      ) : null}

      <SectionCard>
        <RecoveryPipeline
          title={t.casePipeline.title}
          subtitle={t.casePipeline.subtitle}
          stages={pipeline}
          labels={{
            DONE: pipelineStateLabel('DONE', t),
            CURRENT: pipelineStateLabel('CURRENT', t),
            PENDING: pipelineStateLabel('PENDING', t),
            BLOCKED: pipelineStateLabel('BLOCKED', t),
          }}
        />
      </SectionCard>

      <SectionCard title={t.caseDetail.claimText}>
        {claim.status === 403 ? (
          <p className="text-sm text-slate-600">{t.caseDetail.claimDenied}</p>
        ) : claim.ok && claimBody ? (
          <>
            <p className="text-xs text-slate-500">
              {claimBody.isFinal ? t.caseDetail.claimFinal : t.caseDetail.claimDraft}
              {' · '}
              {formatDateTime(claimBody.generatedAt, { locale })}
            </p>
            <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-xs text-slate-800">
              {claimBody.sections.join('\n')}
            </pre>
            <details className="mt-3 text-[11px] text-slate-500">
              <summary className="cursor-pointer">{t.dashboardPage.opportunityAdvanced}</summary>
              <ul className="mt-1 space-y-0.5 font-mono">
                <li>round={claimBody.round}</li>
                <li>version={claimBody.version}</li>
                <li>status={claimBody.status}</li>
                <li>isFinal={String(claimBody.isFinal)}</li>
              </ul>
            </details>
          </>
        ) : (
          <p className="text-sm text-red-600">{t.common.loadFailed}</p>
        )}
      </SectionCard>

      <SectionCard title={t.caseDetail.evidence}>
        {evidence.status === 403 ? (
          <p className="text-sm text-slate-600">{t.common.permissionDenied}</p>
        ) : evidence.ok && evidenceItems.length > 0 ? (
          <ul className="space-y-3">
            {evidenceItems.map((item) => (
              <li key={item.evidenceId} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{item.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {item.kind}
                      {item.role ? ' · ' + item.role : ''}
                    </p>
                  </div>
                  <StatusBadge tone={item.hasFile ? 'ok' : 'neutral'}>
                    {item.hasFile ? t.caseDetail.hasFile : t.caseDetail.noFile}
                  </StatusBadge>
                </div>
                {item.description ? <p className="mt-1 text-xs text-slate-600">{item.description}</p> : null}
                <p className="mt-1 text-[11px] text-slate-500">
                  {t.caseDetail.colEvidenceCaptured}
                  {': '}
                  {item.capturedAt ? formatDateTime(item.capturedAt, { locale }) : '—'}
                </p>
              </li>
            ))}
          </ul>
        ) : evidence.ok ? (
          <p className="text-sm text-slate-500">{t.caseDetail.noEvidence}</p>
        ) : (
          <p className="text-sm text-red-600">{t.common.loadFailed}</p>
        )}
      </SectionCard>

      <SectionCard title={t.caseDetail.appealPackage}>
        {appealPackage.ok && appealPackage.body ? (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="warn">{t.caseDetail.deliverableLocked}</StatusBadge>
              <span className="text-xs text-slate-600">{appealPackage.body.deliverable.kind}</span>
            </div>
            <p className="text-xs text-slate-500">{t.caseDetail.deliverableNote}</p>
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
              <p className="font-medium">{t.caseDetail.customerDataTitle}</p>
              <ul className="mt-1 space-y-0.5">
                <li>
                  {t.caseDetail.rawFiles}
                  {': '}
                  {t.caseDetail.available}
                </li>
                <li>
                  {t.caseDetail.evidenceChain}
                  {': '}
                  {t.caseDetail.available}
                </li>
                <li>
                  {t.caseDetail.auditTrail}
                  {': '}
                  {t.caseDetail.available}
                </li>
              </ul>
              <p className="mt-2 text-slate-500">{t.caseDetail.customerDataNote}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-red-600">{t.common.loadFailed}</p>
        )}
      </SectionCard>

      <SectionCard title={t.caseDetail.opportunities}>
        <details className="text-[11px] text-slate-500">
          <summary className="cursor-pointer">{t.dashboardPage.opportunityAdvanced}</summary>
          <ul className="mt-2 space-y-1 font-mono">
            {body.opportunities.map((item) => (
              <li key={item.id}>
                {item.id} · {item.status} · {item.title}
              </li>
            ))}
            {body.claims.map((item) => (
              <li key={item.id}>
                claim round={item.round} · target={item.target} · status={item.status}
              </li>
            ))}
          </ul>
        </details>
      </SectionCard>
    </div>
  );
}
