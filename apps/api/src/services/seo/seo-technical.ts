/**
 * SEO-5 — TECHNICAL SEO BUILDERS（TRACK C / SEO P3，纯函数层）
 * ---------------------------------------------------------------
 * 提供程序化 SEO 页面所需的技术 SEO 产物，全部**只消费** Recovery Rule 单源：
 *   · locale path segment + fallback policy（5 语言 parity）
 *   · sitemap 条目（**只有通过 indexability gate 的页面才进 sitemap**）
 *   · robots.txt
 *   · metadata（title / description / canonical / robots / hreflang alternates / OpenGraph）
 *   · JSON-LD（BreadcrumbList；FAQPage **仅当页面真实存在 FAQ 时**；ItemList 用于 related rules 内链）
 *
 * 硬规则：不发明规则、不硬编码截止日/费率/金额；index / noindex 一律由 `seoIndexabilityGate()` 决定；
 * 任何缺失来源或未通过门槛的页面 → 既不进 sitemap 也标 noindex。
 */

import {
  seoIndexabilityGate,
  type RecoveryRuleDefinition,
  type SeoIndexabilityReason,
  type SeoRenderMetrics,
} from '../recovery-rules/recovery-rule-definition';

export const SEO_SUPPORTED_LOCALES = ['en', 'zh', 'de', 'ja', 'es'] as const;
export type SeoLocale = (typeof SEO_SUPPORTED_LOCALES)[number];
export const SEO_DEFAULT_LOCALE: SeoLocale = 'en';

const SLUG_RE = /^[a-z][a-z0-9-]{2,63}$/;
const LOCALE_RE = /^[a-z]{2}$/;

/** locale path segment：默认语言不带前缀，其余带 `/zh` 之类前缀。 */
export function localePathSegment(locale: string): string {
  return locale === SEO_DEFAULT_LOCALE ? '' : `/${locale}`;
}

/** locale fallback：请求语言可用则用，否则回落默认语言；非法请求 → 默认语言。 */
export function resolveLocaleFallback(requested: string | null | undefined): SeoLocale {
  if (typeof requested !== 'string' || !LOCALE_RE.test(requested)) return SEO_DEFAULT_LOCALE;
  return (SEO_SUPPORTED_LOCALES as readonly string[]).includes(requested)
    ? (requested as SeoLocale)
    : SEO_DEFAULT_LOCALE;
}

/**
 * `/recover/{slug}` 的 URL 约定（带 locale 前缀；默认语言无前缀）。
 * MSG-20261005-03（SEO_URL_CONTRACT = OPTION_A）：**slug 是 URL identity**；
 * platform / recoveryType / category 只属于页面 metadata、内容结构、JSON-LD、内链分类与 sitemap 分类，
 * **不是 URL identity**。
 */
export function buildRecoverPath(input: { slug: string; locale: SeoLocale }): string | null {
  const slug = String(input.slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  return `${localePathSegment(input.locale)}/recover/${slug}`;
}

export interface SeoAlternate {
  hreflang: string;
  href: string;
}

/**
 * hreflang alternates —— HREFLANG_POLICY = STRICT_REACHABILITY（MSG-20261005-03）：
 * **只声明真实存在页面的语言**，未确认可达的语言一律省略（绝不产生 hreflang → 404）。
 * 缺省时只声明 canonical 语言本身：宁可少声明，也不猜。
 */
export function buildAlternates(input: {
  baseUrl: string;
  path: string;
  canonicalLocale?: SeoLocale;
  reachableLocales?: readonly SeoLocale[];
}): readonly SeoAlternate[] {
  const base = input.baseUrl.replace(/\/+$/, '');
  const suffix = input.path.replace(/^\/(en|zh|de|ja|es)(?=\/|$)/, '');
  const canonicalLocale = input.canonicalLocale ?? SEO_DEFAULT_LOCALE;
  const reachable = [...new Set(input.reachableLocales ?? [canonicalLocale])].filter((locale) =>
    (SEO_SUPPORTED_LOCALES as readonly string[]).includes(locale),
  );
  if (reachable.length === 0) return [];
  const alternates: SeoAlternate[] = reachable.map((locale) => ({
    hreflang: locale,
    href: `${base}${localePathSegment(locale)}${suffix}`,
  }));
  if (reachable.includes(canonicalLocale)) {
    alternates.push({
      hreflang: 'x-default',
      href: `${base}${localePathSegment(canonicalLocale)}${suffix}`,
    });
  }
  return alternates;
}

export interface SeoSitemapEntry {
  url: string;
  lastModified: string;
  alternates: readonly SeoAlternate[];
}

export interface SeoSitemapExclusion {
  slug: string;
  reasons: readonly SeoIndexabilityReason[];
}

export interface BuildSitemapInput {
  baseUrl: string;
  now: Date;
  locale: SeoLocale;
  registeredBasisKeys: readonly string[];
  /** STRICT_REACHABILITY（MSG-20261005-03）：真实存在页面的语言集合；缺省只声明 canonical 语言。 */
  reachableLocales?: readonly SeoLocale[];
  rules: readonly {
    rule: RecoveryRuleDefinition;
    /** renderer 计算的机器可验证信号；缺失即不收录。 */
    renderMetrics?: SeoRenderMetrics;
    conflictingVersions?: boolean;
    canonicalExplicit?: boolean;
    /** 页面最后更新时间（由 renderer / 规则生效时间决定，不由 SEO 层编造）。 */
    lastModified?: string;
  }[];
}

/**
 * sitemap 条目：**只有通过 indexability gate 的页面才收录**；未通过的进入 excluded 并带原因。
 * 这样 sitemap 与页面上的 noindex 决策永远同源。
 */
export function buildSitemapEntries(input: BuildSitemapInput): {
  entries: readonly SeoSitemapEntry[];
  excluded: readonly SeoSitemapExclusion[];
} {
  const base = input.baseUrl.replace(/\/+$/, '');
  const entries: SeoSitemapEntry[] = [];
  const excluded: SeoSitemapExclusion[] = [];

  for (const item of input.rules) {
    const path = buildRecoverPath({ slug: item.rule.slug, locale: input.locale });
    if (path === null) {
      excluded.push({ slug: item.rule.slug, reasons: ['INVALID_DEFINITION'] });
      continue;
    }
    const gate = seoIndexabilityGate({
      rule: item.rule,
      now: input.now,
      registeredBasisKeys: input.registeredBasisKeys,
      renderMetrics: item.renderMetrics,
      conflictingVersions: item.conflictingVersions ?? false,
      canonicalExplicit: item.canonicalExplicit ?? true,
    });
    if (!gate.indexable) {
      excluded.push({ slug: item.rule.slug, reasons: gate.reasons });
      continue;
    }
    entries.push({
      url: `${base}${path}`,
      lastModified: item.lastModified ?? item.rule.effectiveFrom,
      alternates: buildAlternates({
        baseUrl: base,
        path,
        canonicalLocale: input.locale,
        reachableLocales: input.reachableLocales,
      }),
    });
  }
  return { entries, excluded };
}

/** robots.txt：默认允许抓取、指向 sitemap；可选 disallow 前缀（例如 /app、/api）。 */
export function buildRobotsTxt(input: {
  baseUrl: string;
  disallowPaths?: readonly string[];
  sitemapPath?: string;
}): string {
  const base = input.baseUrl.replace(/\/+$/, '');
  const lines = ['User-agent: *'];
  const disallow = (input.disallowPaths ?? []).filter((path) => path.trim() !== '' && path !== '/');
  if (disallow.length === 0) lines.push('Disallow:');
  else for (const path of disallow) lines.push(`Disallow: ${path}`);
  lines.push(`Sitemap: ${base}${input.sitemapPath ?? '/sitemap.xml'}`);
  return lines.join('\n') + '\n';
}

export interface SeoMetadata {
  title: string;
  description: string;
  canonical: string;
  robots: 'index,follow' | 'noindex,follow';
  alternates: readonly SeoAlternate[];
  openGraph: { title: string; description: string; url: string; type: 'website'; locale: string };
}

/** metadata：canonical 自指、hreflang 全套、robots 由 indexability 决定（noindex 时绝不写 index）。 */
export function buildSeoMetadata(input: {
  rule: RecoveryRuleDefinition;
  locale: SeoLocale;
  baseUrl: string;
  indexable: boolean;
  reachableLocales?: readonly SeoLocale[];
}): SeoMetadata {
  const base = input.baseUrl.replace(/\/+$/, '');
  const path = buildRecoverPath({ slug: input.rule.slug, locale: input.locale });
  const canonical = `${base}${path ?? ''}`;
  return {
    title: input.rule.title,
    description: input.rule.problemDescription,
    canonical,
    robots: input.indexable ? 'index,follow' : 'noindex,follow',
    alternates: buildAlternates({
      baseUrl: base,
      path: path ?? '',
      canonicalLocale: input.locale,
      reachableLocales: input.reachableLocales,
    }),
    openGraph: {
      title: input.rule.title,
      description: input.rule.problemDescription,
      url: canonical,
      type: 'website',
      locale: input.locale,
    },
  };
}

export interface BreadcrumbItem {
  name: string;
  url: string;
}

export function buildBreadcrumbJsonLd(items: readonly BreadcrumbItem[]): Record<string, unknown> | null {
  const filtered = items.filter((item) => item.name.trim() !== '' && item.url.trim() !== '');
  if (filtered.length < 2) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: filtered.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/** FAQPage JSON-LD **仅当页面真实存在 FAQ** 时生成；空数组返回 null（禁止虚构 FAQ）。 */
export function buildFaqJsonLd(
  faqs: readonly { question: string; answer: string }[],
): Record<string, unknown> | null {
  const real = (faqs ?? []).filter(
    (faq) => typeof faq?.question === 'string' && faq.question.trim() !== '' &&
      typeof faq?.answer === 'string' && faq.answer.trim() !== '',
  );
  if (real.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: real.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

/** ItemList JSON-LD：related recovery rules 的内部链接（只用真实存在的条目）。 */
export function buildRelatedRulesJsonLd(
  items: readonly { name: string; url: string }[],
): Record<string, unknown> | null {
  const real = (items ?? []).filter((item) => item?.name?.trim() && item?.url?.trim());
  if (real.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: real.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      url: item.url,
    })),
  };
}

/** 边界自证：技术 SEO 构建层不产生任何副作用、不新增事实来源。 */
export const SEO_TECHNICAL_BOUNDARY = {
  ruleSingleSource: true,
  externalWritePerformed: false,
  databaseWritePerformed: false,
  inventsRules: false,
  inventsFaq: false,
  inventsSourceReferences: false,
  indexDecisionFromIndexabilityGate: true,
  productionCredentials: 'ABSENT',
} as const;
