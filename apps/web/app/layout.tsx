import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { getServerLocale, getServerMessages } from '../i18n/server';
import LanguageSwitcher from './language-switcher';

export const metadata: Metadata = {
  title: 'CrossClaim AI',
  description: 'CrossClaim AI — 跨渠道资金追回工作台',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, t] = await Promise.all([getServerLocale(), getServerMessages()]);

  return (
    <html lang={locale}>
      <body>
        <header className="border-b bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <span className="text-lg font-semibold">{t.appName}</span>
            <div className="flex items-center gap-4">
              <span className="text-sm text-slate-500">{t.headerNote}</span>
              <LanguageSwitcher current={locale} />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
        <footer className="mx-auto max-w-5xl px-6 pb-10 text-xs text-slate-500">{t.footerNote}</footer>
      </body>
    </html>
  );
}
