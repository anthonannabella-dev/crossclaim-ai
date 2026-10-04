import { cookies } from 'next/headers';
import Link from 'next/link';

import { getServerMessages } from '../../i18n/server';
import OpportunityActions from '../components/opportunity-actions';
import OpportunityCard from '../components/opportunity-card';
import InlineNotice from '../components/ui/inline-notice';
import RecoveryPipeline from '../components/ui/recovery-pipeline';
import SectionCard from '../components/ui/section-card';
import StatusBadge from '../components/ui/status-badge';
import { buildOpportunityView, type OpportunityApiItem } from '../lib/dashboard-view';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

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
 * UI-7 —— 关税追回客户视图（Customs Customer UX）。
 * 只组合既有只读端点（/opportunities?domain=CUSTOMS + /recovery-money），不新增 API/Schema。
 * 明确区分「预计可追回」与「已确认可追回」；DUTY_TRUTH / DISCREPANCY / ELIGIBILITY / ESTIMATE /
 * providerWrite / lineage 仅出现在「计算依据 / 高级详情」；真实提交保持 HOLD（尚未向海关提交）。
 */
export default async function CustomsPage() {
  const t = await getServerMessages();
  const opportunities = await apiGet<{ items: OpportunityApiItem[]; hasMore: boolean }>(
    '/opportunities?domain=CUSTOMS&limit=20',
  );

  const views = (opportunities.body?.items ?? []).map((item) => buildOpportunityView(item, t));
  const needsData = views.filter((view) => view.statusCode === 'NEEDS_DATA' || view.unattributed).length;

  const flow = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({
    key: 'customs-flow-' + index,
    label: [
      t.casePipeline.customsStageDetected,
      t.casePipeline.customsStageDataCheck,
      t.casePipeline.customsStageMatching,
      t.casePipeline.customsStageEligibility,
      t.casePipeline.customsStagePackage,
      t.casePipeline.customsStageSubmitted,
      t.casePipeline.customsStageInReview,
      t.casePipeline.customsStageReceived,
    ][index - 1]!,
    state: index === 1 ? ('DONE' as const) : ('PENDING' as const),
    hint: index === 6 ? t.customsPage.submitNote : null,
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">{t.customsPage.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{t.customsPage.subtitle}</p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs text-slate-500">{t.customsPage.estimatedLabel}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {views.length > 0 ? t.customsPage.estimatedHint.replace('{count}', String(views.length)) : '—'}
            </p>
            <p className="mt-1 text-xs text-slate-500">{t.customsPage.estimatedNote}</p>
          </div>
          <div className="max-w-sm">
            <p className="text-xs text-slate-500">{t.customsPage.confirmedLabel}</p>
            <p className="mt-1 text-sm text-slate-700">{t.customsPage.confirmedNote}</p>
            <Link href="/money" className="mt-1 inline-block text-xs text-slate-500 underline hover:text-slate-800">
              {t.customsPage.confirmedLink}
            </Link>
          </div>
        </div>
      </section>

      <InlineNotice tone="warn" title={t.customsPage.submitLabel}>
        {t.customsPage.submitNote}
      </InlineNotice>

      <div className="grid gap-3 sm:grid-cols-2">
        <SectionCard title={t.customsPage.missingLabel}>
          <p className="text-sm text-slate-700">
            {needsData > 0 ? t.customsPage.missingNeedsData.replace('{count}', String(needsData)) : t.customsPage.missingNone}
          </p>
          <p className="mt-2 text-xs text-slate-500">{t.customsPage.missingNote}</p>
        </SectionCard>
        <SectionCard title={t.customsPage.actionLabel}>
          <p className="text-sm text-slate-700">{t.customsPage.actionNote}</p>
          <Link
            href="/opportunities"
            className="mt-3 inline-block rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            {t.customsPage.actionCta}
          </Link>
        </SectionCard>
      </div>

      <SectionCard title={t.customsPage.flowTitle} subtitle={t.customsPage.flowSubtitle}>
        <RecoveryPipeline
          title={t.customsPage.flowTitle}
          stages={flow}
          labels={{
            DONE: t.casePipeline.stateDone,
            CURRENT: t.casePipeline.stateCurrent,
            PENDING: t.casePipeline.statePending,
            BLOCKED: t.casePipeline.stateBlocked,
          }}
        />
        <p className="mt-3 text-xs text-slate-500">{t.customsPage.advancedNote}</p>
      </SectionCard>

      <SectionCard
        title={t.customsPage.opportunitiesTitle}
        actions={
          <Link href="/opportunities" className="text-sm text-slate-500 underline hover:text-slate-800">
            {t.dashboardPage.opportunitiesMore}
          </Link>
        }
      >
        {opportunities.status === 403 ? (
          <p className="text-sm text-slate-600">{t.common.permissionDenied}</p>
        ) : opportunities.ok && views.length > 0 ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {views.map((view) => (
              <OpportunityCard
                key={view.id}
                view={view}
                labels={{
                  estimated: t.dashboardPage.opportunityEstimated,
                  confidence: t.dashboardPage.opportunityConfidence,
                  deadline: t.dashboardPage.opportunityDeadline,
                  noDeadline: t.dashboardPage.opportunityNoDeadline,
                  nextStep: t.dashboardPage.opportunityNextStep,
                  openDetails: t.customsPage.calculationBasis,
                  advanced: t.dashboardPage.opportunityAdvancedFields,
                  createCase: t.dashboardPage.opportunityCreateCase,
                  unattributed: t.opportunitiesPage.unattributed,
                }}
                actions={
                  view.canReview ? (
                    <OpportunityActions
                      opportunityId={view.id}
                      labels={{
                        qualify: t.dashboard.reviewQualify,
                        reject: t.dashboard.reviewReject,
                        reasonLabel: t.dashboard.rejectReason,
                        reasons: t.dashboard.rejectReasons as unknown as Record<string, string>,
                        requestFailed: t.common.requestFailed,
                        networkError: t.common.networkError,
                      }}
                    />
                  ) : null
                }
              />
            ))}
          </div>
        ) : opportunities.ok ? (
          <InlineNotice tone="info" title={t.customsPage.opportunitiesEmpty}>
            {t.customsPage.opportunitiesEmptyBody}
          </InlineNotice>
        ) : (
          <InlineNotice tone="danger" title={t.dashboardPage.loadFailedTitle}>
            {t.dashboardPage.loadFailedBody}
          </InlineNotice>
        )}
      </SectionCard>

      <SectionCard title={t.customsPage.refundLabel}>
        <p className="text-sm text-slate-700">{t.customsPage.refundNote}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusBadge tone="warn">{t.customsPage.holdBadge}</StatusBadge>
          <span className="text-xs text-slate-500">{t.customsPage.holdNote}</span>
        </div>
      </SectionCard>
    </div>
  );
}
