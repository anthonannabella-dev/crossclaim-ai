import Link from 'next/link';

import { getServerMessages } from '../i18n/server';

/** UI-8 —— 404 客户视图（不存在 / 无权限范围内不可见）。 */
export default async function NotFound() {
  const t = await getServerMessages();
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <h1 className="text-xl font-semibold text-slate-900">{t.appStates.notFoundTitle}</h1>
      <p className="mt-2 text-sm text-slate-600">{t.appStates.notFoundBody}</p>
      <Link
        href="/"
        className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        {t.common.backToDashboard}
      </Link>
    </div>
  );
}
