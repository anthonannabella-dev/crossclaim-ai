# SEO P3 — GAP AUDIT + 首批页面候选矩阵（TRACK C，与 C18 并行）

> 状态：**执行起点**。本文件是 SEO P3 的 gap audit + 首批 20–30 页面候选矩阵（HOST 2026-10-04 指令 §三/§十/§十五）。
> 与 C18 并行、互不阻塞。硬边界不变：External Write = HOLD、Payment = HOLD、Provider Transport = HOLD、
> Production Credentials = HOLD、TRANSPORT=false、`FINAL_ACCEPTANCE_HEAD = 0f7f7ac` 未改动。

## 1. 现状盘点（2026-10-04，HEAD f4a37d5）

| 能力 | 现状 | 证据 |
|---|---|---|
| SEO 设计文档 | 已有 1 份 | `docs/releases/GROWTH-PROGRAMMATIC-SEO-RECOVERY-DATABASE-CONSTRAINT.md` |
| `/recover/{platform}` 路由 | **不存在** | `apps/web/app` 下无 `recover` 目录 |
| sitemap / robots | **不存在** | 无 `sitemap.ts` / `robots.ts` |
| canonical / hreflang / OpenGraph | **未实现** | 页面 metadata 未做 SEO 化 |
| JSON-LD（Breadcrumb / FAQ / Service） | **未实现** | 无结构化数据模块 |
| Recovery Rule 单源（typed contract） | **缺 typed v1** | DB 有 `RuleVersion` 模型，但代码内无 `RecoveryRuleDefinition` 契约；检索 `RecoveryRuleDefinition` / `recoveryType` 在 `apps/api/src`、`apps/web` 无命中 |
| 公开 Checker / Calculator | **不存在** | 现有端点全部 tenant-scoped（需登录 + RBAC）；无匿名只读判定端点 |
| Indexability gate（noindex 规则） | **不存在** | 无 gate 实现与测试 |
| locale 路由 | 现状为 cookie 语言（`i18n/locales.ts`），**无 path locale segment** | `/en/recover/...` 需要新增 path-locale 方案 |
| SEO 分析事件契约 | **不存在** | 无 provider-neutral event contract |
| 产品侧既有能力（可复用） | C1–C21 / CA-1–CA-6、Eligibility、Estimate、Deadline、Claim-Ready Package、Action Guard、Money Ledger | 见 `docs/releases/` 与 `apps/api/src/services/customs` |

结论：SEO 目前处于 **REGISTERED / docs-only**，需要按「Rule 单源 → 公开只读 Checker/Calculator → 页面与 Technical SEO → Indexability gate」顺序实施。

## 2. 缺口清单（对应 HOST §六 20 项技术要求）

| # | 要求 | 缺口 | 计划单元 |
|---|---|---|---|
| 1 | sitemap | 需新增 `app/sitemap.ts`（按 indexable 集合生成） | SEO-5 |
| 2 | robots | 需新增 `app/robots.ts`（声明 sitemap、禁止后台路径） | SEO-5 |
| 3–4 | dynamic metadata / title / description | 需按 Rule + locale 生成 | SEO-5 |
| 5 | canonical | 需规则化：locale 变体指向同一 canonical 版本 | SEO-5 |
| 6 | hreflang | 依赖 path-locale 方案 | SEO-4/5 |
| 7 | OpenGraph | 需统一 OG 生成 | SEO-5 |
| 8–10 | Breadcrumb / FAQ / Service-HowTo JSON-LD | 需结构化数据模块（FAQ 仅在页面真实含 FAQ 时） | SEO-5 |
| 11–13 | internal linking / platform hub / category pages | 需路由与链接图 | SEO-4 |
| 14 | country / jurisdiction pages | 仅在内容实质足够时建立（先不做） | 待定 |
| 15 | related recovery rules | 依赖 Rule 关联字段 | SEO-2 |
| 16–19 | index/noindex / 404 / duplicate slug / expired RuleVersion / canonical version | 需 gate + 校验 | SEO-6 |
| 20 | locale fallback | 需显式 fallback 策略（缺翻回默认 locale 且 hreflang 一致） | SEO-4/8 |

## 3. 首批页面候选矩阵（28 个，来自「搜索意图 × 引擎能力 × 商业价值」）

列说明：`意图` = 用户真实搜索场景；`引擎` = 产品内可复用的判定/材料来源；`商业` = 付费/Success Fee 意图强度（高/中）；
`工具` = 该页应提供的 Checker / Calculator；`初始收录` = 在 Rule 契约与 gate 落地前的默认策略（当前一律 **NOINDEX**，见 §四）。

| # | platform | recoveryType（slug） | 意图 | 引擎来源 | 商业 | 工具 | 初始收录 |
|---|---|---|---|---|---|---|---|
| 1 | customs | duty-overpayment | 多缴关税能否退回 | Customs duty truth / estimate / eligibility | 高 | Calculator | NOINDEX（待 Rule 契约） |
| 2 | customs | wrong-hs-code | HS 归类错误导致多缴 | Discrepancy / classification correction | 高 | Checker+Calculator | NOINDEX |
| 3 | customs | section-301-overpayment | 301 加征是否可退 | Duty truth + jurisdiction policy | 高 | Calculator | NOINDEX |
| 4 | customs | returned-goods-duty-recovery | 退货后关税可否追回 | Return fact / matching | 高 | Checker | NOINDEX |
| 5 | customs | destroyed-goods-duty-recovery | 销毁货物关税追回 | Return/destruction fact | 中 | Checker | NOINDEX |
| 6 | customs | drawback-eligibility | 我是否符合 drawback | Right lineage + eligibility | 高 | Checker | NOINDEX |
| 7 | customs | customs-refund-eligibility | 海关退税资格自检 | Eligibility + deadline | 高 | Checker | NOINDEX |
| 8 | customs | import-duty-refund-calculator | 退税额估算 | Estimate + Money ledger（estimate 标记） | 高 | Calculator | NOINDEX |
| 9 | amazon | lost-inventory-reimbursement | FBA 丢件赔偿 | 平台索赔规则 + 证据包 | 高 | Checker | NOINDEX |
| 10 | amazon | damaged-inventory-reimbursement | 库存破损赔偿 | 同上 | 高 | Checker | NOINDEX |
| 11 | amazon | inbound-shipment-discrepancy | 入仓数量差异 | 平台索赔规则 | 高 | Checker | NOINDEX |
| 12 | amazon | fba-fee-overcharge | FBA 费用多收 | Fee discrepancy | 高 | Calculator | NOINDEX |
| 13 | amazon | weight-dimension-fee-discrepancy | 重量尺寸费差 | Fee discrepancy | 中 | Calculator | NOINDEX |
| 14 | amazon | missing-reimbursement | 应赔未赔 | 索赔台账 | 高 | Checker | NOINDEX |
| 15 | amazon | refund-without-return-discrepancy | 退款未退货差异 | 平台规则 | 中 | Checker | NOINDEX |
| 16 | ups | late-delivery-refund | UPS 迟送退款 | 服务保障 + 运单证据 | 高 | Checker | NOINDEX |
| 17 | fedex | service-guarantee-refund | FedEx 服务保障索赔 | 同上 | 高 | Checker | NOINDEX |
| 18 | dhl | late-delivery-refund | DHL 迟送退款 | 同上 | 中 | Checker | NOINDEX |
| 19 | ups | duplicate-shipping-charge | 重复计费 | 账单差异 | 中 | Checker | NOINDEX |
| 20 | fedex | residential-surcharge-refund | 住宅附加费争议 | 附加费规则 | 中 | Checker | NOINDEX |
| 21 | dhl | fuel-surcharge-discrepancy | 燃油附加费差异 | 附加费规则 | 中 | Calculator | NOINDEX |
| 22 | tiktok-shop | settlement-discrepancy | 结算差异 | 结算对账 | 中 | Checker | NOINDEX |
| 23 | walmart | settlement-discrepancy | 结算差异 | 结算对账 | 中 | Checker | NOINDEX |
| 24 | tiktok-shop | fulfillment-fee-discrepancy | 履约费差异 | 费用对账 | 中 | Calculator | NOINDEX |
| 25 | walmart | missing-reimbursement | 应赔未赔 | 索赔台账 | 中 | Checker | NOINDEX |
| 26 | shopify | chargeback-evidence-checker | 拒付证据是否充分 | Dispute evidence 规则 | 高 | Checker | NOINDEX |
| 27 | stripe | dispute-evidence-package | 争议证据包 | 同上 | 高 | Checker | NOINDEX |
| 28 | paypal | recoverable-dispute-checker | 争议可否追回 | 同上 | 中 | Checker | NOINDEX |

> 说明：矩阵中的「引擎来源」需在 SEO-2（Rule 契约）中落成可执行字段；在 Rule 契约落地前，所有页面保持 **NOINDEX**，
> 不生成 thin content、不做关键词换词。

## 4. Indexability gate（先落地，再放量）

允许 `index` 的必要条件（全部满足）：
1. 引用中的 `RuleVersion` 当前有效（`effectiveFrom ≤ now < effectiveTo`，无冲突版本）；
2. 存在真实 Recovery capability（对应域的引擎能力可用）；
3. 至少存在 Checker 或 Calculator 中一个**真实可用路径**；
4. 页面有实质内容（problem / who qualifies / deadline / required evidence / calculation ≥ 各段非空）；
5. 有真实 `sourceReferences`；
6. title / eligibility / evidence / calculation 段落完整；
7. 非 thin content；canonical 明确。

任一不满足 → **NOINDEX**。默认策略为 NOINDEX，只有通过 gate 才切 INDEX。

## 5. 实施单元（已登记进 SAFE CONTINUATION QUEUE，与 C18 并行）

| 单元 | 内容 | 风险 | 架构审计 |
|---|---|---|---|
| SEO-1 | 本 gap audit + 候选矩阵 | LOW | NO |
| SEO-2 | `RecoveryRuleDefinition v1` typed contract（platform/category/recoveryType/country/region/title/slug/problemDescription/eligibility/requiredEvidence/calculationMethod/filingDeadline/submissionMethod/feeModel/supportedMode/ruleVersion/effectiveFrom/effectiveTo/sourceReferences/calculatorCapability/checkerCapability/ctaMode） | HIGH | **YES（Rule contract 实质变化）** |
| SEO-3 | 公开只读 Checker / Calculator（匿名、rate limited、无租户数据、无 PII、零外写、estimate 明确标注） | HIGH | **YES（public API security boundary）** |
| SEO-4 | `/recover/{platform}` + `/recover/{platform}/{recoveryType}` + locale segment + platform hub + related rules | MEDIUM | NO（若 locale path 影响既有 i18n 架构则转审计） |
| SEO-5 | Technical SEO：sitemap / robots / metadata / canonical / hreflang / OG / JSON-LD（Breadcrumb/FAQ/Service） | MEDIUM | NO |
| SEO-6 | Indexability gate + thin content + duplicate slug + expired RuleVersion + canonical version 选择 | MEDIUM | NO |
| SEO-7 | provider-neutral SEO 事件契约（seo_page_view / checker_* / calculator_* / estimated_recovery_shown / connect_clicked / upload_clicked / signup_* / recovery_started） | LOW | NO |
| SEO-8 | SEO contract tests + locale parity/fallback + 重复/slug 冲突 + 全量回归 | MEDIUM | NO |

## 6. 与 C18 的并行关系

- C18（真实 Provider 接入）与 SEO P3 **互不阻塞**：SEO 页面/Checker/Calculator 大量使用既有内部规则与 estimate 能力，不需要真实凭据；
- SEO 的 Checker/Calculator 只读、无租户数据、estimate 必须标注为估算，绝不触达 external write / payment / submission；
- 真实 Provider 未获批不影响 SEO 页面、Technical SEO、结构化数据与内部链接建设。
