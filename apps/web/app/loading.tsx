import { getServerMessages } from '../i18n/server';

/** UI-8 —— 全局加载骨架（可访问：aria-busy + sr-only 文案）。 */
export default async function GlobalLoading() {
  const t = await getServerMessages();
  return (
    <div className="space-y-3" aria-busy="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-28 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
      ))}
      <span className="sr-only" role="status">
        {t.common.loading}
      </span>
    </div>
  );
}
