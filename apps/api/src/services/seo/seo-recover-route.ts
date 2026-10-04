/**
 * SEO-4 Stage 1 — /recover 路由骨架判定（TRACK C / SEO P3）
 * ---------------------------------------------------------------
 * 纯函数层：把「请求 → 路由判定」的六种结果固定下来，供页面/Route Handler 消费。
 *
 * 硬规则：
 *   · **不硬编码任何规则**：平台、recoveryType、scheduling、截止日、费率、金额、资格全部来自调用方传入的
 *     生效 `RecoveryRuleDefinition v1` 派生字段（本模块只读 `slug / ruleVersion / platform / recoveryType /
 *     effectiveFrom / effectiveTo`），计算与门槛判定由 SEO-6 indexability gate 结果传入；
 *   · **默认 noindex**：只有 `indexable === true` 且本次判定是 `RECOVER_OK` 才输出 `index,follow`；
 *   · **零副作用**：不写库、不外写、不读凭据、不注册任何 Checker POST（`checkerPostRegistered: false`）；
 *   · 面向用户的文案一律以 **i18n key** 形式返回，页面不得内联字符串。
 */

import {
  buildAlternates,
  buildRecoverPath,
  resolveLocaleFallback,
  type SeoAlternate,
  type SeoLocale,
} from './seo-technical';

export const SEO_RECOVER_ROUTE_REASONS = [
  'RECOVER_OK',
  'RECOVER_SLUG_NOT_FOUND',
  'RECOVER_SLUG_DUPLICATE',
  'RECOVER_RULE_EXPIRED',
  'RECOVER_VERSION_CONFLICT',
  'RECOVER_LOCALE_FALLBACK',
] as const;
export type SeoRecoverRouteReason = (typeof SEO_RECOVER_ROUTE_REASONS)[number];

/** 判定所需的规则单源派生字段（由生效 RuleVersion + RecoveryRuleDefinition v1 派生，不含任何文案/费率/金额）。 */
export interface SeoRecoverRouteRule {
  slug: string;
  ruleVersion: string;
  platform: string;
  recoveryType: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** SEO-6 indexability gate 的结论（本模块不重算门槛）。 */
  indexable: boolean;
  noindexReasons: readonly string[];
}

export interface SeoRecoverRouteInput {
  slug: string | null | undefined;
  requestedLocale?: string | null;
  rules: readonly SeoRecoverRouteRule[];
  now: Date;
  /** canonical selector 判定为「同一 slug 有 >1 生效版本」的 slug 集合。 */
  conflictingSlugs?: readonly string[];
}

export interface SeoRecoverRouteDecision {
  reason: SeoRecoverRouteReason;
  status: 200 | 404 | 410;
  slug: string | null;
  locale: SeoLocale;
  localeFallbackApplied: boolean;
  ruleVersion: string | null;
  path: string | null;
  indexable: boolean;
  robots: 'index,follow' | 'noindex,nofollow';
  noindexReasons: readonly string[];
  /** 只给 key；页面文案必须查 i18n 表。 */
  i18nKeys: readonly string[];
  externalWritePerformed: false;
  databaseWritePerformed: false;
  transportEnabled: false;
  checkerPostRegistered: false;
  productionCredentials: 'ABSENT';
}

const SLUG_RE = /^[a-z][a-z0-9-]{2,63}$/;

const base = (
  reason: SeoRecoverRouteReason,
  partial: Partial<SeoRecoverRouteDecision> & Pick<SeoRecoverRouteDecision, 'status' | 'slug' | 'locale'>,
): SeoRecoverRouteDecision => ({
  reason,
  status: partial.status,
  slug: partial.slug,
  locale: partial.locale,
  localeFallbackApplied: partial.localeFallbackApplied ?? false,
  ruleVersion: partial.ruleVersion ?? null,
  path: partial.path ?? null,
  indexable: partial.indexable ?? false,
  robots: partial.indexable === true ? 'index,follow' : 'noindex,nofollow',
  noindexReasons: partial.noindexReasons ?? [],
  i18nKeys: partial.i18nKeys ?? [],
  externalWritePerformed: false,
  databaseWritePerformed: false,
  transportEnabled: false,
  checkerPostRegistered: false,
  productionCredentials: 'ABSENT',
});

const isExpired = (rule: SeoRecoverRouteRule, now: Date): boolean =>
  rule.effectiveTo !== null && Date.parse(rule.effectiveTo) <= now.getTime();

/** 站点级保护：同一 slug 出现多个版本 → 该 slug 一律不可用（不进 sitemap、noindex、无 canonical）。 */
export function detectDuplicateRouteSlugs(rules: readonly SeoRecoverRouteRule[]): readonly string[] {
  const seen = new Map<string, number>();
  for (const rule of rules) seen.set(rule.slug, (seen.get(rule.slug) ?? 0) + 1);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([slug]) => slug).sort();
}

/**
 * 请求 → 判定。顺序固定：非法 slug → 未注册 → 重复 slug → 版本冲突 → 过期 → locale fallback → OK。
 * 不可用一律走同一 404（不泄露注册表，也不按 slug 是否存在区分响应形状）。
 */
export function resolveRecoverRoute(input: SeoRecoverRouteInput): SeoRecoverRouteDecision {
  const requestedLocale = typeof input.requestedLocale === 'string' ? input.requestedLocale : null;
  const locale = resolveLocaleFallback(requestedLocale);
  const localeFallbackApplied = requestedLocale !== null && requestedLocale !== locale;
  const slug = typeof input.slug === 'string' ? input.slug : null;

  if (slug === null || !SLUG_RE.test(slug)) {
    return base('RECOVER_SLUG_NOT_FOUND', { status: 404, slug, locale, i18nKeys: ['recover.error.notFound'] });
  }

  const versions = input.rules.filter((rule) => rule.slug === slug);
  if (versions.length === 0) {
    return base('RECOVER_SLUG_NOT_FOUND', { status: 404, slug, locale, i18nKeys: ['recover.error.notFound'] });
  }
  if (detectDuplicateRouteSlugs(input.rules).includes(slug)) {
    return base('RECOVER_SLUG_DUPLICATE', { status: 404, slug, locale, i18nKeys: ['recover.error.unavailable'] });
  }
  if ((input.conflictingSlugs ?? []).includes(slug)) {
    return base('RECOVER_VERSION_CONFLICT', {
      status: 404,
      slug,
      locale,
      noindexReasons: ['VERSION_CONFLICT'],
      i18nKeys: ['recover.error.unavailable'],
    });
  }

  const rule = versions[0]!;
  if (isExpired(rule, input.now)) {
    return base('RECOVER_RULE_EXPIRED', {
      status: 410,
      slug,
      locale,
      localeFallbackApplied,
      ruleVersion: rule.ruleVersion,
      noindexReasons: ['RULE_EXPIRED'],
      i18nKeys: ['recover.notice.expired'],
    });
  }

  const path = buildRecoverPath({
    platform: rule.platform.toLowerCase(),
    recoveryType: rule.recoveryType,
    locale,
  });
  const reason: SeoRecoverRouteReason = localeFallbackApplied ? 'RECOVER_LOCALE_FALLBACK' : 'RECOVER_OK';
  const indexable = rule.indexable && reason === 'RECOVER_OK';

  return base(reason, {
    status: 200,
    slug,
    locale,
    localeFallbackApplied,
    ruleVersion: rule.ruleVersion,
    path: path === null || path === '' ? null : path,
    indexable,
    noindexReasons: indexable ? [] : [...rule.noindexReasons],
    i18nKeys: [
      'recover.page.title',
      'recover.page.eligibilityHeading',
      'recover.page.deadlineHeading',
      'recover.page.estimateDisclaimer',
      'recover.cta.checker',
    ],
  });
}

/** 边界自证：Stage 1 的骨架不注册任何 Checker POST，也不产生外写/传输/凭据使用。 */
export const SEO_RECOVER_ROUTE_BOUNDARY = {
  stageOneReasons: SEO_RECOVER_ROUTE_REASONS,
  checkerPostRegistered: false,
  publicCheckerHttp: 'HOLD',
  externalWritePerformed: false,
  databaseWritePerformed: false,
  transportEnabled: false,
  productionCredentials: 'ABSENT',
  defaultRobots: 'noindex,nofollow',
} as const;

/** SEO-4 Stage 2 —— gate 驱动的 metadata（默认 noindex；unavailable 页面不给 canonical / hreflang）。 */
export interface SeoRecoverRouteMetadataInput {
  decision: SeoRecoverRouteDecision;
  baseUrl: string;
  /**
   * 页面标题/描述的**来源引用**（来自生效 RecoveryRuleDefinition v1 的字段名或 i18n key）。
   * 为空即代表「本页没有可用的真实文案」——此时不生成，绝不发明描述。
   */
  titleRef?: string | null;
  descriptionRef?: string | null;
}

export interface SeoRecoverRouteMetadata {
  reason: SeoRecoverRouteReason;
  robots: 'index,follow' | 'noindex,nofollow';
  canonical: string | null;
  alternates: readonly SeoAlternate[];
  titleRef: string | null;
  descriptionRef: string | null;
  i18nKeys: readonly string[];
  externalWritePerformed: false;
  databaseWritePerformed: false;
  transportEnabled: false;
  checkerPostRegistered: false;
  productionCredentials: 'ABSENT';
}

/**
 * metadata 只由「判定结果 + 生效规则字段」派生：
 *   · robots 直接继承判定（默认 noindex）；
 *   · canonical / hreflang 只在 `indexable && path != null` 时输出，404/410/冲突页一律不给，
 *     避免把不可用页面标成可索引或互相 hreflang；
 *   · 标题/描述只接受调用方给出的真实来源引用，缺省即 null（不填充发明文案）。
 */
export function buildRecoverRouteMetadata(input: SeoRecoverRouteMetadataInput): SeoRecoverRouteMetadata {
  const decision = input.decision;
  const canonicalizable = decision.indexable && decision.path !== null;
  const base = input.baseUrl.replace(/\/+$/, '');

  return {
    reason: decision.reason,
    robots: decision.robots,
    canonical: canonicalizable ? `${base}${decision.path}` : null,
    alternates: canonicalizable
      ? buildAlternates({ baseUrl: input.baseUrl, path: decision.path!, canonicalLocale: decision.locale })
      : [],
    titleRef: input.titleRef ?? null,
    descriptionRef: input.descriptionRef ?? null,
    i18nKeys: decision.i18nKeys,
    externalWritePerformed: false,
    databaseWritePerformed: false,
    transportEnabled: false,
    checkerPostRegistered: false,
    productionCredentials: 'ABSENT',
  };
}
