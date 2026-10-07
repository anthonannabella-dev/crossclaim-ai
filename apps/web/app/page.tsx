import { cookies } from 'next/headers';
import Link from 'next/link';

import { formatDateTime } from '../i18n/business-language';
import { getServerLocale, getServerMessages } from '../i18n/server';
import OpportunityActions from './components/opportunity-actions';
import OpportunityCard from './components/opportunity-card';
import InlineNotice from './components/ui/inline-notice';
import GoalConsole from './components/ui/goal-console';
import RecoveryHeadlineCards from './components/ui/recovery-headline-cards';
import PlatformCard from './components/ui/platform-card';
import SecurityStrip from './components/ui/security-strip';
import SectionCard from './components/ui/section-card';
import StatusBadge from './components/ui/status-badge';
import SummaryCards from './components/ui/summary-cards';
import TaskCenter from './components/ui/task-center';
import {
  buildCurrencySummaries,  buildHeadlineCards,
  buildOpportunityView,
  buildPlatformCards,
  buildTasks,
  buildConnectionTasks,
  buildAuthorizationTasks,
  buildTaskKindLabels,
  mergeNeedsAttention,
  selectPrimaryCta,
  type AccountsResponse,
  type MoneyBucket,
  type OpportunityApiItem,
  type RecoveryStateItem,
} from './lib/dashboard-view';

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

interface MoneyResponse {
  organization: { byCurrency: MoneyBucket[]; collection: string; payment: string };
  cases: Array<{ caseId: string; caseNo: string; title: string; status: string; statusLabel: string; currency: string }>;
  feeNote: string;
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

function LoginPrompt({ t }: { t: Awaited<ReturnType<typeof getServerMessages>> }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <h1 className="text-xl font-semibold text-slate-900">{t.firstRun.title}</h1>
      <p className="mt-2 text-sm text-slate-600">{t.firstRun.whatItIs}</p>
      <ol className="mt-4 space-y-2 text-sm text-slate-700">
        <li>1. {t.firstRun.step1}</li>
        <li>2. {t.firstRun.step2}</li>
        <li>3. {t.firstRun.step3}</li>
      </ol>
      <p className="mt-3 text-xs text-slate-500">{t.firstRun.pricingNote}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href="/signup"
          className="inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
        >
          {t.common.createAccount}
        </Link>
        <Link
          href="/login"
          className="inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-800"
        >
          {t.common.goToLogin}
        </Link>
      </div>
      <p className="mt-3 text-xs text-slate-500">{t.footerNote}</p>
    </div>
  );
}

export default async function DashboardPage() {
  const [t, locale] = await Promise.all([getServerMessages(), getServerLocale()]);
  const me = await apiGet<Me>('/auth/me');
  if (!me.ok || !me.body) return <LoginPrompt t={t} />;

  const [money, accounts, recoveryStates, opportunities, imports, goals] = await Promise.all([
    apiGet<MoneyResponse>('/recovery-money'),
    apiGet<AccountsResponse>('/accounts'),
    apiGet<{ items: RecoveryStateItem[] }>('/recovery-states'),
    apiGet<{ items: OpportunityApiItem[]; hasMore: boolean }>('/opportunities?limit=5'),
    apiGet<{ items: ImportBatchItem[] }>('/imports'),
    apiGet<{ items: Array<{ goalId: string; status: string; intent: string }> }>('/agent-goals'),
  ]);

  const summaries = buildCurrencySummaries(money.body?.organization.byCurrency, t);
  const recoveryTasks = buildTasks(recoveryStates.body?.items, t);
  // P5 / P9: one merged Needs Your Attention list (recovery states + account tasks + goals awaiting authorization)
  const tasks = mergeNeedsAttention(
    recoveryTasks,
    buildConnectionTasks(accounts.body, t),
    buildAuthorizationTasks(goals.body?.items, t),
  );
  const platforms = buildPlatformCards(accounts.body, t);
  const opportunityViews = (opportunities.body?.items ?? []).map((item) => buildOpportunityView(item, t));

  // P4 headline cards: amounts come verbatim from /recovery-money per currency (no client-side math)
  const headlineCards = buildHeadlineCards(money.body?.organization.byCurrency, tasks.length, t);

  const connectedAccounts = (accounts.body?.platforms ?? []).reduce(
    (total, group) =>
      total +
      group.accounts.filter((account) => account.connections.some((connection) => connection.status === 'ACTIVE')).length,
    0,
  );
  const cta = selectPrimaryCta(
    {
      pendingTasks: tasks.length,
      connectedAccounts,
      opportunityCount: opportunityViews.length,
      missingPlatforms: platforms.filter((card) => !card.unavailable).length,
    },
    t,
  );

  return (
    <div className="space-y-6">
      <GoalConsole labels={t.goalConsole} />

      <RecoveryHeadlineCards cards={headlineCards} note={t.goalConsole.perCurrencyNote} />

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t.customerShell.brandNote}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">{t.dashboardPage.heroTitle}</h1>
        <p className="mt-3 max-w-3xl text-sm text-slate-600">{t.dashboardPage.heroSubtitle}</p>
        <p className="mt-2 max-w-3xl text-sm text-slate-500">{t.dashboardPage.valueProp}</p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Link
            href={cta.href}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            {cta.label}
          </Link>
          <Link
            href="/money"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            {t.dashboardPage.moneyLink}
          </Link>
          <StatusBadge tone="neutral">{t.common.role + ' ' + me.body.role}</StatusBadge>
        </div>
      </section>

      <InlineNotice tone="warn" title={t.dashboardPage.submissionHoldTitle}>
        {t.dashboardPage.submissionHoldBody}
      </InlineNotice>

      <SectionCard
        title={t.dashboardPage.metricsTitle}
        subtitle={t.dashboardPage.metricsSubtitle}
        actions={
          <Link href="/money" className="text-sm text-slate-500 underline hover:text-slate-800">
            {t.dashboardPage.moneyLink}
          </Link>
        }
      >
        {money.ok && money.body ? (
          <SummaryCards
            summaries={summaries}
            currencyLabel={t.dashboardPage.currencyLabel}
            emptyTitle={t.dashboardPage.metricsEmpty}
            emptyBody={t.dashboardPage.metricsEmptyBody}
            emptyAction={{ label: t.dashboardPage.ctaConnect, href: '/connections' }}
            holdNote={t.dashboardPage.paymentsHold}
            link={{ label: t.dashboardPage.moneyLink, href: '/money' }}
          />
        ) : (
          <InlineNotice tone="danger" title={t.dashboardPage.loadFailedTitle}>
            {t.dashboardPage.loadFailedBody}
          </InlineNotice>
        )}
      </SectionCard>

      <SectionCard id="customer-tasks" title={t.dashboardPage.tasksTitle} subtitle={t.dashboardPage.tasksSubtitle}>
        {recoveryStates.ok ? (
          <TaskCenter
            tasks={tasks}
            labels={{
              title: t.dashboardPage.tasksTitle,
              impact: t.dashboardPage.taskImpact,
              why: t.dashboardPage.taskWhyUser,
              empty: t.dashboardPage.tasksEmpty,
              kindLabels: buildTaskKindLabels(t),
            }}
          />
        ) : (
          <InlineNotice tone="danger" title={t.dashboardPage.loadFailedTitle}>
            {t.dashboardPage.loadFailedBody}
          </InlineNotice>
        )}
      </SectionCard>

      <SectionCard title={t.dashboardPage.platformsTitle} subtitle={t.dashboardPage.platformsSubtitle}>
        {accounts.ok ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {platforms.map((card) => (
              <PlatformCard
                key={card.key}
                card={card}
                labels={{
                  accounts: t.dashboardPage.platformAccounts,
                  lastSync: t.dashboardPage.platformLastSync,
                  never: t.dashboardPage.platformNever,
                  advanced: t.dashboardPage.platformAdvanced,
                  advancedEmpty: t.dashboardPage.platformAdvancedEmpty,
                }}
              />
            ))}
          </div>
        ) : (
          <InlineNotice tone="danger" title={t.dashboardPage.loadFailedTitle}>
            {t.dashboardPage.loadFailedBody}
          </InlineNotice>
        )}
      </SectionCard>

      <SectionCard
        title={t.dashboardPage.opportunitiesTitle}
        subtitle={t.dashboardPage.opportunitiesSubtitle}
        actions={
          <>
            <a href="/api/opportunities/insights.csv" className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
              {t.dashboard.exportCsv}
            </a>
            <Link href="/opportunities" className="text-sm text-slate-500 underline hover:text-slate-800">
              {t.dashboardPage.opportunitiesMore}
            </Link>
          </>
        }
      >
        {opportunities.ok && opportunityViews.length > 0 ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {opportunityViews.map((view) => (
              <OpportunityCard
                key={view.id}
                view={view}
                labels={{
                  estimated: t.dashboardPage.opportunityEstimated,
                  confidence: t.dashboardPage.opportunityConfidence,
                  deadline: t.dashboardPage.opportunityDeadline,
                  noDeadline: t.dashboardPage.opportunityNoDeadline,
                  nextStep: t.dashboardPage.opportunityNextStep,
                  openDetails: t.dashboardPage.opportunityAdvanced,
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
          <InlineNotice tone="info" title={t.dashboardPage.opportunitiesEmpty}>
            {t.dashboardPage.opportunitiesEmptyBody}
          </InlineNotice>
        ) : (
          <InlineNotice tone="danger" title={t.dashboardPage.loadFailedTitle}>
            {t.dashboardPage.loadFailedBody}
          </InlineNotice>
        )}
      </SectionCard>

      <SectionCard
        title={t.dashboardPage.importsTitle}
        actions={
          <Link href="/upload" className="text-sm text-slate-500 underline hover:text-slate-800">
            {t.dashboardPage.importsCta}
          </Link>
        }
      >
        {imports.ok && imports.body && imports.body.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2">{t.dashboard.colBatch}</th>
                  <th>{t.dashboard.colStatus}</th>
                  <th>{t.dashboard.colRowsTotal}</th>
                  <th>{t.dashboard.colRowsOk}</th>
                  <th>{t.dashboard.colRowsFailed}</th>
                  <th>{t.dashboard.colStartedAt}</th>
                </tr>
              </thead>
              <tbody>
                {imports.body.items.slice(0, 5).map((item) => (
                  <tr key={item.id} className="border-t border-slate-100">
                    <td className="py-2 font-mono text-xs">{item.id.slice(0, 8)}…</td>
                    <td>{item.status}</td>
                    <td>{item.rowsTotal}</td>
                    <td>{item.rowsOk}</td>
                    <td>{item.rowsFailed}</td>
                    <td className="text-slate-500">{formatDateTime(item.startedAt, { locale })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <InlineNotice tone="info" title={t.dashboardPage.importsEmpty}>
            {t.dashboardPage.importsEmptyBody}
          </InlineNotice>
        )}
      </SectionCard>

      <SecurityStrip
        title={t.dashboardPage.securityTitle}
        points={[
          t.dashboardPage.security1,
          t.dashboardPage.security2,
          t.dashboardPage.security3,
          t.dashboardPage.security4,
          t.dashboardPage.security5,
          t.dashboardPage.security6,
        ]}
      />
    </div>
  );
}
