# SEO-4 下一单元 — web `[locale]` 路由与可达语言收窄
> **状态：DONE（本单元已完成）** —— `apps/web/app/[locale]/recover/[slug]/page.tsx` 已落地，
> 只服务 zh/de/ja/es，en 仍由 `/recover/[slug]` 承担；两条路由共用 `RecoverView`；
> 文案按 URL locale 取（`getServerMessages(locale)`）；新增 5 例路由合同测试；
> web tsc 0、合同测试 8/8、i18n locales=5 keys=644 hardcoded=0。
> 因此「导入的 reachableLocales = 全部 5 语言」现在与 web 真实可达语言**一致**，无需收窄。

背景：MSG-20261005-03 已把 URL 契约定为 OPTION_A（canonical = `/{locale}/recover/{slug}`，
hreflang 走 STRICT_REACHABILITY）。API 侧已落地（HEAD f9f4765）。

## 尚存的真实缺口

- `apps/web` 目前只有 `app/recover/[slug]/page.tsx`（en 默认路由，`dynamicParams = false`）。
- 静态投影导出默认生成 5 语言页面，并把 `locales` 作为 `reachableLocales` 传入，
  因此 hreflang 可能声明 zh/de/ja/es —— 而这 4 个语言在 web 上**尚不可达**。

## 下一步（最小、可验证）

1. 新增 `apps/web/app/[locale]/recover/[slug]/page.tsx`：
   - `generateStaticParams` 只产出**非默认语言**（zh/de/ja/es），不产出 en（避免与 `/recover/{slug}` 重复）；
   - `locale ∈ 支持集` 校验，非法/缺投影一律 `notFound()`（fail-closed 不变）；
   - metadata 继续只取 artifact 的 `canonical` / `hreflang` / robots，web 不自行解释业务规则。
2. 导出侧把 `reachableLocales` 的默认值从「全部 5 语言」改为「web 真正可服务的语言集合」；
   路由补齐后再扩大到 5 语言。
3. 合同测试：断言 hreflang 声明集合 ⊆ web 可服务语言；断言 `[locale]` 路由不产出 en；断言缺投影 → 404。

## 边界（不变）

DEFAULT_NOINDEX 继续；不新增公开 GET；不引入 301 / slug alias / platform 两层路由；
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT 全 HOLD；
FINAL_ACCEPTANCE_HEAD 未动。
