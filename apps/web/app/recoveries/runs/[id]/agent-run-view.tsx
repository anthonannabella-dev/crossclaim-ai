import Link from 'next/link';

import InlineNotice from '../../../components/ui/inline-notice';
import SectionCard from '../../../components/ui/section-card';
import StatusBadge from '../../../components/ui/status-badge';
import type { AgentRunView as AgentRunViewModel } from '../../../lib/agent-run-view';
import type { Messages } from '../../../../i18n/dictionaries/zh-CN';

/**
 * AGENT EXPERIENCE LAYER / P6：执行详情（业务语言）。
 * 只展示「你的目标 / 进度 / 结果 / 动态」；不出现 runner internals、judge、
 * task namespace、policy engine、raw blocker code、model router。
 */
export default function AgentRunView({ view, t }: { view: AgentRunViewModel; t: Messages }) {
  const labels = t.agentRun;
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{labels.pageTitle}</p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900 sm:text-2xl">{view.intent}</h1>
          </div>
          <StatusBadge tone="neutral">{view.statusLabel}</StatusBadge>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">{labels.scopeLabel}</dt>
            <dd className="text-slate-900">{view.scopeLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{labels.timeRangeLabel}</dt>
            <dd className="text-slate-900">{view.timeRangeLabel}</dd>
          </div>
          {view.approvalLabel ? (
            <div>
              <dt className="text-xs text-slate-500">{labels.approvalLabel}</dt>
              <dd className="text-slate-900">{view.approvalLabel}</dd>
            </div>
          ) : null}
        </dl>
        <p className="mt-4 text-xs text-slate-500">{labels.holdNote}</p>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-500 underline hover:text-slate-800">
          {labels.backToHome}
        </Link>
      </section>

      <SectionCard title={labels.progressTitle}>
        <ol className="space-y-2">
          {view.progress.map((step) => (
            <li key={step.key} className="flex items-center gap-3 text-sm">
              <StatusBadge tone={step.state === 'DONE' ? 'ok' : step.state === 'ACTIVE' ? 'pending' : 'neutral'}>
                {step.state === 'DONE' ? labels.stepDone : step.state === 'ACTIVE' ? labels.stepActive : labels.stepPending}
              </StatusBadge>
              <span className={step.state === 'PENDING' ? 'text-slate-500' : 'text-slate-900'}>{step.label}</span>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard title={labels.resultsTitle}>
        {view.results.length === 0 ? (
          <InlineNotice tone="info" title={labels.resultsEmptyTitle}>
            {labels.resultsEmpty}
          </InlineNotice>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {view.results.map((row) => (
              <div key={row.key} className="rounded-lg border border-slate-200 p-3">
                <dt className="text-xs text-slate-500">{row.label}</dt>
                <dd className="mt-1 text-lg font-semibold text-slate-900">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </SectionCard>

      <SectionCard title={labels.activityTitle}>
        <ul role="list" className="space-y-2">
          {view.activity.map((entry) => (
            <li key={entry.key} role="listitem" className="text-sm text-slate-700">
              {entry.text}
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
