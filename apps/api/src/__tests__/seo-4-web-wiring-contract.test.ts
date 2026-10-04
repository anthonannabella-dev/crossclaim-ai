/**
 * SEO-4 web 接线合同测试（MSG-20261004-35 OPTION_B_REVISED）。
 * 断言页面层保持 fail-closed 与边界：缺投影 → 0 静态参数 / 空 sitemap / 404；不注册 POST；
 * robots 不得与 sitemap 矛盾。按源码契约检查（web 侧无独立测试运行器）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webFile = (relative: string): string => readFileSync(path.join('..', 'web', relative), 'utf8');

const page = webFile('app/recover/[slug]/page.tsx');
const sitemap = webFile('app/sitemap.ts');
const robots = webFile('app/robots.ts');
const reader = webFile('lib/recover-projection.ts');

describe('SEO-4 web 接线合同', () => {
  it('RECOVER_WEB_CONTRACT_FAILS_CLOSED_WITHOUT_PROJECTION：缺投影 → 0 静态参数 / 空 sitemap / 404', () => {
    // 路由：不允许多余参数动态生成，读不到投影即 notFound()。
    expect(page).toContain('dynamicParams = false');
    expect(page).toContain('notFound()');
    expect(page).toContain('loadRecoverProjection');
    // sitemap：读不到投影返回空数组（不猜内容）。
    expect(sitemap).toMatch(/if \(!loaded\.ok\) return \[\];/);
    // 读取器：四类失败都必须存在，且 schema 标记固定。
    expect(reader).toContain("'seo-recover-static-v1'");
    for (const reason of ['MISSING', 'MALFORMED', 'UNKNOWN_SCHEMA', 'INVALID_DIGEST']) {
      expect(reader).toContain(reason);
    }
  });

  it('RECOVER_WEB_CONTRACT_NO_POST_ROUTE：页面层不注册任何 POST / Checker 路由', () => {
    for (const source of [page, sitemap, robots, reader]) {
      expect(source).not.toMatch(/export\s+(async\s+)?function\s+POST\b/);
      expect(source).not.toMatch(/method:\s*['"]POST['"]/i);
    }
  });

  it('RECOVER_WEB_CONTRACT_ROBOTS_SITEMAP_CONSISTENT：robots 只声明 sitemap，不对收录路径 Disallow', () => {
    // 只在**代码行**上断言（注释里解释策略时会提到 Disallow 这个词）。
    const robotsCode = robots
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(robotsCode).toContain('sitemap:');
    expect(robotsCode).not.toMatch(/disallow/i);
    // sitemap 只收录通过 gate 的页面。
    expect(sitemap).toContain('page.inSitemap');
    expect(sitemap).toContain("page.robots === 'index,follow'");
    expect(sitemap).toContain('page.noindexReasons.length === 0');
  });
});
