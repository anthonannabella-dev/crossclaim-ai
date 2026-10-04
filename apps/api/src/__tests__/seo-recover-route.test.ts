/**
 * SEO-4 Stage 1 验收 —— /recover 路由骨架的六条命名用例（SEO-4-RECOVER-WIRING-PLAN.md §5）。
 * 全部只消费生效 RuleVersion + RecoveryRuleDefinition v1 的派生字段与 SEO-6 门槛结论；
 * 测试里出现的日期/版本只用于构造输入，任何 eligibility / deadline / calculation / fee / recovery amount
 * 都不在代码或断言中硬编码（本文件按正则自查）。
 */

import { describe, expect, it } from 'vitest';

import {
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
