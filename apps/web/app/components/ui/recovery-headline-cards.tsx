import Link from 'next/link';

import type { HeadlineCard } from '../../lib/dashboard-view';

/**
 * AGENT EXPERIENCE LAYER / P4：首页四张核心结果卡。
 * 金额逐币种**原样**展示（后端持久化值），前端不做任何换算 / 求和 / 推导。
 */
export default function RecoveryHeadlineCards({
  cards,
  note,
}: {
  cards: HeadlineCard[];
  note: string;
}) {
  return (
    <section aria-label={cards.map((card) => card.label).join(' / ')} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{card.label}</p>
            {card.count !== null ? (
              <p className="mt-2 text-2xl font-semibold text-slate-900">{card.count}</p>
            ) : card.values.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">{card.emptyLabel}</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {card.values.map((value) => (
                  <li key={value.currency} className="text-lg font-semibold text-slate-900">
                    <span className="mr-2 text-xs font-normal text-slate-500">{value.currency}</span>
                    {value.amount}
                  </li>
                ))}
              </ul>
            )}
            {card.hint ? <p className="mt-2 text-[11px] text-slate-500">{card.hint}</p> : null}
            {card.href && card.linkLabel ? (
              <Link href={card.href} className="mt-3 inline-block text-xs text-slate-500 underline hover:text-slate-800">
                {card.linkLabel}
              </Link>
            ) : null}
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400">{note}</p>
    </section>
  );
}
