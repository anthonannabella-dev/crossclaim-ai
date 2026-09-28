import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'CrossClaim AI',
  description: 'CrossClaim AI — 承运商费用追回工作台',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="border-b bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <span className="text-lg font-semibold">CrossClaim AI</span>
            <span className="text-sm text-slate-500">Gate 6 · 客户操作层（内部预览）</span>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
        <footer className="mx-auto max-w-5xl px-6 pb-10 text-xs text-slate-500">
          内部预览：未部署到公网；认证与上传入口仅面向受邀组织。
        </footer>
      </body>
    </html>
  );
}
