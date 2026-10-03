# BUSINESS LANGUAGE CONTRACT（CrossClaim）

- 状态：**ACTIVE**（HOST DIRECTIVE 2026-10-04「FULL INTERNATIONALIZATION COMPLETION」§六/§七/§十九）
- 实现：`apps/web/i18n/business-language.ts`（唯一来源）；校验：`tools/i18n/check-i18n.mjs`
- 原则：四种语言**互相独立**，业务语言不得继承 UI 语言；解析一律 fail-safe。

## 1. 四种语言的定义

| 名称 | 含义 | 典型场景 |
|---|---|---|
| `uiLocale` | 客户操作界面语言 | 中国卖家把界面切成中文 |
| `reportLocale` | 客户查看/下载**报告**的语言 | 同一客户下载的分析报告用中文 |
| `claimLocale` | **Claim / Appeal / Evidence Package** 文本语言 | 面向 Amazon US 的索赔包用 en-US |
| `providerLocale` | 目标 **Provider / Jurisdiction** 要求的语言 | 德国海关支持材料用 de |

允许同时成立：`uiLocale=zh-CN` + `providerLocale=en-US` + `claimLocale=en-US` + `reportLocale=zh-CN`。

## 2. Source of truth 与优先级

| 语言 | 解析顺序（高 → 低） | 兜底 |
|---|---|---|
| `uiLocale` | `cc_lang` cookie → `Accept-Language` → `zh-CN` | `zh-CN`（既有规则，不改） |
| `reportLocale` | 显式选择 → **冻结值** → `uiLocale` | `uiLocale` |
| `claimLocale` | 显式选择 → `providerLocale` → jurisdiction 默认 → `uiLocale` | `uiLocale` |
| `providerLocale` | 用户 override → marketplace 覆盖 → provider 默认 → jurisdiction 默认 → **fail-safe `en-US`** | `en-US`（`failSafe=true`） |

对应函数：`resolveUiLocale` / `resolveReportLocale` / `resolveClaimLocale` / `resolveProviderLocale` / `resolveFrozenLocale`。

## 3. Provider / Jurisdiction 语言规则（非「国家=单一语言」硬规则）

- Provider 表：`PROVIDER_LANGUAGE_RULES`（Amazon / TikTok Shop / Walmart / Shopify / UPS / FedEx / DHL / Stripe / PayPal / CBP / EU_CUSTOMS / JP_CUSTOMS）。
- Marketplace 覆盖：`amazon.de → de`、`amazon.jp → ja`、`amazon.es → es`、`amazon.cn → zh-CN` 等。
- Jurisdiction 默认：`JURISDICTION_DEFAULT_LOCALES`（US→en-US、DE→de、JP→ja、CN→zh-CN、ES→es …）**仅作默认值**，可被 provider 规则与用户 override 覆盖。
- 无法判定 → `en-US` 且 `failSafe=true`（调用方必须记录审计，不得静默）。
- 品牌名不翻译（Amazon / TikTok Shop / Walmart / Shopify / UPS / FedEx / DHL / Stripe / PayPal）。

## 4. 不可变性（immutability）

| 对象 | 冻结时机 | 规则 |
|---|---|---|
| Report | **保存报告时**冻结 `reportLocale` | 之后 UI 切换语言**不得**改变历史报告语言与内容 |
| Claim / Appeal | **生成时**冻结 `claimLocale` | 历史 Claim 不因语言偏好变化被重写 |

`resolveFrozenLocale({ frozen, requested, fallback })`：存在 `frozen` 时**永远优先返回冻结值**。

## 5. 审计要求

Claim / Appeal 生成必须可追溯并记录：`language`（= claimLocale）、`target provider`、`jurisdiction`、`generation version`、`template/model version`。

> ⚠️ 当前 `claim.prepare` 只持久化 `draftText` 与 `target`，**尚无 immutable language metadata**。
> 该补齐涉及核心 Schema → 按 §九 必须先送**架构审计**（本轮已登记为 P0 gap，未擅自变更 Schema）。

## 6. 存储与安全边界

- 语言元数据属**非敏感**字段；不得与 credential / token 混存。
- 后端继续返回稳定 **code**；前端只负责 code → localized label。**禁止**把翻译后的 label 作为业务 code 回传 API。
- 未知 code / 未知错误一律走安全兜底文案，禁止展示 raw stack、Prisma error、provider secret error。

## 7. 格式化边界

`formatMoney` / `formatDate` / `formatDateTime` / `formatNumber` / `formatPercent` 仅做**显示格式化**：

- 金额与数值**一律来自后端**；前端不得做 authoritative 金融计算。
- 多币种**不得相加**；除非后端提供 FX conversion snapshot（须同时展示 base currency / rate source / rate timestamp）。

## 8. 与非目标（明确不做）

- 不更换 i18n 技术栈、不删除既有 dictionary、不改 cookie/Accept-Language 机制、不引入大型新依赖。
- 营销站 SEO locale 路由（`/en`、`/de` … + hreflang/canonical/localized sitemap）属 **P2**，本轮仅登记就绪度，不强行开发。
- 真实 LLM 多语言 Claim 生成 = `REAL_MULTILINGUAL_CLAIM_GENERATION = NO`（Provider/LLM 未接入，属正常状态）。
