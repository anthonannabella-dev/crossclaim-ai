import { notFound } from 'next/navigation';

/**
 * SEO-4 Stage 1（页面层骨架）—— 公开 /recover/[slug] 路由。
 *
 * 当前状态：**骨架 + 默认 noindex**。
 *   · 规则判定 / metadata / JSON-LD / sitemap / 正文的契约已在 API 层实现并通过 24 条专项用例
 *     （apps/api/src/services/seo/seo-recover-route.ts），本页只负责承载它们；
 *   · 页面取数方式（构建期静态 vs 公开只读 GET）正在审计裁决中，因此本层**先不接入任何数据源**，
 *     也不注册任何 API / POST 路由；拿到裁决前一律按「不可用」处理（fail-closed）。
 *   · 无论裁决结果如何，本页默认 noindex；只有 API 层 indexability gate 全绿才允许放开。
 */
export const metadata = {
  robots: { index: false, follow: false },
};

export default async function RecoverPage() {
  // fail-closed：数据源边界未裁定前，不渲染任何规则内容。
  notFound();
}
