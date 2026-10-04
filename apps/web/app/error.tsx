'use client';

import { useEffect, useState } from 'react';

import { DEFAULT_LOCALE, LOCALE_COOKIE, getDictionary, isSupportedLocale, type Locale } from '../i18n';

/**
 * UI-8 —— 全局错误边界（客户端）。
 * 展示客户可读文案 + 重试；技术细节（digest）折叠进「高级详情」。
 */
export default function GlobalErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const raw = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(LOCALE_COOKIE + '='))
      ?.split('=')[1];
    if (isSupportedLocale(raw)) setLocale(raw);
  }, []);

  const t = getDictionary(locale);

  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-900 sm:p-8">
      <h1 className="text-xl font-semibold">{t.appStates.errorTitle}</h1>
      <p className="mt-2 text-sm">{t.appStates.errorBody}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        {t.appStates.retry}
      </button>
      <details className="mt-4 text-[11px] text-red-800">
        <summary className="cursor-pointer">{t.dashboardPage.opportunityAdvanced}</summary>
        <p className="mt-1 break-all font-mono">digest={error.digest ?? '-'}</p>
        <p className="mt-0.5 break-all font-mono">name={error.name}</p>
      </details>
    </div>
  );
}
