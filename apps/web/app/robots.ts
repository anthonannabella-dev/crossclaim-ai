import type { MetadataRoute } from 'next';

/**
 * /robots.txt（SEO-4 Stage 4 页面层）—— 只声明 sitemap，不对任何被收录路径设置 Disallow，
 * 避免出现「sitemap 收录 + robots 禁止」的自相矛盾。策略内容来自构建期配置，不硬编码规则。
 */
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.RECOVER_PUBLIC_BASE_URL ?? 'https://crossclaim.example').replace(/\/+$/, '');
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
