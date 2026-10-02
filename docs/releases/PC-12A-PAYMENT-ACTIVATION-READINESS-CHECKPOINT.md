# PC-12A — PAYMENT ACTIVATION READINESS CONTRACT CHECKPOINT

状态：**READY_FOR_REVIEW**（待架构方裁决）
IMPLEMENTATION_HEAD = 7b6fad5
IMPLEMENTATION_HEAD_FULL = 7b6fad589c3f450f02a61aeca43623894bdcc49b
CI = SUCCESS · RUN_ID = 37061867448 · CI_VERIFIED_HEAD = 7b6fad5
授权：MSG-20261003-102 ⑬–⑯（PC-12A PAYMENT ACTIVATION READINESS CONTRACT）。
边界：**Payment = 0 · collection = OFF · autopay = OFF · external payment write = OFF · R13 HOLD**（本批**未**开启任何真实支付）。

## 1. 范围逐项落地（MSG-102 ⑮.1–⑮.9）

| 项 | 落地 |
|---|---|
| ⑮.1 Payment activation gate | `services/payments/activation-readiness.ts`：统一的 `PaymentActivationReadiness { ready, posture, internalReady, gates, status, checks, blockers, feeDueVsCollected, reversalPolicy, checkedAt }`；**不由 `PAYMENTS_ENABLED` 单点决定** |
| ⑮.2 Required checks | 13 项：内部 9（webhook 验签就绪 · 支付 webhook secret 已配置 · 计费模型就绪 · 费用政策现行 · 商业接受完成 · 对账就绪 · retry·replay 控制就绪 · Action Guard 就绪 · Kill Switch 就绪）+ 外部 4（provider 凭据 · R13 释放 · collection 显式开启 · external payment write 显式开启） |
| ⑮.3 多 gate 独立 | `ready = internalReady AND 四个外部 gate 全绿`；`posture = READY / EXTERNAL_GATE / BLOCKED`；每个 gate 单独打开都不构成就绪（测试逐项断言） |
| ⑮.4 Payment vs collection 分离 | `status.payment = ZERO` 与 `gates.collectionExplicitlyEnabled` 完全独立；显式断言「provider 已配置 + collection=OFF」为合法中间态 |
| ⑮.5 Autopay 独立 | `status.autopay = OFF` 恒定，且不受 `paymentProcessingEnabled` 影响（测试断言） |
| ⑮.6 External write 独立 | `status.externalWrite = OFF` + `gates.externalPaymentWriteExplicitlyEnabled` 独立 gate；webhook 验签就绪**不**自动带来对外写 |
| ⑮.7 fee due ≠ collected | `feeDueVsCollected = { feeDue: DERIVED_FROM_CONFIRMED_SETTLEMENT, feeCollected: ZERO, separated: true, recoveredAmountIsNotCollectedFee: true }` |
| ⑮.8 Reversal 影响面 | `reversalPolicy` 引用既有 `docs/releases/SUCCESS-FEE-BILLING-REDLINE.md`：影响 fee due / invoice status / reconciliation，不影响 fee collected，`reusesExistingMoneyTruth = true`（**不新建 money truth**） |
| ⑮.9 Readiness endpoint | 只读 `GET /payment-activation-readiness`（OWNER / ADMIN；401 / 403）：返回 `internalReady / gates / status / checks / blockers` 等**状态码**，**不返回 secret 取值** |

## 2. 验证证据（MSG-102 ⑯ REQUIRED TESTS）

| 要求 | 用例 / 断言 |
|---|---|
| payment defaults HOLD | 单元「默认：payment=ZERO / collection=OFF / autopay=OFF / externalWrite=OFF / r13=HOLD」；HTTP「默认全 OFF 且 ready=false」 |
| collection defaults OFF | 同上（`status.collection = OFF`） |
| autopay defaults OFF | 同上（`status.autopay = OFF`；单 env flag 用例再断言不变） |
| external payment write defaults OFF | 同上（`status.externalWrite = OFF`） |
| R13 HOLD blocks activation | 「R13 未释放 / 缺 provider 凭据 → EXTERNAL_GATE」；blockers 含 `EXTERNAL:R13_NOT_RELEASED` |
| missing provider credentials blocks production activation | 同上（blockers 含 `EXTERNAL:providerCredentialsConfigured`） |
| override blockers | 内部条件缺失 → `posture = BLOCKED` 且 blockers 含 `INTERNAL:<check>` |
| payment enabled does not imply collection | 「单一 env flag 不解锁」用例 |
| payment enabled does not imply autopay | 同用例（autopay 保持 OFF） |
| collection enabled does not imply external write | 四 gate 独立用例（单独打开 collection 仍 `ready=false`） |
| no secret values exposed | 单元「输出不含任何 secret 取值」+ HTTP「响应不含 sk_ / whsec / client_secret / passwordHash / credentialRef」 |
| fee due ≠ fee collected | `feeDueVsCollected` 断言 |
| reversal does not double-count money | `reversalPolicy` 断言（复用既有 money truth、fee collected 不受影响） |
| unauthorized readiness access rejected | HTTP：未认证 → 401；VIEWER → 403 |
| tsc api / web 0 | 0 error |
| full CI SUCCESS | RUN_ID = 37061867448（head 7b6fad5）5 jobs 全绿 |

### 套件结果（10/10）

- `payment-activation-readiness`（纯内存）：**9/9**
- `payment-activation-readiness-http-db`（真实 HTTP + PostgreSQL）：**1/1**
- 本地 API contract：`API_CONTRACT_OK`（implemented=84 / documented=71；新增 `/payment-activation-readiness` 已登记）

## 3. 明确未做（遵守 PC-12A 边界）

未 enable real payment；未改 `Payment=0`；未 enable collection / autopay；未 enable external payment writes；未移除 R13 HOLD；未加入生产 Stripe 凭据；未调用真实支付端点；未产生真实扣款。

## 4. PC-12B — HOLD（未来真实开启支付时才进入）

需要 HOST / EXTERNAL：real payment provider account · production credentials · webhook secret · merchant/business verification · production callback/webhook config · **explicit R13 release** · **explicit collection decision**。

## 5. 并行线：Carrier 指令已登记（不打断本主线）

HOST DIRECTIVE（Carrier SLA / Dual-Path / Customs）已登记于 `docs/releases/CARRIER-SLA-DUAL-PATH-CUSTOMS-DIRECTIVE.md`，复用核查结论：**V1 零 Schema 变更**；交付第 2 项 `services/carriers/connector-capability.ts` 已完成（8/8 测试）。后续 UPS / FedEx auth、Tracking / Invoice adapter、SLA evaluator、Dual-Path、Progressive Authorization、Claim package、Direct submission、Customs connector 按序送审。

## 6. 下一执行单元（待裁决）

若 PASS：PC-12A = PASS / CLOSED → 可继续 Carrier 队列（第 3 项 UPS / FedEx auth + account discovery，设计优先送审），或按架构方指定的下一内部单元推进。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
