import Link from 'next/link';

import type { TaskView } from '../../lib/dashboard-view';
import EmptyState from './empty-state';
import StatusBadge from './status-badge';

/**
 * 客户待办中心（§九）：每条待办回答「发生了什么 / 影响什么 / 为什么需要你 / 下一步点哪里」。
 */
export default function TaskCenter({
  tasks,
  labels,
}: {
  tasks: TaskView[];
  labels: { impact: string; why: string; empty: string };
}) {
  if (tasks.length === 0) return <EmptyState title={labels.empty} />;

  return (
    <ul className="space-y-3">
      {tasks.map((task) => (
        <li key={task.id} className="rounded-lg border border-slate-200 p-3 sm:p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">{task.title}</p>
            <StatusBadge tone="warn">{task.impact}</StatusBadge>
          </div>
          <p className="mt-2 text-sm text-slate-700">{task.what}</p>
          <div className="mt-2 text-xs text-slate-500">
            <p className="font-medium text-slate-600">{labels.why}</p>
            <p className="mt-0.5">{task.why}</p>
          </div>
          <Link
            href={task.ctaHref}
            className="mt-3 inline-block rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            {task.ctaLabel}
          </Link>
        </li>
      ))}
    </ul>
  );
}
