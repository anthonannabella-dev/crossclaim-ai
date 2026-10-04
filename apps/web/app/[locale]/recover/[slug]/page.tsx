import { notFound } from 'next/navigation';

import type { Locale } from '../../../../i18n';
import { getServerMessages } from '../../../../i18n/server';
import {
  loadRecoverProjection,
  RECOVER_SUPPORTED_LOCALES,
  type RecoverProjectionPage,
} from '../../../../lib/recover-projection';
import { RecoverView } from '../../../recover/recover-view';

/**
 * SEO-4 —— `/[locale]/recover/[slug]`：**本地化路由**。
 * MSG-20261005-03（OPTION_A）：canonical = `/{locale}/recover/{slug}`，slug 是 URL identity；
 * 默认语言（en）由 `/recover/[slug]` 承担，这里**只**服务其余语言，避免同一页面两个 URL。
 *
 * HREFLANG_POLICY = STRICT_REACHABILITY：本路由存在，才代表该语言“真的可达”；
 * 因此导出的 reachableLocales 必须与本路由可产出的语言集合一致。
 * 只读构建期 artifact；缺投影 / 非法 locale / 未命中 ⇒ notFound()（fail-closed）。默认 noindex 不变。
 */
export const dynamicParams = false;

const DEFAULT_LOCALE = 'en';
const LOCALIZED_LOCALES: readonly string[] = RECOVER_SUPPORTED_LOCALES.filter(
  (locale) => locale !== DEFAULT_LOCALE,
);

/** SEO locale code（en/zh/…）→ i18n Locale（en-US/zh-CN/…）：显式对应，不猜。 */
const I18N_LOCALE: Record<string, Locale> = {
  en: 'en-US',
  zh: 'zh-CN',
  de: 'de',
  ja: 'ja',
  es: 'es',
};
const I18N_DEFAULT_LOCALE: Locale = 'en-US';

const findPage = (slug: string, locale: string): RecoverProjectionPage | null => {
  if (!LOCALIZED_LOCALES.includes(locale)) return null;
  const loaded = loadRecoverProjection();
  if (!loaded.ok) return null;
  return loaded.projection.pages.find((page) => page.slug === slug && page.locale === locale) ?? null;
};

export function generateStaticParams() {
  const loaded = loadRecoverProjection();
  if (!loaded.ok) return [];
  return loaded.projection.pages
    .filter((page) => LOCALIZED_LOCALES.includes(page.locale))
    .map((page) => ({ locale: page.locale, slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const page = findPage(slug, locale);
  if (page === null) return { robots: { index: false, follow: false } };
  const languages = Object.fromEntries(page.hreflang.map((entry) => [entry.hreflang, entry.href]));
  return {
    title: page.titleRef ?? undefined,
    description: page.descriptionRef ?? undefined,
    alternates: page.canonical === null ? undefined : { canonical: page.canonical, languages },
    robots: { index: page.inSitemap && page.robots === 'index,follow', follow: true },
  };
}

export default async function LocalizedRecoverPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const page = findPage(slug, locale);
  if (page === null) notFound();

  // 文案跟随 URL 的 locale（不是 cookie），保证 URL / canonical / 语言三者一致。
  const t = await getServerMessages(I18N_LOCALE[page.locale] ?? I18N_DEFAULT_LOCALE);
  return <RecoverView page={page} t={t} />;
}
