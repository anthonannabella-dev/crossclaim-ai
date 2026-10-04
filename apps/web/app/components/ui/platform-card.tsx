import Link from 'next/link';

import type { PlatformCardView } from '../../lib/dashboard-view';
import StatusBadge from './status-badge';

const TONE_BY_PLATFORM = {
  ok: 'ok',
  warn: 'warn',
  pending: 'pending',
  neutral: 'neutral',
} as const;

/** 平台覆盖卡（§六）：客户语言状态 + 高级详情折叠（工程状态不进主视图）。 */
export default function PlatformCard({
  card,
  labels,
}: {
  card: PlatformCardView;
  labels: {
    accounts: string;
    lastSync: string;
    never: string;
    advanced: string;
    advancedEmpty: string;
  };
}) {
  return (
    <div className="flex h-full flex-col justify-between rounded-lg border border-slate-200 p-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">{card.name}</p>
          <StatusBadge tone={TONE_BY_PLATFORM[card.tone]}>{card.status}</StatusBadge>
        </div>
        <dl className="mt-3 space-y-1 text-xs text-slate-600">
          <div className="flex justify-between gap-2">
            <dt>{labels.accounts}</dt>
            <dd className="font-medium text-slate-800">{card.accounts}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>{labels.lastSync}</dt>
            <dd className="text-slate-700">{card.lastSync ?? labels.never}</dd>
          </div>
        </dl>
        {card.detail ? <p className="mt-2 text-xs text-slate-500">{card.detail}</p> : null}
      </div>
      <div className="mt-3 space-y-2">
        {card.advanced.length > 0 ? (
          <details className="text-[11px] text-slate-500">
            <summary className="cursor-pointer">{labels.advanced}</summary>
            <ul className="mt-1 space-y-0.5">
              {card.advanced.map((line) => (
                <li key={line} className="break-all font-mono">
                  {line}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="text-[11px] text-slate-400">{labels.advancedEmpty}</p>
        )}
        {card.cta ? (
          <Link
            href={card.cta.href}
            className="inline-block rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            {card.cta.label}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
