/** SEO-4 静态投影导出验收（MSG-20261004-35 OPTION_B_REVISED，apps/api 侧）。 */

import { describe, expect, it } from 'vitest';

import {
  buildRecoverStaticProjectionFromRules,
  computeRecoverSourceDigest,
  type SeoRecoverExportRule,
} from '../services/seo/seo-recover-static-export';
import { isProjectionPageIndexable, parseRecoverStaticProjection } from '../services/seo/seo-recover-static-projection';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const BASE = 'https://crossclaim.example';

const richRule = (over: Partial<SeoRecoverExportRule> = {}): SeoRecoverExportRule => ({
  slug: 'amazon-fba-fee-refund',
  ruleVersion: 'amazon-fba-fee-refund@v1.0.0',
  platform: 'AMAZON',
  recoveryType: 'fee-refund',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  indexable: true,
  noindexReasons: [],
  title: 'Amazon FBA fee refund',
  problemDescription:
    'FBA fee overcharges can be refunded when the fee was computed against incorrect dimensions or weight, within the dispute window defined by the effective rule version.',
  requiredEvidence: ['settlement report line', 'fee preview versus charged comparison'],
  sourceReferences: ['src:amazon-fba-fee-policy'],
  relatedRuleRefs: ['amazon-inventory-reimbursement'],
  ...over,
});

describe('SEO-4 静态投影导出', () => {
  it('RECOVER_EXPORT_WHITELIST_SELF_VALIDATES：导出即自校验，产物可被解析且只含白名单字段', () => {
    const artifact = buildRecoverStaticProjectionFromRules({
      rules: [richRule()],
      now: NOW,
      baseUrl: BASE,
      breadcrumb: [
        { name: 'Home', url: `${BASE}/` },
        { name: 'Recover', url: `${BASE}/recover` },
      ],
    });
    const parsed = parseRecoverStaticProjection(artifact);
    expect(parsed.ok).toBe(true);
    // 5 语言 parity：每个规则在 5 个 locale 下各生成一页
    expect(artifact.pages.map((page) => page.locale)).toEqual(['en', 'zh', 'de', 'ja', 'es']);
    expect(new Set(artifact.pages.map((page) => page.slug)).size).toBe(1);
    for (const page of artifact.pages) {
      expect(Object.keys(page).sort()).toEqual(
        [
          'canonical',
          'contentSections',
          'decision',
          'descriptionRef',
          'effectiveFrom',
          'effectiveTo',
          'hreflang',
          'inSitemap',
          'jsonLd',
          'locale',
          'noindexReasons',
          'path',
          'relatedLinks',
          'requiredEvidence',
          'robots',
          'ruleVersion',
          'slug',
          'sourceReferences',
          'titleRef',
        ].sort(),
      );
      // 5 个受支持语言都命中 OK（不是 fallback），并且各自有自己的 canonical 与完整 hreflang。
      expect(page.decision).toBe('RECOVER_OK');
      expect(isProjectionPageIndexable(page)).toBe(true);
      expect(page.canonical).not.toBeNull();
      expect(page.hreflang.map((entry) => entry.hreflang)).toEqual(['en', 'zh', 'de', 'ja', 'es', 'x-default']);
    }
  });

  it('RECOVER_EXPORT_DIGEST_STABLE_AND_ORDER_INDEPENDENT：digest 覆盖规则集合且与顺序无关', () => {
    const a = richRule();
    const b = richRule({ slug: 'amazon-inventory-reimbursement', ruleVersion: 'a@v1' });
    expect(computeRecoverSourceDigest([a, b])).toBe(computeRecoverSourceDigest([b, a]));
    expect(computeRecoverSourceDigest([a, b])).not.toBe(computeRecoverSourceDigest([a]));
    expect(computeRecoverSourceDigest([a, b])).toMatch(/^[0-9a-f]{64}$/);

    const artifact = buildRecoverStaticProjectionFromRules({ rules: [a, b], now: NOW, baseUrl: BASE });
    expect(artifact.sourceDigest).toBe(computeRecoverSourceDigest([a, b]));
    expect(parseRecoverStaticProjection(artifact).ok).toBe(true);
  });

  it('RECOVER_EXPORT_FAILS_CLOSED_WHEN_THIN：薄内容规则导出后仍不可索引，且不进 sitemap', () => {
    const artifact = buildRecoverStaticProjectionFromRules({
      rules: [richRule({ problemDescription: '', requiredEvidence: [], sourceReferences: [] })],
      now: NOW,
      baseUrl: BASE,
    });
    for (const page of artifact.pages) {
      expect(isProjectionPageIndexable(page)).toBe(false);
      expect(page.inSitemap).toBe(false);
      expect(page.canonical).toBeNull();
      expect(page.jsonLd).toEqual([]);
      expect(page.contentSections).toEqual([]);
    }
  });
});
