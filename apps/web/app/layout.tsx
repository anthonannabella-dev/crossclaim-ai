import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { getServerLocale, getServerMessages } from '../i18n/server';
import CustomerShell from './components/customer-shell';

export const metadata: Metadata = {
  title: 'CrossClaim AI',
  description: 'CrossClaim AI — 跨渠道资金追回工作台',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, t] = await Promise.all([getServerLocale(), getServerMessages()]);

  return (
    <html lang={locale}>
      <body className="bg-slate-50 text-slate-900 antialiased">
        <CustomerShell t={t} locale={locale}>
          {children}
        </CustomerShell>
      </body>
    </html>
  );
}
