# CARRIER QUEUE #3 FINAL — PROVIDER-SPECIFIC AUTH + ACCOUNT IDENTITY STRATEGY CHECKPOINT

状态：**READY_FOR_REVIEW**（内部契约收口；真实凭据 / 真实 provider 调用继续 HOLD_EXTERNAL）
前序：MSG-20261003-106 = **CARRIER QUEUE #3 = REVISE-MINOR / NOT CLOSED**；唯一剩余 = provider-specific auth / account identity acquisition truth（⑪–⑳）。
IMPLEMENTATION_HEAD = dc0edf6
IMPLEMENTATION_HEAD_FULL = dc0edf6f64ee62c5124a6536024a98b2a9f6bad4
CI = SUCCESS · RUN_ID = 37069842384 · CI_VERIFIED_HEAD = dc0edf6
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. CHANGE A（⑪⑫）— UPS auth model 改为 scenario-aware

`connector-capability.ts` 不再把 UPS 表达成「唯一 OAUTH_AUTH_CODE」：

```text
UPS:
  supportedAuthFlows: [CLIENT_CREDENTIALS, AUTHORIZATION_CODE]
  selectedAuthFlow: AUTHORIZATION_CODE
  authFlowSelectionReason: THIRD_PARTY_CUSTOMER_AUTHORIZATION
FEDEX:
  supportedAuthFlows: [INTEGRATOR_CREDENTIAL_REGISTRATION]
  selectedAuthFlow: INTEGRATOR_CREDENTIAL_REGISTRATION
  authFlowSelectionReason: PROVIDER_INTEGRATOR_REGISTRATION
```

- `authKind` 保留（既有消费方兼容），并由 `selectedAuthFlow` 派生校验：新增 `carrierAuthModelForFlow()` + `assertCarrierAuthTruth()`（错误码 `CARRIER_AUTH_FLOW_INCONSISTENT`）。
- 语义：**selected flow ≠ provider only flow**；本轮产品选择仍是 Authorization Code，未改成 Client Credentials。

## 2. CHANGE B（⑬–⑱）— FedEx 身份获取改为 provider-verified registration

- 新增身份策略事实：`accountIdentityStrategy ∈ { PROVIDER_DISCOVERY, PROVIDER_VERIFIED_REGISTRATION }`；UPS = `PROVIDER_DISCOVERY`，FedEx = `PROVIDER_VERIFIED_REGISTRATION`。
- `discoverCarrierAccounts()` 增加策略守卫：非 discovery 策略（FedEx）→ `IDENTITY_STRATEGY_NOT_DISCOVERY`，**discovery port 永不被调用**（不再需要虚构 list-accounts 结果）。
- 新增 `CarrierAccountRegistrationPort` + `registerCarrierAccountIdentity()`：
  - 输入 = 客户提交的候选账号 + 姓名 + 地址（**candidate identity input**，不是 trusted identity）；
  - 缺任一项证据 → `CANDIDATE_EVIDENCE_REQUIRED`（裸账号号 ≠ verified identity）；
  - provider 注册/验证未通过或缺 credentialRef → `REGISTRATION_NOT_VERIFIED`，**不产生 candidate bind plan**；
  - 通过 → `CANDIDATE_BIND_PLAN`，`identitySource = PROVIDER_VERIFIED_REGISTRATION`，`registrationRef` 进入 bind plan（registration transaction lineage）。
- FedEx 多账号通过 **multiple verified registrations** 满足，不依赖「一次 credential → discover many accounts」。

## 3. CHANGE C（⑲）— identity outcome 策略中立

- `CarrierDiscoveredAccount` → **`CarrierVerifiedAccountIdentity`**（provider / externalAccountId / displayName / accountType / countryOrRegion / status / identityVersion），并显式返回 `identitySource ∈ { PROVIDER_DISCOVERY, PROVIDER_VERIFIED_REGISTRATION }`。
- 旧名保留为 `@deprecated` type alias，避免破坏既有消费方；账号形状校验仍拒绝任何未声明字段（尤其 access token）。

## 4. CHANGE D（⑳）— readiness 暴露 strategy truth

`GET /provider-readiness` 的 `carriers[]` 新增 `authFlows` / `selectedAuthFlow` / `authFlowSelectionReason` / `accountIdentityStrategy`；真实实现仍恒 `authImplemented=false` / `accountDiscoveryImplemented=false` / `productionCredentials=ABSENT` / `platformWriteEnabled=false` / `transportEnabled=false`。API.md 已同步（路由数不变 `implemented=84 / documented=71` = `API_CONTRACT_OK`）。

## 5. 保持项（㉑㉒㉔ 未重做）

- credential lineage：discovery 与 registration **都**绑定 `organizationId + actorUserId + provider + credentialRef`（registration 另带 `registrationRef`）；跨租户 / 跨 provider → `CREDENTIAL_LINEAGE_CONFLICT`。
- candidate identity key `carrier:<provider>:<externalAccountId>` 幂等；explicit selection（多账号不得自动绑定）。
- secret protection / credentialRef-only boundary：端口只接收 `credentialRef`；携带未声明字段 → 拒绝；无 fake production readiness。
- bind HOLD：`bindExecuted=false` / `requiredNextStep=VERIFIED_BIND_REQUIRED_EXTERNAL_GATE` / TRANSPORT 未打开。

## 6. 回归（㉓ 20 项定点）

| 定点要求 | 结果 |
|---|---|
| UPS exposes selected AUTHORIZATION_CODE scenario without claiming it is the only supported OAuth flow | ✅ `supportedAuthFlows` 含 CLIENT_CREDENTIALS + AUTHORIZATION_CODE；selected = AUTHORIZATION_CODE |
| UPS identity strategy = PROVIDER_DISCOVERY | ✅ contract + connector-capability 双侧断言 |
| UPS multiple discovered accounts → explicit selection | ✅ |
| FedEx identity strategy = PROVIDER_VERIFIED_REGISTRATION | ✅（supportedAuthFlows 不含 AUTHORIZATION_CODE） |
| FedEx raw user account number alone ≠ verified identity | ✅ `CANDIDATE_EVIDENCE_REQUIRED`（缺姓名 / 缺地址） |
| FedEx failed registration/validation → no candidate bind plan | ✅ `REGISTRATION_NOT_VERIFIED` |
| FedEx provider-verified registration → verified candidate identity | ✅ `CANDIDATE_BIND_PLAN` + identitySource PROVIDER_VERIFIED_REGISTRATION |
| FedEx does not require fictitious list-accounts result | ✅ discovery 路径 `IDENTITY_STRATEGY_NOT_DISCOVERY` 且 port 未被调用；UPS 反向 `IDENTITY_STRATEGY_NOT_REGISTRATION` |
| identitySource explicitly returned | ✅ discovery vs registration 分别断言 |
| duplicate verified identity remains idempotent | ✅ registration 两次 → 同一 candidateIdentity |
| cross-tenant lineage still rejected | ✅ `CREDENTIAL_LINEAGE_CONFLICT` |
| credentialRef-only boundary unchanged | ✅ 端口只收 credentialRef；缺 credentialRef 的注册结果 → `REGISTRATION_NOT_VERIFIED` |
| platformWrite=false | ✅ outcome / plan |
| transport=false | ✅ outcome / plan |
| production credentials ABSENT | ✅ outcome / plan / readiness |
| no live provider request | ✅ stub fetch（discovery + registration 两条路径） |
| readiness exposes selected auth flow + identity strategy | ✅ |
| existing Queue #3 regressions remain green | ✅ 原有 25 项语义全部保留（仅 FedEx 不再走 discovery） |
| tsc api/web 0 | ✅ tsc api 0 error |
| full CI SUCCESS | ✅ RUN_ID = 37069842384（head dc0edf6） |

本地套件：`carrier-auth-account-discovery` **41/41**；`carrier-connector-capability` **8/8**；`provider-readiness-http-db` **1/1**。

## 7. HOLD_EXTERNAL（㉘）

UPS / FedEx production credentials · real customer authorization · real provider calls · provider sandbox validation · TRANSPORT enablement —— 均不在本批。Carrier Queue #4（Tracking Read Adapter）等待 FINAL PASS 后再授权。

## 8. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① UPS scenario-aware auth model 是否收口；② FedEx provider-verified registration identity 抽象是否收口；③ readiness strategy 字段是否满足 ⑳；④ 是否批准 CARRIER QUEUE #3 = PASS/CLOSED；⑤ 下一内部单元（Carrier Queue #4 Tracking Read Adapter，或架构方指定的内部单元）。

边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
