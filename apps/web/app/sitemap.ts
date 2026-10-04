import type { MetadataRoute } from 'next';

import { loadRecoverProjection } from '../lib/recover-projection';

/**
 * /sitemap.xml（SEO-4 Stage 4 页面层）—— 只收录 artifact 判定可索引的 /recover 页面。
 * fail-closed：artifact 缺失 / 越界 / 该页未通过 gate → 不收录（宁可空 sitemap，也不收录 noindex 页）。
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const loaded = loadRecoverProjection();
  if (!loaded.ok) return [];

  return loaded.projection.pages
    .filter((page) => page.inSitemap && page.robots === 'index,follow' && page.noindexReasons.length === 0)
    .map((page) => ({
      url: page.canonical ?? '',
      lastModified: page.effectiveFrom,
    }))
    .filter((entry) => entry.url !== '');
}
