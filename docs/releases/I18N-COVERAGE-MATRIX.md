# I18N COVERAGE MATRIX（自动扫描 + 人工分类）

- 生成方式：`tools/i18n/check-i18n.mjs`（硬编码扫描）+ `work/scripts/i18n-hardcode-scan.mjs`（分类）
- REVIEWED_HEAD：见提交；扫描范围：`apps/web/app/**/*.tsx|ts`
- 术语：`Customer-facing?` = 是否属普通客户主流程；`Uses dictionary?` = 是否经 `i18n` dictionary 取文案。

## 1. 汇总

| 指标 | 值 |
|---|---|
| 支持语言 | `zh-CN` / `en-US` / `de` / `ja` / `es`（5） |
| 字典键（每语言） | 173（**parity 通过**，无空值） |
| 状态码本地化 | 13 个 code × 5 语言 + `status.UNKNOWN` 兜底（通过） |
| Business Language Layer | `uiLocale` / `reportLocale` / `claimLocale` / `providerLocale` + fail-safe resolver（通过） |
| 格式化 | `formatMoney` / `formatDate` / `formatDateTime` / `formatNumber` / `formatPercent`（通过） |
| **Customer UI 硬编码** | **169**（棘轮基线 `tools/i18n/hardcode-baseline.json`，只允许下降） |
| Ops/Admin 硬编码（允许保留技术语言） | 88 |

## 2. 逐页矩阵

| Page / Surface | Customer-facing? | Uses dictionary? | Hardcoded strings | zh-CN | en-US | de | ja | es | Status localization | Date format | Money format | Business language dependency | Action required |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/`（dashboard） | ✅ | 部分 | 0 | ✅ | ✅ | ✅ | ✅ | ✅ | 部分（沿用后端 code） | ❌ 需接入 `formatDateTime` | ❌ 需接入 `formatMoney` | reportLocale | P1：格式化接入 |
| `/signup` | ✅ | ❌ | 13 | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | n/a | n/a | — | **P0：硬编码入字典** |
| `/login` | ✅ | ✅ | 0 | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | n/a | n/a | — | 完成 |
| `/accounts`（含 view） | ✅ | ❌ | 33 | ✅ | ✅ | ✅ | ✅ | ✅ | 部分 | ❌ | ❌ | providerLocale（连接状态） | **P0：硬编码入字典 + providerLocale 展示** |
| `/opportunities`（含 list） | ✅ | ❌ | 23 | ✅ | ✅ | ✅ | ✅ | ✅ | 部分（`status` 已本地化） | ❌ | ❌ | reportLocale | **P0：硬编码入字典** |
| `/connections` | ✅ | ❌ | 7 | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | n/a | n/a | providerLocale | **P0：硬编码入字典** |
| `/money`（含 view） | ✅ | ❌ | 29 | ✅ | ✅ | ✅ | ✅ | ✅ | 部分 | ❌ | 部分（多币种已分组） | reportLocale | **P0：硬编码入字典 + `formatMoney`** |
| `/billing` | ✅ | ✅ | 0 | ✅ | ✅ | ✅ | ✅ | ✅ | 部分 | ❌ | ❌ | reportLocale | P1：格式化接入 |
| `/plan`（含 view） | ✅ | ❌ | 26 | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | n/a | n/a | — | **P0：硬编码入字典** |
| `/cases` | ✅ | 部分 | 43 | ✅ | ✅ | ✅ | ✅ | ✅ | 部分 | ❌ | ❌ | claimLocale / reportLocale | **P0：硬编码入字典** |
| `/cases/:id` | ✅ | 部分 | 2 | ✅ | ✅ | ✅ | ✅ | ✅ | 部分 | ❌ | ❌ | claimLocale | **P0：补键** |
| `/cases/:id/claim-package` | ✅ | ❌ | 36 | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | ❌ | ❌ | **claimLocale（关键）** | **P0：硬编码入字典** |
| `/upload` | ✅ | ✅ | 1 | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | n/a | n/a | — | P1：残留 1 处 |
| `/integration-status` | ❌（Ops/Debug） | ❌ | 57 | ✅ | ✅ | ✅ | ✅ | ✅ | 技术 code 直出（允许） | — | — | providerLocale | 保留；label 可本地化（P1） |
| `/platform-recovery-state` | ❌（Ops/Debug） | ❌ | 25 | ✅ | ✅ | ✅ | ✅ | ✅ | 技术 code 直出（允许） | — | — | providerLocale | 保留；label 可本地化（P1） |
| `/operations` | ❌（Ops） | ✅（`lib/console.ts`） | 33 | ✅ | ✅ | ✅ | ✅ | ✅ | 技术 code 直出（允许） | — | — | — | 保留 |
| `/admin/*` | ❌（Admin） | 部分 | 0 | ✅ | ✅ | ✅ | ✅ | ✅ | 技术 code 直出（允许） | — | — | — | 保留 |

> 说明：Ops / Admin / Evidence / Debug Console 的**技术字段**（`entryFactId`、`projectionId`、`basisReference`、`credentialRef`、`providerSubmissionId`、`transportEnabled`、`externalWritePerformed`、`productionCredentials`、`idempotencyKey`、技术 enum）**按指令 §一 允许保留**，不计入 Customer UI 硬编码。

## 3. P0 / P1 / P2 gap 清单

**P0（Customer UI 必须收敛）**

| # | Gap | 位置 | 当前 |
|---|---|---|---|
| P0-1 | Customer 页面中英双写 / 中文硬编码入字典 | signup(13) · accounts(33) · opportunities(23) · connections(7) · money(29) · plan(26) · cases(43) · cases/:id(2) · claim-package(36) · upload(1) | 169 行 |
| P0-2 | Status localization 接入各客户页（当前仅 opportunities 部分） | accounts / money / cases / claim-package | 部分 |
| P0-3 | Date / Money 统一经 `formatMoney` / `formatDate*` | dashboard / money / cases / billing | 未接入 |
| P0-4 | Claim/Appeal **immutable language metadata**（`claimLocale` 持久化 + generation/template version） | `claim.prepare`（Schema） | **缺 → 需架构审计** |

**P1**

- Email / notification 模板 locale 架构（`EMAIL_PROVIDER = HOST_ACTION_REQUIRED`，模板架构可先做）
- Report language 选择器 + 冻结持久化
- Provider language resolver 接入各 provider 接入点
- locale preference persistence（报告/Claim 冻结值的存储读取）
- Ops Console label 本地化（技术 code 保留）

**P2**

- Marketing / SEO locale 路由（`/en` `/de` `/ja` `/es` `/zh-CN` + hreflang / canonical / localized sitemap / landing pages）
- `MARKETING_I18N_READYNESS = MISSING`（营销站尚不存在，按指令不强行开发）

## 4. 当前结论

| 项 | 结论 |
|---|---|
| `I18N_INFRASTRUCTURE` | PASS（5 语言字典 + cookie/Accept-Language + parity/blank 强制） |
| `SUPPORTED_UI_LOCALES` | zh-CN · en-US · de · ja · es |
| `CUSTOMER_UI_LOCALIZATION` | **REVISE**（硬编码 169；本轮建立 guard 与棘轮，内容迁移未完成） |
| `CUSTOMER_UI_HARDCODED_STRING_COUNT` | 169（基线，只允许下降） |
| `DICTIONARY_KEY_PARITY` | PASS |
| `EMPTY_TRANSLATION_COUNT` | 0 |
| `STATUS_LOCALIZATION` | PASS（13 code × 5 语言 + UNKNOWN 兜底；**页面接入**仍属 P0-2） |
| `DATE_MONEY_LOCALIZATION` | 工具层 PASS；**页面接入**未完成（P0-3） |
| `BUSINESS_LANGUAGE_LAYER` | PASS（四语言 + fail-safe resolver + contract） |
| `REPORT_LANGUAGE_READINESS` | REVISE（解析就绪；冻结持久化与选择器待做） |
| `CLAIM_LANGUAGE_READINESS` | REVISE（解析就绪；immutable metadata 需架构审计） |
| `PROVIDER_LANGUAGE_READINESS` | PASS（provider/jurisdiction 规则 + marketplace 覆盖 + fail-safe） |
| `EMAIL_LANGUAGE_READINESS` | EXTERNAL_GATE（provider 未接；模板架构 P1） |
| `MARKETING_I18N_READYNESS` | MISSING（P2） |
