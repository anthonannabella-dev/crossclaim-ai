/**
 * SEO-6 — INDEXABILITY GATE INTEGRATION（TRACK C / SEO P3，纯函数层）
 * ---------------------------------------------------------------
 * 把 Recovery Rule 单源 → indexability gate → 页面产物（metadata / JSON-LD / sitemap 收录决策）
 * 组成**每页一份的执行计划**，并覆盖 Technical SEO 要求 15–20：
 *   15 related recovery rules 内部链接 · 16 index/noindex policy · 17 duplicate slug / 404 保护
 *   18 expired RuleVersion 处理 · 19 canonical version selection · 20 locale fallback policy
 *
 * 硬规则：不发明规则、不绕过 gate、不产生副作用；任何不满足门槛的页面一律 noindex + 不进 sitemap。
 */

import {
  detectRecoveryRuleVersionConflicts,
  selectCurrentlyEffectiveRecoveryRuleVersion,
  seoIndexabilityGate,
  type RecoveryRuleDefinition,
  type SeoIndexabilityReason,
  type SeoRenderMetrics,
} from '../recovery-rules/recovery-rule-definition';
import {
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
  buildRecoverPath,
  buildRelatedRulesJsonLd,
  buildSeoMetadata,
  resolveLocaleFallback,
  type BreadcrumbItem,
  type SeoLocale,
  type SeoMetadata,
} from './seo-technical';

export interface RecoveryPagePlanInput {
  rule: RecoveryRuleDefinition;
  locale: SeoLocale;
  baseUrl: string;
  now: Date;
  registeredBasisKeys: readonly string[];
  renderMetrics?: SeoRenderMetrics;
  conflictingVersions?: boolean;
  canonicalExplicit?: boolean;
  /** 真实存在的关系页（内部链接用；为空则不生成 ItemList）。 */
  related?: readonly { name: string; url: string }[];
  /** 真实存在的面包屑层级（至少两级才会生成 JSON-LD）。 */
  breadcrumb?: readonly BreadcrumbItem[];
  /** 页面真实存在的 FAQ（为空则绝不生成 FAQPage）。 */
  faqs?: readonly { question: string; answer: string }[];
}

export interface RecoveryPagePlan {
  slug: string;
  path: string;
  ruleVersion: string;
  indexable: boolean;
  noindexReasons: readonly SeoIndexabilityReason[];
  metadata: SeoMetadata;
  /** 只包含真实可生成的 JSON-LD 块（无 FAQ 就没有 FAQPage）。 */
  jsonLd: readonly Record<string, unknown>[];
  inSitemap: boolean;
  /** 边界自证：计划本身不产生任何副作用。 */
  externalWritePerformed: false;
  databaseWritePerformed: false;
  productionCredentials: 'ABSENT';
}

/**
 * 单页计划：indexable 只由 indexability gate 决定；metadata 的 robots / sitemap 收录与之严格一致。
 */
export function planRecoveryPage(input: RecoveryPagePlanInput): RecoveryPagePlan {
  const gate = seoIndexabilityGate({
    rule: input.rule,
    now: input.now,
    registeredBasisKeys: input.registeredBasisKeys,
    renderMetrics: input.renderMetrics,
    conflictingVersions: input.conflictingVersions ?? false,
    canonicalExplicit: input.canonicalExplicit ?? true,
  });

  const path = buildRecoverPath({
    platform: input.rule.platform.toLowerCase(),
    recoveryType: input.rule.recoveryType,
    locale: input.locale,
  }) ?? '';

  const metadata = buildSeoMetadata({
    rule: input.rule,
    locale: input.locale,
    baseUrl: input.baseUrl,
    indexable: gate.indexable,
  });

  const jsonLd: Record<string, unknown>[] = [];
  const breadcrumb = buildBreadcrumbJsonLd(input.breadcrumb ?? []);
  if (breadcrumb) jsonLd.push(breadcrumb);
  const related = buildRelatedRulesJsonLd(input.related ?? []);
  if (related) jsonLd.push(related);
  const faq = buildFaqJsonLd(input.faqs ?? []);
  if (faq) jsonLd.push(faq);

  return {
    slug: input.rule.slug,
    path,
    ruleVersion: input.rule.ruleVersion,
    indexable: gate.indexable,
    noindexReasons: gate.reasons,
    metadata,
    jsonLd,
    inSitemap: gate.indexable,
    externalWritePerformed: false,
    databaseWritePerformed: false,
    productionCredentials: 'ABSENT',
  };
}

/** 同一 slug 出现多个版本（或同 slug 不同内容）→ 站点级保护（要求 17）。 */
export function detectDuplicateSlugs(rules: readonly RecoveryRuleDefinition[]): readonly string[] {
  const seen = new Map<string, number>();
  for (const rule of rules) seen.set(rule.slug, (seen.get(rule.slug) ?? 0) + 1);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([slug]) => slug);
}

export interface LocalizedPageResolution {
  found: boolean;
  locale: SeoLocale;
  rule: RecoveryRuleDefinition | null;
  /** 未找到时的原因（路由层据此返回 404，而不是渲染空页面）。 */
  reason: 'OK' | 'UNKNOWN_SLUG' | 'NO_EFFECTIVE_VERSION' | 'RULE_VERSION_CONFLICT';
  /** 同 slug 当前生效版本数（0/1/>1）；>1 视为冲突（要求 19）。 */
  effectiveVersions: number;
}

/**
 * 按 slug + 请求语言解析页面（要求 18/19/20）：
 *   · 请求语言不受支持 → 回落默认语言并显式告知（locale fallback policy）；
 *   · 找不到 slug（或全部已过期）→ UNKNOWN_SLUG / NO_EFFECTIVE_VERSION（上层 404）；
 *   · 同 slug 多个生效版本 → RULE_VERSION_CONFLICT（fail-closed，不猜 canonical）。
 */
export function resolveLocalizedRecoveryPage(input: {
  rules: readonly RecoveryRuleDefinition[];
  slug: string;
  requestedLocale?: string | null;
  now: Date;
}): LocalizedPageResolution {
  const locale = resolveLocaleFallback(input.requestedLocale);
  const candidates = input.rules.filter((rule) => rule.slug === input.slug);
  if (candidates.length === 0) {
    return { found: false, locale, rule: null, reason: 'UNKNOWN_SLUG', effectiveVersions: 0 };
  }
  const selection = selectCurrentlyEffectiveRecoveryRuleVersion(candidates, input.now);
  if (selection.conflict) {
    return {
      found: false,
      locale,
      rule: null,
      reason: 'RULE_VERSION_CONFLICT',
      effectiveVersions: selection.effectiveCount,
    };
  }
  if (selection.canonical === null) {
    return { found: false, locale, rule: null, reason: 'NO_EFFECTIVE_VERSION', effectiveVersions: 0 };
  }
  return { found: true, locale, rule: selection.canonical, reason: 'OK', effectiveVersions: 1 };
}

/** 站点级计划：每页一份计划 + 被排除页与重复 slug（供 sitemap / robots / 监控消费）。 */
export function planRecoverySite(input: {
  rules: readonly RecoveryRuleDefinition[];
  locale: SeoLocale;
  baseUrl: string;
  now: Date;
  registeredBasisKeys: readonly string[];
  renderMetricsBySlug?: Record<string, SeoRenderMetrics | undefined>;
}): {
  pages: readonly RecoveryPagePlan[];
  excluded: readonly { slug: string; reasons: readonly SeoIndexabilityReason[] }[];
  duplicateSlugs: readonly string[];
} {
  const pages: RecoveryPagePlan[] = [];
  const excluded: { slug: string; reasons: readonly SeoIndexabilityReason[] }[] = [];
  // 冲突必须**按 slug**判定：不同 slug 的规则本来就各自独立（此前按全局判定会把整个站点误判为冲突）。
  const conflictingSlugs = new Set(detectRecoveryRuleVersionConflicts(input.rules, input.now));

  for (const rule of input.rules) {
    const plan = planRecoveryPage({
      rule,
      locale: input.locale,
      baseUrl: input.baseUrl,
      now: input.now,
      registeredBasisKeys: input.registeredBasisKeys,
      renderMetrics: input.renderMetricsBySlug?.[rule.slug],
      // 同 slug 多个同时生效版本 → 该页 fail-closed（其余 slug 不受影响）。
      conflictingVersions: conflictingSlugs.has(rule.slug),
      canonicalExplicit: true,
    });
    if (plan.inSitemap) pages.push(plan);
    else excluded.push({ slug: rule.slug, reasons: plan.noindexReasons });
  }

  return { pages, excluded, duplicateSlugs: detectDuplicateSlugs(input.rules) };
}

/** 边界自证：页面计划层是纯计算，不写库、不外写、不绕过 Action Guard。 */
export const SEO_PAGE_PLAN_BOUNDARY = {
  externalWritePerformed: false,
  databaseWritePerformed: false,
  actionGuardBypassed: false,
  inventsRules: false,
  indexDecisionFromIndexabilityGate: true,
  productionCredentials: 'ABSENT',
} as const;
