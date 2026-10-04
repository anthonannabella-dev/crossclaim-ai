'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { LOCALE_COOKIE, SUPPORTED_LOCALES, isLocalePlaceholder, type Locale } from '../i18n';
import type { Messages } from '../i18n/dictionaries/zh-CN';

const LABELS: Record<Locale, string> = {
  'zh-CN': '中文',
  'en-US': 'English',
  de: 'Deutsch',
  ja: '日本語',
  es: 'Español',
};

/** 语言切换：写入 cc_lang cookie 后刷新（占位语言置灰不可选）。 */
export default function LanguageSwitcher({ current, t }: { current: Locale; t: Messages }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function change(next: string) {
    setBusy(true);
    if (typeof document !== 'undefined') {
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    }
    router.refresh();
    setBusy(false);
  }

  return (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      <span className="sr-only">{t.customerShell.language}</span>
      <select
        value={current}
        disabled={busy}
        onChange={(event) => void change(event.target.value)}
        className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
        aria-label={t.customerShell.language}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale} disabled={isLocalePlaceholder(locale)}>
            {LABELS[locale]}
            {isLocalePlaceholder(locale) ? t.customerShell.languageSoon : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
