# CARRIER SLA / DUAL-PATH / CUSTOMS RECOVERY —— HOST DIRECTIVE REGISTER

来源：**HOST DIRECTIVE 2026-10-02（Carrier SLA / Dual-Path / Customs Recovery 增量要求）**
状态：**REGISTERED —— 设计优先，逐项送审；不打断当前主线**（当前主线 = PC-12A；TRACK C2 account provenance 已 CLOSED）。

## 0. 指令自带的硬约束（不可协商）

1. 复用现有 `PlatformAccount` + `SourceConnection` 作为**唯一**外部账户 / 授权连接事实源。
2. 复用现有主链：`SourceTransaction → CanonicalFact → RuleEvaluation → RecoveryOpportunity → ClaimItem → Case → Claim → Settlement → RecoveryPayout`。
3. **不得**新增与 `PlatformAccount` / `Claim` / `Settlement` 平行且语义重复的第二事实源（例如 `carrier_accounts` / `sla_disputes`）。
4. Carrier Invoice 默认进入现有 `SourceTransaction` / `CanonicalFact` / `EvidenceArtifact(INVOICE)`；**只有**证明现有模型无法满足查询 / 约束时，才可提出**附属 Projection Schema**（单独送审）。
5. 必须保持既有 tenant isolation、account provenance、immutability、Action Guard、HITL、fail-closed 不变量。

## 1. 复用核查（结论：V1 **不需要任何新模型 / 新枚举**）

| 指令要求的语义 | 仓库现状 | 结论 |
|---|---|---|
| `PlatformAccount.platform = UPS / FEDEX` | `enum Platform` 已含 `UPS` / `FEDEX` / `DHL` / `CUSTOMS` | ✅ 复用 |
| `RecoveryDomain.LOGISTICS` / `CUSTOMS` | `enum RecoveryDomain { PLATFORM, LOGISTICS, CUSTOMS }` | ✅ 复用 |
| `RuleScope.FREIGHT_RATE` | 已存在 | ✅ 复用 |
| `RuleScope.SLA` / `DIM_WEIGHT` / `FUEL_SURCHARGE` / `ACCESSORIAL` / `DUPLICATE_CHARGE` | 全部已存在 | ✅ 复用 |
| `RuleScope.CUSTOMS_DUTY` | 已存在 | ✅ 复用 |
| `RouteTarget.PLATFORM` / `CARRIER` | 已存在 | ✅ 复用 |
| `RouteTarget.CUSTOMS_AUTHORITY` / `CUSTOMS_BROKER` / `CUSTOMER_SELF` | 已存在 | ✅ 复用 |
| `EvidenceKind.CUSTOMS_DOC` / `BROKER_CORRESPONDENCE` | 已存在 | ✅ 复用 |
| `FREIGHT_RATE_V1` 与 `RuleSet` / `RuleVersion` / `RuleEvaluation` | 已存在（规则引擎为单源） | ✅ 复用 |

因此：**本指令的 V1 全部可由「既有 Schema + 新增 service / connector / adapter 模块」实现，无需 migration、无需新表**。
若未来确需附属 Projection，必须按指令第 4 条单独提交 Schema Delta 与理由。

## 2. 新增能力（模块边界，全部 additive）

### 2.1 Carrier Integration Service（UPS / FedEx 统一 Connector）

统一 operation 契约：`authorize` · `refreshAuthorization` · `listShipments` · `getTracking` · `getInvoice` · `getPOD` · `prepareClaim` · `submitClaim` · `getClaimStatus`。

**Capability negotiation（强制）**：`supportsTrackingRead` · `supportsInvoiceRead` · `supportsPODRead` · `supportsDirectClaimSubmission` · `supportsClaimStatusRead`。
**禁止**假设所有 Provider 都具有公开 Direct Claim API —— 未审计的能力默认 `false`，未知 provider 一律 fail-closed。

**Submission Mode**：`DIRECT_API` · `PORTAL_DEEPLINK` · `CLAIM_READY_PACKAGE`（后续如官方授权允许，可新增**受审计**的其他模式）。

### 2.2 Dual-Path Routing

- **PATH A — Independent Carrier Account**：`PlatformAccount.platform = UPS / FEDEX`，`SourceConnection.kind = API`，`RecoveryDomain = LOGISTICS`；Carrier Invoice + Tracking + Rate Card + POD → `RuleEvaluation` → `RecoveryOpportunity` → `RecoveryRoute.target = CARRIER` → `Claim`。
- **PATH B — Platform Shipping**：复用 Amazon / TikTok / Walmart 既有 `PlatformAccount` 与 `SourceConnection`；平台运单 + 平台扣费 + Tracking → Carrier Audit Agent → `RecoveryOpportunity` → `RecoveryRoute.target = PLATFORM` → `Claim`。
- **PATH B 不得**向承运商发起 Claim；`responsibleParty` / `payer` 必须由**服务端事实链**确定，客户端不得指定可信责任方。

### 2.3 Carrier Audit Agent（在 `FREIGHT_RATE_V1` 基础上增加 SLA evaluator）

支持 `RuleScope`：`FREIGHT_RATE` / `SLA` / `DIM_WEIGHT` / `FUEL_SURCHARGE` / `ACCESSORIAL` / `DUPLICATE_CHARGE`。

SLA Opportunity 必须**逐项验证**：account provenance · payer / responsible party · official shipment/tracking identity · service level · promised delivery timestamp · actual delivery timestamp · official invoice/charge basis · claim deadline · SLA suspension / service exclusion · contract/policy applicability。
**任何关键事实缺失或歧义 → `RuleEvaluationResult = NEEDS_MORE_DATA`（禁止猜测）。**

### 2.4 Progressive Authorization（三阶段，禁止把 ESTIMATED 当 verified）

- **Stage 1 — Potential Recovery**：仅用已有店铺连接数据（shipment / carrier / tracking / shipping charge / promised delivery / actual delivery）输出 `potentialRecoverableAmount`、`candidateShipmentCount`、`confidence`、`status = ESTIMATED`。**禁止**写成最终 verified recoverable amount。
- **Stage 2 — Verified Recovery**：用户授权 Carrier Account 后获取 official invoice / official tracking / rate·contract evidence / POD / SLA policy·suspension，**重新确定性计算**后才允许生成正式 `RecoveryOpportunity.recoverableAmount`。
- **Stage 3 — Recovery**：仅在同时满足 —— `RuleEvaluation = OPPORTUNITY` · account provenance 完整 · payer/responsible party 已确认 · claim deadline 有效 · SLA suspension/exclusion 已检查 · required evidence 完整 · `RecoveryRoute` 已确认 · Submission Adapter `supportsDirectClaimSubmission = true` · Action Guard PASS —— 才允许进入自动提交候选；否则保持 `NEEDS_MORE_DATA` / `NEEDS_MANUAL`，**不得真实外写**。

### 2.5 中国 Customs Recovery（V1/V2/V3，复用同一框架）

复用 `Platform.CUSTOMS` · `RecoveryDomain.CUSTOMS` · `RuleScope.CUSTOMS_DUTY` · `RouteTarget.CUSTOMS_AUTHORITY` / `CUSTOMS_BROKER` / `CUSTOMER_SELF` · `EvidenceKind.CUSTOMS_DOC` / `BROKER_CORRESPONDENCE`。

- **V1**：报关单 / 税单 / 缴税记录导入 → Customs Rule Evaluation → `RecoveryOpportunity` → Claim-Ready Package → 官方系统 Deep Link / Customer Self Submit。
- **V2**：企业授权 / 合作报关或税务服务机构 Connector。
- **V3**：取得官方允许的生产 API 后替换为 API Adapter。
- **核心 Claim / Evidence / Settlement / Billing 不因本指令重构。**

### 2.6 FedEx / UPS 授权要求

- **UPS**：按第三方应用场景设计 **OAuth Auth-Code flow**，支持一个客户多个 shipper account 映射为多个 `PlatformAccount`。
- **FedEx**：按 **FedEx Integrator Provider / Credential Registration** 能力设计 provider-specific onboarding；**不得**假定其客户授权流程与 UPS 完全相同。
- **token / client secret / refresh credential 禁止进入 `PlatformAccount`**；统一通过 `SourceConnection.credentialRef` 指向 Secret Store。

## 3. 本阶段交付顺序（指令第七节，逐项送审）

1. 先完成当前 account provenance 收口，**不打断当前主线**（C2 已 CLOSED；当前主线 = PC-12A，完成后再按序推进）。
2. Carrier Connector Capability Interface（**本批已交付内部契约**，见 §4）。
3. UPS / FedEx auth + account discovery。
4. Tracking read adapter。
5. Invoice ingestion adapter。
6. SLA evaluator + suspension / exclusion。
7. Dual-Path Routing。
8. Progressive Recovery Preview。
9. Claim package preparation。
10. Direct submission capability（**须单独审计后才可开启**）。
11. Customs China connector（同一框架接入）。

每一个生产外写 Provider 必须**单独**经过：

```text
DESIGN → IMPLEMENTATION → FIXTURE/SANDBOX → REAL DATA READ VALIDATION
       → SUBMISSION DRY RUN → ACTION GUARD → PRODUCTION ENABLEMENT
```

**禁止**因为「UI 已完成」或「存在 OAuth」就宣称「全自动追回已完成」。

## 4. 本批交付（Carrier Connector Capability Interface）

`apps/api/src/services/carriers/connector-capability.ts`：operation 契约 + capability flags + submission modes + provider descriptor（UPS / FEDEX）+ 能力协商与 fail-closed 守护；
`apps/api/src/__tests__/carrier-connector-capability.test.ts`：永久回归。
默认 `supportsDirectClaimSubmission = false`（未审计即不可声明）；所有 provider 的 `credentialReferenceOnly = true`、`platformWriteEnabled = false`、`readiness = EXTERNAL_GATE`。

## 5. 门槛（本指令相关的强制边界）

**ARCH REVIEW REQUIRED（必须先送架构方裁决）**：

- SLA evaluator 语义（suspension / service exclusion / deadline 计算）
- `responsibleParty` / `payer` 的服务端判定规则
- Dual-Path 路由规则与其与既有 `RecoveryRoute` 的一致性
- 任何 Schema / Projection 变更（当前评估：V1 **不需要**）
- Direct submission capability 的开启（Step 10）

**HOST APPROVAL REQUIRED（外部、不可逆或涉及真实数据/资金）**：

- 真实承运商账号授权（UPS OAuth / FedEx Integrator Provider 注册）
- 生产 client id / client secret / 生产 webhook secret
- callback 域名注册（DNS / 域名）
- 真实客户数据读取（REAL DATA READ VALIDATION）
- 任何真实外写 / 真实提交 / 付费服务

**当前一律保持**：NO platform write · TRANSPORT=false · Payment = 0 · collection/autopay OFF · R13 HOLD · 无生产凭据。
