import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * /recover 静态投影读取（MSG-20261004-35 OPTION_B_REVISED）。
 *
 * 边界：web **只读构建期 artifact**，不读规则表、不用 Prisma、不调 API（C-0008-A）。
 * fail-closed：文件缺失 / JSON 非法 / schema 版本不识别 / digest 非法 → 一律不可用，
 * 页面据此保持 noindex（绝不因为取不到数据就套模板并 index）。
 */

export const RECOVER_PROJECTION_SCHEMA = 'seo-recover-static-v1' as const;
export const RECOVER_SUPPORTED_LOCALES = ['en', 'zh', 'de', 'ja', 'es'] as const;

export interface RecoverProjectionPage {
  slug: string;
  locale: (typeof RECOVER_SUPPORTED_LOCALES)[number];
  /** SEO-5 的 canonical 路径；不可索引时为 null（页面层据此决定是否给 canonical）。 */
  path: string | null;
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
  jsonLd: readonly unknown[];
  inSitemap: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  noindexReasons: readonly string[];
}

export interface RecoverProjection {
  schema: typeof RECOVER_PROJECTION_SCHEMA;
  generatedAt: string;
  sourceDigest: string;
  pages: readonly RecoverProjectionPage[];
}

export type RecoverProjectionLoad =
  | { ok: true; projection: RecoverProjection }
  | { ok: false; reason: 'MISSING' | 'MALFORMED' | 'UNKNOWN_SCHEMA' | 'INVALID_DIGEST' };

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function projectionPath(): string {
  return process.env.RECOVER_PROJECTION_PATH ?? path.join(process.cwd(), '.generated', 'recover-projection.json');
}

export function loadRecoverProjection(filePath: string = projectionPath()): RecoverProjectionLoad {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'MISSING' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'MALFORMED' };
  const candidate = parsed as Partial<RecoverProjection>;
  if (candidate.schema !== RECOVER_PROJECTION_SCHEMA) return { ok: false, reason: 'UNKNOWN_SCHEMA' };
  if (typeof candidate.sourceDigest !== 'string' || !DIGEST_RE.test(candidate.sourceDigest)) {
    return { ok: false, reason: 'INVALID_DIGEST' };
  }
  if (!Array.isArray(candidate.pages)) return { ok: false, reason: 'MALFORMED' };
  for (const page of candidate.pages) {
    if (page === null || typeof page !== 'object') return { ok: false, reason: 'MALFORMED' };
    if (typeof page.slug !== 'string' || typeof page.ruleVersion !== 'string') return { ok: false, reason: 'MALFORMED' };
    if (!(RECOVER_SUPPORTED_LOCALES as readonly string[]).includes(String(page.locale))) {
      return { ok: false, reason: 'MALFORMED' };
    }
  }
  return { ok: true, projection: candidate as RecoverProjection };
}

/** 页面只有在 artifact 里同时满足「进 sitemap + index,follow + 无 noindex reason」才算可索引。 */
export function isProjectionPageIndexable(page: RecoverProjectionPage): boolean {
  return page.inSitemap && page.robots === 'index,follow' && page.noindexReasons.length === 0;
}
