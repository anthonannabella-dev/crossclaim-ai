# CROSS-SYSTEM RECOVERY LAYER —— R46 后高级版本核心主线与长期 Architecture Constraint

状态：**REGISTERED（docs-only：不改代码、不改 Schema、不重构、不打断当前主线）**
来源：HOST PRODUCT / ARCHITECTURE PRIORITY UPDATE — CROSS-SYSTEM RECOVERY LAYER（宿主指令；原文见附录 A，逐字保留）
登记时间：2026-10-02（UTC）；登记时 HEAD = `be579fd`。

## 0. 一句话

> CrossClaim connects marketplaces, payments, carriers and customs into one recovery graph,
> finds where money leaked, and turns each discrepancy into an executable recovery case.
>
> CrossClaim 把平台、支付、物流和关税连接成一张资金追回图谱，找到钱在哪个环节漏掉，并把每个异常自动变成可执行的追回案件。

差异化不是「支持多少平台」，而是 **Cross-System Reconciliation + Recovery Graph + Cross-Domain Recovery Engine**：
判断「理论上应该回来多少钱」vs「实际上回来多少钱」，从而发现**单个平台自身无法发现**的资金损耗。

## 1. 队列关系与执行顺序（重要，避免误读为打断主线）

- R46（S1–S6）已 **CLOSED**（MSG-20261002-65）；资金域不再扩展。
- 当前在跑的主线是 **TRACK C2（Multi-Account Foundation）**——由架构方 MSG-65 ③ / MSG-66 指定，排在 TRACK B 与 Growth SEO 之前。
- 本指令的 **P0-1（PlatformAccount Identity）与 TRACK C2 是同一件事**：MSG-66 已批准 M1–M6，slice 2a 已交付（`9496d3e`：account scope 下推 + 事实身份账户作用域 + 绑定不可变 + 跨租户守卫；188 files / 1854 tests PASS；fresh deploy PASS）。
  → **不重复造系统、不重做已完成的审计**；X1 只审计 TRACK C2 未覆盖的部分。
- 因此实际执行顺序为：**完成 TRACK C2（slice 2b → C2 FINAL 送审）→ PHASE X1 Architecture Audit → X2 最小提案送审 → X3…X7**。
- 队列影响：对 R46 = **NONE**（已关闭）；对 TRACK C2 = **NONE**（不打断），但 C2 slice 2b 的验收口径需与本文件 §10 的账号隔离项对齐。

## 2. 复用强制（禁止平行系统）

> 下一阶段目标不是「新建 CrossSystemXXX 全套模型，把旧系统废掉」，而是**先识别缺失能力，在现有领域模型上补最小、清晰、可审计的层**。

| 复用资产 | 用途（新阶段） |
|---|---|
| `CanonicalFact` / `CanonicalFactSource` | 事实层与来源溯源：Entity Resolution 与 Graph Builder 的**唯一事实输入** |
| `PlatformAccount` / `SourceConnection.platformAccountId` / 各表 `accountId` | 账户归属与跨店隔离（TRACK C2 已落地，见 §1） |
| `RecoveryGraphNode` / `RecoveryGraphEdge` | 关系表达载体（Schema 已存在；**能力**待 X5 实现） |
| `RecoveryOpportunity` / `ClaimItem` / `EvidenceArtifact` / `RecoveryPackage` | 追回链路下半段，直接复用 |
| `RecoveryManualSubmission` / `PlatformWriteAttempt` / `providerCaseRef*` | 对外提交与平台真实状态区分（TRACK S 冻结） |
| `ProviderOutcomeFact` / `ReimbursementFact` / `ClaimReconciliationProjection` | 结果与到账对账 |
| `Settlement` / `FeeCalculation` / `BillingInvoice` + R46 只读一致性检查器 | 资金链，保持既有独立审批与不可变边界 |
| Action Guard / HITL / tenant isolation / append-only / idempotency / audit trail | 全部继续适用 |
| `services/reconciliation/*`（factKey / 冲突判定 / fail-closed） | 跨来源对账语义，Entity Resolution 必须与之一致 |

## 3. 四项 P0 缺口与现状映射

| P0 能力 | 现状 | 结论 |
|---|---|---|
| **P0-1 PlatformAccount Identity** | TRACK C2（MSG-65/66 裁决）已批准并实施：`Platform` 枚举 + `PlatformAccount`（org+platform+externalAccountId+identityVersion）+ `SourceConnection.platformAccountId` + `accountId` 下推到 SourceTransaction / CanonicalFact / RecoveryOpportunity / ClaimItem / EvidenceArtifact + 结构化唯一 `(organizationId, accountId, factKey)` + legacy partial unique + 回填 fail-closed + 绑定写一次 + 跨租户守卫 | **覆盖中**：slice 2a 已交付（HEAD 9496d3e，188 files / 1854 tests PASS）；slice 2b 待补 Opportunity/ClaimItem/EvidenceArtifact 服务端接线与跨账户拒绝 |
| **P0-2 Cross-Provider Entity Resolution** | 缺能力。现有 `CanonicalFact.factKey` 只做**同种外部引用**的归一（同一 provider 内的 orderId/trackingNo 等），跨 provider（TikTok orderId ↔ UPS trackingNo ↔ Stripe paymentIntent）没有任何确定性关联机制 | **缺口**：X4 实现 v1（仅确定性匹配） |
| **P0-3 Recovery Graph Builder** | `RecoveryGraphNode` / `RecoveryGraphEdge` Schema 已存在，但**没有 builder 把 CanonicalFacts 转成图**；现有 usage 有限 | **缺口**：X5 实现（幂等重建 + provenance/version） |
| **P0-4 Cross-Domain Recovery Rules** | Rule Engine 目前主要面向**单一 fact / 单一 provider**（RuleSet / RuleVersion / RuleEvaluation 输入是事实集合，但没有跨 provider 实体与跨域条件的正式契约） | **缺口**：X6 只做 1–3 条高价值规则（TikTok + Carrier 先行） |

四项共同组成 **CROSS-SYSTEM RECOVERY LAYER**。

## 4. Entity Resolution 置信度边界（冻结）

- **HIGH CONFIDENCE**（可形成确定性关系）：exact order reference · exact tracking number · exact payment/order reference · exact settlement reference · exact platform case reference · exact customs entry reference。
- **MEDIUM CONFIDENCE**（只能形成候选）：amount + currency + timestamp window · merchant reference · invoice/order mapping · SKU + fulfillment reference。
- **LOW CONFIDENCE**（不得自动确认）：fuzzy time/amount similarity。

三种结果：`AUTO_MATCH` / `CANDIDATE_MATCH` / `AMBIGUOUS`。
**AMBIGUOUS 必须 fail-closed（人工复核）**；低置信度匹配不得直接形成不可逆事实；
**禁止**因为「amount 相同、日期接近」就自动把两笔不同交易合并。

## 5. Recovery Graph Builder 要求（X5）

`Canonical Facts / resolved entities → 自动生成/更新 Recovery Graph`。
可复用现有 Edge 语义（`RELATED_TO` / `DERIVED_FROM` / `SAME_SHIPMENT` / `RESPONSIBLE_FOR` / `CAUSES` / `DUPLICATES`），但每条 Edge 必须明确：
**builder · identity basis · confidence · provenance · rule/version · createdAt · evidence/source references**。

> 禁止把 LLM 推断直接写成高可信 Graph Edge。LLM 只能产生 **candidate**；最终写入必须走确定性规则或可审计的人工确认。

## 6. Cross-Domain Recovery Rules 示例（X6，先做 TikTok + Carrier）

1. `TIKTOK_REFUND_WITH_DELIVERY_PROOF`：TikTok Refund = FULL_REFUND **AND** Carrier Shipment = DELIVERED **AND** POD = AVAILABLE **AND** Settlement 包含全额退款扣减 → `RecoveryOpportunity(REFUND_WITH_DELIVERY_PROOF)`。
2. `CARRIER_INVOICE_OVERCHARGE`：CarrierInvoice.actualCharge > contractExpectedCharge + allowedSurcharge **AND** shipment 归属已确认的 Marketplace/Shopify order。
3. `MARKETPLACE_PAYOUT_SHORTFALL`：Expected Settlement − Known Refunds − Known Fees − Known Adjustments ≠ Actual Payout（在全部已知调整已 reconciliation 之后仍存在差额）。
4. `DOUBLE_LOSS`：Marketplace 已退款买家 **AND** carrier 已成功派送 **AND** carrier invoice 仍含争议附加费 → 同一 commerce entity 产生 A（marketplace refund discrepancy）与 B（carrier billing correction）两个 Opportunity，并展示该 commerce entity 的 Total Recoverable。

## 7. RecoveryOpportunity 必须支持跨系统来源（X1 审计项）

现有 `RecoveryOpportunity.domain` / `channel` 可能过于「单渠道化」。未来一个 Opportunity 可能由 TikTok + UPS + POD + Settlement 共同产生，因此必须能追溯：
**all source facts · involved providers · involved PlatformAccounts · evidence · graph entity · rule version · match confidence**。
优先用现有 link table / evidence / graph 表达；**表达不了再提最小 Schema Delta Proposal**（Design First）。

## 8. 「多平台菜单」不等于完成

左侧菜单加 Amazon / TikTok / Walmart / Shopify / UPS / FedEx / Customs，但各模块仍「各自独立、不共享身份、不共享事实、不互相验证、不共同产生 Recovery Opportunity」→ 仍然只是「多个单点 Recovery Tool 放到一个 Dashboard」。
真正完成标准是：**平台之间的数据能发生关系**。

## 9. 阶段计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **X1 Architecture Audit** | 审计 PlatformAccount gap / canonical account scope / factKey·dedupeKey / existing Graph usage / opportunity source model | **只出报告**（docs-only），不改代码 |
| **X2 Minimal Architecture Proposal** | 只针对真实缺口：minimal Schema Delta / service boundary / identity model / graph builder / rule input contract | 先送审（Design First） |
| **X3 PlatformAccount + Account Isolation** | 账户归属与跨店误合并风险 | 复用 TRACK C2 成果；只补未覆盖部分 |
| **X4 Entity Resolution v1** | 只做确定性匹配：order reference / tracking / settlement ref / payment reference | 模糊匹配不自动确认 |
| **X5 Recovery Graph Builder v1** | 把已有 facts 转成可查询 Graph | 幂等 + provenance + version |
| **X6 First Cross-System Rule** | TikTok + Carrier，仅 1–3 条高价值规则 | 跨系统 RecoveryOpportunity |
| **X7 End-to-End Validation** | synthetic → anonymized real data → human verification | 可演示的端到端 Cross-System Slice |

## 10. 永久验收矩阵（18 项；作为后续永久回归基线）

1. 同 Organization、不同 `PlatformAccount` 相同 orderId 不得合并。
2. 不同 Organization 数据绝不关联。
3. exact tracking 可以把 marketplace order 与 carrier shipment 建立候选/确定关系。
4. ambiguous tracking/order 映射 fail-closed。
5. 仅金额 + 时间相近不得自动高可信合并。
6. resolved entity 能追溯全部原始 `SourceTransaction`。
7. Graph Edge 能追溯 identity basis 与 rule/version。
8. Graph rebuild 幂等。
9. 同一事实重复导入不重复建 Graph。
10. refund + delivered + POD 能产生指定 Cross-System Opportunity。
11. 缺 POD 时不得产生同级确定性 Recovery 结论。
12. Carrier invoice correction 与 Marketplace recovery 可以同时存在。
13. 一个 commerce entity 可以拥有多个 `RecoveryOpportunity`。
14. `RecoveryOpportunity` 不能因 Graph rebuild 被重复创建。
15. Graph/Identity 失败不得影响现有 Claim/Settlement 历史事实。
16. tenant isolation / account isolation 继续 fail-closed。
17. 无 Production API / 无 external write / 无 payment activation。
18. 现有 R45/R46 全量回归必须保持绿。

## 11. 成功判据与长期北极星

**成功判据（必须可演示）**：一个真实或脱敏商家的 `TikTok Order + TikTok Settlement/Refund + UPS/FedEx Shipment + POD` 进入系统后，自动判断这些数据属于同一笔 commerce transaction，发现某笔 refund / settlement / carrier charge 存在 Recovery Opportunity，并生成 amount / reason / source facts / evidence / responsible party / recovery route / Claim-Ready Package —— 且该 Opportunity「只有把两个或多个系统的数据放在一起才能发现」。

**第一条真实 Cross-System Slice = TikTok + Carrier**，随后 Shopify + Stripe/PayPal + Carrier → Amazon + Carrier → Customs。

**长期北极星**：Canonical Fact Layer + Platform Account Identity + Entity Resolution + Recovery Graph + Cross-Domain Recovery Rules + Recovery Outcome Data，形成 Recovery Intelligence 数据飞轮（哪种异常 / 哪个平台 / 哪个 Carrier / 哪种 Evidence / 什么 Rule / Claim 是否成功 / Appeal 是否成功 / 实际追回金额 / 回款时间）。

## 12. 执行要求与既有 HOLD（不变）

1. 当前主线不停（R46 已关闭；TRACK C2 继续到 C2 FINAL）。
2. 不立即重构。
3. C2 收口后先做 Architecture Audit（PHASE X1，只出报告）。
4. 优先复用现有 CanonicalFact / RecoveryGraph / Reconciliation。
5. **Schema 变更必须 Design First**（先送架构方裁决）。
6. Production / external write / payment / real credentials 继续 **HOLD**；`TRANSPORT=false`、R13 Payment Activation HOLD、Payment = 0 不变。
7. 新阶段最高优先级不是增加平台数量，而是让平台之间的数据真正发生关系。

## 附录 A：宿主原文（verbatim）

```text
[PRODUCT / ARCHITECTURE PRIORITY UPDATE — CROSS-SYSTEM RECOVERY LAYER]

这是 CrossClaim R46 之后的高级版本主线调整。

重要：

- 不打断当前 R46；
- R46 按既定审计、测试、Settlement/Billing linkage 继续收口；
- 当前 Production HOLD / external write HOLD / payment HOLD / HITL / Action Guard 全部保持；
- 本指令主要定义 R46 完成后的下一阶段优先级；
- 不要求立即大规模重构；
- 先审计现有 CanonicalFact / RecoveryGraph / ClaimItem / Reconciliation 能力，优先复用。

---

一、重新明确 CrossClaim 的核心竞争差异化

CrossClaim 的核心差异化不是：

“支持 Amazon + TikTok + Walmart + Shopify + UPS + FedEx + Customs。”

单纯 Multi-Platform 不足以形成壁垒。

真正目标是：

CROSS-SYSTEM RECONCILIATION
+
RECOVERY GRAPH
+
CROSS-DOMAIN RECOVERY ENGINE

即：

把 Marketplace、Payment、Carrier、Customs 的数据连接成同一张 Recovery Graph，

识别同一笔商业交易在：

- Order
- Payment
- Shipment
- Inventory
- Return
- Refund
- Fee
- Settlement
- Payout
- Carrier Invoice
- Customs Entry
- Claim
- Recovery

之间的关系，

并判断：

“理论上应该回来多少钱”
vs
“实际上回来多少钱”

从而发现单个平台自身无法发现的资金损耗。

最终产品定义：

CrossClaim connects marketplaces, payments, carriers and customs into one recovery graph, finds where money leaked, and turns each discrepancy into an executable recovery case.

中文：

CrossClaim 把平台、支付、物流和关税连接成一张资金追回图谱，找到钱在哪个环节漏掉，并把每个异常自动变成可执行的追回案件。

---

二、当前底座必须优先复用

当前已有能力包括但不限于：

- CanonicalFact
- CanonicalFactSource
- RecoveryGraphNode
- RecoveryGraphEdge
- RecoveryOpportunity
- ClaimItem
- EvidenceArtifact
- RecoveryPackage
- RecoveryManualSubmission
- ProviderOutcomeFact
- ReimbursementFact
- ClaimReconciliationProjection
- Settlement
- Billing / Fee 基础链
- Action Guard
- HITL
- tenant isolation
- append-only facts
- reconciliation
- idempotency
- audit trail

因此：

禁止重新造一套平行系统。

下一阶段目标不是：

“新建 CrossSystemXXX 全套模型，把旧系统废掉。”

而是：

先识别缺失能力，
在现有领域模型上补最小、清晰、可审计的层。

---

三、当前真正缺失的四块能力

P0 — PlatformAccount Identity
P0 — Cross-Provider Entity Resolution
P0 — Recovery Graph Builder
P0 — Cross-Domain Recovery Rules

这四项共同组成：

CROSS-SYSTEM RECOVERY LAYER

---

四、P0-1 PlatformAccount Identity

首先解决：

“这条数据到底属于哪个公司、哪个平台、哪个店铺/账号？”

目标关系：

User
→ Organization
→ PlatformAccount
→ SourceConnection
→ SourceTransaction
→ CanonicalFact

PlatformAccount 至少需要稳定表达：

- organizationId
- platform / provider
- externalAccountId
- sellerId / merchantId / storeId（按平台）
- marketplace / region
- displayName
- status
- stable external identity
- lifecycle
- createdAt / updatedAt

原则：

1. 不允许长期依赖 label 作为账号身份；
2. 一个 PlatformAccount 可以挂多个 SourceConnection；
3. 一个 Organization 可以有多个相同 Platform 的 PlatformAccount；
4. 不同 PlatformAccount 的相同 orderId / externalId 不得互相 dedupe；
5. Store A 授权失效不得影响 Store B；
6. 历史事实即使 Connection revoke，也必须保留 Account provenance。

请先审计现有：

SourceConnection
SourceTransaction
CanonicalFact
factKey
dedupeKey
sourceFingerprint
ClaimItem.platformRef

是否已经包含足够的 account scope。

如存在跨店碰撞风险，优先修这个问题。

---

五、P0-2 Cross-Provider Entity Resolution

目标：

系统能够判断来自不同系统的数据是否属于同一笔真实商业交易。

示例：

TikTok:

orderId = TT-983721
trackingNo = 1Z999AA123

UPS:

trackingNo = 1Z999AA123
invoiceNo = INV-8881

Stripe:

paymentIntent = pi_123
metadata.order = TT-983721

TikTok Settlement:

orderId = TT-983721
refund = 120 USD

这些不能继续只是四组孤立记录。

CrossClaim 应能够形成：

Transaction / Commerce Entity
├─ Marketplace Order
├─ Payment
├─ Shipment
├─ Carrier Invoice
├─ POD
├─ Refund
├─ Settlement
└─ Payout

请设计统一 Identity Resolution 机制。

允许使用的匹配依据可以包括：

HIGH CONFIDENCE:

- exact order reference
- exact tracking number
- exact payment/order reference
- exact settlement reference
- exact platform case reference
- exact customs entry reference

MEDIUM CONFIDENCE:

- amount + currency + timestamp window
- merchant reference
- invoice/order mapping
- SKU + fulfillment reference

LOW CONFIDENCE:

- fuzzy time/amount similarity

要求：

低置信度匹配不得直接形成不可逆事实。

应：

AUTO_MATCH
或
CANDIDATE_MATCH
或
AMBIGUOUS

并且 AMBIGUOUS 必须 fail-closed / human review。

禁止因为：

amount 相同
日期接近

就自动把两笔不同交易合并。

---

六、P0-3 Recovery Graph Builder

现有：

RecoveryGraphNode
RecoveryGraphEdge

已有 Schema，不代表能力已经完成。

下一阶段需要真正实现 Graph Builder。

目标：

Canonical Facts / resolved entities
↓
自动生成/更新 Recovery Graph

例如：

Organization
↓
PlatformAccount
↓
Order
├─ Payment
├─ Shipment
│   ├─ Tracking
│   ├─ POD
│   └─ Carrier Invoice
├─ Return
├─ Refund
├─ Settlement
├─ Payout
└─ Customs Entry

Graph Edge 可以复用现有：

RELATED_TO
DERIVED_FROM
SAME_SHIPMENT
RESPONSIBLE_FOR
CAUSES
DUPLICATES

但需要明确每种 Edge 的：

- builder
- identity basis
- confidence
- provenance
- rule/version
- createdAt
- evidence/source references

禁止把 LLM 推断直接作为高可信 Graph Edge。

LLM 可以产生 candidate，
最终写入必须走确定性规则或可审计人工确认。

---

七、P0-4 Cross-Domain Recovery Rules

这是整个新阶段最重要的产品能力。

当前 Rule Engine 如果主要判断单一 provider / 单一 fact，
下一阶段要支持：

MULTI-FACT
MULTI-PROVIDER
MULTI-DOMAIN

规则。

示例 1：

TIKTOK_REFUND_WITH_DELIVERY_PROOF

条件：

TikTok Refund = FULL_REFUND
AND
Carrier Shipment = DELIVERED
AND
POD = AVAILABLE
AND
Settlement includes full refund deduction

输出：

RecoveryOpportunity
type = REFUND_WITH_DELIVERY_PROOF

evidence:

- Marketplace order
- refund event
- tracking
- POD
- settlement line

---

示例 2：

CARRIER_INVOICE_OVERCHARGE

CarrierInvoice.actualCharge

??

contractExpectedCharge + allowedSurcharge

AND

shipment belongs to confirmed Marketplace/Shopify order

输出：

Carrier Recovery Opportunity

---

示例 3：

MARKETPLACE_PAYOUT_SHORTFALL

Expected Settlement

Known Refunds

Known Fees

Known Adjustments

!=

Actual Payout

在全部已知调整已 reconciliation 后仍存在差额：

输出：

Settlement / Payout Discrepancy Opportunity

---

示例 4：

DOUBLE_LOSS

Marketplace already refunded buyer

AND

carrier delivered successfully

AND

carrier invoice also contains disputed surcharge

同一 commerce entity 可生成：

Recovery Opportunity A:
Marketplace refund discrepancy

Recovery Opportunity B:
Carrier billing correction

并显示：

Total Recoverable for this commerce entity

---

八、Recovery Opportunity 必须支持跨系统来源

当前 RecoveryOpportunity 有：

domain
channel

请审计是否过于“单渠道化”。

未来一个 Opportunity 可能由：

TikTok + UPS + POD + Settlement

共同产生。

因此 Opportunity 必须能够追溯：

- all source facts
- involved providers
- involved PlatformAccounts
- evidence
- graph entity
- rule version
- match confidence

不要强行让一个 Cross-System Opportunity 只拥有单一 Channel 语义。

如果现有 Schema 已能通过 link table / evidence / graph 表达，则优先复用。

如果不能，再提交最小 Schema Delta Proposal。

---

九、不要把“多平台菜单”误当成完成

禁止把以下视为新阶段完成：

左侧菜单增加：

Amazon
TikTok
Walmart
Shopify
UPS
FedEx
Customs

如果这些模块仍：

- 各自独立；
- 不共享身份；
- 不共享事实；
- 不互相验证；
- 不共同产生 Recovery Opportunity；

则 CrossClaim 仍只是：

“多个单点 Recovery Tool 放到一个 Dashboard。”

这不算达到新阶段目标。

真正完成标准是：

平台之间的数据能发生关系。

---

十、建议的新高级版本逻辑

Adapters
↓
Source Transactions
↓
Canonical Facts
↓
PlatformAccount Scope
↓
Entity Resolution
↓
Recovery Graph
↓
Cross-System Reconciliation
↓
Cross-Domain Rule Engine
↓
Recovery Opportunities
↓
Cases
↓
Evidence
↓
Approval
↓
Claim / Claim-Ready Package
↓
Outcome
↓
Reimbursement Reconciliation
↓
Settlement
↓
Billing

现有下半段：

Opportunity
→ Case
→ Evidence
→ Claim
→ Reconciliation
→ Settlement

尽量复用。

下一阶段主要补强上半段：

Account
→ Identity
→ Graph
→ Cross-System Rules

---

十一、第一阶段不要追求“大而全”

先完成一个真实 Cross-System Slice。

建议第一条：

TIKTOK + CARRIER

原因：

TikTok settlement / refund / return
+
UPS/FedEx shipment / POD / invoice

比较容易证明“单系统看不到、组合后能看到”。

第一条真实目标：

TikTok Order
↓
TikTok Refund / Settlement
+
UPS/FedEx Shipment
↓
Delivered / POD
↓
Cross-System Rule
↓
Recovery Opportunity
↓
Evidence Package
↓
Recovery Case

完成这一条后再扩：

SHOPIFY + STRIPE/PAYPAL + CARRIER

然后：

AMAZON + CARRIER

最后：

CUSTOMS

---

十二、测试与永久验收要求

至少增加以下验收矩阵：

1. 同 Organization、不同 PlatformAccount 相同 orderId 不得合并。
2. 不同 Organization 数据绝不关联。
3. exact tracking 可以把 marketplace order 与 carrier shipment 建立候选/确定关系。
4. ambiguous tracking/order 映射 fail-closed。
5. 仅金额+时间相近不得自动高可信合并。
6. resolved entity 能追溯全部原始 SourceTransaction。
7. Graph Edge 能追溯 identity basis 与 rule/version。
8. Graph rebuild 幂等。
9. 同一事实重复导入不重复建 Graph。
10. refund + delivered + POD 能产生指定 Cross-System Opportunity。
11. 缺 POD 时不得产生同级确定性 Recovery 结论。
12. Carrier invoice correction 与 Marketplace recovery 可以同时存在。
13. 一个 commerce entity 可以拥有多个 RecoveryOpportunity。
14. RecoveryOpportunity 不能因 Graph rebuild 被重复创建。
15. Graph/Identity 失败不得影响现有 Claim/Settlement 历史事实。
16. tenant isolation / account isolation 继续 fail-closed。
17. 无 Production API / 无 external write / 无 payment activation。
18. 现有 R45/R46 全量回归必须保持绿。

---

十三、开发顺序

R46 正常收口。

然后：

PHASE X1
Architecture Audit

审计：

- PlatformAccount gap
- canonical account scope
- factKey / dedupeKey
- existing Graph usage
- opportunity source model

只出报告。

---

PHASE X2
Minimal Architecture Proposal

只针对真正缺口提出：

- minimal Schema Delta
- service boundary
- identity model
- graph builder
- rule input contract

先送审。

---

PHASE X3
PlatformAccount + Account Isolation

优先解决账户归属和跨店误合并风险。

---

PHASE X4
Entity Resolution v1

只做确定性强匹配：

- order reference
- tracking
- settlement ref
- payment reference

模糊匹配先不自动确认。

---

PHASE X5
Recovery Graph Builder v1

把已有 facts 转成可查询 Graph。

---

PHASE X6
First Cross-System Rule

TikTok + Carrier

只做 1–3 条高价值规则。

---

PHASE X7
End-to-End Validation

synthetic
→ anonymized real data
→ human verification

Production API / external write 继续保持 HOLD。

---

十四、成功判据

这个阶段完成，不是看“代码写了多少”。

至少必须能够演示：

一个真实或脱敏商家的：

TikTok Order
+
TikTok Settlement/Refund
+
UPS/FedEx Shipment
+
POD

进入 CrossClaim 后，

系统自动判断：

这些数据属于同一笔 commerce transaction，

然后发现：

某笔 refund / settlement / carrier charge 存在 Recovery Opportunity，

并生成：

- amount
- reason
- source facts
- evidence
- responsible party
- recovery route
- Claim-Ready Package

而且这个 Opportunity 是：

“只有把两个或多个系统的数据放在一起才能发现。”

做到这一点，

CrossClaim 才真正拥有：

Cross-System Recovery

而不是 Multi-Platform Dashboard。

---

十五、长期北极星

CrossClaim 的核心壁垒应逐步形成：

Canonical Fact Layer
+
Platform Account Identity
+
Entity Resolution
+
Recovery Graph
+
Cross-Domain Recovery Rules
+
Recovery Outcome Data

最终：

每处理一笔真实 Recovery Case，

系统都会积累：

- 哪种异常
- 哪个平台
- 哪个 Carrier
- 哪种 Evidence
- 什么 Recovery Rule
- Claim 是否成功
- Appeal 是否成功
- 实际追回金额
- 回款时间

形成 Recovery Intelligence 数据飞轮。

---

执行要求

1. 当前 R46 不停。
2. 不立即重构。
3. R46 后先做 Architecture Audit。
4. 优先复用现有 CanonicalFact / RecoveryGraph / Reconciliation。
5. Schema 变更必须 Design First。
6. Production / external write / payment / real credentials 继续 HOLD。
7. 新阶段最高优先级不是增加平台数量，而是让平台之间的数据真正发生关系。

请把：

CROSS-SYSTEM RECOVERY LAYER

登记为 R46 后高级版本的核心主线和长期 Architecture Constraint。
```
