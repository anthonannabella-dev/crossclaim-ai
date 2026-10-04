import Link from 'next/link';

import { getServerMessages } from '../../i18n/server';

/** /recover 段的 404 视图：统一形状，不区分「未注册」与「非法 slug」（不 fingerprint 注册表）。 */
export default async function RecoverNotFound() {
  const t = await getServerMessages();
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <h1 className="text-xl font-semibold text-slate-900">{t.recover.error.notFound}</h1>
      <p className="mt-2 text-sm text-slate-600">{t.recover.error.unavailable}</p>
      <Link
        href="/"
        className="mt-4 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        {t.common.backToDashboard}
      </Link>
    </div>
  );
}
