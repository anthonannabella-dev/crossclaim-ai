# PC-12A FINAL-2 — ACTIVATION STATE SEMANTICS CHECKPOINT（CHANGE D）

状态：**READY_FOR_REVIEW / REVISE 收口**（待架构方裁决）
前序：PC-12A FINAL IMPLEMENTATION_HEAD = 21df2e3 / CI 37063999616 → **MSG-20261003-104 = REVISE-MINOR**（CHANGE A/B/C PASS；仅 CHANGE D 剩 activationState / readinessMeaning 一致性）。
IMPLEMENTATION_HEAD = 8555d8f
IMPLEMENTATION_HEAD_FULL = 8555d8f12b7a91e99bc9d813eeb00344a7ca3149
CI = SUCCESS · RUN_ID = 37066022817 · CI_VERIFIED_HEAD = 8555d8f
边界：**Payment = 0 · collection = OFF · autopay = OFF · external payment write = OFF · R13 HOLD**（本批未开启任何真实支付）。

## 1. 两处语义收口（MSG-104 ⑪–⑮）

### ① `activationState` 只由 `paymentActivated` 决定

```text
activationState = paymentActivated ? ACTIVATED : NOT_ACTIVATED
```

此前由 `paymentActivated || collectionActivated || autopayActivated || externalWriteActivated` **任一**推导，会产出 `currentState.payment = ZERO` 却 `activationState = ACTIVATED` 的机器矛盾。
collection / autopay / externalWrite 是刻意独立的状态，**不得**反过来证明 payment 已启用（未采用可选 PARTIALLY_ACTIVATED 扩展，遵循「不要扩大设计」）。

### ② `readinessMeaning` 三态且与当前 payment 状态一致

```text
!activationReady                    → PREREQUISITES_NOT_READY
activationReady && !paymentActivated → PREREQUISITES_READY_NOT_ACTIVATED
activationReady &&  paymentActivated → PREREQUISITES_READY_AND_ACTIVATED
```

此前只看 `activationReady`，会出现 `activationState = ACTIVATED` 与 `readinessMeaning = PREREQUISITES_READY_NOT_ACTIVATED` 并存。

## 2. 定点回归（MSG-104 ⑯）

| 要求 | 用例 |
|---|---|
| prerequisites ready + payment off → PREREQUISITES_READY_NOT_ACTIVATED | 「FINAL-2：prerequisites 就绪但 payment 未开启」 |
| prerequisites ready + payment on → activated meaning（不得 NOT_ACTIVATED） | 「FINAL-2：payment 真正开启 → ACTIVATED 且 readinessMeaning 不得再写 NOT_ACTIVATED」 |
| payment=false + autopay / collection / externalWrite 任一 true → 不得 ACTIVATED | 「FINAL-2：activationState 只由 paymentActivated 决定」 |
| payment=true + collection=false → payment 可 ACTIVATED 且 collection 仍 OFF | 「FINAL-2：payment 开启但 collection 仍关是合法状态」 |
| prerequisites 未就绪 → PREREQUISITES_NOT_READY（与 activationState 不冲突） | 「FINAL-2：prerequisites 未就绪时 readinessMeaning = PREREQUISITES_NOT_READY」 |
| autopay / external write 保持独立 | 同上用例（各自单独开启均不改变 payment 语义） |
| 既有测试保持 green | 原 12 项 unit + 5 项 HTTP 全部保留 |
| tsc api / web 0 | 0 error |
| full CI SUCCESS | RUN_ID = 37066022817（head 8555d8f）5 jobs 全绿 |

### 套件结果（22/22）

- `payment-activation-readiness`：**17/17**（原 12 + 新增 5 项 FINAL-2 回归）
- `payment-activation-readiness-http-db`：**5/5**
- 本地 API contract：`API_CONTRACT_OK`（implemented=84 / documented=71）

## 3. 明确未做（MSG-104 ⑰⑱）

未重做 payment capability registry / provider readiness / webhook registry / policy registry / DB acceptance / Action Guard / Kill Switch / source tagging；`fee due ≠ fee collected` 与 `reversal reuses existing money truth` 保持不变；未开启 payment / collection / external payment write / R13。

## 4. 下一执行单元（待裁决）

若 PASS：PC-12A = PASS / CLOSED → 正式进入 **Carrier Queue #3（UPS / FedEx auth + account discovery internal contract）**，或按架构方指定的内部单元推进。PC-12B 保持 HOLD_EXTERNAL / HOST_ACTION_REQUIRED。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
