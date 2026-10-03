# HOST DIRECTIVE 2026-10-03 — MULTI-JURISDICTION CUSTOMS RECOVERY PIPELINE

状态：**REGISTERED / QUEUED**（设计+Schema+规则引擎+资金链路，实施前需架构方审计；**不中断**当前 Carrier Queue）
登记时开发 HEAD 参考：`cda3d30`（登记时实际 HEAD 见 STATE.json / 本提交）。

## 0. 产品边界（Host 原文第 0 段）

- 不做任何国家的「正常法定退税 / 正常出口退税」产品；不建中国出口退税 API / 申报系统。
- 只做**异常 / 历史 / 增量**的 Customs / Duty Recovery。
- 全球客户统一使用同一套 Recovery Engine；国家差异放在 **jurisdiction rule pack**。
- 实际增量追回到账后才允许 Success Fee；默认商业模式 20% Success Fee。
- 真实外写 / 真实海关申报 / 需牌照的代理行为继续 HOLD。

## 1. 登记结论（工程侧）

- 复用既有底座（不新增第二套 Case / Billing / Settlement / Fee）：`RecoveryDomain.CUSTOMS`、`Platform.CUSTOMS`、`Channel.CUSTOMS_BROKER`、`EvidenceKind.CUSTOMS_DOC` / `BROKER_CORRESPONDENCE`、`RuleScope.CUSTOMS_DUTY`、`RouteTarget.CUSTOMS_AUTHORITY` / `CUSTOMS_BROKER` / `CUSTOMER_SELF` 均已存在。
- 新增事实模型 `CustomsEntryFact`（国家无关公共字段 + `jurisdictionSpecific` JSON 扩展）属 **Schema 变更** → 需架构方 Schema Delta 审核。
- Jurisdiction Rule Pack（`rules/customs/{us,uk,eu,ca,au,sg,jp,other}`，全部版本化 `ruleSetId` / `ruleSetVersion` / `effectiveFrom` / `effectiveTo` / `source` / `lastVerified` / `legalBasis`）属 **规则引擎** → 需架构方审计。
- 商业归因闸门 `RecoveryCommercialEligibility`（Business Eligibility AND Financial Settlement Eligibility = Billable）属 **资金链路** → 需架构方审计；不得存在 FeeCalculation 旁路（含 `services/settlement/record-fee.ts` 与旧 `workflow/commission-reconciliation.ts`）。
- 继承既有不变量：`UNKNOWN != FAIL`、`PARTIAL != NOT_ELIGIBLE`、`CONFLICT != SILENTLY RESOLVED`，并新增 `UNKNOWN != BILLABLE`。

## 2. CUSTOMS RECOVERY QUEUE（Host 建议，登记为独立队列）

| Queue | 内容 |
|---|---|
| C1 | Multi-Jurisdiction Customs Entry Contract（`CustomsEntryFact` 数据事实契约） |
| C2 | Customs Provider Interface + Fixture/File Adapter |
| C3 | Customs Evidence Bundle（`evidenceConflicts[]` / `missingEvidence[]` / `evidenceReferences[]`） |
| C4 | Jurisdiction Rule Pack Contract（版本化规则包契约） |
| C5 | US Rule Pack v1 |
| C6 | Customs Eligibility Evaluation（deterministic / explainable / versioned；无 LLM 终判） |
| C7 | Customs Amount Calculation（actualDutyPaid − correctDutyLiability = estimatedIncrementalRecoverableAmount） |
| C8 | Customs Remedy Router（routeType / authority / deadline / requiredEvidence / brokerRequired / customerActionRequired / writePermissionRequired） |
| C9 | Customs Recovery Package（复用既有 `RecoveryPackage`） |
| C10 | Commercial Eligibility Guard（`RecoveryCommercialEligibility`） |
| C11 | 统一所有 `FeeCalculation` 创建路径（消除旁路） |
| C12 | UK Rule Pack |
| C13 | EU Rule Pack |
| C14+ | Canada / Australia / Singapore / Japan |

Wave 实施顺序（非产品边界）：C1 US → C2 UK·EU → C3 Canada·Australia → C4 Singapore·Japan·其他高量辖区。Schema / API / Rule Engine **不得**写死 `country == US`。

## 3. 架构方必须审计的边界（ARCH REVIEW REQUIRED）

- `CustomsEntryFact` 及 `jurisdictionSpecific` 扩展（Schema / Projection 变更）。
- Jurisdiction Rule Pack 语义（tariff / preference / exclusion / deadline / eligibility / remedy / evidence requirements / calculation rules）。
- Customs Recovery Classification（`CUSTOMS_OVERPAYMENT` / `DUPLICATE_DUTY` / `RATE_OVERPAYMENT` / `MISSED_EXCLUSION` / `PREFERENCE_MISSED` / `POTENTIAL_HS_CLASSIFICATION_ERROR` / `VALUATION_REVIEW_REQUIRED` / `DRAWBACK_CANDIDATE` / `NORMAL_STATUTORY_ENTITLEMENT` / `NOT_ELIGIBLE` / `INDETERMINATE`）与谁可自动确认（POTENTIAL_* 与 VALUATION_* 默认 INDETERMINATE / BROKER_REVIEW_REQUIRED，不得 AI 自动确认）。
- Remedy Router 与既有 `RecoveryRoute` / `RouteTarget` 的一致性；英国/EU/加拿大不得硬套美国程序。
- Success Fee 商业归因闸门（`incrementalRecovery == true`、`successFeeEligible == true`、`classificationDecision == ELIGIBLE`、`attributionStatus == CONFIRMED`）与 `isSettlementFeeEligible()` 的组合语义。
- IOR / Importer Rights 判定（Importer of Record / Declarant / Duty Payer / Broker / Refund-Correction Right Holder；DDP buyer 或 indirect payer 若无权利链证据 → INDETERMINATE / NOT_ELIGIBLE）。
- Platform 信号边界：Amazon / TikTok / Shopify 授权只能产生 `CUSTOMS_OPPORTUNITY_SIGNAL`，不得直接生成 `CUSTOMS_OVERPAYMENT` 或 `successFeeEligible = true`。

## 4. HOST APPROVAL REQUIRED

- 真实海关 / broker 账号授权与真实数据读取（REAL DATA READ VALIDATION）。
- 真实外写 / 真实海关申报 / 需牌照的代理行为（当前 HOLD）。
- 付费数据源 / 付费 API 申请。
- 生产凭据、callback 域名注册、任何不可逆外部操作。

## 5. 队列影响

`NONE_ON_CURRENT_UNIT` —— 不中断当前 **CARRIER QUEUE #9B FINAL**（Prisma/PostgreSQL store + HTTP route）。本指令进入独立 CUSTOMS RECOVERY QUEUE，待当前单元收口且架构方放行后按 C1… 顺序执行。

## 6. Host 原文（逐字留档）

```text
[HOST → CODEX] CROSSCLAIM — MULTI-JURISDICTION CUSTOMS RECOVERY PIPELINE

请基于当前仓库实际底座继续推进 Customs / Trade Recovery。

参考当前开发 HEAD：
"cda3d30"

目标不是新增“中国出口退税模块”，而是在现有 Recovery OS 中增加一条：

Multi-Jurisdiction Customs Duty Recovery Pipeline
多国家/地区关税异常追回流水线。

核心产品边界：

- 不做任何国家的“正常法定退税/正常出口退税”产品
- 不建设中国出口退税 API / 申报系统
- 只做异常、历史、增量的 Customs / Duty Recovery
- 全球客户统一使用同一套 Recovery Engine
- 国家差异放到 "jurisdiction rule pack"
- 实际增量追回到账后才允许 Success Fee
- 默认商业模式：20% Success Fee
- 真实外写、真实海关申报、需要牌照的代理行为继续 HOLD

---

1. 当前已有能力必须复用

当前 Schema / Services 已经具备：

RecoveryDomain.CUSTOMS
Platform.CUSTOMS
Channel.CUSTOMS_BROKER

SourceConnection:
FILE_UPLOAD
API
SFTP
EMAIL
MANUAL

EvidenceKind:
CUSTOMS_DOC
BROKER_CORRESPONDENCE

RuleScope.CUSTOMS_DUTY

RouteTarget:
CUSTOMS_AUTHORITY
CUSTOMS_BROKER
CUSTOMER_SELF

RecoveryOpportunity
Case
ClaimItem
RecoveryPackage
Settlement
RecoveryPayout
FeeCalculation
BillingInvoice
SettlementAdjustment
FeeCalculationAdjustment

因此：

禁止重新造第二套 Customs Case / Billing / Settlement / Fee 系统。

Customs 必须进入统一主链：

Source Data
→ Canonical Fact
→ RuleEvaluation
→ RecoveryOpportunity
→ Case
→ Evidence
→ ClaimItem
→ RecoveryPackage
→ Settlement
→ RecoveryPayout
→ FeeCalculation
→ Billing

---

2. 新增统一 Customs 数据事实模型

建立国家无关：

CustomsEntryFact

或等价 immutable snapshot / canonical fact contract。

至少包含：

jurisdiction

entryNumber
entryLineNumber

importerOfRecordRef
brokerRef

entryDate
clearanceDate
liquidationStatus
liquidationDate

hsCode
countryOfOrigin

customsValue
dutiableValue

declaredDutyRate
dutyPaid

currency

preferenceProgram
exclusionReference

rawReference
snapshotDigest
observedAt

注意：

不同国家字段不完全一致。

所以：

核心公共字段固定 + jurisdictionSpecific Json 扩展。

例如：

jurisdictionSpecific: {
  ...
}

禁止因为美国有 "Entry Number / HTS / liquidation"，就把整个模型写死成美国模型。

---

3. 多国 Provider Adapter

建立统一 Provider Contract：

CustomsDataProvider

建议能力：

listEntries()
getEntry()
listEntryLines()

listDutyPayments()

getEntryDocuments()

getBrokerReferences()

getRefundOrAdjustmentStatus()

不同来源均适配为同一 Canonical Customs Fact：

Broker API
Customs API
CSV/XLSX
SFTP
Email
Manual Upload

不得让后续 Recovery Engine 感知具体供应商。

目录建议：

services/customs/

  customs-entry-read.ts
  customs-entry-normalizer.ts
  customs-evidence-bundle.ts
  customs-recovery-eligibility.ts
  customs-recovery-amount.ts
  customs-remedy-router.ts
  customs-recovery-package.ts

  providers/
    customs-provider.ts
    fixture-provider.ts
    file-provider.ts
    broker-api-provider.ts

---

4. Jurisdiction Rule Pack

必须从第一天支持多国。

建立：

rules/customs/

下面：

us/
uk/
eu/
ca/
au/
sg/
jp/
other/

不要把国家逻辑硬编码在：

customs-recovery-eligibility.ts

核心引擎只调用：

resolveJurisdictionRulePack(jurisdiction)

返回：

Tariff Rules
Preference Rules
Exclusion Rules
Deadline Rules
Eligibility Rules
Remedy Rules
Evidence Requirements
Calculation Rules

所有规则必须版本化：

ruleSetId
ruleSetVersion
effectiveFrom
effectiveTo
source
lastVerified
legalBasis

---

5. 第一批支持国家

架构必须多国。

但实施顺序建议：

Wave C1:
US

Wave C2:
UK
EU

Wave C3:
Canada
Australia

Wave C4:
Singapore
Japan
Other high-volume jurisdictions

注意：

这只是实现顺序，不是产品边界。

Schema / API / Rule Engine 不得写死：

country == US

---

6. Customs Evidence Bundle

复制 Carrier Queue 已验证模式。

新增：

CustomsEvidenceBundle

至少整合：

Customs Entry
Entry Line
Duty Payment
Commercial Invoice
HS / tariff declaration
Country of Origin
Applicable Tariff Reference
Preference / Exclusion Evidence
Broker Evidence
Refund / adjustment history

输出：

COMPLETE
PARTIAL

以及：

evidenceConflicts[]
missingEvidence[]
evidenceReferences[]

必须延续：

UNKNOWN != FAIL
PARTIAL != NOT_ELIGIBLE
CONFLICT != SILENTLY RESOLVED

增加：

UNKNOWN != BILLABLE

---

7. Customs Recovery Classification

建立确定性分类：

CUSTOMS_OVERPAYMENT
DUPLICATE_DUTY
RATE_OVERPAYMENT
MISSED_EXCLUSION
PREFERENCE_MISSED

POTENTIAL_HS_CLASSIFICATION_ERROR
VALUATION_REVIEW_REQUIRED
DRAWBACK_CANDIDATE

NORMAL_STATUTORY_ENTITLEMENT

NOT_ELIGIBLE
INDETERMINATE

其中：

NORMAL_STATUTORY_ENTITLEMENT

只是排除分类。

不是产品功能。

不得为它建设正常退税工作流。

---

8. Eligibility Engine

新增：

CustomsRecoveryEligibilityEvaluation

统一：

ELIGIBLE
NOT_ELIGIBLE
INDETERMINATE

并输出：

ruleSetId
ruleSetVersion
jurisdiction
decision
classification
ruleResults[]
blockers[]
evidenceReferences[]
evaluatedAt

必须是：

deterministic
explainable
versioned
no LLM final judgment

AI 可以辅助异常发现。

AI 不得决定：

successFeeEligible

---

9. 第一版优先自动化的机会类型

先做确定性最高的：

A. Duplicate Duty

同一义务重复缴纳
→ deterministic

B. Rate / Tariff Overpayment

已确认 HS/HTS
+
历史申报税率
+
对应日期权威税率
→ 差异

C. Missed Explicit Exclusion

明确 exclusion
+
适用时间
+
商品/entry 条件满足
→ 可判断

之后再逐步：

PREFERENCE_MISSED
POTENTIAL_HS_CLASSIFICATION_ERROR
VALUATION_REVIEW_REQUIRED
DRAWBACK_CANDIDATE

其中：

POTENTIAL_HS_CLASSIFICATION_ERROR
VALUATION_REVIEW_REQUIRED

默认：

INDETERMINATE / BROKER_REVIEW_REQUIRED

不得 AI 自动确认。

---

10. Customs Amount Calculator

建立国家无关：

CustomsRecoveryAmountCalculation

最核心：

actualDutyPaid
-
correctDutyLiability
=
estimatedIncrementalRecoverableAmount

但 jurisdiction pack 可以覆盖计算规则。

例如：

US calculation rules
UK calculation rules
EU calculation rules
...

金额必须区分：

actualDutyPaid

correctDutyLiability

estimatedIncrementalRecoverableAmount

actualIncrementalRecoveredAmount

其中只有最后一个能参与收费。

---

11. Remedy Router

建立：

CustomsRemedyRouter

核心引擎只输出：

routeType
authority
deadline
requiredEvidence
brokerRequired
customerActionRequired
writePermissionRequired

具体程序由 jurisdiction pack 提供。

例如美国可能有：

PSC
PROTEST
DRAWBACK
BROKER_REVIEW
CUSTOMS_AUTHORITY
NO_ROUTE

英国/EU/加拿大不能硬套美国程序。

它们必须有各自 Rule Pack。

---

12. Recovery Package

复用现有：

RecoveryPackage

构建：

Customs Recovery Package

至少包括：

Entry
Entry Line

Duty Payment Evidence

Commercial Invoice

Declared HS
Applicable Tariff Reference

Origin Evidence

Preference / Exclusion Evidence

Actual Duty Paid

Correct Duty Liability

Estimated Recovery

Classification

Rule Version

Legal / Policy Basis

Remedy Path

Deadline

Evidence Digest

初期：

platformWrite = false
transport = false

输出给：

Customer
Customs Broker
Licensed Partner

不得自动执行需要牌照的行为。

---

13. Success Fee Commercial Gate

这是必须补进现有 R46 Fee Chain 的关键。

当前：

isSettlementFeeEligible()

主要判断：

Settlement received
confirmed
reconciled
evidence exists
not reversed
amount valid

还必须新增业务归因资格。

建立统一：

RecoveryCommercialEligibility

或：

RecoveryAttributionEligibility

所有 FeeCalculation 创建路径必须调用。

至少要求：

incrementalRecovery == true

successFeeEligible == true

classificationDecision == ELIGIBLE

attributionStatus == CONFIRMED

之后才能进入：

Settlement Fee Eligibility

所以最终：

Business Eligibility
AND
Financial Settlement Eligibility
=
Billable

---

14. Customs 收费规则

允许：

CUSTOMS_OVERPAYMENT
DUPLICATE_DUTY
RATE_OVERPAYMENT
CONFIRMED_MISSED_EXCLUSION
CONFIRMED_PREFERENCE_MISSED
其他已确认异常增量追回

进入：

successFeeEligible = true

禁止：

NORMAL_STATUTORY_ENTITLEMENT

POTENTIAL_HS_CLASSIFICATION_ERROR

VALUATION_REVIEW_REQUIRED

INDETERMINATE

NOT_ELIGIBLE

进入成功费。

---

15. Fee Calculation

默认：

basis = RECOVERED_AMOUNT_PCT
rate = 0.20

但 rate 必须继续来自：

server-side trusted versioned Fee Policy

不得客户端上传。

最终：

baseAmount
=
verified actual incremental recovered amount

不是：

estimated recovery

approved amount

normal entitlement

expected recovery

---

16. 所有收费路径必须统一 Guard

特别检查：

services/settlement/record-fee.ts

以及旧：

workflow/commission-reconciliation.ts

不得存在旁路。

最终：

ANY FeeCalculation creation
        ↓
RecoveryCommercialEligibility Guard
        ↓
SettlementFeeEligibility Guard
        ↓
Server Fee Policy
        ↓
FeeCalculation

禁止：

Settlement matched
+
successFeeRate exists
→ directly bill

---

17. 多国 API / 数据策略

不要先依赖某一家 Customs API。

统一支持：

API
FILE
SFTP
EMAIL
MANUAL

第一阶段可以：

fixture
+
真实 Broker CSV/XLSX
+
Customs Entry 文件

跑通。

之后再接：

US Broker API
UK Broker API
EU Customs/Broker sources
Canada
Australia
...

这样第三方 API 可替换，不影响业务层。

---

18. Platform API 与 Customs 的关系

Amazon / TikTok / Shopify 等：

只能做：

CUSTOMS_OPPORTUNITY_SIGNAL

例如：

客户存在跨境进口活动

不能仅凭电商平台授权生成：

CUSTOMS_OVERPAYMENT

更不能：

successFeeEligible = true

必须取得 Customs / Broker / Entry / Duty 数据。

---

19. IOR / Importer Rights

Customs Recovery 必须识别：

Importer of Record
Declarant
Duty Payer
Broker
Refund/Correction Right Holder

如果卖家只是：

DDP buyer / indirect payer

但没有对应 Customs Recovery 权利，

则：

INDETERMINATE
or
NOT_ELIGIBLE

直到取得合同/授权/权利链证据。

不得只因“卖家承担了物流成本”就判定有退款权。

---

20. 推荐执行队列

不要中断正在进行的 Carrier Queue。

登记新的：

CUSTOMS RECOVERY QUEUE

建议：

Queue C1

Multi-Jurisdiction Customs Entry Contract

Queue C2

Customs Provider Interface + Fixture/File Adapter

Queue C3

Customs Evidence Bundle

Queue C4

Jurisdiction Rule Pack Contract

Queue C5

US Rule Pack v1

Queue C6

Customs Eligibility Evaluation

Queue C7

Customs Amount Calculation

Queue C8

Customs Remedy Router

Queue C9

Customs Recovery Package

Queue C10

Commercial Eligibility Guard

Queue C11

统一所有 FeeCalculation 创建路径

Queue C12

UK Rule Pack

Queue C13

EU Rule Pack

Queue C14+

Canada / Australia / Singapore / Japan

---

21. 测试至少覆盖

必须覆盖：

不同 jurisdiction 同一核心引擎

以及：

1. US Duplicate Duty → ELIGIBLE
2. US Rate Overpayment → ELIGIBLE
3. US explicit exclusion → ELIGIBLE
4. US HS uncertain → INDETERMINATE
5. UK 规则不得调用 US remedy
6. EU 规则不得使用 US HTS assumptions
7. jurisdiction missing → INDETERMINATE
8. rule pack missing → INDETERMINATE
9. conflicting country/origin → INDETERMINATE
10. missing duty payment → INDETERMINATE
11. normal statutory entitlement → not billable
12. expected recovery → not billable
13. actual recovered settlement → potentially billable
14. reversed settlement → fee reversed/voided
15. cross-tenant reference → rejected
16. API 与 FILE 同一 entry → 去重/对账
17. API 与 FILE 冲突 → NEEDS_REVIEW
18. client-supplied rate → rejected
19. platform-only signal → cannot become billable customs claim
20. broker review required → cannot bill before confirmation

---

22. 最终架构原则

CrossClaim 应形成：

GLOBAL CORE

SourceConnection
CanonicalFact
Evidence
Eligibility
Opportunity
Case
RecoveryPackage
Settlement
Fee
Billing

上面插：

JURISDICTION RULE PACKS

而不是：

US Product
UK Product
EU Product
China Product

每个国家重写一套系统。

最终产品应做到：

ONE GLOBAL RECOVERY ENGINE
+
MULTI-JURISDICTION CUSTOMS RULE PACKS

产品边界：

全球跨境卖家都可以使用。

我们不做：

各国正常退税服务。

我们只做：

历史异常关税/税费增量追回。

收费原则：

实际增量追回到账后，按服务器版本化商业规则计算 Success Fee；默认 20%。
```
