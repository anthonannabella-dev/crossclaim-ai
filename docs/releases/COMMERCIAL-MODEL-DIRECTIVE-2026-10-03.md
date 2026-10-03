# HOST DIRECTIVE 2026-10-03 — ACQUISITION + 15% SUCCESS-FEE COMMERCIAL MODEL FINALIZATION

状态：**REGISTERED / SUPERSEDES（旧 Customs Self-Service Pricing）**；收费政策改动属**资金链路** → 实施前需架构方审计。
登记基线：`cda3d30`（登记时实际 HEAD 见 STATE.json / 本提交）。

## 1. 统一商业原则（最新唯一口径）

`FREE AUDIT` → `MANAGED RECOVERY` → `ACTUAL RECOVERY RECEIVED` → **15% SUCCESS FEE**

英文：Free to find. Pay only when we recover. No recovery, no fee. 15% after actual recovery.
中文：免费帮你找钱；真正追回到账后才收费；未追回 $0；成功追回仅收 15%。

## 2. 关键规则

- **不新增基础审核费**：不得出现 audit fee / case opening fee / file retrieval fee（$15 / $20 / $25 …）。低价值客户用 **Execution Threshold**（服务器配置化阈值）过滤，低于阈值 → 免费展示结果、不进入高成本人工执行。
- **平台/物流统一**：Amazon / TikTok Shop / Walmart / Shopify（及未来 payment recovery）、UPS / FedEx / DHL / Freight Forwarder / Carrier SLA / Billing Overcharge 一律同一漏斗 + `STANDARD_SUCCESS_FEE = 15%`；**不得客户端指定费率**，继续使用 server-side / versioned / trusted Fee Policy。
- **Customs（最新）**：`FREE CUSTOMS AUDIT` → Qualified Customs Recovery Opportunity → Customs Recovery Agreement → Managed Recovery → Verified Actual Incremental Recovery Received → **`CUSTOMS_SUCCESS_FEE = 15%`**。旧口径（FREE AUDIT → PAID PACKAGE → SUBSCRIPTION，$299 / $699 / $1,499 / $2,999）全部 **SUPERSEDED**（保留历史审计记录）。
- **Customs 不做正常退税**：不建 China normal export tax refund / normal VAT refund filing / normal statutory refund workflow / normal tax filing SaaS；`NORMAL_STATUTORY_ENTITLEMENT` 只作排除分类（`successFeeEligible = false`）。收费对象仅限异常增量追回（CUSTOMS_OVERPAYMENT / DUPLICATE_DUTY / RATE_OVERPAYMENT / MISSED_EXCLUSION / CONFIRMED_PREFERENCE_MISSED / 其他 confirmed abnormal·incremental recovery）。
- **计费基数永久规则**：`Success Fee = Verified Actual Incremental Recovery Received × 15%`；**不得**用 estimated recovery / approved amount / expected recovery / normal statutory entitlement 作基数（示例：Estimated 10,000 / Approved 8,500 / Actual 7,000 → Fee = 1,050）。
- **CUSTOMS_VIP_WAIVER**：不是让 Customs 免费，而是以 Platform / Logistics 佣金减免换高价值 Customs 客户；触发条件（全部服务器配置化）：Customs estimated recovery ≥ 阈值 + `classificationDecision == ELIGIBLE` + Customs Agreement SIGNED；支持 `waiverCap`。
- **客户分层**：Tier A 高价值 Customs（Priority Recovery / Broker·Licensed Partner 路线 / 可选平台·Carrier 费减免 / Customs 15%）；Tier B 标准回收（≥ execution threshold / Managed Recovery / 15%）；Tier C Micro Opportunity（低于阈值 → 免费展示，不进入高成本人工执行）。
- **Free Audit ≠ Free Recovery**：免费覆盖 Connect / Upload / Scan / Opportunity Count / Estimated Recovery / 高层原因 / 证据完整度 / 缺失数据 / 回收类别；Managed Recovery 到账后统一 15%。
- **SEO / Free Tool 获客**：Amazon FBA Refund Checker、TikTok Shop Loss Checker、Walmart Recovery Checker、UPS Refund Checker、FedEx SLA Refund Checker、DHL Refund Checker、Customs Duty Overpayment Checker、Duplicate Duty Checker、Tariff / Exclusion Checker；统一 CTA「Scan for free」，进入 Account → Connect/Upload → Free Audit → Opportunity → Managed Recovery → Actual Recovery → 15%。
- **平台信号与 Customs 判断严格分离**：Amazon / TikTok / Walmart / Shopify 授权只能产生 `CUSTOMS_OPPORTUNITY_SIGNAL`；不得直接确认 CUSTOMS_OVERPAYMENT / recoverableAmount / successFeeEligible；Customs 判断必须来自 Broker / Customs Entry / Duty Payment / Customs Documents / Tariff Rules。
- **所有 Fee 路径统一 Guard（含 record-fee.ts、commission-reconciliation.ts 与未来所有 FeeCalculation 创建路径）**：`RecoveryCommercialEligibility` → `SettlementFeeEligibility` → Server Fee Policy → FeeCalculation；只有 `incrementalRecovery == true` + `successFeeEligible == true` + `classificationDecision == ELIGIBLE` + actual recovery received 才允许收费。

## 3. 仓库收口要求（本次已执行/待执行）

- 已执行：本指令留档；`STATE.json` 记录最新商业模型；旧 Customs Self-Service Pricing 文档标记 **SUPERSEDED**（保留历史）。
- 待架构方审计后执行（资金链路）：`FeePolicy` 默认费率 20% → **15%**（STANDARD / CUSTOMS 两档）、Execution Threshold、`CUSTOMS_VIP_WAIVER`（含 waiverCap）、Commercial Policy 枚举 `STANDARD_SUCCESS_15` / `CUSTOMS_SUCCESS_15` / `CUSTOMS_VIP_WAIVER` / `ENTERPRISE_CUSTOM_RATE` / `MICRO_NOT_SERVICED`、以及统一 Fee Guard 的落地与回归（含 client-supplied rate 拒绝）。
- 文档同步：`PRODUCT_SPEC.md`、`.autopilot/TASKS.md`、commercial policy docs、Customs pricing docs。

## 4. 明确不重构

继续复用 Settlement / RecoveryPayout / FeeCalculation / FeeCalculationSettlement / FeePolicy / BillingInvoice / Payment / Reversal；**不得**因 20% → 15% 重构 Recovery Engine。只改：Commercial Policy、Product Spec、Commercial Documents、Default Fee Policy、Tests / Acceptance；金额一律由服务器可信、版本化 Fee Policy 提供。

## 5. 边界

NO platform write · TRANSPORT=false · Payment = 0（不发起扣款）· autopay = OFF · collection = OFF · R13 HOLD · 无生产凭据；真实外写 / 海关申报 / 牌照代理继续 HOLD。

## 6. Host 原文（逐字留档）

```text
[HOST → CODEX] CROSSCLAIM — ACQUISITION + 15% SUCCESS-FEE COMMERCIAL MODEL FINALIZATION

请将以下内容作为 CrossClaim 当前最新商业模式与获客逻辑，并对仓库内旧的 Customs Self-Service Pricing 口径做 SUPERSEDE（覆盖但保留历史记录）。

参考当前开发基线：
"cda3d30"

1. 最终统一商业原则

CrossClaim 对外统一为：

FREE AUDIT
免费发现资金机会
↓
MANAGED RECOVERY
CrossClaim 推进追回
↓
ACTUAL RECOVERY RECEIVED
客户实际收到增量追回资金
↓
15% SUCCESS FEE

统一对外口径：

Free to find.
Pay only when we recover.
No recovery, no fee.
15% after actual recovery.

中文：

免费帮你找钱。
真正追回到账后才收费。
未追回，$0。
成功追回仅收15%。

---

2. 不增加基础审核费

不要增加：

$15 / $20 / $25
audit fee
case opening fee
file retrieval fee

防止低价值客户占用资源，使用：

Execution Threshold

例如：

estimated recovery < configurable threshold
→ 免费展示结果
→ 不进入高成本人工追回

阈值服务器配置化。

---

3. Platform / Logistics 统一收费

覆盖：

Amazon
TikTok Shop
Walmart
Shopify / future payment recovery

UPS
FedEx
DHL
Freight Forwarder
Carrier SLA
Billing Overcharge

统一：

FREE AUDIT
↓
Recovery
↓
Actual Recovery Received
↓
15% Success Fee

默认商业政策：

STANDARD_SUCCESS_FEE = 15%

不得客户端自行指定费率。

继续使用：

server-side
versioned
trusted Fee Policy

---

4. Customs 商业模式

旧：

FREE AUDIT
→ PAID PACKAGE
→ SUBSCRIPTION
→ Managed Recovery later

以及：

$299
$699
$1,499
$2,999

全部标记：

SUPERSEDED

但保留历史审计记录。

最新 Customs：

FREE CUSTOMS AUDIT
↓
Qualified Customs Recovery Opportunity
↓
Customs Recovery Agreement
↓
Managed Recovery
↓
Verified Actual Incremental Recovery Received
↓
15% Success Fee

默认：

CUSTOMS_SUCCESS_FEE = 15%

---

5. Customs 不做正常退税

不建设：

China normal export tax refund
normal VAT refund filing
normal statutory refund workflow
normal tax filing SaaS

"NORMAL_STATUTORY_ENTITLEMENT"

只能作为排除分类：

successFeeEligible = false

Customs 收费对象仅限异常增量追回，例如：

CUSTOMS_OVERPAYMENT
DUPLICATE_DUTY
RATE_OVERPAYMENT
MISSED_EXCLUSION
CONFIRMED_PREFERENCE_MISSED
其他 confirmed abnormal / incremental recovery

---

6. 成功费计算公式

永久规则：

Success Fee
=
Verified Actual Incremental Recovery Received
× 15%

例如：

Estimated Recovery: $10,000
Approved: $8,500
Actual Received: $7,000

CrossClaim Fee:
$7,000 × 15%
= $1,050

不得使用：

estimated recovery
approved amount
expected recovery
normal statutory entitlement

作为收费基数。

---

7. 高价值 Customs 客户减免

新增：

CUSTOMS_VIP_WAIVER

目的不是让 Customs 免费。

而是：

用 Platform / Logistics 的佣金减免
换取高价值 Customs Recovery 客户

例如：

Platform recovered = $3,000
Carrier recovered = $2,000

Standard Fee:
$5,000 × 15%
= $750

若发现：

Qualified Customs Opportunity = $80,000

且：

Customs qualification = ELIGIBLE
Customs Agreement = SIGNED

商业政策可以：

Platform / Logistics $750 Fee
→ WAIVED

Customs 实际追回：

$60,000
× 15%
= $9,000

---

8. Waiver 必须配置化

Commercial Policy 至少支持：

STANDARD_SUCCESS_15
CUSTOMS_SUCCESS_15
CUSTOMS_VIP_WAIVER
ENTERPRISE_CUSTOM_RATE
MICRO_NOT_SERVICED

例如：

Customs estimated recovery >= configurable threshold
AND
Customs classificationDecision == ELIGIBLE
AND
Customs Agreement == SIGNED

才允许 Platform / Logistics Fee Waiver。

可支持：

waiverCap

全部服务器配置化。

---

9. 客户分层

Tier A — High Value Customs

高价值 Customs Opportunity

策略：

Priority Recovery
Broker / Licensed Partner Route
Platform / Carrier Fee Waiver 可选
Customs 15% Success Fee

Tier B — Standard Recovery

Platform / Logistics
≥ minimum execution threshold

策略：

Managed Recovery
15% Success Fee

Tier C — Micro Opportunity

below execution threshold

策略：

免费展示结果
不进入高成本人工执行

---

10. Free Audit ≠ Free Recovery

免费包括：

Connect
Upload
Scan
Opportunity Count
Estimated Recovery
High-level Reason
Evidence Completeness
Missing Data
Recovery Category

但：

Managed Recovery

成功到账以后统一：

15%

---

11. SEO / Free Tool Acquisition

支持：

Amazon FBA Refund Checker
TikTok Shop Loss Checker
Walmart Recovery Checker
UPS Refund Checker
FedEx SLA Refund Checker
DHL Refund Checker
Customs Duty Overpayment Checker
Duplicate Duty Checker
Tariff / Exclusion Checker

统一 CTA：

Scan for free

进入：

Account
→ Connect / Upload
→ Free Audit
→ Recovery Opportunity
→ Managed Recovery
→ Actual Recovery
→ 15%

---

12. Platform 与 Customs 判断严格分离

Amazon / TikTok / Walmart / Shopify 授权：

只能产生：

CUSTOMS_OPPORTUNITY_SIGNAL

不得直接确认：

CUSTOMS_OVERPAYMENT
recoverableAmount
successFeeEligible

真正 Customs 判断必须来自：

Broker
Customs Entry
Duty Payment
Customs Documents
Tariff Rules

---

13. 所有 Fee 路径统一 Guard

包括：

record-fee.ts
commission-reconciliation.ts
未来所有 FeeCalculation creation path

必须统一经过：

RecoveryCommercialEligibility
↓
SettlementFeeEligibility
↓
Server Fee Policy
↓
FeeCalculation

只有：

incrementalRecovery == true
successFeeEligible == true
classificationDecision == ELIGIBLE
actual recovery received

才允许收费。

---

14. 对外营销最终统一口径

英文：

Free Audit.
No Recovery, No Fee.
15% only after actual recovery.

中文：

免费扫描跨境经营中被多收、漏赔和错收的钱。

发现免费。

真正追回到账后才收费。

未追回，$0。

成功追回仅收15%。

Customs：

Customs Recovery 无前期费用。
仅对实际增量追回到账金额收取15%成功费。

高价值 Customs：

符合 Customs Recovery 条件并完成签约的客户，
可根据商业政策获得 Platform / Carrier Recovery Fee 减免。

不要表述：

Customs Recovery 全程免费

---

15. 仓库收口

同步：

PRODUCT_SPEC.md
.autopilot/TASKS.md
.autopilot/STATE.json
commercial policy docs
Customs pricing docs

旧：

CUSTOMS SELF-SERVICE PRICING
PAID CLAIM PACKAGE
299 / 699 / 1499 / 2999

标记：

SUPERSEDED

长期规则更新为：

CrossClaim Acquisition
= FREE AUDIT

CrossClaim Monetization
= SUCCESS FEE AFTER ACTUAL RECOVERY

Default Success Fee
= 15%

Platform / Logistics
= 15%

Customs Managed Recovery
= 15%

High-value Customs customers
= configurable Platform / Logistics fee waiver

Normal statutory entitlement
= NOT BILLABLE

---

16. 不重构现有资金底座

继续复用：

Settlement
RecoveryPayout
FeeCalculation
FeeCalculationSettlement
FeePolicy
BillingInvoice
Payment
Reversal

不得因为佣金从20%调整到15%重构 Recovery Engine。

只修改：

Commercial Policy
Product Spec
Commercial Documents
Default Fee Policy
Tests / Acceptance

所有金额计算继续由服务器可信、版本化 Fee Policy 提供。

最终产品原则：

CrossClaim 用免费扫描获客，以实际追回到账后的15%成功费变现；Customs 高价值机会用于提升 LTV，并可通过平台/物流佣金减免促进转化。
```
