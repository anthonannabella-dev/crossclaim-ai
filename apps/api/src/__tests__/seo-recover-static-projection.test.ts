/**
 * SEO-4 静态投影契约验收（MSG-20261004-35 / OPTION_B_REVISED）：
 *   · artifact 版本化 + sourceDigest；
 *   · 白名单：出现 tenant / organizationId / 凭据 / PII / 不在白名单的键 → 整份拒绝；
 *   · schema 版本不认识、digest 非法、locale 非法 → fail-closed；
 *   · 页面可索引必须三条件同时成立。
 */

import { describe, expect, it } from 'vitest';

import {
  SEO_RECOVER_STATIC_SCHEMA,
  buildRecoverStaticProjection,
  isProjectionPageIndexable,
  parseRecoverStaticProjection,
  type SeoRecoverStaticPage,
} from '../services/seo/seo-recover-static-projection';

const DIGEST = 'd'.repeat(64);

const page = (over: Partial<SeoRecoverStaticPage> = {}): SeoRecoverStaticPage => ({
  slug: 'amazon-fba-fee-refund',
  locale: 'en',
  path: '/recover/amazon/fee-refund',
  ruleVersion: 'amazon-fba-fee-refund@v1.0.0',
  decision: 'RECOVER_OK',
  robots: 'noindex,nofollow',
  canonical: null,
  hreflang: [],
  titleRef: null,
  descriptionRef: null,
  contentSections: [],
  requiredEvidence: [],
  sourceReferences: ['src:amazon-fba-fee-policy'],
  relatedLinks: [],
  jsonLd: [],
  inSitemap: false,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  noindexReasons: ['THIN_CONTENT'],
  ...over,
});

describe('SEO-4 静态投影契约', () => {
  it('RECOVER_PROJECTION_SCHEMA_VERSIONED_AND_DIGESTED：artifact 带版本与 64-hex digest', () => {
    const projection = buildRecoverStaticProjection({
      pages: [page()],
      generatedAt: new Date('2026-10-05T00:00:00.000Z'),
      sourceDigest: DIGEST,
    });
    expect(projection.schema).toBe(SEO_RECOVER_STATIC_SCHEMA);
    expect(projection.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(projection.generatedAt).toBe('2026-10-05T00:00:00.000Z');
    expect(parseRecoverStaticProjection(projection).ok).toBe(true);

    expect(() =>
      buildRecoverStaticProjection({ pages: [page()], generatedAt: new Date(), sourceDigest: 'not-a-digest' }),
    ).toThrow();
  });

  it('RECOVER_PROJECTION_REJECTS_FORBIDDEN_FIELDS：tenant / organizationId / 凭据 / PII / 白名单外键一律拒绝', () => {
    const base = buildRecoverStaticProjection({ pages: [page()], generatedAt: new Date(), sourceDigest: DIGEST });
    const withTenant = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    (withTenant.pages as Record<string, unknown>[])[0]!.organizationId = 'org_123';
    expect(parseRecoverStaticProjection(withTenant)).toEqual({ ok: false, reason: 'FORBIDDEN_FIELD' });

    const withCredential = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    (withCredential.pages as Record<string, unknown>[])[0]!.credentialReference = 'credref:slot-1';
    expect(parseRecoverStaticProjection(withCredential)).toEqual({ ok: false, reason: 'FORBIDDEN_FIELD' });

    // 白名单之外的（即便人畜无害）键也必须拒绝，避免逐步把内部行 dump 出来。
    const withExtraKey = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    (withExtraKey.pages as Record<string, unknown>[])[0]!.internalNote = 'x';
    expect(parseRecoverStaticProjection(withExtraKey)).toEqual({ ok: false, reason: 'FORBIDDEN_FIELD' });
  });

  it('RECOVER_PROJECTION_UNKNOWN_SCHEMA_FAILS_CLOSED：schema 版本不认识 → 拒绝整份 artifact', () => {
    const projection = buildRecoverStaticProjection({ pages: [page()], generatedAt: new Date(), sourceDigest: DIGEST });
    const mutated = { ...projection, schema: 'seo-recover-static-v2' } as unknown;
    expect(parseRecoverStaticProjection(mutated)).toEqual({ ok: false, reason: 'UNKNOWN_SCHEMA' });

    const badDigest = { ...projection, sourceDigest: 'zz' } as unknown;
    expect(parseRecoverStaticProjection(badDigest)).toEqual({ ok: false, reason: 'INVALID_DIGEST' });

    // locale 不在 5 语言内 → MALFORMED（不会静默回退成默认语言）。
    const badLocale = JSON.parse(JSON.stringify(projection)) as Record<string, unknown>;
    (badLocale.pages as Record<string, unknown>[])[0]!.locale = 'fr';
    expect(parseRecoverStaticProjection(badLocale)).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('RECOVER_PROJECTION_INDEXABLE_REQUIRES_ALL_FLAGS：三条件同时成立才可索引', () => {
    expect(isProjectionPageIndexable(page())).toBe(false);
    expect(
      isProjectionPageIndexable(page({ robots: 'index,follow', inSitemap: false, noindexReasons: [] })),
    ).toBe(false);
    expect(
      isProjectionPageIndexable(page({ robots: 'index,follow', inSitemap: true, noindexReasons: ['THIN_CONTENT'] })),
    ).toBe(false);
    expect(isProjectionPageIndexable(page({ robots: 'index,follow', inSitemap: true, noindexReasons: [] }))).toBe(true);
  });
});
