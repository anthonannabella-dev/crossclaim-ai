import Link from 'next/link';

import type { CurrencySummary } from '../../lib/dashboard-view';
import EmptyState from './empty-state';

/**
 * 首页金额区（§五）：按币种分组展示 4 个核心指标，不做跨币种求和。
 * 金额值全部来自后端聚合，前端只负责格式化展示。
 */
export default function SummaryCards({
  summaries,
  currencyLabel,
  emptyTitle,
  emptyBody,
  emptyAction,
  holdNote,
  link,
}: {
  summaries: CurrencySummary[];
  currencyLabel: string;
  emptyTitle: string;
  emptyBody: string;
  emptyAction: { label: string; href: string };
  holdNote: string;
  link: { label: string; href: string };
}) {
  if (summaries.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} action={emptyAction} />;
  }

  return (
    <div className="space-y-4">
      {summaries.map((summary) => (
        <div key={summary.currency} className="rounded-lg border border-slate-200 p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {currencyLabel} {summary.currency}
            </p>
            <Link href={link.href} className="text-xs text-slate-500 underline hover:text-slate-800">
              {link.label}
            </Link>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {summary.cells.slice(0, 4).map((cell) => (
              <div key={cell.key}>
                <p className="text-xs text-slate-500">{cell.label}</p>
                <p className="mt-1 text-lg font-semibold text-slate-900">{cell.value}</p>
                {cell.hint ? <p className="mt-0.5 text-[11px] text-slate-400">{cell.hint}</p> : null}
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-4">
            {summary.cells.slice(4).map((cell) => (
              <div key={cell.key}>
                <p className="text-xs text-slate-500">{cell.label}</p>
                <p
                  className={
                    'mt-1 font-semibold ' + (cell.emphasis ? 'text-base text-emerald-700' : 'text-sm text-slate-800')
                  }
                >
                  {cell.value}
                </p>
                {cell.hint ? <p className="mt-0.5 text-[11px] text-slate-400">{cell.hint}</p> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-slate-500">{holdNote}</p>
    </div>
  );
}
