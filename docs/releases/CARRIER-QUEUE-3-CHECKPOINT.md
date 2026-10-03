# CARRIER QUEUE #3 — UPS / FEDEX AUTH + ACCOUNT DISCOVERY INTERNAL CONTRACT CHECKPOINT

状态：**READY_FOR_REVIEW**（内部契约批次；真实凭据 / 真实 provider 调用继续 HOLD_EXTERNAL）
前序：MSG-20261003-105 ③ `PC-12A = PASS / CLOSED`；⑤⑭ 正式授权 **CARRIER QUEUE #3**；⑥ Carrier 生产凭据 = **HOLD_EXTERNAL**。
IMPLEMENTATION_HEAD = 1ae5ca5
IMPLEMENTATION_HEAD_FULL = 1ae5ca5bc2467a5c99ece361874ee2247339f724
CI = SUCCESS · RUN_ID = 37068040288 · CI_VERIFIED_HEAD = 1ae5ca5
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 交付内容（裁决 ⑯–㉓、㉗）

### 1.1 CarrierAuthContract（`apps/api/src/services/carriers/carrier-auth-contract.ts`）

- **UPS / FedEx 分别声明**，不强行统一为同一协议：UPS = `OAUTH_AUTH_CODE`（第三方应用 OAuth Auth-Code，客户授权 → 多 shipper account 映射多个 PlatformAccount）；FedEx = `INTEGRATOR_CREDENTIAL_REGISTRATION`（provider-specific onboarding，不假定与 UPS 相同流程）。统一的是 interface，不是 provider-specific details。
- 单一口径：`authKind` 直接取自既有 `connector-capability.ts` 的 `descriptor.authModel`（**不另立第二套 provider 事实源**，也不新增与 PlatformAccount / SourceConnection 平行的模型）。
- 每个 provider 分别声明：`authorizationEndpoint` / `tokenEndpoint` / `accountDiscoveryEndpoint`（**抽象名 + `configuredBy: HOST` + `value: null`**，本仓库不持有任何真实 URL / client id / client secret）、`tokenExpiry`（`supported: true, defaultTtlSeconds: null` —— 真实 TTL 由 HOST / provider 文档注入，不猜）、`refreshBehavior`（UPS = `REFRESH_TOKEN`；FedEx = `CLIENT_CREDENTIAL_REISSUE`）、只读 scope 意图（`TRACKING_READ` / `INVOICE_READ` / `POD_READ`；`assertCarrierReadOnlyScopeIntents` 拒绝任何 write / 未登记意图）。
- 凭据边界沿用 PC-11A：`credentialReferenceOnly: true`（只允许 `credentialRef`）；`identityVerificationRequired: true`；`multiAccountPerCredential: PROVIDER_DISCOVERY_DECIDES`（**不得假定 1 credential = 1 account**）。
- `authImplemented: false` / `accountDiscoveryImplemented: false`（真实网络调用未实现）与 `authContractReady: true` / `accountDiscoveryContractReady: true`（内部契约就绪）**分离表达** —— 与 PC-11A 的「CONTRACT IMPLEMENTED ≠ PROVIDER NETWORK INTEGRATION IMPLEMENTED」一致。

### 1.2 CarrierAccountDiscoveryPort（`apps/api/src/services/carriers/carrier-account-discovery.ts`）

```text
CarrierAccountDiscoveryPort.discoverAccounts({ provider, credentialRef, organizationId, actorUserId })
  -> Promise<CarrierDiscoveredAccount[]>
     { provider, externalAccountId, displayName, accountType, countryOrRegion, status, identityVersion }
```

- 顺序 fail-closed：未知 carrier → 输入形状校验（明文凭据 / 未声明字段拒绝）→ `credentialRef` 必需 → tenant 上下文必需 → credential lineage 登记 → discovery port 调用 → 账号形状校验 → 幂等去重 → 0 / 1 / 多账号分支。
- **服务端派生身份**：候选 `externalAccountId` 只能来自 provider discovery 响应（`identitySource: PROVIDER_DISCOVERY`，`identityHintAccepted: false`）；用户输入的 account number 仅作 hint，**永不**成为 verified identity，也不参与账号选择（多账号 + 命中 hint 仍要求显式选择）。
- 结果处理：`0 → NO_ACCOUNT_DISCOVERED`；`1 → CANDIDATE_BIND_PLAN`；`多个 → EXPLICIT_SELECTION_REQUIRED`（**禁止自动绑定**）。绑定执行保持 HOLD：`bindExecuted: false`、`requiredNextStep: VERIFIED_BIND_REQUIRED_EXTERNAL_GATE`。
- 幂等：`candidateIdentity = carrier:<provider>:<externalAccountId>`，同一 provider + externalAccountId 重复 discovery（含同一响应内重复条目）映射到**同一候选身份**。
- tenant safety：credential lineage 绑定 `organizationId + actorUserId + provider + credentialRef`；同一 `credentialRef` 出现在其它 organization（跨租户）或其它 provider → `CREDENTIAL_LINEAGE_CONFLICT`。
- 凭据不外泄：discovery 端口只接收 `credentialRef`；账号对象出现任何未声明字段（尤其 access token / client secret）→ `DISCOVERED_ACCOUNT_INVALID`；outcome / bind plan 只含引用，不含凭据取值。
- read-only first：不触碰 claim submission / refund submission / shipment mutation / SLA claim write / payout mutation。

### 1.3 read-only readiness 投影（裁决 ㉗）

`GET /provider-readiness` 新增 `carriers`（**按 provider 分别投影，无泛化 CARRIER_READY**）：`provider` / `authKind` / `authContractReady` / `accountDiscoveryContractReady` / `authImplemented` / `accountDiscoveryImplemented` / `identityVerificationRequired` / `productionCredentials: ABSENT` / `productionApprovalState: NOT_REQUESTED` / `sandboxState: AVAILABLE` / `platformWriteEnabled: false` / `transportEnabled: false` / `requiredHostActions`；响应不含任何 secret。

## 2. 回归（裁决 ㉘）

| 编号 | 必需测试 | 结果 |
|---|---|---|
| 1 | unknown carrier fail-closed | ✅ resolve null / require 抛 `CARRIER_PROVIDER_UNKNOWN`，且 discovery port 未被调用 |
| 2 | missing credentialRef rejected | ✅ 缺省 / 空串 / 仅空白 → `CREDENTIAL_REF_REQUIRED` |
| 3 | plaintext token input not supported | ✅ `accessToken` / `refreshToken` / `clientSecret` → `PLAINTEXT_CREDENTIAL_NOT_SUPPORTED`，值不出现在结果中 |
| 4 | account discovery uses credentialRef | ✅ port 只收到 `{ provider, credentialRef, organizationId, actorUserId }` |
| 5 | zero account result stable | ✅ 两次 `NO_ACCOUNT_DISCOVERED` 完全一致（plan null） |
| 6 | one account produces candidate plan | ✅ `CANDIDATE_BIND_PLAN` + `bindExecuted: false` |
| 7 | multiple accounts requires explicit selection | ✅ `EXPLICIT_SELECTION_REQUIRED` + plan null |
| 8 | client-forged externalAccountId ignored | ✅ hint 被忽略，候选只有服务端检索到的 identity |
| 9 | discovered identity server-derived | ✅ `identitySource: PROVIDER_DISCOVERY` + `candidateIdentity` 派生 |
| 10 | duplicate discovery identity stable | ✅ 重复条目去重 + 两次结果同一 identity |
| 11 | cross-tenant result cannot be reused | ✅ 跨 organization / 跨 provider → `CREDENTIAL_LINEAGE_CONFLICT` |
| 12 | UPS and FedEx capability facts separate | ✅ readiness 两条独立，`authKind` 分别断言 |
| 13 | credential value never returned/logged | ✅ outcome 无凭据字段；port 返回凭据字段即 `DISCOVERED_ACCOUNT_INVALID` |
| 14 | bindExecuted remains false | ✅ outcome / plan 恒 false |
| 15 | platform write remains false | ✅ outcome / plan / readiness 恒 false |
| 16 | TRANSPORT remains false | ✅ `transportEnabled: false` 恒成立 |
| 17 | no live provider request | ✅ stub `fetch` 抛错仍全流程通过；sandbox port 无网络 |
| 18 | production credentials remain ABSENT | ✅ contract / readiness / plan 恒 `ABSENT` |
| 19 | tsc api / web 0 | ✅ `tsc --noEmit` 0 error（api）；web 未改动 |
| 20 | full CI SUCCESS | ✅ RUN_ID = 37068040288（head 1ae5ca5）5 jobs 全绿 |

本地套件：`carrier-auth-account-discovery` **25/25**；`provider-readiness-http-db` **1/1**（新增 carriers 投影断言）；`API contract = API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由，仅在既有 `/provider-readiness` 上做加法）。

## 3. 明确未做（裁决 ㉙）

未调用真实 UPS / FedEx API；未写入生产凭据；未开启 carrier claim submission；未开启 transport；未开启 payout / recovery write；未把用户输入账号号当 verified identity；未合并 PlatformAccount 与 SourceConnection；未新增平行 carrier_accounts / sla_disputes 事实源。

## 4. HOLD_EXTERNAL（裁决 ㉚）

UPS developer credentials · FedEx developer credentials · callback / config registration · 真实 seller / carrier 账户授权 · sandbox → production provider 调用 · 真实客户数据读取验证。**PC-12B（真实支付启用）同样维持 HOLD_EXTERNAL。**

## 5. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① CarrierAuthContract（UPS / FedEx 分别声明、endpoint 抽象、refresh / expiry、只读 scope 意图）是否已收口；② CarrierAccountDiscoveryPort 语义（server-derived identity / 0-1-多分支 / 幂等 / tenant lineage / bindExecuted=false）是否已收口；③ carrier readiness 投影是否满足 ㉗；④ 是否批准 CARRIER QUEUE #3 内部契约 = PASS/CLOSED；⑤ 下一内部单元（Carrier Queue #4 tracking read adapter，或架构方指定的内部单元）。

边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
