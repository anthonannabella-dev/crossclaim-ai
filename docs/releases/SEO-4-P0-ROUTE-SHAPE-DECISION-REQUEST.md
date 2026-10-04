# [SEO-4 → ARCHITECT] 路由形状 vs canonical 不一致 —— 请裁定 URL 契约方向

## 0. 事实（可复核，含文件与行）

| 位置 | 现状 |
| --- | --- |
| `apps/api/src/services/seo/seo-technical.ts` L42 / L52 | canonical 约定 = `/{locale}/recover/{platform}` 或 `/{locale}/recover/{platform}/{recoveryType}` |
| `apps/api/src/services/seo/seo-recover-static-projection.ts` L20 | 投影 `canonical` 沿用同一规则（注释示例 `/zh/recover/amazon/fee-refund`；不可用时 `null`） |
| `apps/web/app/recover/[slug]/page.tsx` | 站点**只**服务 `/recover/{slug}`（单路径段、无 locale 前缀；`dynamicParams = false` + 缺投影即 `notFound()`） |
| `apps/web/app/sitemap.ts` | sitemap 的 `<loc>` 直接取 `page.canonical` |
| `apps/web/app/robots.ts` | 只声明 sitemap，不写 Disallow |

结论：artifact 里写出的 canonical / hreflang / sitemap URL 在站点上**并不存在**（既没有 `[locale]` 段，
也没有 `{platform}/{recoveryType}` 段）。因此即使某页通过了 indexability gate，它的 canonical 也无法自指，
索引必然失败 —— 这就是当前 **全部页面保持 default NOINDEX** 的真实原因之一。

## 1. 为什么这不是纯实现细节

两个方向的修法都会改动**公共 URL 契约**（canonical + hreflang + sitemap + 内部链接 + 5 语言可达性），
而 SEO-5 的 URL 约定与 SEO-4 裁定里授权的 web 路由形状（`apps/web /recover/[slug]` → `generateStaticParams`
→ metadata / JSON-LD / content → sitemap → 5 locales）互相矛盾。
两种解读都成立，所以不敢单方面改：

- 解读 1：SEO-4 裁定已授权 `/recover/{slug}` 形状 → 应把 SEO-5 的 URL 约定改成 slug 单源。
- 解读 2：SEO-5 的 `{platform}/{recoveryType}` 才是目标形状 → 应给 web 增加两层路由，slug 退化为别名。

## 2. 方案（请二选一，或给出第三种）

### 方案 A（我倾向）：canonical 对齐已授权的真实路由

- URL 形状：`/recover/{slug}`（en，默认无前缀）+ `/{locale}/recover/{slug}`（zh / de / ja / es）。
- `slug` 成为 URL 的**唯一来源**；`platform` / `recoveryType` 仅用于展示、内链与结构化数据，不进 URL。
- 改动面：`seo-technical.ts` 的 URL 构造 + `seo-recover-static-projection.ts` 的 canonical +
  `apps/web` 增加 `app/[locale]/recover/[slug]`（或在现有路由做 locale 前缀解析）+ hreflang alternates +
  sitemap；SEO-4/SEO-5 相关合同测试同步。
- 优点：与已授权路由形状一致，改动集中在 URL 构造层，路由数量最少。
- 风险：若未来想做 `platform`/`recoveryType` 维度的聚合页，需要另开一层。

### 方案 B：让 web 服从 SEO-5 的两层路径

- 新增 `/recover/{platform}`、`/recover/{platform}/{recoveryType}` 及各自 `{locale}` 变体；
  `slug` 变成别名（需要 alias/redirect 规则，否则既有 slug 链接变 404）。
- 改动面：新增 2 层路由 + 别名/301 规则 + 全部内链重写 + sitemap/hreflang 重算 + 5 语言可达性改造。
- 优点：URL 自带平台/类型的语义（对 SEO 有一定价值）。
- 风险：改动面大、需要 301 策略，且 SEO-4 已按 `/recover/[slug]` 落地了页面内容层。

## 3. 请裁定

1. 选 **A** 还是 **B**（或第三方案）？
2. 是否要求 **5 语言全部 URL 可达**？若某语言暂不可达，hreflang 是否只声明可达语言（避免指向 404）？
3. 既有的 `/recover/{slug}`（en）是否需要保留为 canonical 本体，或改为 301 到新形状？
4. 通过之前的默认策略是否继续 `NOINDEX`（我按现状继续 default noindex fail-closed，不因本轮而 INDEX）。

## 4. 边界声明（本轮未动）

- 未改任何 SEO 代码；**没有**新增公共 GET；**没有**把任何页面改成 INDEX。
- `EXTERNAL_WRITE = HOLD`、`PAYMENT = HOLD`、`TRANSPORT = HOLD`、`PRODUCTION_CREDENTIALS = HOLD`、
  `PRODUCTION_ENABLEMENT = HOLD`。
- 公开 Checker/Calculator 仍为只读、匿名、限流、零外写；estimate 仍标注为估算；Recovery Rule 仍单源。
- `SEARCH_CONSOLE` / 域名所有权仍属宿主动作。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。
