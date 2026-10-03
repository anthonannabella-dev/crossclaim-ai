# HOST BACKEND ARCHITECTURE DIRECTIVE — 登记（SAFE_CONTINUATION_QUEUE）

- SOURCE = HOST BACKEND ARCHITECTURE DIRECTIVE
- STATUS = **QUEUED_AFTER_CURRENT_C2**（不打断当前 execution unit）
- REGISTERED_HEAD = 93114f1（93114f14e2c5bc5404b91efc3f84c2c5d7f3fab4）
- REGISTERED_AT = 2026-10-02T21:49:28.585Z
- 当前主线：C2 Account Provenance / Settlement Lineage / Action Guard / Closure 收口 + Carrier Queue #3（UPS / FedEx auth + account discovery internal contract，送审中）

## 0. 登记结论（§35 七项回报）

1. **当前 HEAD**：93114f1（分支 gate/7-commercial-validation；CI 以该 SHA 的 run 为准）。
2. **当前 C2 closure 状态**：C2 Account Provenance / Settlement lineage / Action Guard / Closure 均已收口（C2 = CLOSED，MSG-20261002-68 系列裁决）；当前 execution unit = **Carrier Queue #3**（MSG-20261003-105 ⑤⑭ 授权），已实现并送审（1ae5ca5 / CI 37068040288）。
3. **本指令 ingestion 状态**：**QUEUED_AFTER_CURRENT_C2** —— 已逐字留档于本文档 §3，并写入 `.autopilot/STATE.json` → `backend_architecture_directive` 与 `.autopilot/TASKS.md` → SAFE_CONTINUATION_QUEUE；未启动任何 B 阶段实施。
4. **是否与现行 roadmap 冲突**：**无直接冲突，但需要架构方 Schema Delta 审核**。Carrier Queue #3（UPS / FedEx auth + account discovery）与本指令 PHASE B3 同向；Fastify 迁移、AsyncJob / Outbox、DomainFactSnapshot、DocumentExtraction、ConnectionCapability / SyncState、OAuthAuthorizationSession、SecretVault 均为**新增基础设施**，不触碰既有不变量（tenant isolation / account provenance / evidence lineage / idempotency / masking / audit / Action Guard / HITL / settlement·payout truth / fee·billing 分离）。
5. **下一个实际可执行 backend delta**：**PHASE B1 — HTTP Layer 迁移设计（Node HTTP → Fastify，仅 adapter / routing 层，`/api/v1` 兼容计划，无 domain 重写）**。实施前只出设计 + 兼容计划，代码改动仅限 HTTP adapter。
6. **是否需要 schema delta review**：**需要**。本指令 §30 点名的 8 个模型必须先走 Schema Delta Proposal + 架构方审核，方可落 Prisma migration：OAuthAuthorizationSession / ConnectionCapability / ConnectionSyncState / DomainFactSnapshot / DomainFactSnapshotSource / DocumentExtraction / AsyncJob / OutboxEvent。
7. **不打断当前 C2 closure**：遵守 §32 PHASE B0 —— 当前送审中的 Carrier Queue #3 与既有队列继续执行；AUTOPILOT 在**不中断**现有任务的前提下，把 B1–B10 计入 SAFE_CONTINUATION_QUEUE，待当前单元收口后自动进入 B1。

## 1. 关键硬约束摘要（实施时必须逐条保持）

- **技术栈不变**：TypeScript / PostgreSQL / Prisma / Vitest / 现有 services architecture；**禁止**引入 Python / FastAPI / Pydantic / Celery（§1、§18）。
- **HTTP 层**：Node HTTP → Fastify，**只替换 HTTP Adapter / Routing Layer**；禁止重写 service layer / domain rules / Prisma models / Action Guard / permissions / settlement·recovery logic；路径直接以 `/api/v1` 定版（§2）。
- **禁止第二事实源**：tenants↔Organization、users↔User+Membership、store_integrations / carrier_accounts↔PlatformAccount+SourceConnection、claims↔RecoveryOpportunity+ClaimItem+Case+Claim、sla_disputes↔RecoveryOpportunity+ClaimItem+Case+Claim；carrier_invoices 优先落在 SourceTransaction / structured domain fact（§3、§23、§24）。
- **主链固定**：External Source → PlatformAccount → SourceConnection → SourceTransaction → CanonicalFact → RuleEvaluation → RecoveryOpportunity → RecoveryRoute → ClaimItem → Case → Claim → Submission → Provider Outcome → Settlement → RecoveryPayout → FeeCalculation → BillingInvoice（§3）。
- **Provider Integration Layer**：`apps/api/src/integrations/{core,providers}`，统一 `ProviderAdapter` 接口；`submit()` 可选，不得假设 Tracking / Invoice / Claim Submission API 均可用（§4）。
- **ConnectionCapability**：显式表达 SUPPORTED / UNSUPPORTED / REQUIRES_SCOPE / REQUIRES_PARTNER_APPROVAL / UNKNOWN，禁止 UI 猜测（§5）。
- **OAuthAuthorizationSession**：state 只存 hash、PKCE verifier 不入业务库、明确 expiry、callback 必须 CAS/consume、重放拒绝、跨 tenant 拒绝（§6、§26）。
- **Token / Secret**：access_token / refresh_token / client_secret 一律进 SecretVault（`services/secrets/`），PostgreSQL 只留 credentialRef；DB / AuditLog / HTTP response 永不出现真实 token（§7）。
- **同步状态**：ConnectionSyncState 按 resourceType 维护 cursor / watermark（§8）。
- **结构化事实**：不扩展 CanonicalFact；新增 immutable / versioned DomainFactSnapshot + DomainFactSnapshotSource（必挂 SourceTransaction，禁止成为无来源的第二事实源）（§9–§11）。
- **Dual-Path Routing**：集中在 `services/routing/recovery-routing.ts`；平台运单（如 AMAZON_BUY_SHIPPING / TikTok Shipping）→ RouteTarget.PLATFORM；独立承运商（MERCHANT_CARRIER + carrier=UPS）→ RouteTarget.CARRIER；缺 OAuth 时仍是 CARRIER + needs action CONNECT_UPS，禁止降级成 PLATFORM（§12–§14）。
- **Document AI**：Upload → FileAsset → Security Scan → DocumentExtraction → Schema Validation → SourceTransaction → DomainFactSnapshot → Matching → RuleEvaluation → RecoveryOpportunity；禁止 PDF → LLM → Claim（§15–§16）。
- **AI / OCR 边界**：只能 parse / normalize / extract / classify / candidate match / explain / draft；禁止 AI output → recoverableAmount / Settlement / RecoveryPayout；歧义 → NEEDS_REVIEW（§17）。
- **异步一期**：PostgreSQL AsyncJob（FOR UPDATE SKIP LOCKED，idempotency + retry + backoff + dead-letter + tenant scope）+ Transactional Outbox；暂不引入 Redis / Temporal / Celery（§18–§21）。
- **SubmissionAdapter 统一**：capability ∈ DIRECT_API / PORTAL_DEEPLINK / CLAIM_READY_PACKAGE / UNAVAILABLE；DIRECT_API 仅在 Provider 官方资质 + Action Guard 全部确认后开启（§22、§31 PHASE B9）。
- **PlatformWriteAttempt 复用**：暂不改名 / 不做 schema churn，先做 service / adapter（§23）。
- **Diagnose 入口**：不做 POST /claims/diagnose；改为 `POST /api/v1/diagnostics`（202 + diagnosticRunId），结果只到 RuleEvaluation → RecoveryOpportunity（§25）。
- **投影层**：Dashboard 不得前端 join 十张表；由 `projections/` 提供 overview / action-center / recoveries / integrations / executive-report（§27–§29）。
- **每阶段验收硬约束**：prisma validate PASS / typecheck PASS / targeted tests PASS / relevant PostgreSQL DB tests PASS / CI PASS；不变量保持 tenant isolation · account provenance · evidence lineage · idempotency · masking · audit · Action Guard · HITL · settlement truth · payout truth · fee·billing separation（§33）。
- **最终原则**：AI 只能帮助判断和生成，资金的真实入账与对外提交必须由规则、证据、可验证的服务端事实链驱动（§34）。

## 2. SAFE_CONTINUATION_QUEUE（B1–B10）

| 阶段 | 内容 | 前置 |
|---|---|---|
| PHASE B0 | 完成当前 C2 / Settlement / Action Guard / Closure（**已 CLOSED**）与当前 execution unit，不打断 | — |
| PHASE B1 | HTTP Layer 迁移：Fastify 设计 + `/api/v1` + 兼容计划，无 domain 重写 | 当前单元收口 |
| PHASE B2 | Integration Foundation：ProviderAdapter / OAuthAuthorizationSession / ConnectionCapability / ConnectionSyncState / SecretVault 抽象 | B1 + Schema Delta 审核 |
| PHASE B3 | UPS / FedEx 第一接入：OAuth + Account Discovery + Tracking Read + Capability Detection（**禁止**安装/启用 Direct Claim API） | B2 |
| PHASE B4 | Invoice / POD / Rate / SLA data 接入 | B3 |
| PHASE B5 | Structured Domain Facts：shipment/v1、customs-entry/v1 | B4 + Schema Delta 审核 |
| PHASE B6 | Dual-Path Routing：Platform Shipping vs Independent Carrier | B5 |
| PHASE B7 | Document AI：7501 / C88 / 中国报关单 / invoice / POD | B6 + Schema Delta 审核 |
| PHASE B8 | AsyncJob + Outbox（PostgreSQL 原生），暂不强化 Redis / Temporal | B5 |
| PHASE B9 | Submission Adapter：一期只开 CLAIM_READY_PACKAGE / PORTAL_DEEPLINK；DIRECT_API 需官方资质 + Action Guard 全绿 | B6 + 外部资质 |
| PHASE B10 | Customer Projection APIs：Overview / Action Center / Recoveries / Integrations / Executive Report | B8 |

## 3. HOST 原文（verbatim）

```text
[HOST → CODEX] CROSSCLAIM BACKEND ARCHITECTURE DIRECTIVE

TYPE: PRODUCT + BACKEND ARCHITECTURE DIRECTIVE

IMPORTANT:
本指令是基于 CrossClaim 当前真实代码库的增量升级，不是重写项目。

当前 C2 Account Provenance / Settlement Lineage / Action Guard / Closure 主线优先级最高。

DO NOT INTERRUPT CURRENT C2 CLOSURE.

不要因为本指令：

- 重置 AUTOPILOT
- 重开后端项目
- 改写现有领域模型
- 切换到 Python
- 新建第二套 claims/accounts/integrations
- 破坏已有 schema / tenant isolation / provenance / Action Guard

先收口当前主线，再把本指令加入 SAFE_CONTINUATION_QUEUE。

---

1. 当前技术栈保持不变

继续使用：

- TypeScript
- PostgreSQL
- Prisma
- Vitest
- 当前 services architecture

禁止按外部方案重写为：

- Python
- FastAPI
- Pydantic
- Celery

原因：

CrossClaim 当前已经拥有成熟的：

- Organization / User / Membership
- PlatformAccount
- SourceConnection
- SourceTransaction
- CanonicalFact
- Rule Engine
- RecoveryOpportunity
- ClaimItem
- Case
- Claim / Appeal
- EvidenceArtifact
- RecoveryPackage
- PlatformWriteAttempt
- Settlement
- RecoveryPayout
- FeeCalculation
- BillingInvoice
- AuditLog
- Action Guard
- HITL
- Tenant isolation
- Account provenance

不得建立第二套事实源。

---

2. HTTP Layer 可以逐步升级 Fastify

当前 Node 原生 HTTP Router 已明显开始复杂。

允许未来迁移：

Node HTTP
→ Fastify

但要求：

只替换 HTTP Adapter / Routing Layer。

禁止重写已有：

- service layer
- domain rules
- Prisma models
- Action Guard
- permissions
- settlement/recovery logic

目标：

Fastify
↓
Existing Workflow / Domain Services
↓
Prisma
↓
PostgreSQL

旧 API 保持兼容直到新 "/api/v1" 稳定。

---

3. 禁止新建重复核心模型

以下 Gemini/外部建议不得直接实施：

tenants
→ 已有 Organization

users
→ 已有 User + Membership

store_integrations
→ 已有 PlatformAccount + SourceConnection

carrier_accounts
→ 已有 PlatformAccount + SourceConnection

claims 单表
→ 已有 RecoveryOpportunity + ClaimItem + Case + Claim

carrier_invoices 独立真相表
→ 优先进入 SourceTransaction / structured domain fact

sla_disputes
→ RecoveryOpportunity + ClaimItem + Case + Claim

核心链必须保持：

External Source
→ PlatformAccount
→ SourceConnection
→ SourceTransaction
→ Canonical Fact
→ RuleEvaluation
→ RecoveryOpportunity
→ RecoveryRoute
→ ClaimItem
→ Case
→ Claim
→ Submission
→ Provider Outcome
→ Settlement
→ RecoveryPayout
→ FeeCalculation
→ BillingInvoice

---

4. 新增 Provider Integration Layer

新增目录建议：

apps/api/src/integrations/

core/

- provider-adapter.ts
- capability.ts
- oauth.ts
- sync.ts
- registry.ts

providers/

- amazon/
- tiktok/
- walmart/
- ups/
- fedex/
- dhl/
- customs/

统一 ProviderAdapter：

interface ProviderAdapter {
  provider: Platform;

  getAuthorizationUrl(...): Promise<AuthorizationStart>;
  exchangeAuthorizationCode(...): Promise<AuthorizationResult>;
  refreshAuthorization(...): Promise<void>;

  discoverAccounts(...): Promise<ProviderAccount[]>;

  listTransactions?(...): Promise<ProviderPage>;
  listShipments?(...): Promise<ProviderPage>;
  getTracking?(...): Promise<ProviderTracking>;
  getInvoice?(...): Promise<ProviderInvoice>;
  getPOD?(...): Promise<ProviderPOD>;

  getCapabilities(...): Promise<ProviderCapabilities>;

  prepareSubmission?(...): Promise<PreparedSubmission>;
  submit?(...): Promise<SubmissionResult>;
  getSubmissionStatus?(...): Promise<SubmissionStatus>;
}

"submit()" 必须可选。

不得假设：

Tracking API 可用

Invoice API 可用

Claim Submission API 可用

---

5. 新增 ConnectionCapability

这是下一阶段必须补的模型。

用途：

让系统真实知道每个连接到底支持什么，而不是 UI 猜测。

建议 capability：

- ACCOUNT_READ
- SHIPMENT_READ
- TRACKING_READ
- INVOICE_READ
- POD_READ
- CLAIM_PREPARE
- CLAIM_SUBMIT
- CLAIM_STATUS_READ
- SETTLEMENT_READ

状态：

- SUPPORTED
- UNSUPPORTED
- REQUIRES_SCOPE
- REQUIRES_PARTNER_APPROVAL
- UNKNOWN

建议 Schema 概念：

ConnectionCapability

id
organizationId
connectionId

capability
status

source
checkedAt
expiresAt
metadata

createdAt
updatedAt

必须带：

organizationId

并进入现有 tenant integrity 体系。

前端未来依据真实 capability 展示：

UPS
✓ Tracking
✓ Invoice
✓ POD
○ Direct Submission
Partner approval required

---

6. 新增 OAuthAuthorizationSession

OAuth 流程禁止仅靠前端 state。

新增服务端授权会话。

建议：

OAuthAuthorizationSession

id
organizationId
actorUserId
provider

stateHash
pkceRef

requestedScopes
returnPath

expiresAt
consumedAt

createdAt

规则：

- state 只存 hash
- PKCE verifier 不直接进入业务表
- session 单次消费
- 有明确 expiry
- callback 后 CAS / consume
- 重放拒绝
- 跨 tenant 拒绝

---

7. Token / Secret 禁止进入 PostgreSQL

继续使用当前 credentialRef 原则。

不要实施：

access_token encrypted column
refresh_token encrypted column

推荐：

PostgreSQL:
credentialRef

Secret Vault:
access_token
refresh_token
client_secret

允许未来适配：

- AWS Secrets Manager
- Azure Key Vault
- Aliyun KMS / Secret Manager
- HashiCorp Vault

建议新增：

services/secrets/
  secret-vault.ts
  adapters/

统一接口：

interface SecretVault {
  put(...)
  get(...)
  rotate(...)
  revoke(...)
}

数据库、AuditLog、HTTP response 永远不得包含真实 token。

---

8. 新增 ConnectionSyncState

Provider 数据必须支持增量同步。

不要把所有同步状态长期塞进 SourceConnection.config。

建议：

ConnectionSyncState

id
organizationId
connectionId

resourceType

cursor
watermark

lastStartedAt
lastSuccessAt
nextSyncAt

failureCount
lastErrorCode

createdAt
updatedAt

resourceType：

- ACCOUNT
- SHIPMENT
- TRACKING
- INVOICE
- POD
- SETTLEMENT

每个资源独立 cursor / watermark。

---

9. 新增 Structured Domain Fact Layer

当前 CanonicalFact 适合简单事实：

- externalId
- occurredAt
- amount
- currency

但 SLA / Customs 需要大量结构化字段。

禁止无限扩展 CanonicalFact。

新增：

DomainFactSnapshot

建议：

id
organizationId
accountId

domain
channel

factType
entityKey

schemaVersion
payload

snapshotDigest

observedAt
createdAt

必须 immutable / versioned。

再新增：

DomainFactSnapshotSource

用于关联：

DomainFactSnapshot
→ SourceTransaction

禁止 Structured Fact 成为不可追溯的新事实源。

必须：

SourceTransaction
→ DomainFactSnapshot

---

10. Shipment Fact 示例

schemaVersion：

shipment/v1

payload 示例：

{
  "trackingNumber": "...",
  "carrier": "UPS",
  "serviceLevel": "GROUND",
  "labelPurchaseSource": "AMAZON_BUY_SHIPPING",
  "promisedDeliveryAt": "...",
  "actualDeliveryAt": "...",
  "shippingCharge": "41.30",
  "currency": "USD"
}

未来可扩：

- invoice reference
- shipper account
- pickup time
- destination
- rate class
- DIM weight
- actual weight
- SLA suspension
- POD state
- carrier exception

---

11. Customs Fact 示例

schemaVersion：

customs-entry/v1

payload：

{
  "documentType": "CBP_7501",
  "entryNumber": "...",
  "jurisdiction": "US",
  "entryDate": "...",
  "importer": "...",
  "hsCode": "...",
  "declaredValue": "...",
  "dutyPaid": "...",
  "currency": "USD"
}

未来支持：

- CBP 7501
- C88
- 中国报关单
- 税款缴款书
- Broker statement
- classification records

---

12. Dual-Path Routing 独立成服务

不要把平台包运单 / 独立 Carrier 分流逻辑写散在 HTTP route。

建立：

services/routing/
  recovery-routing.ts

输入：

- DomainFactSnapshot
- RecoveryOpportunity
- PlatformAccount
- ConnectionCapability
- existing Provider context

输出：

RecoveryRoute

---

13. Platform Shipping 路由

例如：

labelPurchaseSource = AMAZON_BUY_SHIPPING

则：

RouteTarget.PLATFORM

例如 TikTok Shipping：

RouteTarget.PLATFORM

不要直接向 UPS/FedEx 建 Carrier Claim。

---

14. Independent Carrier 路由

例如：

labelPurchaseSource = MERCHANT_CARRIER
carrier = UPS

则：

RouteTarget.CARRIER

即使 UPS 尚未连接：

仍然是：

RouteTarget.CARRIER

但是：

route/status/projection
→ needs action CONNECT_UPS

禁止因为缺 OAuth 而把 responsible party 改成 Platform。

---

15. 新增 Document AI Pipeline

必须采用：

Upload
→ FileAsset
→ Security Scan
→ DocumentExtraction
→ Schema Validation
→ SourceTransaction
→ DomainFactSnapshot
→ Matching
→ RuleEvaluation
→ RecoveryOpportunity

禁止：

PDF
→ LLM
→ Claim

---

16. 新增 DocumentExtraction

建议：

DocumentExtraction

id
organizationId
fileAssetId

documentType

extractor
extractorVersion
schemaVersion

status

payload
payloadDigest

reviewRequired
errorCode

startedAt
finishedAt

createdAt

status：

- PENDING
- PROCESSING
- EXTRACTED
- NEEDS_REVIEW
- FAILED

documentType：

- CBP_7501
- C88
- CHINA_CUSTOMS_DECLARATION
- COMMERCIAL_INVOICE
- RATE_CARD
- POD
- OTHER

---

17. AI / OCR 不能直接形成资金事实

OCR / LLM 输出只能：

- parse
- normalize
- extract
- classify
- candidate match
- explain
- draft

禁止直接：

AI output
→ recoverableAmount
→ Settlement
→ RecoveryPayout

必须经过：

Extraction
→ Validation
→ DomainFact
→ Rule Engine
→ Evidence completeness
→ Opportunity

低置信 / 冲突：

NEEDS_REVIEW

---

18. 异步任务第一阶段不要引入 Celery

禁止因为外部建议增加 Python Celery runtime。

第一阶段：

PostgreSQL-backed AsyncJob

建议：

AsyncJob

id
organizationId

jobType
idempotencyKey

status
payload

attemptCount
maxAttempts

nextRunAt

lockedAt
lockedBy

lastErrorCode

createdAt
updatedAt
finishedAt

jobType：

- CONNECTION_SYNC
- DOCUMENT_EXTRACT
- DOMAIN_NORMALIZE
- OPPORTUNITY_SCAN
- CLAIM_STATUS_SYNC
- SETTLEMENT_SYNC

Worker 使用：

FOR UPDATE SKIP LOCKED

必须保证：

- idempotency
- retry
- backoff
- dead-letter state
- tenant scope

---

19. 新增 Transactional Outbox

新增：

OutboxEvent

目的：

业务写入与事件发布必须同事务。

例如：

SourceTransaction created
+
OutboxEvent(source_transaction.created)

在同一个 PostgreSQL transaction 中提交。

Worker：

source_transaction.created
→ canonicalize
→ domain_fact.created
→ evaluate
→ opportunity.detected

禁止：

DB commit
→ memory callback / Redis publish

作为唯一事件保证机制。

---

20. Redis 暂时不是硬依赖

第一阶段：

PostgreSQL
+
AsyncJob
+
Outbox

即可。

Redis 后续只有在明确需要：

- distributed cache
- rate limit
- ephemeral lock
- high-frequency queue

时再引入。

不要为了“现代架构”而增加 Redis。

---

21. Temporal 延后

CrossClaim 最终适合 Temporal，因为存在长生命周期流程：

submit
→ wait
→ provider status
→ missing evidence
→ human action
→ retry
→ appeal
→ settlement

但现在不要立即引入。

Stage 1：

Postgres AsyncJob + Outbox

Stage 2：

当真实 Amazon / UPS / FedEx 生产 API 接入并出现长生命周期 workflow 后：

评估 Temporal TypeScript SDK。

不要 Celery。

---

22. Submission Adapter 统一

不要建立：

ups_claim_submission
fedex_claim_submission
amazon_claim_submission

统一：

interface SubmissionAdapter {
  capability(...): Promise<SubmissionCapability>;

  prepare(...): Promise<PreparedSubmission>;

  submit?(...): Promise<SubmissionResult>;

  getStatus?(...): Promise<SubmissionStatus>;
}

Capability：

- DIRECT_API
- PORTAL_DEEPLINK
- CLAIM_READY_PACKAGE
- UNAVAILABLE

---

23. 复用 PlatformWriteAttempt

现有：

PlatformWriteAttempt

已经具备：

- snapshotDigest
- idempotencyKey
- attemptNo
- status
- approvalId
- providerRef
- retry
- reconcile
- error classification

继续复用。

未来如果 Provider 范围扩大到 Carrier / Customs，可评估概念重命名：

PlatformWriteAttempt
→ ExternalWriteAttempt

但目前禁止为了命名做高风险 schema churn。

先抽象 service / adapter。

---

24. Claim Ready / Manual Recovery 继续复用现有结构

已经存在：

RecoveryPackage
RecoveryPackageArtifact
RecoveryManualSubmission
RecoveryManualSubmissionReference
RecoveryManualSubmissionEvidence

所以：

PORTAL_DEEPLINK
CLAIM_READY_PACKAGE

必须优先复用这些模型。

不要新建第二套 package/submission。

---

25. Diagnose API 不应叫 claims/diagnose

禁止新增：

POST /claims/diagnose

因为 Diagnose ≠ Claim。

建议：

POST /api/v1/diagnostics

返回：

{
  "diagnosticRunId": "...",
  "status": "QUEUED"
}

HTTP：

202 Accepted

再：

GET /api/v1/diagnostics/:id

诊断最终产生：

RuleEvaluation
→ RecoveryOpportunity

不是直接 Claim。

---

26. OAuth API 统一

不要设计：

/integrations/carrier/oauth

建议：

POST /api/v1/integrations/:provider/oauth/start

例如：

POST /api/v1/integrations/ups/oauth/start

返回：

{
  "authorizationSessionId": "...",
  "authorizationUrl": "...",
  "expiresAt": "..."
}

Callback：

GET /api/v1/integrations/:provider/oauth/callback

流程：

validate state
→ consume OAuthAuthorizationSession
→ exchange code
→ token → SecretVault
→ credentialRef
→ Discover Accounts
→ PlatformAccount
→ SourceConnection
→ ConnectionCapability
→ ConnectionSyncState

---

27. Customer Read Projection

前端不要自己 join 十几张表计算 Dashboard。

新增 projection layer：

projections/
  overview/
  action-center/
  recoveries/
  integrations/
  executive-report/

API：

GET /api/v1/overview
GET /api/v1/actions
GET /api/v1/recoveries
GET /api/v1/recoveries/:id
GET /api/v1/integrations
GET /api/v1/reports/executive

这些是 projection。

不是业务事实源。

---

28. Overview Projection

必须严格区分：

Potential
Verified
In Recovery
Recovered

Recovered 必须来自真实：

Settlement / RecoveryPayout

绝不允许：

Claim APPROVED

Recovered

---

29. Action Center Projection

返回真实用户动作：

- CONNECT_INTEGRATION
- REAUTHORIZE
- UPLOAD_DOCUMENT
- APPROVE
- PROVIDER_REQUEST
- REVIEW_EXCEPTION

每一条都必须有真实 backend reason。

禁止 AI 生成假的“待处理”。

---

30. 推荐新增 Schema 数量控制

优先只评估以下 8 个模型：

1. OAuthAuthorizationSession
2. ConnectionCapability
3. ConnectionSyncState
4. DomainFactSnapshot
5. DomainFactSnapshotSource
6. DocumentExtraction
7. AsyncJob
8. OutboxEvent

任何额外新表必须回答：

“现有模型为什么不能承担？”

否则禁止创建。

---

31. 目标目录

最终逐步演进到：

apps/api/src/

http/
auth/
action-guard/

integrations/
  core/
  providers/

acquisition/
ingest/
canonical/

domain-facts/
  shipment/
  customs/

documents/
rules/
routing/

claim/
claims/
evidence/
recovery/

submission/

settlement/
billing/

projections/

jobs/
outbox/

storage/
secrets/
audit/
operations/

禁止一次性搬迁所有目录。

Incremental only。

---

32. 实施顺序

PHASE B0

先完成当前：

C2 Account Provenance
Settlement Lineage
Action Guard
Closure

不得中断。

---

PHASE B1

HTTP Layer 治理：

- Fastify design
- "/api/v1"
- compatibility plan
- no domain rewrite

---

PHASE B2

Integration Foundation：

- ProviderAdapter
- OAuthAuthorizationSession
- ConnectionCapability
- ConnectionSyncState
- SecretVault abstraction

---

PHASE B3

UPS / FedEx 第一批：

只做：

- OAuth
- Account Discovery
- Tracking Read
- Capability Detection

禁止此阶段假装存在 Direct Claim API。

---

PHASE B4

增加：

- Invoice
- POD
- Rate
- SLA data

---

PHASE B5

Structured Domain Facts：

- shipment/v1
- customs-entry/v1

---

PHASE B6

Dual-Path Routing：

Platform Shipping
vs
Independent Carrier

---

PHASE B7

Document AI：

- 7501
- C88
- China customs documents
- invoice
- POD

---

PHASE B8

AsyncJob + Outbox

先 PostgreSQL。

暂不强制 Redis / Temporal。

---

PHASE B9

Submission Adapter：

第一阶段：

- CLAIM_READY_PACKAGE
- PORTAL_DEEPLINK

只有 Provider 能力、合规资格和 Action Guard 全部确认后才：

- DIRECT_API

---

PHASE B10

Customer Projection APIs：

- Overview
- Action Center
- Recoveries
- Integrations
- Executive Report

用于前端产品化。

---

33. 所有阶段共同硬约束

每个阶段必须：

- prisma validate PASS
- typecheck PASS
- targeted tests PASS
- relevant PostgreSQL DB tests PASS
- CI PASS

不得削弱：

- tenant isolation
- account provenance
- evidence lineage
- idempotency
- masking
- audit
- Action Guard
- HITL
- settlement truth
- payout truth
- fee/billing separation

---

34. 最终产品目标

必须支持：

One Organization
→ Multiple Platforms
→ Multiple Accounts
→ Multiple Providers
→ One Recovery OS

完整链路：

授权/上传
→ 自动读取
→ 自动标准化
→ 自动发现资金损失
→ 自动验证
→ 自动生成证据
→ 自动路由
→ 能 API 则受保护提交
→ 无 API 则生成 Claim Ready Package / Portal Handoff
→ 跟踪 Provider Outcome
→ 识别真实到账
→ Settlement / Payout
→ 自动计算服务费
→ Billing

核心原则：

“AI 可以参与判断和生成，但资金事实、账户归属、提交动作、到账事实必须来自可验证、可审计、可追溯的数据链。”

---

35. AUTOPILOT INGESTION

当读取本指令后：

记录：

SOURCE = HOST BACKEND ARCHITECTURE DIRECTIVE

STATUS = QUEUED_AFTER_CURRENT_C2

不得立即打断当前 execution unit。

把以下项目加入 SAFE_CONTINUATION_QUEUE：

B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9 → B10

并回报：

1. 当前 HEAD
2. 当前 C2 closure 状态
3. 本指令 ingestion 状态
4. 是否与现有 roadmap 冲突
5. 第一项实际可执行 backend delta
6. 是否需要 schema delta review
7. 不得仅回复计划；当前 C2 收口后自动继续执行
```
