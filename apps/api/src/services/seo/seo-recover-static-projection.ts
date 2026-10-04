/**
 * SEO-4 静态投影契约（MSG-20261004-35：OPTION_B_REVISED）
 * ---------------------------------------------------------------
 * apps/api 在**构建期**把生效规则经已验收的 codec + facade 转成最小白名单 artifact，
 * apps/web 只读这份 artifact 做 SSG。硬边界：
 *   · web 不得读规则表 / 不得用 Prisma（C-0008-A），因此这里**只允许白名单字段**；
 *   · 禁止 tenant data / organizationId / 客户账号 / 凭据 / 内部 DB id / raw RuleVersion row / PII；
 *   · 解析端 fail-closed：schema 版本不认识、digest 非法、locale 非法、出现禁用字段 → 拒绝整份 artifact。
 */

export const SEO_RECOVER_STATIC_SCHEMA = 'seo-recover-static-v1' as const;

/** 与 apps/web 已落地的 5 语言一致（web 侧只做查表，不做规则解释）。 */
export const SEO_RECOVER_STATIC_LOCALES = ['en', 'zh', 'de', 'ja', 'es'] as const;
export type SeoRecoverStaticLocale = (typeof SEO_RECOVER_STATIC_LOCALES)[number];

export interface SeoRecoverStaticPage {
  slug: string;
  locale: SeoRecoverStaticLocale;
  ruleVersion: string;
  decision: string;
  robots: string;
  canonical: string | null;
  hreflang: readonly { hreflang: string; href: string }[];
  titleRef: string | null;
  descriptionRef: string | null;
  contentSections: readonly { i18nKey: string; ref: string; sourceRef: string | null }[];
  requiredEvidence: readonly string[];
  sourceReferences: readonly string[];
  relatedLinks: readonly { name: string; url: string }[];
  jsonLd: readonly Record<string, unknown>[];
  inSitemap: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  noindexReasons: readonly string[];
}

export interface SeoRecoverStaticProjection {
  schema: typeof SEO_RECOVER_STATIC_SCHEMA;
  generatedAt: string;
  /** 64 位小写 hex，覆盖输入规则集合（与 C18 的 digest 风格一致）。 */
  sourceDigest: string;
  pages: readonly SeoRecoverStaticPage[];
}

export type SeoRecoverProjectionParseResult =
  | { ok: true; projection: SeoRecoverStaticProjection }
  | { ok: false; reason: 'UNKNOWN_SCHEMA' | 'INVALID_DIGEST' | 'MALFORMED' | 'FORBIDDEN_FIELD' };

const DIGEST_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEY_RE =
  /organizationid|organizationref|tenant|credential|secret|password|token|apikey|api_key|email|phone|ssn|accountnumber|customer/i;

/** 只允许白名单键：任何白名单之外的键都视为越界（fail-closed）。 */
const PAGE_KEYS = new Set([
  'slug',
  'locale',
  'ruleVersion',
  'decision',
  'robots',
  'canonical',
  'hreflang',
  'titleRef',
  'descriptionRef',
  'contentSections',
  'requiredEvidence',
  'sourceReferences',
  'relatedLinks',
  'jsonLd',
  'inSitemap',
  'effectiveFrom',
  'effectiveTo',
  'noindexReasons',
]);

const findForbiddenKey = (value: unknown, depth = 0): string | null => {
  if (depth > 6 || value === null || typeof value !== 'object') return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_RE.test(key)) return key;
    const hit = findForbiddenKey(nested, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
};

const extraKeys = (page: Record<string, unknown>): string[] =>
  Object.keys(page).filter((key) => !PAGE_KEYS.has(key));

export function buildRecoverStaticProjection(input: {
  pages: readonly SeoRecoverStaticPage[];
  generatedAt: Date;
  sourceDigest: string;
}): SeoRecoverStaticProjection {
  if (!DIGEST_RE.test(input.sourceDigest)) throw new Error('SOURCE_DIGEST_INVALID');
  return {
    schema: SEO_RECOVER_STATIC_SCHEMA,
    generatedAt: input.generatedAt.toISOString(),
    sourceDigest: input.sourceDigest,
    pages: input.pages,
  };
}

export function parseRecoverStaticProjection(raw: unknown): SeoRecoverProjectionParseResult {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'MALFORMED' };
  const candidate = raw as Partial<SeoRecoverStaticProjection> & { pages?: unknown };
  if (candidate.schema !== SEO_RECOVER_STATIC_SCHEMA) return { ok: false, reason: 'UNKNOWN_SCHEMA' };
  if (typeof candidate.sourceDigest !== 'string' || !DIGEST_RE.test(candidate.sourceDigest)) {
    return { ok: false, reason: 'INVALID_DIGEST' };
  }
  if (!Array.isArray(candidate.pages)) return { ok: false, reason: 'MALFORMED' };
  if (findForbiddenKey(candidate) !== null) return { ok: false, reason: 'FORBIDDEN_FIELD' };

  for (const page of candidate.pages) {
    if (page === null || typeof page !== 'object') return { ok: false, reason: 'MALFORMED' };
    const record = page as Record<string, unknown>;
    if (extraKeys(record).length > 0) return { ok: false, reason: 'FORBIDDEN_FIELD' };
    if (typeof record.slug !== 'string' || typeof record.ruleVersion !== 'string') {
      return { ok: false, reason: 'MALFORMED' };
    }
    if (!(SEO_RECOVER_STATIC_LOCALES as readonly string[]).includes(String(record.locale))) {
      return { ok: false, reason: 'MALFORMED' };
    }
  }
  return { ok: true, projection: candidate as SeoRecoverStaticProjection };
}

/** 页面只有在「进 sitemap + index,follow + 无 noindex reason」三者同时成立时才算可索引。 */
export function isProjectionPageIndexable(page: SeoRecoverStaticPage): boolean {
  return page.inSitemap && page.robots === 'index,follow' && page.noindexReasons.length === 0;
}
