import { notFound } from 'next/navigation';

import type { Locale } from '../../../i18n';
import { getServerMessages } from '../../../i18n/server';
import { loadRecoverProjection, type RecoverProjectionPage } from '../../../lib/recover-projection';
import { RecoverView } from '../recover-view';

/**
 * SEO-4 —— `/recover/[slug]`：**默认语言（en）的 canonical 路由**。
 * MSG-20261005-03（OPTION_A）：canonical = `/{locale}/recover/{slug}`，en 无前缀；此路由保留、不 301。
 *
 * 只读已构建 artifact；apps/api 侧负责取数（web 不碰 Prisma / 不调 API；C-0008-A）。
 * 页面文案只取 i18n key；内容 / 证据 / 来源只来自 artifact。默认 noindex，只有 artifact 判定可索引时才放开。
 */
export const dynamicParams = false;

const DEFAULT_LOCALE = 'en';
/** SEO locale code（en/zh/…）与 i18n Locale（en-US/zh-CN/…）是两套代码，这里显式对应，不猜。 */
const I18N_DEFAULT_LOCALE: Locale = 'en-US';

const findPage = (slug: string, locale: string): RecoverProjectionPage | null => {
  const loaded = loadRecoverProjection();
  if (!loaded.ok) return null;
  return loaded.projection.pages.find((page) => page.slug === slug && page.locale === locale) ?? null;
};

export function generateStaticParams() {
  const loaded = loadRecoverProjection();
  if (!loaded.ok) return [];
  return loaded.projection.pages.filter((page) => page.locale === DEFAULT_LOCALE).map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findPage(slug, DEFAULT_LOCALE);
  if (page === null) return { robots: { index: false, follow: false } };
  const languages = Object.fromEntries(page.hreflang.map((entry) => [entry.hreflang, entry.href]));
  return {
    title: page.titleRef ?? undefined,
    description: page.descriptionRef ?? undefined,
    alternates: page.canonical === null ? undefined : { canonical: page.canonical, languages },
    robots: { index: page.inSitemap && page.robots === 'index,follow', follow: true },
  };
}

export default async function RecoverPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // fail-closed：artifact 缺失 / 无此 slug / 未通过 gate ⇒ 一律按不存在处理。
  const page = findPage(slug, DEFAULT_LOCALE);
  if (page === null) notFound();

  const t = await getServerMessages(I18N_DEFAULT_LOCALE);
  return <RecoverView page={page} t={t} />;
}
