import type { Messages } from '../../i18n';
import type { RecoverProjectionPage } from '../../lib/recover-projection';

/**
 * SEO-4 recover 页面展示层（MSG-20261005-03 OPTION_A）。
 * 两个路由（默认语言 `/recover/[slug]` 与本地化 `/[locale]/recover/[slug]`）共用这一份展示，
 * 页面文案只取 i18n key，内容 / 证据 / 来源只来自构建期 artifact —— web 不自行解释业务规则。
 */
export function RecoverView({ page, t }: { page: RecoverProjectionPage; t: Messages }) {
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
