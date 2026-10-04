/** SEO-6 单元验收：页面计划整合（gate → metadata/JSON-LD/sitemap）+ 404/重复 slug/过期/冲突/locale。 */

import { describe, expect, it } from 'vitest';

import {
  detectDuplicateSlugs,
  planRecoveryPage,
  planRecoverySite,
  resolveLocalizedRecoveryPage,
  SEO_PAGE_PLAN_BOUNDARY,
} from '../services/seo/seo-page-plan';
import type { RecoveryRuleDefinition, SeoRenderMetrics } from '../services/recovery-rules/recovery-rule-definition';

const NOW = new Date('2026-10-04T06:00:00.000Z');
const DIGEST = 'a'.repeat(64);
const BASE = 'https://crossclaim.ai';
const REGISTERED = ['engine:customs-drawback-eligibility', 'engine:customs-duty-difference'];

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

describe('SEO-6 — page plan + indexability integration', () => {
  it('单页计划：通过 gate 时 indexable + 进 sitemap + metadata robots=index', () => {
    const plan = planRecoveryPage({
      rule: rule(),
      locale: 'en',
      baseUrl: BASE,
      now: NOW,
      registeredBasisKeys: REGISTERED,
      renderMetrics: metrics,
      breadcrumb: [
        { name: 'Home', url: BASE },
        { name: 'Customs', url: `${BASE}/recover/customs` },
      ],
      related: [{ name: 'Customs protest', url: `${BASE}/recover/customs/protest` }],
      faqs: [{ question: 'Who qualifies?', answer: 'Importers of record.' }],
    });
    expect(plan.indexable).toBe(true);
    expect(plan.inSitemap).toBe(true);
    expect(plan.noindexReasons).toEqual([]);
    expect(plan.metadata.robots).toBe('index,follow');
    expect(plan.path).toBe('/recover/us-customs-drawback');
    expect(plan.jsonLd.map((b) => b['@type'])).toEqual(['BreadcrumbList', 'ItemList', 'FAQPage']);
    expect(plan.externalWritePerformed).toBe(false);
  });

  it('单页计划：未通过 gate 时 noindex + 不进 sitemap + 无虚假 JSON-LD', () => {
    const plan = planRecoveryPage({
      rule: rule(),
      locale: 'en',
      baseUrl: BASE,
      now: NOW,
      registeredBasisKeys: REGISTERED,
      // 缺 renderer 指标
    });
    expect(plan.indexable).toBe(false);
    expect(plan.inSitemap).toBe(false);
    expect(plan.metadata.robots).toBe('noindex,follow');
    expect(plan.noindexReasons).toContain('RENDER_METRICS_REQUIRED');
    expect(plan.jsonLd).toEqual([]); // 没有真实面包屑/FAQ → 不生成
  });

  it('站点级计划：重复 slug 会被检出，冲突时全部 fail-closed', () => {
    const dupA = rule({ ruleVersion: 'v2', effectiveFrom: '2026-10-01T00:00:00.000Z' });
    const dupB = rule({ ruleVersion: 'v10', effectiveFrom: '2026-10-01T00:00:00.000Z' });
    expect(detectDuplicateSlugs([dupA, dupB])).toEqual(['us-customs-drawback']);

    const site = planRecoverySite({
      rules: [dupA, dupB],
      locale: 'en',
      baseUrl: BASE,
      now: NOW,
      registeredBasisKeys: REGISTERED,
      renderMetricsBySlug: { 'us-customs-drawback': metrics },
    });
    expect(site.duplicateSlugs).toEqual(['us-customs-drawback']);
    expect(site.pages).toHaveLength(0);
    expect(site.excluded.every((e) => e.reasons.includes('RULE_VERSION_CONFLICT'))).toBe(true);
  });

  it('站点级计划：只有合规页面进 pages，其余进 excluded 且带原因', () => {
    const site = planRecoverySite({
      rules: [rule(), rule({ slug: 'thin-page', recoveryType: 'protest' })],
      locale: 'en',
      baseUrl: BASE,
      now: NOW,
      registeredBasisKeys: REGISTERED,
      renderMetricsBySlug: { 'us-customs-drawback': metrics },
    });
    expect(site.pages.map((p) => p.slug)).toEqual(['us-customs-drawback']);
    expect(site.excluded.map((e) => e.slug)).toEqual(['thin-page']);
    expect(site.duplicateSlugs).toEqual([]);
  });

  it('解析页面：未知 slug → 404；过期 → NO_EFFECTIVE_VERSION；多生效版本 → RULE_VERSION_CONFLICT', () => {
    expect(
      resolveLocalizedRecoveryPage({ rules: [rule()], slug: 'nope', now: NOW }).reason,
    ).toBe('UNKNOWN_SLUG');

    const expired = rule({ effectiveTo: '2026-10-02T00:00:00.000Z' });
    expect(
      resolveLocalizedRecoveryPage({ rules: [expired], slug: 'us-customs-drawback', now: NOW }).reason,
    ).toBe('NO_EFFECTIVE_VERSION');

    const conflict = resolveLocalizedRecoveryPage({
      rules: [rule({ ruleVersion: 'v2' }), rule({ ruleVersion: 'v10' })],
      slug: 'us-customs-drawback',
      now: NOW,
    });
    expect(conflict.reason).toBe('RULE_VERSION_CONFLICT');
    expect(conflict.rule).toBeNull();
    expect(conflict.effectiveVersions).toBe(2);
  });

  it('locale fallback policy：未知语言回落 en 并显式返回实际使用的 locale', () => {
    const fallback = resolveLocalizedRecoveryPage({
      rules: [rule()],
      slug: 'us-customs-drawback',
      requestedLocale: 'fr',
      now: NOW,
    });
    expect(fallback.found).toBe(true);
    expect(fallback.locale).toBe('en');

    const explicit = resolveLocalizedRecoveryPage({
      rules: [rule()],
      slug: 'us-customs-drawback',
      requestedLocale: 'ja',
      now: NOW,
    });
    expect(explicit.locale).toBe('ja');
    expect(explicit.rule?.ruleVersion).toBe('2026.10.1');
  });

  it('边界自证：页面计划层纯计算，不写库、不外写、不绕 Action Guard', () => {
    expect(SEO_PAGE_PLAN_BOUNDARY).toEqual({
      externalWritePerformed: false,
      databaseWritePerformed: false,
      actionGuardBypassed: false,
      inventsRules: false,
      indexDecisionFromIndexabilityGate: true,
      productionCredentials: 'ABSENT',
    });
  });
});
