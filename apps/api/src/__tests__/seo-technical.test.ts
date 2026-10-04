/** SEO-5 单元验收：locale / sitemap / robots / metadata / canonical / hreflang / JSON-LD。 */

import { describe, expect, it } from 'vitest';

import {
  buildAlternates,
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
  buildRecoverPath,
  buildRelatedRulesJsonLd,
  buildRobotsTxt,
  buildSeoMetadata,
  buildSitemapEntries,
  localePathSegment,
  resolveLocaleFallback,
  SEO_DEFAULT_LOCALE,
  SEO_TECHNICAL_BOUNDARY,
} from '../services/seo/seo-technical';
import type { RecoveryRuleDefinition, SeoRenderMetrics } from '../services/recovery-rules/recovery-rule-definition';

const NOW = new Date('2026-10-04T06:00:00.000Z');
const DIGEST = 'a'.repeat(64);
const BASE = 'https://crossclaim.ai';

const rule = (overrides: Partial<RecoveryRuleDefinition> = {}): RecoveryRuleDefinition => ({
  definitionVersion: 'v1',
  platform: 'CUSTOMS',
  category: 'customs',
  recoveryType: 'drawback',
  jurisdictionScope: 'COUNTRY',
  jurisdictionCodes: ['US'],
  region: null,
  title: 'US Customs drawback recovery',
  slug: 'us-customs-drawback',
  problemDescription: 'Duty paid on re-exported goods may be recoverable.',
  eligibility: {
    requiresIorIdentity: true,
    requiresAuthorizedSigner: false,
    requiresBrokerPoa: true,
    requiresFilingAuthorization: true,
    minimumEvidenceCount: 2,
  },
  eligibilityMethod: { kind: 'DECISION_TABLE', basisKey: 'engine:customs-drawback-eligibility' },
  requiredEvidence: ['evidence:entry-summary', 'evidence:export-proof'],
  calculationMethod: { kind: 'DUTY_DIFFERENCE', basisKey: 'engine:customs-duty-difference' },
  filingDeadline: { kind: 'STATUTORY', days: 90, sourceReferenceId: 'src:cfr-1900' },
  submissionMode: 'BROKER_FILED',
  feeModel: 'SUCCESS_FEE',
  supportedMode: 'ASSISTED',
  relatedRuleRefs: ['rule:customs-protest'],
  sourceReferences: [{ id: 'src:cfr-1900', label: '19 CFR 190' }],
  capabilities: { checker: true, calculator: true },
  ctaMode: 'FREE_AUDIT_THEN_START',
  ruleVersion: '2026.10.1',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  ...overrides,
});

const metrics: SeoRenderMetrics = {
  problemContentLength: 600,
  eligibilityContentLength: 600,
  evidenceContentLength: 600,
  calculationContentLength: 600,
  uniqueContentDigest: DIGEST,
  sourceBackedSections: 3,
};

const REGISTERED = ['engine:customs-drawback-eligibility', 'engine:customs-duty-difference'];

describe('SEO-5 — technical SEO builders', () => {
  it('locale：默认语言不带前缀、其它语言带前缀；fallback 回落 en', () => {
    expect(localePathSegment('en')).toBe('');
    expect(localePathSegment('zh')).toBe('/zh');
    expect(SEO_DEFAULT_LOCALE).toBe('en');
    expect(resolveLocaleFallback('ja')).toBe('ja');
    expect(resolveLocaleFallback('fr')).toBe('en');
    expect(resolveLocaleFallback(null)).toBe('en');
    expect(resolveLocaleFallback('not-a-locale')).toBe('en');
  });

  it('URL 契约：/recover/{platform} 与 /recover/{platform}/{recoveryType}，非法段返回 null', () => {
    expect(buildRecoverPath({ slug: 'customs-duty-overpayment', locale: 'en' })).toBe(
      '/recover/customs-duty-overpayment',
    );
    expect(buildRecoverPath({ slug: 'customs-duty-overpayment', locale: 'zh' })).toBe(
      '/zh/recover/customs-duty-overpayment',
    );
    expect(buildRecoverPath({ slug: 'BAD SLUG', locale: 'en' })).toBeNull();
    expect(buildRecoverPath({ slug: 'ab', locale: 'en' })).toBeNull();
  });

  it('hreflang alternates：5 语言 + x-default，且 canonical 语言自指', () => {
    const alternates = buildAlternates({ baseUrl: BASE, path: '/zh/recover/customs-drawback', canonicalLocale: 'zh' });
    expect(alternates).toHaveLength(2);
    expect(alternates.map((a) => a.hreflang)).toEqual(['zh', 'x-default']);
    expect(alternates.find((a) => a.hreflang === 'zh')?.href).toBe(`${BASE}/zh/recover/customs-drawback`);
    expect(alternates.find((a) => a.hreflang === 'x-default')?.href).toBe(`${BASE}/zh/recover/customs-drawback`);
  });

  it('STRICT_REACHABILITY：只声明传入的可达语言，未确认的可达语言一律省略', () => {
    const alternates = buildAlternates({
      baseUrl: BASE,
      path: '/recover/customs-drawback',
      canonicalLocale: 'en',
      reachableLocales: ['en', 'ja'],
    });
    expect(alternates.map((a) => a.hreflang)).toEqual(['en', 'ja', 'x-default']);
    expect(alternates.some((a) => a.hreflang === 'de')).toBe(false);
    expect(buildAlternates({ baseUrl: BASE, path: '/recover/x', reachableLocales: [] })).toEqual([]);
  });

  it('sitemap：只有通过 indexability gate 的页面才收录，未通过带原因进 excluded', () => {
    const { entries, excluded } = buildSitemapEntries({
      baseUrl: BASE,
      now: NOW,
      locale: 'en',
      registeredBasisKeys: REGISTERED,
      rules: [
        { rule: rule(), renderMetrics: metrics, lastModified: '2026-10-02T00:00:00.000Z' },
        { rule: rule({ slug: 'thin-page' }) }, // 缺 renderer 指标 → RENDER_METRICS_REQUIRED
        { rule: rule({ slug: 'expired-page', effectiveTo: '2026-10-02T00:00:00.000Z' }), renderMetrics: metrics },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toBe(`${BASE}/recover/us-customs-drawback`);
    expect(entries[0]?.lastModified).toBe('2026-10-02T00:00:00.000Z');
    expect(excluded.map((e) => e.slug).sort()).toEqual(['expired-page', 'thin-page']);
    expect(excluded.find((e) => e.slug === 'thin-page')?.reasons).toContain('RENDER_METRICS_REQUIRED');
    expect(excluded.find((e) => e.slug === 'expired-page')?.reasons).toContain('RULE_NOT_EFFECTIVE');
  });

  it('robots.txt：默认放行并指向 sitemap；可选 disallow 前缀，"/" 被忽略', () => {
    const txt = buildRobotsTxt({ baseUrl: BASE, disallowPaths: ['/app', '/api', '/'] });
    expect(txt).toBe('User-agent: *\nDisallow: /app\nDisallow: /api\nSitemap: https://crossclaim.ai/sitemap.xml\n');
    expect(buildRobotsTxt({ baseUrl: BASE })).toBe(
      'User-agent: *\nDisallow:\nSitemap: https://crossclaim.ai/sitemap.xml\n',
    );
  });

  it('metadata：canonical 自指 + robots 由 indexability 决定（noindex 绝不写 index）', () => {
    const indexable = buildSeoMetadata({ rule: rule(), locale: 'en', baseUrl: BASE, indexable: true });
    expect(indexable.canonical).toBe(`${BASE}/recover/us-customs-drawback`);
    expect(indexable.robots).toBe('index,follow');
    expect(indexable.title).toBe(rule().title);
    expect(indexable.alternates).toHaveLength(2);
    expect(indexable.openGraph.url).toBe(indexable.canonical);

    const noindex = buildSeoMetadata({ rule: rule(), locale: 'de', baseUrl: BASE, indexable: false });
    expect(noindex.robots).toBe('noindex,follow');
    expect(noindex.canonical).toBe(`${BASE}/de/recover/us-customs-drawback`);
  });

  it('JSON-LD：Breadcrumb 需要至少两级；FAQ 与 related 列表为空时返回 null（禁止虚构）', () => {
    expect(buildBreadcrumbJsonLd([{ name: 'Home', url: BASE }])).toBeNull();
    const breadcrumb = buildBreadcrumbJsonLd([
      { name: 'Home', url: BASE },
      { name: 'Customs', url: `${BASE}/recover/customs` },
      { name: rule().title, url: `${BASE}/recover/us-customs-drawback` },
    ]);
    expect(breadcrumb?.['@type']).toBe('BreadcrumbList');
    expect((breadcrumb?.itemListElement as unknown[]).length).toBe(3);

    expect(buildFaqJsonLd([])).toBeNull();
    expect(buildFaqJsonLd([{ question: '  ', answer: 'x' }])).toBeNull();
    const faq = buildFaqJsonLd([{ question: 'Who qualifies?', answer: 'Importers of record.' }]);
    expect(faq?.['@type']).toBe('FAQPage');

    expect(buildRelatedRulesJsonLd([])).toBeNull();
    const related = buildRelatedRulesJsonLd([{ name: 'Customs protest', url: `${BASE}/recover/customs/protest` }]);
    expect(related?.['@type']).toBe('ItemList');
  });

  it('边界自证：技术 SEO 层不写外部、不发明规则/FAQ/来源，index 决策来自 gate', () => {
    expect(SEO_TECHNICAL_BOUNDARY).toEqual({
      ruleSingleSource: true,
      externalWritePerformed: false,
      databaseWritePerformed: false,
      inventsRules: false,
      inventsFaq: false,
      inventsSourceReferences: false,
      indexDecisionFromIndexabilityGate: true,
      productionCredentials: 'ABSENT',
    });
  });
});
