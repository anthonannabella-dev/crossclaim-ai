import Link from 'next/link';

import type { TaskKind, TaskView } from '../../lib/dashboard-view';
import EmptyState from './empty-state';
import StatusBadge from './status-badge';

/**
 * 客户待办中心（单一模型，P5 扩展）。
 * 每条仍回答：发生了什么 / 影响什么 / 为什么需要我 / 一个明确 CTA。
 * 类别（AUTHORIZATION / APPROVAL / CUSTOMS_POA / … / CASE）以客户语言展示；
 * 技术 code 只用于高级视图，不作为主文案。
 */
export default function TaskCenter({
  tasks,
  labels,
}: {
  tasks: TaskView[];
  labels: {
    title: string;
    impact: string;
    why: string;
    empty: string;
    kindLabels: Record<TaskKind, string>;
  };
}) {
  if (tasks.length === 0) return <EmptyState title={labels.empty} />;

  return (
    <ul role="list" aria-label={labels.title} className="space-y-3">
      {tasks.map((task) => (
        <li key={task.id} role="listitem" data-task-kind={task.kind} className="rounded-lg border border-slate-200 p-3 sm:p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">{task.title}</p>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="neutral">{labels.kindLabels[task.kind]}</StatusBadge>
              <StatusBadge tone="warn">{task.impact}</StatusBadge>
            </div>
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
