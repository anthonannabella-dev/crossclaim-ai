'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import type { Locale } from '../../i18n';
import type { Messages } from '../../i18n/dictionaries/zh-CN';
import LanguageSwitcher from '../language-switcher';
import { buildCustomerNav, isActivePath, isBareRoute } from './nav-model';

/**
 * UI-1 — Customer App Shell：桌面左侧导航 + 移动端 drawer（MSG-20261004-01 §三）。
 * 只重组既有 route 的入口，不新增/删除 route，保持 URL 与 API contract 兼容。
 * 认证页（/login、/signup）使用无导航的「裸」外壳。
 */
export default function CustomerShell({
  children,
  t,
  locale,
}: {
  children: ReactNode;
  t: Messages;
  locale: Locale;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const groups = buildCustomerNav(t);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (isBareRoute(pathname)) {
    return (
      <div className="flex min-h-screen flex-col bg-slate-50">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
            <Link href="/" className="text-lg font-semibold text-slate-900">
              {t.appName}
            </Link>
            <LanguageSwitcher current={locale} t={t} />
          </div>
        </header>
        <main className="flex flex-1 justify-center px-4 py-10 sm:px-6">{children}</main>
        <footer className="px-4 pb-8 text-xs text-slate-500 sm:px-6">{t.footerNote}</footer>
      </div>
    );
  }

  const nav = (onNavigate?: () => void) => (
    <nav aria-label={t.customerShell.menuTitle} className="space-y-6">
      {groups.map((group) => (
        <div key={group.title}>
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group.title}</p>
          <ul className="mt-2 space-y-1">
            {group.items.map((item) => {
              const active = isActivePath(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={
                      'block rounded-lg px-3 py-2 text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 ' +
                      (active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100')
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      <a
        href="#main-content"
        className="sr-only rounded bg-white px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        {t.customerShell.skipToContent}
      </a>

      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white px-4 py-6 lg:block">
        <Link href="/" className="block px-3 text-lg font-semibold text-slate-900">
          {t.appName}
        </Link>
        <p className="mt-1 px-3 text-xs text-slate-500">{t.customerShell.brandNote}</p>
        <div className="mt-6">{nav()}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setOpen(true)}
                aria-expanded={open}
                aria-controls="customer-nav-drawer"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 lg:hidden"
              >
                {t.customerShell.openMenu}
              </button>
              <Link href="/" className="text-base font-semibold text-slate-900 lg:hidden">
                {t.appName}
              </Link>
            </div>
            <div className="flex items-center gap-3">
              <LanguageSwitcher current={locale} t={t} />
            </div>
          </div>
        </header>

        <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>

        <footer className="px-4 pb-8 text-xs text-slate-500 sm:px-6">{t.footerNote}</footer>
      </div>

      {open ? (
        <div className="fixed inset-0 z-30 lg:hidden">
          <button
            type="button"
            aria-label={t.customerShell.closeMenu}
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full bg-slate-900/40"
          />
          <div
            id="customer-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t.customerShell.menuTitle}
            className="absolute inset-y-0 left-0 w-72 max-w-[85%] overflow-y-auto bg-white px-4 py-6 shadow-xl"
          >
            <div className="flex items-center justify-between px-3">
              <span className="text-base font-semibold text-slate-900">{t.appName}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
              >
                {t.customerShell.closeMenu}
              </button>
            </div>
            <div className="mt-4">{nav(() => setOpen(false))}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
