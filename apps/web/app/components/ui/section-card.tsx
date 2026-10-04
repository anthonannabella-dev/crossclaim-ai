import type { ReactNode } from 'react';

/** 统一卡片层级：白底 + 细边框 + 一致内边距（替代逐页手写 rounded border p-3）。 */
export default function SectionCard({
  title,
  subtitle,
  actions,
  children,
  id,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      {title || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            {title ? <h2 className="text-base font-semibold text-slate-900">{title}</h2> : null}
            {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={title || actions ? 'mt-4' : ''}>{children}</div>
    </section>
  );
}
