#!/usr/bin/env node
/**
 * /recover 投影流水线守卫（MSG-20261004-35 OPTION_B_REVISED）。
 *
 * 构建顺序：apps/api `npm run export:recover-static` → 生成 artifact → apps/web build（SSG 读它）。
 * 本脚本只做「投影是否可用」的显式检查：
 *   · 默认（未设 RECOVER_PROJECTION_REQUIRED）→ 缺失即打印 FAIL-CLOSED 说明并退出 0（不阻断 CI）；
 *   · 设 RECOVER_PROJECTION_REQUIRED=1（发布前）→ 缺失/非法即退出 1，避免发布空页面集却无人察觉。
 * 任何情况下都**不会**因为缺投影而放行「用模板凑页面」的路径。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = 'seo-recover-static-v1';
const DIGEST_RE = /^[0-9a-f]{64}$/;
const LOCALES = new Set(['en', 'zh', 'de', 'ja', 'es']);

const filePath =
  process.env.RECOVER_PROJECTION_PATH ?? path.join(process.cwd(), '.generated', 'recover-projection.json');
const required = process.env.RECOVER_PROJECTION_REQUIRED === '1';

let verdict = 'OK';
let detail = '';
let pages = 0;
let indexable = 0;

try {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (parsed?.schema !== SCHEMA) {
    verdict = 'UNKNOWN_SCHEMA';
    detail = String(parsed?.schema);
  } else if (typeof parsed.sourceDigest !== 'string' || !DIGEST_RE.test(parsed.sourceDigest)) {
    verdict = 'INVALID_DIGEST';
    detail = 'sourceDigest';
  } else if (!Array.isArray(parsed.pages)) {
    verdict = 'MALFORMED';
    detail = 'pages';
  } else {
    for (const page of parsed.pages) {
      if (typeof page?.slug !== 'string' || !LOCALES.has(String(page?.locale))) {
        verdict = 'MALFORMED';
        detail = 'page';
        break;
      }
    }
    pages = parsed.pages.length;
    indexable = parsed.pages.filter(
      (page) => page.inSitemap && page.robots === 'index,follow' && (page.noindexReasons ?? []).length === 0,
    ).length;
  }
} catch {
  verdict = 'MISSING';
  detail = filePath;
}

if (verdict === 'OK') {
  console.log(`RECOVER_PROJECTION_OK pages=${pages} indexable=${indexable} path=${filePath}`);
  process.exit(0);
}

console.log(`RECOVER_PROJECTION_${verdict} detail=${detail}`);
console.log('FAIL-CLOSED：/recover 不产出任何静态页面，sitemap 为空，全部请求走 404（绝不套模板并 index）。');
if (verdict === 'MISSING') {
  console.log('提示：先在 apps/api 运行 npm run export:recover-static 生成投影，再构建 apps/web。');
}
process.exit(required ? 1 : 0);
