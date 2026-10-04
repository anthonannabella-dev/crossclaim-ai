# [SEO-3 → ARCHITECT] PUBLIC HTTP FINAL 送审（CHANGE A/B 与 HTTP 边界已落地，请裁定是否可注册公开入口）

## 0. 耐久记录

- 本文件即耐久记录：`docs/releases/SEO-3-PUBLIC-HTTP-FINAL-REQUEST.md`（随本批 commit 推到 `gate/7-commercial-validation`）。
- 上一轮裁决 **MSG-20261004-28（REVISE）** 已逐字归档；本轮是它的 FINAL 复核请求。
- 通道说明：本机 `gh` token 已失效，因此 durable record 用仓库文件而非 issue #2 comment（同 MSG-20261005-02 的处理）。

## 1. 声明（硬边界，全部未变）

- **未注册任何公开 HTTP 入口**：`apps/api` 里没有任何 route/server 文件引用 `seo-public-handler` / `runPublicSeoChecker`
  （已 grep 复核），与 `PUBLIC_CHECKER_HTTP = HOLD` 一致。
- `EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT` 全 HOLD；`TRANSPORT=false`。
- 公开 Checker/Calculator：无租户数据、无 PII、匿名只读、零外写、不创建 submission、不绕过 Action Guard、不扣费；
  `estimate` 标注为估算；Recovery Rule 单源（只消费生效中的 `RecoveryRuleDefinition v1`）。
- 未改动 `FINAL_ACCEPTANCE_HEAD`。

## 2. 上一轮 REVISE 要求的落地情况

| 要求 | 现状 |
| --- | --- |
| CHANGE A：`basisKey` 不是格式检查，必须按 rule/engine 的 `publicInputSchema` 校验（含 allowed keys / type / min / max / enum），未知 key 拒绝 | 已落地：`services/seo/seo-public-input-schema.ts`（+ `seo-public-input-schema.test.ts`） |
| CHANGE B：数值一律 schema-driven 校验（`Number.isFinite`、类型、整数/小数、min/max），不再因 `typeof === 'number'` 直接 continue | 同上，已落地并覆盖用例 |
| 限流：in-memory 仅 DEV/STAGING；生产必须共享存储原子限流或 CDN/边缘 | 已落地 in-memory（`seo-rate-limit.ts`），标注为 **DEV/STAGING_ONLY**；生产共享/边缘限流**尚未**实现（需外部基础设施） |
| HTTP 边界：POST only / JSON / body ≤ 8 KiB / 限流在昂贵逻辑前 / 2–3s timeout / 有界并发 / no-store / same-origin CORS / 不落 raw body IP UA / engine 输出校验 fail-closed（ENGINE_OUTPUT_INVALID） | 已落地：`services/seo/seo-public-http-guard.ts`（+ `seo-public-http-guard.test.ts`）、engine 输出校验（`ENGINE_OUTPUT_INVALID` fail-closed） |

## 3. 证据

- `npx tsc --noEmit`（apps/api）= exit 0。
- `npx vitest run src/__tests__/seo-` = **15 个文件 / 96 例全过**，含
  `seo-public-input-schema`、`seo-public-http-guard`、`seo-public-handler`、`seo-public-checker`、`seo-rate-limit`、
  `seo-page-plan`、`seo-technical`、`seo-recover-route`、`seo-analytics`，以及本轮新增的
  `seo-4-locale-route-contract`（5 例）与 `seo-canonical-route-shape`（4 例）。
- `i18n` 检查：`locales=5 keys=644 hardcoded=0`。
- 与本轮同时完成的事项（互不阻塞）：MSG-20261005-03 的 OPTION_A URL 契约已落地
  —— canonical = `/{locale}/recover/{slug}`、`HREFLANG_POLICY = STRICT_REACHABILITY`，
  `apps/web` 新增 `/[locale]/recover/[slug]`（zh/de/ja/es），`en` 仍由 `/recover/[slug]` 承担，全站仍 default NOINDEX。

## 4. 请裁定

1. **PUBLIC_CHECKER_HTTP**：CHANGE A/B + HTTP 边界清单是否认定达成，可否注册公开 HTTP 入口（仍只在无外写、无扣费、无 submission 的前提下）？
2. 生产限流（共享/边缘原子限流）是否必须在上线（生产启用）前完成？若是，是否同意当前 in-memory 只用于 DEV/STAGING 并在生产前以基础设施补齐？
3. 若认定达成，下一步是否允许我接线公开入口（仅 GET/POST 只读估算，无外写），并把 SEO-8 公开面合同测试定稿？
4. 若仍需补证据，请只列**最小集合**。

## 5. HOST_ACTION（与上轮相同，未新增）

- 生产限流所需的共享/边缘基础设施（Redis/CDN 层）——属外部依赖；
- Search Console 验证 / 域名所有权——SEO 页面转 INDEX 前必须由宿主完成。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。
