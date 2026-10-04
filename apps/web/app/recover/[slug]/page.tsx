import { notFound } from 'next/navigation';

import { getServerMessages } from '../../../i18n/server';
import { loadRecoverProjection, type RecoverProjectionPage } from '../../../lib/recover-projection';

/**
 * SEO-4 —— 公开 /recover/[slug] 页面（MSG-20261004-35 OPTION_B_REVISED）。
 *
 * 只消费构建期 artifact（apps/api 导出）：不读规则表、不用 Prisma、不调 API（C-0008-A）。
 * 页面文案只来自 i18n key；规则内容（证据 / 来源）只来自 artifact。
 * 默认 noindex：只有 artifact 判定为可索引时才放开。
 */
export const dynamicParams = false;

const findPage = (slug: string, locale: string): RecoverProjectionPage | null => {
  const loaded = loadRecoverProjection();
  if (!loaded.ok) return null;
  return loaded.projection.pages.find((page) => page.slug === slug && page.locale === locale) ?? null;
};

export function generateStaticParams() {
  const loaded = loadRecoverProjection();
  if (!loaded.ok) return [];
  return loaded.projection.pages.filter((page) => page.locale === 'en').map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findPage(slug, 'en');
  if (page === null) return { robots: { index: false, follow: false } };
  const languages = Object.fromEntries(page.hreflang.map((entry) => [entry.hreflang, entry.href]));
  return {
    title: page.titleRef ?? undefined,
    description: page.descriptionRef ?? undefined,
    alternates:
      page.canonical === null
        ? undefined
        : { canonical: page.canonical, languages },
    robots: { index: page.inSitemap && page.robots === 'index,follow', follow: true },
  };
}

export default async function RecoverPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findPage(slug, 'en');
  // fail-closed：artifact 缺失 / 该 slug 不存在 / 未通过 gate → 一律按不可用处理。
  if (page === null) notFound();

  const t = await getServerMessages();
  const indexable = page.inSitemap && page.robots === 'index,follow' && page.noindexReasons.length === 0;

  return (
    <article className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold text-slate-900">{t.recover.page.title}</h1>
      {!indexable && <p className="mt-2 text-sm text-slate-500">{t.recover.error.unavailable}</p>}

      {page.contentSections.length > 0 && (
        <section className="mt-6">
          <h2 className="text-lg font-medium text-slate-900">{t.recover.page.problemHeading}</h2>
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {page.contentSections.map((section) => (
              <li key={`${section.i18nKey}:${section.ref}`}>{section.ref}</li>
            ))}
          </ul>
        </section>
      )}

      {page.requiredEvidence.length > 0 && (
        <section className="mt-6">
          <h2 className="text-lg font-medium text-slate-900">{t.recover.page.evidenceHeading}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {page.requiredEvidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {page.sourceReferences.length > 0 && (
        <section className="mt-6">
          <h2 className="text-lg font-medium text-slate-900">{t.recover.page.sourcesHeading}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
            {page.sourceReferences.map((ref) => (
              <li key={ref}>{ref}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-8 text-xs text-slate-500">{t.recover.page.estimateDisclaimer}</p>
    </article>
  );
}
