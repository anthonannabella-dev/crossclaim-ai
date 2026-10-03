# PC-10 FINAL — WEBHOOK VERIFICATION（CHANGE A / B）CHECKPOINT

状态：**READY_FOR_REVIEW / REVISE 收口**（待架构方裁决）
前序：PC-10 首版 IMPLEMENTATION_HEAD = 767199b / CI 37051884721 → **MSG-20261003-98 = REVISE-MINOR**（CHANGE A 失败状态端到端一致；CHANGE B 服务端租户归属回归）。
IMPLEMENTATION_HEAD = e7902fd
IMPLEMENTATION_HEAD_FULL = e7902fd609f000f8bb8d38b62a963d1cf895123b
CI = SUCCESS · RUN_ID = 37053471042 · CI_VERIFIED_HEAD = e7902fd
边界：**Payment 仍 HOLD · TRANSPORT = false · 无生产凭据 · NO platform write**。

## 1. CHANGE A — 失败状态契约端到端一致

真实 webhook 路径不再把验签失败统一压成 400，而是复用统一边界的 `webhookFailureStatus(outcome)`：

| outcome | HTTP |
|---|---|
| `MISSING_SECRET` | **503** |
| `SIGNATURE_MISMATCH` | **401** |
| `UNKNOWN_PROVIDER` / `UNSUPPORTED_SIGNATURE_VERSION` / `MALFORMED_SIGNATURE` / `MISSING_SIGNATURE` / `TIMESTAMP_EXPIRED` / `TIMESTAMP_IN_FUTURE` | **400** |

结构化日志同时记录 `reason`（既有稳定值）与 `outcome`（统一枚举），仍不含 secret 与原始 payload。

据此更新的既有契约期望：`workflow-payment`「缺密钥」用例由 400 改为 **503**（这是架构方明确要求统一的真相，非弱化）。

## 2. CHANGE B — 服务端租户归属永久回归

新增用例「租户归属由服务端派生：事件写入 invoice 所属组织，客户端自报 organizationId 被忽略」：

- 事件 `metadata.invoiceId` 指向组织 B 的 BillingInvoice，同时在 payload 中伪造 `metadata.organizationId = ORG_FORGED`；
- 结果：`200 IGNORED`（Payment 仍 HOLD），`PaymentEvent` **只落在组织 B**（`BillingInvoice.organizationId` 派生），伪造组织 **0 行**。

## 3. 验证证据

| 项 | 证据 |
|---|---|
| 缺 signing secret → 503 | `webhook-verification-http-db`「缺 signing secret → 503（统一映射 missing_secret）且零业务写入」；`workflow-payment`「缺密钥 → 503 REJECTED 且不落库」 |
| 签名不匹配 → 401 | 「无效签名 → 401（统一失败映射 SIGNATURE_MISMATCH）」「raw-byte 变异 → 401」 |
| 其余失败面 → 400 | 「缺少签名 → 400」「未知 provider → 400」「过期时间戳 → 400」 |
| 服务端租户归属 | 「租户归属由服务端派生」（见 §2） |
| 零业务写入 | 全部失败面断言 `PaymentEvent` count = 0 |
| verification 先于持久化 | 「验签通过但无法归属租户 → 200 IGNORED，仍零业务写入」 |
| secret 不泄露 | 响应与捕获日志断言不含 secret |
| 既有 webhook 回归 | `workflow-payment` 13/13 · `workflow-payment-provider-shapes` 9/9 |
| tsc api / web | 0 error |
| full CI | RUN_ID = 37053471042（head e7902fd）5 jobs 全绿 |

### 套件结果

- `webhook-verification-http-db`：**8/8 PASS**（新增 503 与租户归属各 1）
- `webhook-verification`（纯内存）：**10/10 PASS**
- 既有回归：`workflow-payment` **13/13**、`workflow-payment-provider-shapes` **9/9**
（合计 **40/40**）

## 4. 明确未做（遵守边界）

未重做已验证的 verifier 架构（统一边界 / raw-byte / HMAC / constant-time / provider registry / 时间窗 / 幂等）；未启用 payment（`PAYMENTS_ENABLED=off` → IGNORED）、transport、provider OAuth、platform write；未获取生产 webhook secret；未新增依赖。

## 5. 下一执行单元（待裁决）

若 PASS：PC-10 = PASS / CLOSED → PC-11 AUTHORIZED（真实 provider 接入属 HOST 边界，或架构方指定的下一单元）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
