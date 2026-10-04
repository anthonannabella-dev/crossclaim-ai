/**
 * SEO-4 静态投影导出（MSG-20261004-35 OPTION_B_REVISED，apps/api 侧）
 * ---------------------------------------------------------------
 * 输入：生效规则集合（由调用方从 RuleVersion 读取并解析，web 侧永不接触）。
 * 输出：`seo-recover-static-v1` artifact 对象（只含白名单字段）。
 *
 * 关键约束：
 *   · 只通过已验收的 facade `buildRecoverPagePlan()` 产生页面数据，**不在这里重新解释业务规则**；
 *   · 导出前用 `parseRecoverStaticProjection()` **自校验**：任何越界字段 / schema 问题直接抛错，
 *     绝不让一份越界 artifact 落盘；
 *   · sourceDigest 覆盖输入规则集合（顺序无关），便于「规则变了要重建」被审计发现。
 */

import { createHash } from 'node:crypto';

import {
  SEO_RECOVER_STATIC_SCHEMA,
  SEO_RECOVER_STATIC_LOCALES,
  parseRecoverStaticProjection,
  type SeoRecoverStaticLocale,
  type SeoRecoverStaticPage,
  type SeoRecoverStaticProjection,
} from './seo-recover-static-projection';
import { buildRecoverPagePlan, type SeoRecoverRouteRule } from './seo-recover-route';

/** 导出器需要的最小规则形状：路由字段 + 真实正文来源（全部来自 RecoveryRuleDefinition v1）。 */
export interface SeoRecoverExportRule extends SeoRecoverRouteRule {
  title: string;
  problemDescription: string;
  requiredEvidence: readonly string[];
  sourceReferences: readonly string[];
  relatedRuleRefs: readonly string[];
}

export interface SeoRecoverExportInput {
  rules: readonly SeoRecoverExportRule[];
  now: Date;
  baseUrl: string;
  conflictingSlugs?: readonly string[];
  relatedPages?: readonly { name: string; url: string }[];
  breadcrumb?: readonly { name: string; url: string }[];
  locales?: readonly SeoRecoverStaticLocale[];
}

/** 规则集合的 64-hex digest：排序后覆盖 slug / ruleVersion / 生效窗口，顺序无关。 */
export function computeRecoverSourceDigest(rules: readonly SeoRecoverExportRule[]): string {
  const canonical = [...rules]
    .map((rule) => `${rule.slug}|${rule.ruleVersion}|${rule.effectiveFrom}|${rule.effectiveTo ?? '*'}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildRecoverStaticProjectionFromRules(input: SeoRecoverExportInput): SeoRecoverStaticProjection {
  const locales = input.locales ?? SEO_RECOVER_STATIC_LOCALES;
  const pages: SeoRecoverStaticPage[] = [];

  for (const rule of input.rules) {
    for (const locale of locales) {
      const plan = buildRecoverPagePlan({
        slug: rule.slug,
        requestedLocale: locale,
        rules: input.rules,
        now: input.now,
        conflictingSlugs: input.conflictingSlugs,
        rule,
        baseUrl: input.baseUrl,
        relatedPages: input.relatedPages,
        breadcrumb: input.breadcrumb,
      });

      pages.push({
        slug: rule.slug,
        locale,
        path: plan.decision.path,
        ruleVersion: rule.ruleVersion,
        decision: plan.decision.reason,
        robots: plan.decision.robots,
        canonical: plan.metadata.canonical,
        hreflang: plan.metadata.alternates.map((alternate) => ({
          hreflang: alternate.hreflang,
          href: alternate.href,
        })),
        titleRef: plan.metadata.titleRef,
        descriptionRef: plan.metadata.descriptionRef,
        contentSections: plan.content.sections.map((section) => ({
          i18nKey: section.i18nKey,
          ref: section.ref,
          sourceRef: section.sourceRef,
        })),
        requiredEvidence: [...rule.requiredEvidence],
        sourceReferences: [...rule.sourceReferences],
        relatedLinks: plan.content.internalLinks.map((link) => ({ name: link.name, url: link.url })),
        jsonLd: [...plan.jsonLd.blocks],
        inSitemap: plan.sitemap.included,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
        noindexReasons: [...plan.decision.noindexReasons],
      });
    }
  }

  const artifact: SeoRecoverStaticProjection = {
    schema: SEO_RECOVER_STATIC_SCHEMA,
    generatedAt: input.now.toISOString(),
    sourceDigest: computeRecoverSourceDigest(input.rules),
    pages,
  };

  // 自校验：越界字段 / 非法 locale / schema 问题一律在落盘前抛错。
  const validated = parseRecoverStaticProjection(artifact);
  if (!validated.ok) throw new Error('PROJECTION_SELF_CHECK_FAILED:' + validated.reason);
  return artifact;
}
