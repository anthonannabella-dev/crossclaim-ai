/**
 * SEO-4 Stage 1 验收 —— /recover 路由骨架的六条命名用例（SEO-4-RECOVER-WIRING-PLAN.md §5）。
 * 全部只消费生效 RuleVersion + RecoveryRuleDefinition v1 的派生字段与 SEO-6 门槛结论；
 * 测试里出现的日期/版本只用于构造输入，任何 eligibility / deadline / calculation / fee / recovery amount
 * 都不在代码或断言中硬编码（本文件按正则自查）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildRecoverSitemapAndRobots,
  buildRecoverRouteMetadata,
  buildRecoverRouteJsonLd,
  SEO_RECOVER_ROUTE_BOUNDARY,
  detectDuplicateRouteSlugs,
  resolveRecoverRoute,
  type SeoRecoverRouteRule,
} from '../services/seo/seo-recover-route';

const NOW = new Date('2026-10-04T12:00:00.000Z');

const rule = (over: Partial<SeoRecoverRouteRule> = {}): SeoRecoverRouteRule => ({
  slug: 'amazon-fba-fee-refund',
  ruleVersion: 'amazon-fba-fee-refund@v1.0.0',
  platform: 'AMAZON',
  // recoveryType 在路径里必须是小写 slug 形状（与 SEO-5 buildRecoverPath 的约束一致）。
  recoveryType: 'fee-refund',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  indexable: true,
  noindexReasons: [],
  ...over,
});

const input = (over: Partial<Parameters<typeof resolveRecoverRoute>[0]> = {}) => ({
  slug: 'amazon-fba-fee-refund',
  requestedLocale: 'en',
  rules: [rule()],
  now: NOW,
  ...over,
});

describe('SEO-4 Stage 1 /recover 路由骨架', () => {
  it('RECOVER_SLUG_NOT_FOUND：未注册或非法 slug → 统一 404、noindex、不泄露注册表', () => {
    const missing = resolveRecoverRoute(input({ slug: 'nope-nothing-here' }));
    expect(missing.reason).toBe('RECOVER_SLUG_NOT_FOUND');
    expect(missing.status).toBe(404);
    expect(missing.robots).toBe('noindex,nofollow');
    expect(missing.indexable).toBe(false);
    expect(missing.path).toBeNull();
    expect(missing.i18nKeys).toEqual(['recover.error.notFound']);

    // 非法形状与「未注册」返回同一形状（不按注册表做 fingerprinting）。
    const illegal = resolveRecoverRoute(input({ slug: '../etc/passwd' }));
    expect(illegal.reason).toBe('RECOVER_SLUG_NOT_FOUND');
    expect(illegal.status).toBe(missing.status);
    expect(illegal.i18nKeys).toEqual(missing.i18nKeys);
  });

  it('RECOVER_SLUG_DUPLICATE：同一 slug 多版本 → fail-closed（404、noindex、无 canonical）', () => {
    const duplicated = [
      rule({ ruleVersion: 'a@v1' }),
      rule({ ruleVersion: 'a@v2', effectiveFrom: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(detectDuplicateRouteSlugs(duplicated)).toEqual(['amazon-fba-fee-refund']);

    const decision = resolveRecoverRoute(input({ rules: duplicated }));
    expect(decision.reason).toBe('RECOVER_SLUG_DUPLICATE');
    expect(decision.status).toBe(404);
    expect(decision.robots).toBe('noindex,nofollow');
    expect(decision.path).toBeNull();
    expect(decision.ruleVersion).toBeNull();
  });

  it('RECOVER_RULE_EXPIRED：生效窗口已结束 → 410、noindex、不进 sitemap', () => {
    const decision = resolveRecoverRoute(
      input({ rules: [rule({ effectiveTo: '2026-09-01T00:00:00.000Z' })] }),
    );
    expect(decision.reason).toBe('RECOVER_RULE_EXPIRED');
    expect(decision.status).toBe(410);
    expect(decision.robots).toBe('noindex,nofollow');
    expect(decision.indexable).toBe(false);
    expect(decision.noindexReasons).toContain('RULE_EXPIRED');
    expect(decision.i18nKeys).toEqual(['recover.notice.expired']);
  });

  it('RECOVER_VERSION_CONFLICT：canonical selector 判 >1 生效版本 → 与 DUPLICATE 同口径 fail-closed', () => {
    const decision = resolveRecoverRoute(
      input({ conflictingSlugs: ['amazon-fba-fee-refund'] }),
    );
    expect(decision.reason).toBe('RECOVER_VERSION_CONFLICT');
    expect(decision.status).toBe(404);
    expect(decision.robots).toBe('noindex,nofollow');
    expect(decision.noindexReasons).toContain('VERSION_CONFLICT');
    expect(decision.path).toBeNull();
  });

  it('RECOVER_LOCALE_FALLBACK：缺失语言回退默认语言 → 200、noindex、输出 hreflang 所需 locale', () => {
    const decision = resolveRecoverRoute(input({ requestedLocale: 'fr' }));
    expect(decision.reason).toBe('RECOVER_LOCALE_FALLBACK');
    expect(decision.status).toBe(200);
    expect(decision.locale).toBe('en');
    expect(decision.localeFallbackApplied).toBe(true);
    // gate 通过也只允许 RECOVER_OK 进 index；fallback 页保持 noindex。
    expect(decision.indexable).toBe(false);
    expect(decision.robots).toBe('noindex,nofollow');
    expect(decision.path).not.toBeNull();

    // 支持的语言且无冲突 → OK：此时才由 gate 决定 index。
    const ok = resolveRecoverRoute(input({ requestedLocale: 'de' }));
    expect(ok.reason).toBe('RECOVER_OK');
    expect(ok.locale).toBe('de');
    expect(ok.indexable).toBe(true);
    expect(ok.robots).toBe('index,follow');
  });

  it('RECOVER_NO_CHECKER_HTTP：骨架不注册任何 Checker POST，也不产生外写/传输/凭据使用', () => {
    expect(SEO_RECOVER_ROUTE_BOUNDARY.checkerPostRegistered).toBe(false);
    expect(SEO_RECOVER_ROUTE_BOUNDARY.publicCheckerHttp).toBe('HOLD');
    expect(SEO_RECOVER_ROUTE_BOUNDARY.defaultRobots).toBe('noindex,nofollow');

    for (const candidate of [
      resolveRecoverRoute(input()),
      resolveRecoverRoute(input({ slug: 'nope-nothing-here' })),
      resolveRecoverRoute(input({ rules: [] })),
    ]) {
      expect(candidate.checkerPostRegistered).toBe(false);
      expect(candidate.externalWritePerformed).toBe(false);
      expect(candidate.databaseWritePerformed).toBe(false);
      expect(candidate.transportEnabled).toBe(false);
      expect(candidate.productionCredentials).toBe('ABSENT');
      // 页面不允许内联文案：只能给 i18n key。
      for (const key of candidate.i18nKeys) expect(key).toMatch(/^recover\.[A-Za-z.]+$/);
    }
  });
});

describe('SEO-4 Stage 2 metadata（gate 驱动，默认 noindex）', () => {
  const BASE = 'https://crossclaim.example';

  it('RECOVER_METADATA_NOINDEX_DEFAULT：不可用与 fallback 页面一律 noindex，且不给 canonical/hreflang', () => {
    const cases = [
      resolveRecoverRoute(input({ slug: 'nope-nothing-here' })),
      resolveRecoverRoute(input({ rules: [rule({ effectiveTo: '2026-09-01T00:00:00.000Z' })] })),
      resolveRecoverRoute(input({ requestedLocale: 'fr' })),
    ];
    for (const decision of cases) {
      const meta = buildRecoverRouteMetadata({ decision, baseUrl: BASE });
      expect(meta.robots).toBe('noindex,nofollow');
      expect(meta.canonical).toBeNull();
      expect(meta.alternates).toEqual([]);
      // 不带来源引用时不得发明标题/描述。
      expect(meta.titleRef).toBeNull();
      expect(meta.descriptionRef).toBeNull();
    }
  });

  it('RECOVER_METADATA_CANONICAL_ONLY_WHEN_INDEXABLE：只有 indexable 的 OK 页才有 canonical', () => {
    const ok = resolveRecoverRoute(input({ requestedLocale: 'de' }));
    const meta = buildRecoverRouteMetadata({ decision: ok, baseUrl: BASE, titleRef: 'rule.title' });
    expect(meta.robots).toBe('index,follow');
    expect(meta.canonical).toBe(`${BASE}${ok.path}`);
    expect(meta.titleRef).toBe('rule.title');
    expect(meta.descriptionRef).toBeNull();

    // gate 未通过的页面（indexable=false）→ 即便 REASON 是 OK 也不给 canonical。
    const gatedOut = resolveRecoverRoute(input({ rules: [rule({ indexable: false, noindexReasons: ['THIN_CONTENT'] })] }));
    const gatedMeta = buildRecoverRouteMetadata({ decision: gatedOut, baseUrl: BASE });
    expect(gatedMeta.robots).toBe('noindex,nofollow');
    expect(gatedMeta.canonical).toBeNull();
    expect(gatedMeta.alternates).toEqual([]);
  });

  it('RECOVER_METADATA_ALTERNATES_X_DEFAULT：可索引页给出 5 语言 hreflang + x-default；不可索引页没有', () => {
    const ok = resolveRecoverRoute(input({ requestedLocale: 'ja' }));
    const meta = buildRecoverRouteMetadata({ decision: ok, baseUrl: BASE });
    const langs = meta.alternates.map((a) => a.hreflang);
    expect(langs).toEqual(['en', 'zh', 'de', 'ja', 'es', 'x-default']);
    expect(meta.alternates.find((a) => a.hreflang === 'x-default')?.href).toBe(`${BASE}${ok.path}`);
    for (const alternate of meta.alternates) expect(alternate.href.startsWith(BASE)).toBe(true);
  });
});

describe('SEO-4 Stage 3 JSON-LD（只由真实来源生成）', () => {
  const breadcrumb = [
    { name: 'Home', url: 'https://crossclaim.example/' },
    { name: 'Recover', url: 'https://crossclaim.example/recover' },
  ];

  it('RECOVER_JSONLD_NONE_WHEN_NOT_INDEXABLE：不可索引 / 冲突页不输出任何结构化数据', () => {
    const notFound = resolveRecoverRoute(input({ slug: 'nope-nothing-here' }));
    const missing = buildRecoverRouteJsonLd({ decision: notFound, sourceReferences: ['src:x'], breadcrumb });
    expect(missing.blocks).toEqual([]);
    expect(missing.skipped).toContain('NOT_INDEXABLE');

    const gatedOut = resolveRecoverRoute(input({ rules: [rule({ indexable: false })] }));
    const gated = buildRecoverRouteJsonLd({ decision: gatedOut, sourceReferences: ['src:x'], breadcrumb });
    expect(gated.blocks).toEqual([]);
    expect(gated.skipped).toContain('NOT_INDEXABLE');
  });

  it('RECOVER_JSONLD_ONLY_REAL_SOURCES：没有真实 sourceReferences → 一律不生成', () => {
    const ok = resolveRecoverRoute(input({ requestedLocale: 'en' }));
    const noSources = buildRecoverRouteJsonLd({ decision: ok, sourceReferences: [], breadcrumb });
    expect(noSources.blocks).toEqual([]);
    expect(noSources.skipped).toContain('NO_SOURCE_REFERENCES');

    const withSources = buildRecoverRouteJsonLd({ decision: ok, sourceReferences: ['src:statute-1'], breadcrumb });
    expect(withSources.blocks.length).toBeGreaterThan(0);
    expect(withSources.skipped).not.toContain('NO_SOURCE_REFERENCES');
  });

  it('RECOVER_JSONLD_NO_FAQ_WITHOUT_FAQ：没有真实 FAQ 就不出现 FAQPage', () => {
    const ok = resolveRecoverRoute(input({ requestedLocale: 'en' }));
    const decision = buildRecoverRouteJsonLd({ decision: ok, sourceReferences: ['src:statute-1'], breadcrumb });
    expect(decision.skipped).toContain('NO_FAQ');
    const types = decision.blocks.map((block) => String(block['@type'] ?? ''));
    expect(types).not.toContain('FAQPage');

    const withFaq = buildRecoverRouteJsonLd({
      decision: ok,
      sourceReferences: ['src:statute-1'],
      breadcrumb,
      faqs: [{ question: 'Is this an estimate?', answer: 'Yes - estimates are labelled as estimates.' }],
    });
    expect(withFaq.skipped).not.toContain('NO_FAQ');
    expect(withFaq.blocks.map((block) => String(block['@type'] ?? ''))).toContain('FAQPage');
  });
});

describe('SEO-4 Stage 4 sitemap / robots 一致性', () => {
  const BASE = 'https://crossclaim.example';

  it('RECOVER_SITEMAP_ONLY_GATE_PASSING：只有 indexable 的 200 页进 sitemap，其余记录原因', () => {
    const indexable = resolveRecoverRoute(input({ requestedLocale: 'en' }));
    const gateWithheld = resolveRecoverRoute(input({ rules: [rule({ indexable: false })] }));
    const expired = resolveRecoverRoute(input({ rules: [rule({ effectiveTo: '2026-09-01T00:00:00.000Z' })] }));
    const fallback = resolveRecoverRoute(input({ requestedLocale: 'fr' }));

    const site = buildRecoverSitemapAndRobots({
      decisions: [indexable, gateWithheld, expired, fallback],
      baseUrl: BASE,
    });

    expect(site.entries.map((entry) => entry.loc)).toEqual([`${BASE}${indexable.path}`]);
    expect(site.excluded.map((entry) => entry.reason)).toEqual([
      'NOT_INDEXABLE',
      'NOT_INDEXABLE',
      'NOT_INDEXABLE',
    ]);
    expect(site.consistency.conflictCount).toBe(0);
    expect(site.robotsTxt).toContain(`Sitemap: ${site.sitemapLoc}`);
    // robots 不包含任何被排除的路径（避免与 sitemap 矛盾）。
    for (const excluded of site.excluded) expect(excluded.slug === null || !site.robotsTxt.includes(excluded.slug)).toBe(true);
  });

  it('RECOVER_ROBOTS_DISALLOW_REMOVES_SITEMAP_ENTRY：robots 禁止的路径绝不进 sitemap（一致优先）', () => {
    const indexable = resolveRecoverRoute(input({ requestedLocale: 'en' }));
    const site = buildRecoverSitemapAndRobots({
      decisions: [indexable],
      baseUrl: BASE,
      disallowPaths: ['/recover'],
    });

    expect(site.entries).toEqual([]);
    expect(site.excluded).toEqual([{ slug: indexable.slug, reason: 'ROBOTS_DISALLOW' }]);
    expect(site.robotsTxt).toContain('Disallow: /recover');
    expect(site.consistency.conflictCount).toBe(0);
  });
});
