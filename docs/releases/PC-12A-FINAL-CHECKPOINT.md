# PC-12A FINAL — READINESS TRUTH WIRING CHECKPOINT（CHANGE A–D）

状态：**READY_FOR_REVIEW / REVISE 收口**（待架构方裁决）
前序：PC-12A 首版 IMPLEMENTATION_HEAD = 7b6fad5 / CI 37061867448 → **MSG-20261003-103 = REVISE-MINOR**（CHANGE A–D；架构 PASS）。
IMPLEMENTATION_HEAD = 21df2e3
IMPLEMENTATION_HEAD_FULL = 21df2e36eab6d420568c50b7f1cf8da638f7b206
CI = SUCCESS · RUN_ID = 37063999616 · CI_VERIFIED_HEAD = 21df2e3
边界：**Payment = 0 · collection = OFF · autopay = OFF · external payment write = OFF · R13 HOLD**（本批未开启任何真实支付）。

## 1. CHANGE A — 消除 ready 与状态矛盾（currentState / activationPrerequisites 分离）

| 字段 | 语义 |
|---|---|
| `currentState` | **当前真正是否已开启**：`payment: ZERO\|ENABLED` · `collection: OFF\|ON` · `autopay: OFF\|ON` · `externalWrite: OFF\|ON` · `r13: HOLD\|RELEASED` |
| `activationPrerequisites` | 未来启用**前置条件**：`providerCredentialsConfigured` · `r13Released` · `collectionApproved` · `externalWriteApproved` |
| `activationReady`（+ `ready` 兼容别名） | `internalReady AND 四个前置条件全绿` —— **不表示已经开启** |
| `readinessMeaning` | `PREREQUISITES_READY_NOT_ACTIVATED` \| `PREREQUISITES_NOT_READY` |
| `activationState` | `NOT_ACTIVATED` \| `ACTIVATED`（由真实开关派生） |

因此「已具备开启条件但尚未开启」可被正确表达：`activationReady = true` 且 `currentState.payment = ZERO` 且 `activationState = NOT_ACTIVATED`；**不再出现 `ready=true` 与 `r13=HOLD` 并存的矛盾**。

## 2. CHANGE B — endpoint 接真实既有事实源（不再静态默认）

| fact | 来源 |
|---|---|
| `webhookVerificationReady` | PC-10 `WEBHOOK_PROVIDER_REGISTRY`（统一 webhook 验签能力） |
| `providerCredentialsConfigured` | PC-11 `projectProviderReadiness()`（当前 `ABSENT` → false；真实凭据配置后自动变 true） |
| `feePolicyCurrent` | PC-09 `findPolicy('refund-and-fee-policy')` 的 CURRENT 状态 |
| `commercialAcceptanceReady` | 真实 DB（`getAcceptanceStatus`） |
| `billingModelReady` / `reconciliationReady` / `retryReplayControlsReady` | 新增 `services/payments/payment-capabilities.ts`（`implemented × productionVerified × evidenceRef` 单一真源；reconciliation 的 `productionVerified=false` → 诚实计入 blocker） |
| `actionGuardReady` / `killSwitchReady` | 注入的 Action Guard 与真实 kill-switch resolver 探针 |
| `r13Released` / `collectionApproved` / `externalWriteApproved` | **EXPLICIT_FROZEN_GATE**（HOST / production decision，显式标注而非「系统不知道状态」） |

每项 check 现返回 `{ value, source }`，`source ∈ ENV \| DB \| CAPABILITY \| INJECTED \| EXPLICIT_FROZEN_GATE`。

## 3. CHANGE C — 运行时接线回归（证明 endpoint 不是静态 DTO）

| 用例 | 断言 |
|---|---|
| webhook secret 缺失 / 存在 | `checks.paymentWebhookSecretConfigured = { false/true, ENV }`，**且其余 check 与 `currentState` 完全不变** |
| 商业接受未完成 / 接受全部 CURRENT | `{ false → true, DB }`，且 provider gate 与 `currentState` 不变；`activationReady` 仍为 false（另有 blocker） |
| Action Guard / Kill Switch | 由注入与真实 resolver 派生 → `{ true, INJECTED }` |
| provider readiness | 当前 `ABSENT` → `providerCredentialsConfigured = false` |
| 授权边界 | 未认证 401 · VIEWER 403 · OWNER 200 |
| secret 安全 | 响应不含 `sk_` / `whsec` / `client_secret` / `passwordHash` / `credentialRef` |

## 4. CHANGE D — 语义断言对齐

`allGreen` 用例明确断言其测的是 **ACTIVATION PREREQUISITES READY**，而非「payment 当前已启用」：`activationReady = true` + `currentState.payment = ZERO` + `activationState = NOT_ACTIVATED` + `readinessMeaning = PREREQUISITES_READY_NOT_ACTIVATED`；另有用例断言真实开启后 `activationState = ACTIVATED` 且 `currentState` 反映真实开关。

## 5. 套件结果（17/17）

- `payment-activation-readiness`（纯内存）：**12/12**
- `payment-activation-readiness-http-db`（真实 HTTP + PostgreSQL）：**5/5**
- `tsc api` 0 error · `API_CONTRACT_OK`（implemented=84 / documented=71）
- full CI：RUN_ID = 37063999616（head 21df2e3）5 jobs 全绿

## 6. 明确未做（遵守边界与 ㉓）

未重做 payment architecture；未 enable real payment / collection / autopay / external payment write；未 release R13；未加生产 Stripe 凭据；未调用真实支付 provider；`autopay` 保持 OFF 且未被纳入自动开启。

## 7. PC-12B 与并行线

- **PC-12B（production payment activation）= HOLD_EXTERNAL / HOST_ACTION_REQUIRED**：real payment provider account · production credentials · webhook secret · merchant/business verification · production callback/webhook config · explicit R13 release · explicit collection decision。
- 并行线（MSG-103 ㉒）：Carrier SLA / Dual-Path / Customs 指令已登记（V1 零 Schema 变更），Carrier Connector Capability Interface 已完成（8/8）；**主 closure 顺序为先 PC-12A FINAL，再切 Carrier 队列第 3 项（UPS / FedEx auth + account discovery internal contract）**。

## 8. 下一执行单元（待裁决）

若 PASS：PC-12A = PASS / CLOSED → 正式切入 Carrier 队列第 3 项，或按架构方指定的下一内部单元推进。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
