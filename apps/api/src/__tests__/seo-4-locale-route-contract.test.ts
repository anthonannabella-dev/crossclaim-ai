/**
 * SEO-4 本地化路由合同（MSG-20261005-03 = OPTION_A）
 * ---------------------------------------------------------------
 * 只读 apps/web 源码。钉死三件事：
 *   1) `/[locale]/recover/[slug]` 存在且 fail-closed（缺投影 / 非法 locale / 未命中 → 404）
 *   2) 默认语言仍由 `/recover/[slug]` 承担，两条路由不产生同一页面的第二个 URL
 *   3) 文案按 URL locale 取；展示层共用一份；两条路由都不注册 POST、不碰 Prisma
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webFile = (relative: string): string => readFileSync(path.join('..', 'web', relative), 'utf8');

const localePage = webFile('app/[locale]/recover/[slug]/page.tsx');
const defaultPage = webFile('app/recover/[slug]/page.tsx');
const view = webFile('app/recover/recover-view.tsx');
const serverI18n = webFile('i18n/server.ts');

describe('SEO-4 本地化路由合同（OPTION_A）', () => {
  it('LOCALE_ROUTE_FAILS_CLOSED：缺投影 / 非法 locale / 未命中 ⇒ notFound', () => {
    expect(localePage).toContain('dynamicParams = false');
    expect(localePage).toContain('notFound()');
    expect(localePage).toContain('loadRecoverProjection');
  });

  it('LOCALE_ROUTE_EXCLUDES_DEFAULT_LOCALE：en 仍由 /recover/[slug] 承担，不产生重复 URL', () => {
    expect(localePage).toContain("const DEFAULT_LOCALE = 'en'");
    expect(localePage).toContain('LOCALIZED_LOCALES');
    expect(defaultPage).toContain("const DEFAULT_LOCALE = 'en'");
    expect(defaultPage).toContain('generateStaticParams');
  });

  it('LOCALE_MESSAGES_FOLLOW_URL：文案按 URL locale 取，不靠 cookie 猜', () => {
    expect(serverI18n).toMatch(/getServerMessages\(locale\?: Locale\)/);
    expect(localePage).toContain('I18N_LOCALE');
    expect(localePage).toContain('getServerMessages(I18N_LOCALE[page.locale] ?? I18N_DEFAULT_LOCALE)');
    expect(defaultPage).toContain('getServerMessages(I18N_DEFAULT_LOCALE)');
  });

  it('NO_DUPLICATE_PRESENTATION：两条路由共用同一展示组件', () => {
    expect(view).toContain('export function RecoverView');
    expect(localePage).toContain("from '../../../recover/recover-view'");
    expect(defaultPage).toContain("from '../recover-view'");
  });

  it('NO_PUBLIC_WRITE：两条路由都不注册 POST / 不直接使用 Prisma', () => {
    for (const source of [localePage, defaultPage, view]) {
      expect(source).not.toMatch(/export\s+(async\s+)?function\s+POST\b/);
      expect(source).not.toMatch(/method:\s*['"]POST['"]/i);
      expect(source).not.toMatch(/@prisma|PrismaClient/);
    }
  });
});
