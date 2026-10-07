import Link from 'next/link';

import type { ActiveFlowView } from '../../lib/dashboard-view';

export interface ActiveRecoveryLabels {
  title: string;
  subtitle: string;
  empty: string;
  openLabel: string;
}

/**
 * CUSTOMER-UI-PRODUCTIZATION-V2 / P3：CrossClaim 正在帮你做什么。
 * 只消费已有后端事实（goal 状态 + case 状态标签），不新建事实源、不显示内部命名空间。
 * 顶部列表默认 3–5 条，点开才进详情页。
 */
export default function ActiveRecovery({
  flows,
  labels,
}: {
  flows: ActiveFlowView[];
  labels: ActiveRecoveryLabels;
}) {
  return (
    <section aria-labelledby="active-recovery" className="space-y-3">
      <div>
        <h2 id="active-recovery" className="text-lg font-semibold text-slate-900">
          {labels.title}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{labels.subtitle}</p>
      </div>
      {flows.length === 0 ? (
        <p className="text-sm text-slate-500">{labels.empty}</p>
      ) : (
        <ul role="list" aria-label={labels.title} className="divide-y divide-slate-100">
          {flows.map((flow) => (
            <li key={flow.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{flow.title}</p>
                <p className="mt-0.5 text-sm text-slate-600">{flow.detail}</p>
              </div>
              <Link
                href={flow.href}
                className="shrink-0 text-xs text-slate-500 underline hover:text-slate-900"
              >
                {labels.openLabel}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
