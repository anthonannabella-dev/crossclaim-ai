# SEO-3 — PUBLIC API SECURITY 审计要求（实现清单）

> 来源：架构方对 `3066ac2` 的 PUBLIC API SECURITY AUDIT 裁决 = **REVISE**（要点已按原文记录于 `.autopilot/STATE.json` 的 `track_c_seo_p3.seo_3_audit_verdict`；逐字归档待补）。
> 状态：**PUBLIC_CHECKER_HTTP = HOLD**，本清单是实现依据；`SEO-4 /recover 页面接线 = AUTHORIZED（默认 NOINDEX）`。

## 已 PASS（不要重做）
匿名无 session · 不访问 tenant 数据 · 无 submission/payment/外写 · RuleVersion server-resolved · basisKey 必须真实注册 · 规则缺失或无能力 fail-closed · 资格失败不运行 calculator · `ESTIMATE_ONLY` + disclaimer · slug/key/长度/数量限制 · 字符串型 PII 过滤。

## 必修 1 — CHANGE A：rule/engine 级**语义**白名单
现状问题：答案白名单只是**格式**白名单 `^[a-z][a-z0-9_]{0,31}$`，`phone` / `email` / `customer_name` / `account` / `secret` / `foo` 都能进入引擎；`RecoveryRuleDefinition` 也没有 `publicInputSchema`。

要求：
- registry 按 `basisKey` 提供 `publicInputSchema`：`allowed keys → type → min/max → enum/options`。
- 未知 key → `UNKNOWN_ANSWER_KEY` → `INVALID_REQUEST`（**不得**把任意格式合法的 key 继续传给引擎）。
- 示例（customs drawback）：`reexported: boolean`、`duty_amount: number(0..100000000)`、`days_since_import: integer(0..3650)`。

## 必修 2 — CHANGE B：数值输入必须 schema 驱动校验
现状问题：`typeof value === 'number' || 'boolean'` 直接 `continue`，所以 `{"phone": 14155550132}` 绕过 PII 检测。

要求：按字段 schema 做 `Number.isFinite` / 类型匹配 / 整数或小数要求 / `min`–`max` / 禁止超范围。
**不要**用通用正则把"6 位以上数字"一律当 PII —— 那会误杀合法金额；正确做法是依赖字段 schema，而不是通用正则猜测。

## 生产限流
- `IN_MEMORY_RATE_LIMIT = DEV/STAGING_ONLY`（多实例/多 worker 可绕；`Map` 无 TTL 也会被新 key 撑爆）。
- 生产二选一：A. 共享存储 atomic limiter（如 Redis）；B. CDN/API Gateway/reverse proxy 全局限流 + 应用层第二层。
- 可先接线的前提：`PUBLIC_API_ENABLED=false` 默认关闭，或仅 staging；若做单机 canary，必须同时满足：单实例、单 Node process、无 PM2 cluster、无 autoscale/serverless、上游已有全局限流、Map 有 TTL/max-size、有 kill switch。
- 匿名 key 必须来自**可信代理提供的真实 client IP**；不可直接信任可伪造的 `X-Forwarded-For`。

## 公开 HTTP 接线前的最小防护清单
POST only · `Content-Type: application/json` · body ≤ 8 KiB（**解析 JSON 前**限制）· rate limit 在昂贵 engine 调用**之前** · 总处理 timeout ≈ 2–3s · bounded concurrency / semaphore · `Cache-Control: no-store` · same-origin CORS 或不开放 CORS（**禁止** `Access-Control-Allow-Origin: *`）· 不记录 raw body / raw IP / raw UA。

## 输出校验（新增要求）
`runCalculation()` 的返回目前被直接信任。公网边界必须校验：`estimate.min/max` finite、`min >= 0`、`max >= min`、`currency ^[A-Z]{3}$`、`disclaimerKey` 为安全 token、`reasonCodes` 有数量/长度上限；不合法 → `ENGINE_OUTPUT_INVALID` → fail-closed。

## 其他裁定
- Slug 枚举**不是** P0 阻塞（`/recover/...` 本就是公开 SEO 资产，slug 不是秘密）；可统一外部 404 响应减少 fingerprinting，不做复杂 anti-enumeration。
- `SEO-4_RECOVER_PAGE_WIRING = AUTHORIZED`（canonical / hreflang / JSON-LD / sitemap plumbing / renderer / Checker UI shell 可继续），`DEFAULT_NOINDEX = REQUIRED`。
- `PUBLIC_CHECKER_HTTP_ENABLEMENT = HOLD`：等 CHANGE A/B + HTTP 边界落完，再送一次很窄的 **SEO-3 PUBLIC HTTP FINAL**，只需核 10 项（publicInputSchema、unknown key reject、numeric finite/range、8 KiB cap、trusted-IP rate key、bounded/shared limiter、timeout+concurrency、no-store+same-origin、engine output validation、zero write/submission/payment regression）。
- `SEARCH_CONSOLE` / `DOMAIN_OWNERSHIP` = **HOST_ACTION_REQUIRED**（不阻塞 `/recover` 页面代码建设，但阻塞最终搜索引擎生产验证）。
