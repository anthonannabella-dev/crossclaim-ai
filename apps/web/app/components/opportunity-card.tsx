import Link from 'next/link';
import type { ReactNode } from 'react';

import type { OpportunityView } from '../lib/dashboard-view';
import StatusBadge from './ui/status-badge';

/**
 * Opportunity 卡片（§七）：客户默认看到「来源 / 问题 / 预计可追回 / 可信度 / 截止时间 / 状态 / 下一步」；
 * domain / channel / accountState 等工程字段只在「高级详情」出现。
 */
export default function OpportunityCard({
  view,
  labels,
  actions,
}: {
  view: OpportunityView;
  labels: {
    estimated: string;
    confidence: string;
    deadline: string;
    noDeadline: string;
    nextStep: string;
    openDetails: string;
    advanced: string;
    createCase: string;
    unattributed: string;
  };
  actions?: ReactNode;
}) {
  const advancedLines = [
    'domain=' + view.domain,
    'channel=' + view.channel,
    'type=' + view.opportunityType,
    'status=' + view.statusCode,
    'opportunityId=' + view.id,
  ];

  return (
    <article className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{view.source}</p>
          <h3 className="mt-1 text-sm font-semibold text-slate-900">{view.problem}</h3>
          {view.account ? <p className="mt-0.5 text-xs text-slate-500">{view.account}</p> : null}
          {view.unattributed ? (
            <p className="mt-0.5 text-xs text-amber-700">{labels.unattributed}</p>
          ) : null}
        </div>
        <StatusBadge tone="neutral">{view.statusLabel}</StatusBadge>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">{labels.estimated}</dt>
          <dd className="mt-0.5 text-base font-semibold text-slate-900">
            {view.amount ? view.amount + ' ' + view.currency : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">{labels.confidence}</dt>
          <dd className="mt-0.5 font-medium text-slate-800">{view.confidence}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{labels.deadline}</dt>
          <dd className="mt-0.5 font-medium text-slate-800">
            {view.deadline ? view.deadline.slice(0, 10) : labels.noDeadline}
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link
          href={'/cases?opportunity=' + view.id}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
        >
          {view.canCreateCase ? labels.createCase : labels.nextStep}
        </Link>
        {actions}
      </div>

      <details className="mt-3 text-[11px] text-slate-500">
        <summary className="cursor-pointer">{labels.openDetails}</summary>
        <ul className="mt-1 space-y-0.5">
          <li className="font-medium text-slate-600">{labels.advanced}</li>
          {advancedLines.map((line) => (
            <li key={line} className="break-all font-mono">
              {line}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
