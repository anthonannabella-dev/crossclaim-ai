/**
 * SEO-4 canonical ↔ route shape 回归测试（MSG-20261005-03 = OPTION_A）
 * ---------------------------------------------------------------
 * 这正是当初导致全站无法自指的缺陷：artifact 写出的 canonical 用了
 * `/{locale}/recover/{platform}/{recoveryType}`，而站点只服务 `/recover/{slug}`。
 * 这里把「canonical 必须与真实路由形状逐字一致」钉死，防止以后回退：
 *   · path = `/{locale}/recover/{slug}`（en 无前缀）
 *   · /recover/ 之后**只能有一段**
 *   · canonical = baseUrl + path
 *   · hreflang 也必须是同样的形状，且只声明可达语言
 */

import { describe, expect, it } from 'vitest';

import {
  buildRecoverStaticProjectionFromRules,
  type SeoRecoverExportRule,
} from '../services/seo/seo-recover-static-export';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const BASE = 'https://crossclaim.example';
const LOCALES = ['en', 'zh', 'de', 'ja', 'es'];

const rule = (over: Partial<SeoRecoverExportRule> = {}): SeoRecoverExportRule => ({
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

const expectedPath = (locale: string, slug: string): string =>
  locale === 'en' ? `/recover/${slug}` : `/${locale}/recover/${slug}`;

const artifact = buildRecoverStaticProjectionFromRules({
  rules: [rule()],
  now: NOW,
  baseUrl: BASE,
  breadcrumb: [
    { name: 'Home', url: `${BASE}/` },
    { name: 'Recover', url: `${BASE}/recover` },
  ],
});

describe('SEO-4 canonical ↔ route shape（OPTION_A 回归）', () => {
  it('CANONICAL_SHAPE_IS_SLUG_BASED：/{locale}/recover/{slug}，en 无前缀，且 /recover/ 后只有一段', () => {
    for (const page of artifact.pages) {
      expect(page.path).toBe(expectedPath(page.locale, page.slug));
      // 关键回归点：绝不能再出现 /recover/{platform}/{recoveryType} 这种两段形状。
      const segments = (page.path ?? '').split('/').filter((part) => part !== '');
      expect(segments[segments.length - 2]).toBe('recover');
      expect(segments[segments.length - 1]).toBe(page.slug);
      expect(segments.length).toBeLessThanOrEqual(3);
    }
  });

  it('CANONICAL_SELF_REFERENCES：canonical = baseUrl + path（页面能自指）', () => {
    for (const page of artifact.pages) {
      if (page.canonical === null) continue;
      expect(page.canonical).toBe(`${BASE}${page.path}`);
    }
  });

  it('HREFLANG_SAME_SHAPE_AND_REACHABLE_ONLY：hreflang 形状一致且只声明可达语言', () => {
    for (const page of artifact.pages) {
      for (const alternate of page.hreflang) {
        if (alternate.hreflang === 'x-default') continue;
        expect(LOCALES).toContain(alternate.hreflang);
        expect(alternate.href).toBe(`${BASE}${expectedPath(alternate.hreflang, page.slug)}`);
      }
      const declared = page.hreflang.filter((entry) => entry.hreflang !== 'x-default').map((entry) => entry.hreflang);
      expect(new Set(declared).size).toBe(declared.length);
    }
  });

  it('NO_PLATFORM_SEGMENT_IN_URL：platform / recoveryType 只作分类，不进 URL', () => {
    for (const page of artifact.pages) {
      expect(page.path ?? '').not.toContain('amazon/');
      expect(page.path ?? '').not.toContain('fee-refund/');
      expect((page.path ?? '').endsWith('/fee-refund')).toBe(false);
    }
  });
});
