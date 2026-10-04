import type { ReactNode } from 'react';

export type BadgeTone = 'ok' | 'warn' | 'pending' | 'danger' | 'neutral';

const TONES: Record<BadgeTone, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  pending: 'border-sky-200 bg-sky-50 text-sky-700',
  danger: 'border-red-200 bg-red-50 text-red-700',
  neutral: 'border-slate-200 bg-slate-50 text-slate-600',
};

/** 统一状态徽标（避免各页面自行拼 className）。 */
export default function StatusBadge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={
        'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ' + TONES[tone]
      }
    >
      {children}
    </span>
  );
}
