# GROWTH — Programmatic SEO / Recovery Database · 长期架构约束（TRACK C）

状态：**REGISTERED（docs-only）** · 来源：**HOST DIRECTIVE 2026-10-02（Growth Architecture / 高级版本）** · 队列影响：**NONE（不打断 R46 → Full Regression 主线）**

## 1. 目标模型（单源）

```
Recovery Rule → 产品规则判断 → Audit / Checker → Calculator → Claim/Evidence Package → SEO Landing Page
```

一条规则同时服务产品与 SEO，**禁止**「内容站」与「产品」两套数据。

URL 分类（目标，非本轮实现）：`/recover/{platform}/` 与 `/recover/{platform}/{recoveryType}`，例如 `/recover/amazon/`、`/recover/amazon/lost-inventory`、`/recover/customs/duty-overpayment`。平台清单：amazon · tiktok · walmart · shopify · stripe · paypal · ups · fedex · dhl · customs。

## 2. P1 核查结论：现有架构**不阻碍**统一模型

| HOST 要求 | 现有位置 | 判定 |
| --- | --- | --- |
| platform | `RuleSet.channel`（`Channel`：AMAZON_FBA / AMAZON_OTHER / UPS / FEDEX / DHL / … / OTHER） | 已存在（需补 SEO 平台粒度映射） |
| ruleVersion / effectiveFrom / effectiveTo / sourceReferences | `RuleVersion.version` / `effectiveFrom` / `effectiveTo` / `source` / `legalBasis` / `lastVerified` / `verifiedBy` | 已存在 |
| category / recoveryType / country·region / title / slug / problemDescription / eligibility / requiredEvidence / calculationMethod / filingDeadline / submissionMethod / feeModel / supportedMode / calculator·checker capability / CTA mode | 目前位于 `RuleVersion.definition`（Json）——语义在使用，但**未定型** | 需在 P3 前定成 typed contract（不新增表即可承载） |
| 多语言 | `apps/web/i18n`（zh-CN / en-US / de / ja / es + 字典一致性 CI） | 已存在（UI 文案层） |
| CTA A `SUCCESS_FEE` | `FeeCalculation`（basis/rate）+ 现有 billing 链路（R46 S4/S5 已闭环） | 已存在 |
| CTA B `PAID_CLAIM_PACKAGE`（Customs） | `docs/releases/CUSTOMS-SELF-SERVICE-PRICING-CONTRACT.md`（PACKAGE_S..XL + entitlement gate） | 已登记（implementation_started = NO） |
| Checker / Calculator 能力 | 现有 eligibility / fee-compute 纯函数 + Case 创建链路 | 可复用（需暴露只读面） |

**缺口（P3 才实施）**：(a) 规则定义 typed contract；(b) country/region 维度；(c) locale 维度的内容存储；(d) SEO 元数据 / 索引策略；(e) 公开只读 checker/calculator 端点。

## 3. 预留契约（**冻结命名**，避免后期返工）

`RecoveryRuleDefinition v1`（存放于 `RuleVersion.definition`，P3 增加 zod + JSON Schema 校验）：

```
platform, category, recoveryType, country, region,
title, slug, problemDescription,
eligibility, requiredEvidence, calculationMethod, filingDeadline,
submissionMethod, feeModel, supportedMode,
ruleVersion, effectiveFrom, effectiveTo, sourceReferences,
calculatorCapability, checkerCapability, ctaMode
```

### 未来最小 Schema Delta（P3 提交架构方裁决，**本轮不实施**）

1. `RuleVersion.country` / `RuleVersion.region`（可空；索引 `(domain, channel, country, recoveryType)`）。
2. `RecoveryRuleContent`：`ruleVersionId + locale + title / slug / problemDescription / eligibilityText / evidenceText / calculationText / faq[] / ctaLabel`，`@@unique(ruleVersionId, locale)` + `@@unique(locale, slug)`。
3. 索引策略：`RecoveryRuleIndexPolicy`（indexable / noindexReason / qualityScore / lastEvaluatedAt）或等价的纯函数计算（可不落库）。
4. 公开只读端点（**无 PII / 无租户数据**）：`/api/public/recovery-rules/:slug`、`/api/public/checker/:ruleVersionId`（rate-limited）。

### 统一管道不变量

- SEO 页面**只能**消费生效中的 `RuleVersion` + 与产品**同一套** eligibility / calculator 纯函数。
- 页面层（`apps/web`）**不得**出现业务规则副本；由架构契约测试禁止规则常量出现在 web 包内。
- 不新增任何绕过 Action Guard / HITL / 资金边界的路径；SEO 只读，写路径仍走既有受保护入口。

## 4. 语言与内容

- UI 结构文案走现有 i18n 字典；**规则 / SEO 文案不得硬编码在 React 页面**，P3 起走 `RecoveryRuleContent`。
- locale 维度采用 URL segment（`/en/recover/...`、`/zh/recover/...`…），canonical 自引用或指向默认语言，并输出 hreflang 交叉链接。
- 某 locale 内容缺失时**不得**产生薄页面：回退默认语言并 canonical 到回退版本，或直接 `noindex`。

## 5. Programmatic SEO 预留（本轮不生成页面）

canonical URL · sitemap **由数据库规则 + 索引策略生成**（非手写）· robots 控制 · JSON-LD（FAQPage / BreadcrumbList / Service·HowTo 视规则） · internal linking（平台 → 类别 → 规则 → related recovery rules） · 聚合页（platform / category / country） · index–noindex 控制 · 页面质量门槛。

**Indexable 基线（P3 细化）**：
1. `RuleVersion` 处于生效期且 `tier` 允许公开；
2. 该规则挂载**真实** checker 或 calculator（capability 非空且实现存在）；
3. 内容层该 locale 具备 title / problemDescription / eligibility / requiredEvidence / calculationMethod 五段实质内容；
4. 至少 1 条可核验 `sourceReferences`；
5. 同一 `(platform, category, country, recoveryType)` 只有一个 active 版本（无未裁决冲突）。

任一不满足 → `noindex`（页面仍可作为工具页存在）。

**严禁**：批量 AI 博客；无真实规则 / 无工具的薄页面；为 SEO 复刻一份业务规则。

## 6. 收费 / CTA 模型（页面层只做展示与入口）

**A. SUCCESS_FEE**（Amazon / TikTok / Walmart / Shopify / Stripe / PayPal / UPS / FedEx / DHL）：Free Audit → Recovery → **实际到账** → Success Fee。沿用现有 fee / billing 链路；R13 Payment Activation Gate 继续 HOLD。

**B. PAID_CLAIM_PACKAGE**（主用 Customs）：Free Audit → Estimated Recoverable → **Pay to Unlock** → Claim-Ready Package → 客户 / Broker 自行提交。沿用 `CUSTOMS-SELF-SERVICE-PRICING-CONTRACT.md` 的 entitlement gate；支付域仍关闭。

页面 CTA 由规则定义内 `feeModel` + `ctaMode` 决定；两者都**不触发**新的外写、扣款或平台提交。

## 7. 标准页面结构（预留）

用户问题 → 是否符合追回条件 → 时限（filingDeadline） → 所需证据 → 可追回金额计算方式 → **Free Checker / Calculator** → Upload / Connect Data → Estimated Recoverable → Start Recovery。

## 8. 分阶段（HOST 指定）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 不影响当前 Recovery 主线 | 满足（本文件为登记，无代码改动） |
| P1 | 确认现有架构不阻碍统一模型 | **已完成**（§2 结论：不阻碍） |
| P2 | 现有模型足够则只记录设计，不重复造系统 | **已完成**（本文件） |
| P3 | 核心 Recovery Engine 稳定后实施首批 20–30 个高意图页面（届时提交最小 Schema Delta + 内容层 + 只读端点 + sitemap/robots/JSON-LD） | 待启动 |
| P4 | 验证 Search → Checker → Case → Recovery 转化后扩到 100+ | 待启动 |

## 9. 第一阶段明确不做

不批量生产 100/500 页面 · 不写大量 AI 博客 · 不为 SEO 改动 Recovery 事实模型 · 不把业务规则复制到页面代码 · 不引入与主线无关的大型 CMS · 不降低现有审计 / 安全 / HITL / 资金边界。

## 10. 与现有 Gate 的关系

TRACK C 与 Gate 7 / R46 主线**并行**，不占用主线队列。TRACK C 中任何 **Schema 变化、对外动作、支付/合规相关** 变更仍必须回架构方审计并遵守既有 Gate：`Payment activation = OFF` · `autopay = OFF` · `payment collection = OFF` · `external payment write = OFF` · R13 Payment Activation = HOLD · `TRANSPORT = false` · 无生产凭据。
