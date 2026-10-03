# HOST DIRECTIVE 2026-10-03（补充四）— CUSTOMS ONE-CLICK AUTOMATED RECOVERY COMPLETION

登记时间：2026-10-03（UTC+9）｜登记时参考 HEAD：`7e2e712`（gate/7-commercial-validation）
来源：宿主粘贴指令「[HOST → CODEX] CROSSCLAIM — CUSTOMS ONE-CLICK AUTOMATED RECOVERY COMPLETION DIRECTIVE」

## 0. 执行纪律（本指令 §10）

- 不得打断 CARRIER QUEUE #9B FINAL-2 —— **已完成**：MSG-20261003-121 ⑤ `CARRIER QUEUE #9B = PASS / CLOSED`（FINAL-2 impl `2a5399e` / CI `37105566664` / doc `7a816ec`）。
- FINAL-2 PASS 后继续授权内部推进：**Commercial C10–C11**、**Customs C1+**；本指令追加 **C15–C21** 到 Customs Execution Queue。
- 本指令**不重开 C1–C14**，不重复建设既有 Recovery / Settlement / Billing / Fee 底座。
- 当前优先单元仍为 **CARRIER QUEUE #10 FINAL**（MSG-20261003-122 ⑦ 已授权，Schema Delta AUTHORIZED）；C15–C21 属 **P2 内部实现**，真实 filing 仍 `HOLD_EXTERNAL`。

## 1. 冻结的最终产品目标（§1）

`CLAIM_READY`（Opportunity → Eligibility → Amount → Package → Broker-ready Package）**不是**产品终点。最终闭环：
Platform / Carrier / Customs Data → Automatic Recovery Detection → Eligibility → Amount → Remedy Route → Evidence / Recovery Package → Customer Start Recovery → Licensed Broker / Filing Provider → Authority Submission → Status Tracking → Actual Refund / Recovery → Settlement + Reconciliation → 15% Success Fee。
产品目标：客户完成必要授权后，只点一次 **Start Recovery**，其余可自动化部分由系统执行。

## 2. 一键 ≠ 绕过合规授权（§2）

三类授权**完全独立、不得互相推导**：`Platform OAuth` / `Broker / Filing POA or equivalent authorization` / `Payment Authorization`（「Platform OAuth != Broker POA」）。
首次 onboarding 可完成：Customs Recovery Agreement、Importer/Claimant identity confirmation、Broker direct POA 或等效授权、Broker/Filing Provider connection；完成后具体 opportunity 才能进入 `READY_TO_FILE`。

## 3. Customs Execution Queue（§3，C1–C14 定义不变，追加 C15–C21）

**C15 — Customs Filing Provider Contract**：新增 provider-neutral `CustomsFilingProvider`（`createSubmission` / `uploadEvidence` / `getSubmission` / `getSubmissionStatus` / `listRequestsForInformation` / `respondToRequest` / `getRefundStatus`）；能力必须 **operation-level fail-closed**：`DATA_READ` / `FILING_CREATE` / `DOCUMENT_UPLOAD` / `STATUS_READ` / `RFI_READ` / `RFI_RESPOND` / `WEBHOOK` / `REFUND_STATUS`；缺 Filing capability → 只能 `CLAIM_READY` / `BROKER_HANDOFF`，**不得伪造自动提交能力**。

**C16 — Customs Authorization Readiness**：新增 `CustomsAuthorizationReadiness`，验证 `CustomsAgreementSigned` / `ImporterOfRecordConfirmed` / `ClaimantConfirmed` / `RecoveryRightConfirmed` / `BrokerConnected` / `BrokerAuthorizationValid` / `FilingPermissionValid` / `ProviderCapabilityReady`；仅全部满足 → `READY_TO_FILE`，否则明确返回 `BROKER_POA_REQUIRED` / `IOR_NOT_CONFIRMED` / `CLAIMANT_NOT_CONFIRMED` / `RECOVERY_RIGHT_NOT_CONFIRMED` / `BROKER_NOT_CONNECTED` / `FILING_PROVIDER_NOT_READY`。

**C17 — Customs Submission Attempt Ledger**：append-only / tenant-scoped / idempotent submission ledger（`organizationId` / `claimItemId` / `caseId` / `opportunityId` / `packageId` / `packageDigest` / `provider` / `operation` / `jurisdiction` / `remedyType` / `idempotencyKey` / `providerSubmissionId` / `submissionStatus` / `submittedAt`）。核心不变量：同一 claim / package / filing operation 在 retry / timeout / worker concurrency 下**至多一次真实 filing**；复用既有 `platform.write` / `RecoveryPackage` / manual submission / Carrier Queue 已验证的 server-derived truth · idempotency · CAS · append-only · tenant isolation · Action Guard · ambiguous response → no blind retry 模式。

**C18 — First Real Filing/Broker Adapter**：只选 1 个真实同时支持 Customs Data + Filing + Status 的 Broker / ABI / Filing Provider；必须一次性拿到能力证据（real filing operation、idempotency semantics、submission identifier、status query、webhook、document upload、ambiguous response behavior、retry semantics、credential lifecycle、sandbox/test environment、authorization/POA requirement）；缺关键能力 → `NEEDS_MANUAL` / `BROKER_HANDOFF`，**不得降低门槛**。

**C19 — Filing Status / Webhook Read Model**：统一状态 `PREPARING / READY_TO_FILE / SUBMITTED / ACCEPTED / NEEDS_MORE_INFO / UNDER_REVIEW / DENIED / APPROVED / PAID / UNKNOWN` + 来源等级 `USER_REPORTED / PROVIDER_VERIFIED / AUTHORITY_VERIFIED`；禁止「customer says submitted → 自动视为 authority accepted」；禁止「APPROVED → 自动视为 PAID」。

**C20 — Refund → Settlement Integration**：复用 `ProviderOutcomeFact` → `RecoveryPayout` → `Settlement` → `Reconciliation` → `FeeCalculation` → `Billing`；Customs 不得另开第二套资金系统；链路：Provider/Authority refund evidence → Verified Recovery Receipt → Settlement → Reconciliation → Verified Actual Incremental Recovery → Commercial Eligibility → 15% Fee Policy → FeeCalculation；**只有 verified actual incremental recovered amount 才能触发 15% 收费**。

**C21 — One-Click Start Recovery**：`POST /customs-opportunities/:id/start-recovery`（server-side action）。客户端只提供 `opportunityId` 与必要确认字段；以下全部 server-derived：`recoverableAmount` / `classification` / `eligibility` / `ruleVersion` / `IOR` / `claimant` / `broker` / `packageDigest` / `feeRate` / `filingRoute` / `deadline`。服务端须验证 tenant / actor / account lineage / CustomsEntryFact / IOR·claimant rights / Broker authorization / Evidence Bundle / Eligibility / Rule Version / Amount / Remedy Route / Deadline / Recovery Package / Provider Capability / Commercial Terms；全部满足 → `READY_TO_FILE` → immutable submission snapshot → `CustomsFilingProvider`；否则 fail-closed。

## 4. 客户 UX（§4）

Opportunity 卡片展示 Estimated Recovery / Eligibility / Evidence / Remedy / Broker / Authorization / Filing Provider / Deadline / Success Fee（after actual recovery）+ `[Start Recovery]`；状态推进 Preparing → Submitted → Accepted → Under Review → Approved → Paid。客户端**不**出现：手工录入、登录 Broker portal、回复上传、手工导出 Case data、手工查询状态；仅当 provider capability 或法规要求时才回退人工。

## 5. 高风险案件必须 HITL / Broker Review（§5）

默认**不**straight-through 自动提交：`POTENTIAL_HS_CLASSIFICATION_ERROR` / `VALUATION_REVIEW_REQUIRED` / `IOR_RIGHTS_UNCLEAR` / `CONFLICTING_EVIDENCE` / `INDETERMINATE` 走 Auto Detect → Auto Prepare → Broker/Expert Review → Approved → Filing。仅确定性较高者（`DUPLICATE_DUTY` / `RATE_OVERPAYMENT` / `CONFIRMED_EXCLUSION` / other deterministic confirmed cases）可在 jurisdiction/provider capability 明确后进入 Straight-Through Processing。

## 6. 必须复用 / 禁止新建（§6）

复用：SourceConnection / PlatformAccount / CanonicalFact / RuleSet·RuleVersion / RecoveryOpportunity / Case / ClaimItem / EvidenceArtifact / RecoveryPackage / Action Guard / Settlement / Reconciliation / RecoveryPayout / FeePolicy / FeeCalculation / Billing。
禁止：Customs-only Billing、Customs-only Settlement、Customs-only Payment、第二套 Recovery Engine。

## 7. 平台集成 backlog（§7）

现状：Amazon = 只读 adapter（production credentials / real calls HOLD）；TikTok Shop = provider contract 已有、真实 adapter 未建；Walmart = 同；Shopify = file/fixture 路径已有、真实 OAuth/API adapter 未建。将 TikTok Read Adapter / Walmart Read Adapter / Shopify OAuth + Read Adapter 登记为 provider integration backlog；平台信号只能作为 `CUSTOMS_OPPORTUNITY_SIGNAL`，不得确认 Customs entitlement。

## 8. Carrier 数据同源（§8）

UPS / FedEx / DHL 的 shipment / return / re-export / delivery / tracking / invoice 与 Customs Entry·Duty·Platform Order 做 cross-source linkage；Carrier 数据只能增强 Customs Evidence / Drawback Candidate detection，**不得**用 shipment 记录确认 Customs entitlement。

## 9. 完成标准（§9）

不得把「Customs Recovery Package generated」当作「Customs 自动追回完成」。完成标准 12 项：`CUSTOMS_DATA_READY` / `CUSTOMS_ELIGIBILITY_READY` / `CUSTOMS_AMOUNT_READY` / `CUSTOMS_REMEDY_READY` / `CUSTOMS_PACKAGE_READY` / `BROKER_AUTH_READY` / `FILING_PROVIDER_READY` / `ONE_CLICK_START_RECOVERY` / `SUBMISSION_IDEMPOTENCY` / `STATUS_TRACKING` / `REFUND_TO_SETTLEMENT` / `15_PERCENT_FEE_CHAIN`。在 Filing Provider / Broker 真实能力与授权未打通前，必须明确 `INTERNAL_READY / EXTERNAL_GATE`，不得称为 production automated customs recovery。

## 10. 边界判定（Codex 登记时评估）

### 可立即内部实施（无需宿主授权）

- C15 契约层（provider-neutral 接口 + operation-level capability matrix，fail-closed）。
- C16 `CustomsAuthorizationReadiness` 判断层（纯只读判定 + 明确拒绝码）。
- C17 submission attempt ledger 的**契约与 Schema 提案**（append-only / idempotent / tenant-scoped），真实写入路径先只允许在测试环境验证。
- C19 status/webhook read model 的契约层（来源等级分离、禁止自动升级）。
- C21 的 server-side 校验与 fail-closed 编排（在 `provider capability` 未就绪时一律返回 `BROKER_HANDOFF`）。
- 平台 backlog / Carrier cross-source linkage 的登记与只读设计。

### HOST APPROVAL REQUIRED（不得自行执行）

- C18 真实 Filing/Broker Provider 选型与接入（第三方真实账号授权、POA/代表资格确认）。
- 任何真实 customs filing / authority submission（外部写、不可逆）。
- 付费数据源 / 正式 API 申请、生产凭据引入。
- 真实客户数据（entry / duty / IOR / claimant 维度）进入非合成环境。
- 真实资金链路（Provider/Authority refund 对接、Settlement 实盘、15% 实际扣费）。
- 代表客户执行业务的牌照/合规结论（licensed broker / customs attorney / IOR 身份）。

### ARCH REVIEW REQUIRED（须架构方审计后才实施）

- C17 Schema Delta（submission attempt ledger）。
- C16 授权就绪判定语义与 `READY_TO_FILE` 边界。
- C19 状态机与来源等级（`USER_REPORTED` / `PROVIDER_VERIFIED` / `AUTHORITY_VERIFIED`）。
- C20 资金链路复用性与 15% fee trigger（`verified actual incremental recovered`）。
- C21 one-click action 的权限模型 / Action Guard 注册 / immutable submission snapshot 语义。
- Straight-Through Processing 的适用条件（jurisdiction/provider capability）。

### 冻结边界（继续 HOLD）

NO platform write · TRANSPORT=false · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · 无生产凭据 · 真实 customs filing = HOLD_EXTERNAL / REGULATED GATE。

## 11. 原文（逐字保留）

```text
[HOST → CODEX] CROSSCLAIM — CUSTOMS ONE-CLICK AUTOMATED RECOVERY COMPLETION DIRECTIVE

基于当前实际仓库与最新裁决继续推进。

当前参考：

- branch: "gate/7-commercial-validation"
- latest reviewed direction includes "MSG-20261003-120"
- Customs C1+ 已获内部开发授权
- 15% Commercial Model C10–C11 已获内部实施授权
- 当前 Queue #9B FINAL-2 必须继续优先收口，不得被本指令打断

本指令不是重开 C1–C14，不得重复建设已存在的 Recovery / Settlement / Billing / Fee 底座。

---

1. 冻结最终产品目标

Customs Recovery 的最终完成标准不得停在：

Opportunity
→ Eligibility
→ Recovery Amount
→ Recovery Package
→ Broker-ready Package

这只能算：

CLAIM_READY

不是产品最终闭环。

CrossClaim 最终目标必须是：

Platform / Carrier / Customs Data
↓
Automatic Recovery Detection
↓
Eligibility
↓
Amount
↓
Remedy Route
↓
Evidence / Recovery Package
↓
Customer Start Recovery
↓
Licensed Broker / Filing Provider
↓
Authority Submission
↓
Status Tracking
↓
Actual Refund / Recovery
↓
Settlement + Reconciliation
↓
15% Success Fee

产品目标：

客户完成必要授权后，只需点击一次 "Start Recovery"，后续由系统自动执行可自动化部分。

---

2. 一键 ≠ 绕过合规授权

以下三类授权继续完全独立：

Platform OAuth
Broker / Filing POA or equivalent authorization
Payment Authorization

不得互相推导。

"Platform OAuth != Broker POA"

客户首次 onboarding 可完成：

Customs Recovery Agreement
Importer / Claimant identity confirmation
Broker direct POA / required authorization
Broker/Filing Provider connection

完成后，后续具体 Customs Opportunity 才能进入：

READY_TO_FILE

---

3. 在现有 C1–C14 后增加 Customs Execution Queue

不要修改既有 C1–C14 定义。

追加以下实施队列：

C15 — Customs Filing Provider Contract

新增 provider-neutral：

CustomsFilingProvider

至少定义：

createSubmission()
uploadEvidence()
getSubmission()
getSubmissionStatus()
listRequestsForInformation()
respondToRequest()
getRefundStatus()

能力必须 operation-level fail-closed：

DATA_READ
FILING_CREATE
DOCUMENT_UPLOAD
STATUS_READ
RFI_READ
RFI_RESPOND
WEBHOOK
REFUND_STATUS

任何 provider 缺少 Filing capability：

→ CLAIM_READY / BROKER_HANDOFF

不得伪造自动提交能力。

---

C16 — Customs Authorization Readiness

新增：

CustomsAuthorizationReadiness

至少验证：

CustomsAgreementSigned
ImporterOfRecordConfirmed
ClaimantConfirmed
RecoveryRightConfirmed
BrokerConnected
BrokerAuthorizationValid
FilingPermissionValid
ProviderCapabilityReady

只有全部满足才：

READY_TO_FILE

否则明确返回：

BROKER_POA_REQUIRED
IOR_NOT_CONFIRMED
CLAIMANT_NOT_CONFIRMED
RECOVERY_RIGHT_NOT_CONFIRMED
BROKER_NOT_CONNECTED
FILING_PROVIDER_NOT_READY

---

C17 — Customs Submission Attempt Ledger

建立 append-only / tenant-scoped / idempotent submission ledger。

至少保存：

organizationId
claimItemId
caseId
opportunityId
packageId
packageDigest
provider
operation
jurisdiction
remedyType
idempotencyKey
providerSubmissionId
submissionStatus
submittedAt

核心不变量：

同一 claim / package / filing operation
不得因为 retry / timeout / worker concurrency
产生两次真实 filing

复用现有：

platform.write
RecoveryPackage
manual submission
Carrier Queue

已经验证的：

server-derived truth
idempotency
CAS
append-only
tenant isolation
Action Guard
ambiguous response → no blind retry

模式。

---

C18 — First Real Filing/Broker Adapter

只选择 1 个真实支持：

Customs Data
+
Filing
+
Status

的 Broker / ABI / Filing Provider 作为样板。

不要一次接多个国家/多个 provider。

必须先完成 capability evidence：

real filing operation
idempotency semantics
submission identifier
status query
webhook
document upload
ambiguous response behavior
retry semantics
credential lifecycle
sandbox/test environment
authorization / POA requirement

缺关键能力：

NEEDS_MANUAL / BROKER_HANDOFF

不得降低门槛。

---

C19 — Filing Status / Webhook Read Model

建立统一状态：

PREPARING
READY_TO_FILE
SUBMITTED
ACCEPTED
NEEDS_MORE_INFO
UNDER_REVIEW
DENIED
APPROVED
PAID
UNKNOWN

并严格区分来源：

USER_REPORTED
PROVIDER_VERIFIED
AUTHORITY_VERIFIED

禁止：

customer says submitted
→ automatically treat as authority accepted

禁止：

APPROVED
→ automatically treat as PAID

---

C20 — Refund → Settlement Integration

复用现有：

ProviderOutcomeFact
RecoveryPayout
Settlement
Reconciliation
FeeCalculation
Billing

Customs 不得另建第二套资金系统。

链路：

Provider / Authority refund evidence
↓
Verified Recovery Receipt
↓
Settlement
↓
Reconciliation
↓
Verified Actual Incremental Recovery
↓
Commercial Eligibility
↓
15% Fee Policy
↓
FeeCalculation

只有：

verified actual incremental recovered amount

可以参与15%收费。

---

C21 — One-Click Start Recovery

新增最终客户动作：

POST /customs-opportunities/:id/start-recovery

或等价 server-side action。

客户端只允许提供：

opportunityId

以及必要的人类确认字段。

不得由客户端自报：

recoverableAmount
classification
eligibility
ruleVersion
IOR
claimant
broker
packageDigest
feeRate
filingRoute
deadline

这些全部 server-derived。

服务端点击后重新验证：

tenant
actor
account lineage
CustomsEntryFact
IOR / claimant rights
Broker authorization
Evidence Bundle
Eligibility
Rule Version
Amount
Remedy Route
Deadline
Recovery Package
Provider Capability
Commercial Terms

全部满足：

READY_TO_FILE
→ immutable submission snapshot
→ CustomsFilingProvider

否则 fail-closed。

---

4. 一键客户体验

最终 UI 目标：

Customs Recovery Opportunity

Estimated Recovery   $18,620
Eligibility          ELIGIBLE
Evidence             COMPLETE
Remedy               DRAWBACK
Broker               CONNECTED
Authorization        VALID
Filing Provider      READY
Deadline             214 days
Success Fee          15% after actual recovery

[ Start Recovery ]

点击后：

Preparing
→ Submitted
→ Accepted
→ Under Review
→ Approved
→ Paid

客户不应再手工：

下载资料
登录 Broker portal
重复上传
手工复制 Case data
手工查询状态

除非 provider capability 或法规明确要求。

---

5. 高风险案件保持 HITL / Broker Review

以下默认不得 straight-through 自动提交：

POTENTIAL_HS_CLASSIFICATION_ERROR
VALUATION_REVIEW_REQUIRED
IOR_RIGHTS_UNCLEAR
CONFLICTING_EVIDENCE
INDETERMINATE

流程：

Auto Detect
→ Auto Prepare
→ Broker / Expert Review
→ Approved
→ Filing

而确定性较高的：

DUPLICATE_DUTY
RATE_OVERPAYMENT
CONFIRMED_EXCLUSION
other deterministic confirmed cases

未来可进入：

Straight-Through Processing

但必须由 jurisdiction/provider capability 明确允许。

---

6. 不要重做现有底座

必须复用：

SourceConnection
PlatformAccount
CanonicalFact
RuleSet / RuleVersion
RecoveryOpportunity
Case
ClaimItem
EvidenceArtifact
RecoveryPackage
Action Guard
Settlement
Reconciliation
RecoveryPayout
FeePolicy
FeeCalculation
Billing

禁止新建：

Customs-only Billing
Customs-only Settlement
Customs-only Payment
第二套 Recovery Engine

---

7. 四个平台真实接入缺口同时登记，但不要抢占 Customs 当前主线

当前真实代码状态：

Amazon
= 有 read-only adapter，但 production credentials / real calls HOLD

TikTok Shop
= provider contract exists，real adapter 未完成

Walmart
= provider contract exists，real adapter 未完成

Shopify
= file/fixture path exists，real OAuth/API adapter 未完成

请将：

TikTok Read Adapter
Walmart Read Adapter
Shopify OAuth + Read Adapter

登记为 provider integration backlog。

它们最终为：

CUSTOMS_OPPORTUNITY_SIGNAL

提供平台事实，但不得替代 Customs/Broker 数据。

---

8. 物流真实 provider 接入同理

UPS / FedEx / DHL 等物流数据最终用于：

shipment
return
re-export
delivery
tracking
invoice

与 Customs Entry / Duty / Platform Order 做 cross-source linkage。

Carrier 数据只能增强 Customs Evidence / Drawback Candidate detection。

不得单凭物流记录确认 Customs entitlement。

---

9. 永久完成标准

以后不得把：

Customs Recovery Package generated

标记成 Customs 自动化“完成”。

最终完成条件至少是：

CUSTOMS_DATA_READY = YES
CUSTOMS_ELIGIBILITY_READY = YES
CUSTOMS_AMOUNT_READY = YES
CUSTOMS_REMEDY_READY = YES
CUSTOMS_PACKAGE_READY = YES
BROKER_AUTH_READY = YES
FILING_PROVIDER_READY = YES
ONE_CLICK_START_RECOVERY = YES
SUBMISSION_IDEMPOTENCY = YES
STATUS_TRACKING = YES
REFUND_TO_SETTLEMENT = YES
15_PERCENT_FEE_CHAIN = YES

若 Filing Provider / Broker 真实生产能力尚未接通，则必须明确：

INTERNAL_READY / EXTERNAL_GATE

不得将其表述为 production automated customs recovery。

---

10. 当前执行纪律

本指令：

DO NOT INTERRUPT CARRIER QUEUE #9B FINAL-2

先完成 MSG-120 指定的窄 DB truth constraint。

FINAL-2 PASS 后：

按已授权方向推进：

Commercial C10–C11
Customs C1+

并把本指令的：

C15–C21

追加到 Customs Execution Queue。

核心目标：

CrossClaim Customs 的终点不是“生成材料”，而是客户完成必要授权后，一键启动 Recovery，由 Broker/Filing Provider 自动提交、状态回传、到账对账，并进入15% Success Fee Chain。
```
