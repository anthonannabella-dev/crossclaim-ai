# PC-10 — WEBHOOK VERIFICATION CHECKPOINT

状态：**READY_FOR_REVIEW**（待架构方裁决）
IMPLEMENTATION_HEAD = 767199b
IMPLEMENTATION_HEAD_FULL = 767199b0850afaa8c034a641dc79f89c311bc653
CI = SUCCESS · RUN_ID = 37051884721 · CI_VERIFIED_HEAD = 767199b
授权：MSG-20261003-97 ㉑（PC-10 WEBHOOK VERIFICATION）。
边界：**Payment 仍 HOLD · TRANSPORT = false · 无生产凭据 · NO platform write**。

## 1. 范围逐项落地（MSG-97 ㉑ PC-10 SCOPE 1–10）

| 项 | 要求 | 实现 |
|---|---|---|
| 1 统一 verification boundary | 所有 webhook 必须经过显式 verification layer | 新增 `services/webhooks/verification.ts::verifyWebhookRequest()`；`payment-webhook.ts` 改为复用该边界（不再各自实现验签） |
| 2 Raw body integrity | 对**原始字节**验签，禁止 parse → stringify | HTTP 层收集 `Buffer` 并透传 `rawBodyBytes`；签名载荷 = `timestamp + '.' + rawBody.toString('utf8')`（与到达字节一致）；测试以「原 body 加一个空格」断言签名失效 |
| 3 Signature verification | 显式算法 / header / constant-time / key·version aware / fail-closed | `WEBHOOK_PROVIDER_REGISTRY`（provider × signatureVersion × algorithm × signatureHeader × timestampParameter × secretEnvKey × tolerance）；HMAC-SHA256 + `timingSafeEqual`（hex 定长比较）；**未知 provider → UNKNOWN_PROVIDER 拒绝**；**未知 signature version（只给 v2）→ UNSUPPORTED_SIGNATURE_VERSION 拒绝** |
| 4 Timestamp / replay window | 过期与未来超阈值拒绝 | `TIMESTAMP_EXPIRED` / `TIMESTAMP_IN_FUTURE`（tolerance = registry 300s，可注入覆盖）；边界内（-299s）接受 |
| 5 Event id idempotency | (provider, eventId) 唯一处理边界 | 既有 `PaymentEvent` 唯一约束 + 先查/捕获 P2002；重复投递 → DUPLICATE 且不产生第二份业务写入（既有回归覆盖） |
| 6 Verification before persistence | raw → verify → parse → map → persist | 验签失败在 JSON.parse 之前返回；失败路径零业务写入（测试断言 `PaymentEvent` count = 0） |
| 7 Failure behavior | 稳定响应 + safe log + 无 secret + 不落事实 | `webhookFailureStatus()`（400 / 401 / 503）与既有 400 稳定面一致；结构化日志只含 provider / outcome / payloadHash / skew；响应与日志断言不含 secret |
| 8 Secret handling | 只来自 server-side 配置，不入 body/query/DB，不写日志 | secret 仅从 `env[spec.secretEnvKey]`（`PAYMENT_WEBHOOK_SECRET`）读取；无 secret → `MISSING_SECRET`（503）fail-closed；从不回显 |
| 9 Provider/version registry | 不散落 `if provider ===` | 单一 registry + `resolveWebhookProvider()`；未登记的 provider 直接拒绝 |
| 10 Payment webhook remains HOLD | 验证 ≠ 启用支付 | `PAYMENTS_ENABLED=off` → 验签通过后仍 **IGNORED + 200**（只留痕，不触碰 Billing/Payment）；未改任何 payment 开关 |

## 2. 验证证据（MSG-97 ㉑ REQUIRED TESTS）

| 要求 | 用例 / 断言 |
|---|---|
| valid signature accepted | `webhook-verification`「valid signature accepted」（VERIFIED + 200 + 日志无 secret） |
| invalid signature rejected | 「invalid signature rejected」→ `SIGNATURE_MISMATCH`（401 语义） |
| missing signature rejected | 「missing signature rejected」→ `MISSING_SIGNATURE` |
| unknown provider rejected | 「unknown provider rejected（即使签名本身有效）」→ `UNKNOWN_PROVIDER`；HTTP 「未知 provider（x-webhook-provider）→ 400，零业务写入」 |
| unknown signature version rejected | 「unknown signature version rejected（只给 v2）」→ `UNSUPPORTED_SIGNATURE_VERSION` |
| raw-byte mutation invalidates signature | 「raw-byte mutation invalidates signature」+ HTTP「raw-byte 变异（原 body 加空格）→ 400，零业务写入」 |
| timestamp expired rejected | 「timestamp expired / future beyond skew」→ `TIMESTAMP_EXPIRED`；HTTP「过期时间戳 → 400，零业务写入」 |
| future timestamp beyond skew rejected | 同上 → `TIMESTAMP_IN_FUTURE` |
| valid timestamp accepted | 边界内（-299s）→ `VERIFIED` |
| duplicate event id does not double-write | 既有 `workflow-payment-provider-shapes`「重复投递 → DUPLICATE；并发投递 → 一个 PROCESSED、一个 DUPLICATE，资金只动一次」 |
| verification failure causes zero business writes | HTTP 用例对失败面逐项断言 `PaymentEvent` count = 0 |
| verification occurs before parser/business handler | 失败路径在 `JSON.parse` 之前返回；「验签通过但无法归属租户 → 200 IGNORED，仍零业务写入」证明验签先于持久化 |
| secret never returned | 响应体断言不含 secret（HTTP 用例） |
| secret never logged | 注入 sink 捕获日志行，断言不含 secret（HTTP 用例） |
| cross-tenant event cannot mutate foreign tenant | 事件归属由服务端从 invoice 解析（既有回归覆盖；无法归属 → 不落库） |
| payment remains HOLD | `PAYMENTS_ENABLED=off` → IGNORED；未改 payment 开关（既有回归 + 本批未触碰） |
| transport remains false | `TRANSPORT=false` 未改动；`/ops-readiness.transport = DISABLED`（既有回归） |
| existing webhook regressions green | `workflow-payment` 13/13 · `workflow-payment-provider-shapes` 9/9 |
| tsc api / web 0 | 两者 `tsc --noEmit` = 0 error |
| full CI SUCCESS | RUN_ID = 37051884721（head 767199b）5 jobs 全绿 |

### 套件结果

- `webhook-verification`（纯内存）：**10/10 PASS**
- `webhook-verification-http-db`（真实 HTTP + PostgreSQL）：**6/6 PASS**
- 既有 webhook 回归：`workflow-payment` **13/13**、`workflow-payment-provider-shapes` **9/9**
- 本地 API contract：`API_CONTRACT_OK`（未新增路由，无漂移）

## 3. 明确未做（遵守 PC-10 边界）

未获取生产 webhook secret；未启用 provider OAuth；未启用 platform write；未激活 payment / collection；未打开 TRANSPORT；未调用任何真实 provider endpoint；未新增依赖（自实现 HMAC，无 Stripe SDK）。

## 4. 说明（与既有审计口径的关系）

既有 provider 事件形状验证（C-0010-C1）与 webhook 开关/幂等/归属（C-0010-A）行为**保持不变**：本批只把验签与时间窗/版本判定收敛到统一边界，并补齐未知 provider / 未知 signature version 的显式拒绝。失败面 HTTP 码沿用既有稳定契约（签名/格式类 400，缺密钥 503 语义在统一层暴露）。

## 5. 下一执行单元（待裁决）

若 PASS：PC-10 = PASS / CLOSED → 可进入 **PC-11 真实 provider 接入**（HOST 边界）或架构方指定的下一单元。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
