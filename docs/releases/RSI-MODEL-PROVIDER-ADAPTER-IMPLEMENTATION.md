# RSI Model Router → Provider Adapter 落地记录（本地仿真，contract v2）

- 裁定来源：`AI-ARCHITECT-INBOX.md` **MSG-20261005-09**（`RSI_MODEL_PROVIDER_ADAPTER_DESIGN = PASS_WITH_REVISE`，reviewed HEAD = `070daf1`）
- 分支：`gate/7-commercial-validation`（不在 `main` 上开发）
- 本轮范围：**只做零网络、零费用的本地仿真 Adapter + Router 接线**；真实 provider 网络与付费调用继续 HOLD

## 1. 授权范围（逐条对照）

| 裁定项 | 状态 |
| --- | --- |
| `RSI_MODEL_PROVIDER_ADAPTER_DESIGN` | `PASS_WITH_REVISE` |
| `LOCAL_SIM_ADAPTER_IMPLEMENTATION` | `AUTHORIZED` → 已实现 |
| `ROUTER_TO_SIM_ADAPTER_WIRING` | `AUTHORIZED` → 已实现 |
| `OUTPUT_SCHEMA_VALIDATION` | `REQUIRED` → 已实现（严格 schema，字段集合/类型不符即失败） |
| `INPUT_SENSITIVE_DATA_FILTER` | `REQUIRED` → 已实现（解析不可变 prompt → digest 校验 → 敏感数据扫描） |
| `OUTPUT_SENSITIVE_DATA_FILTER` | `REQUIRED` → 已实现（输出 schema 校验后再扫敏感数据） |
| `ADAPTER_INTERNAL_RETRY` | `FORBIDDEN` → 一次 `invoke` = 恰好一次 attempt；记录里 `retryCount` 恒为 0 |
| `TIMEOUT_MS` | `REQUIRED` → `timeoutMs` 是 invocation 显式字段 |
| `IN_PROCESS_REAL_PROVIDER_CREDENTIALS` | `NOT_AUTHORIZED` → 本模块不读任何密钥 |
| `RSI_MODEL_NETWORK` / `RSI_PAID_MODEL_CALLS` | `HOLD` → `TRANSPORT` 未被解开，组合里没有任何网络路径 |

## 2. 端口形状（升级既有 contract，不新建第二套）

`apps/api/src/services/autonomy/rsi-model-router.ts` 直接升级仓库里既有的
`RsiModelProviderAdapter` / `RsiProviderResult`，旧结构不再并存：

- `RsiProviderUsage = { inputTokens, outputTokens, estimatedCost }`
- `RsiProviderAttemptResult` 改为**判别式联合**：
  - `{ ok: true; modelId; outputRef; outputDigest; usage; latencyMs }`
  - `{ ok: false; reason; usage?; latencyMs }`（失败调用也可能已经产生 token/费用，`usage` 允许非空并进台账）
- `RsiModelInvocation` 至少携带：`callId` / `taskKind` / `promptRef` / `promptDigest` / `tier` / `timeoutMs` /
  `maxOutputTokens` / `budget.remainingUsd` / `budget.maxUsdThisCall`
- `RsiModelProviderAdapter.pricing`：声明 `inputUsdPerToken` / `outputUsdPerToken` / `maxInputTokens`；
  缺失或非正即视为**无法证明最坏费用**，直接 `BUDGET_GUARD_UNENFORCEABLE` fail-closed，绝不调用 provider

## 3. 预算熔断（调用前证明，不是先调用再看）

`checkRsiCallBudget()` 在**任何 adapter 调用之前**证明：

```
estimatedWorstCaseCost = inputUsdPerToken * maxInputTokens + outputUsdPerToken * maxOutputTokens
<= 剩余日预算 <= 剩余月预算 <= 剩余 incident 预算 <= 本次调用上限(request.maxCost)
```

- 不满足 → `BUDGET_EXCEEDED`，**不调用 adapter**，并写入一条 `result = 'REJECTED'`、`estimatedCost = 0` 的台账记录
- 无法证明（缺 pricing / 非法 `maxOutputTokens`）→ `BUDGET_GUARD_UNENFORCEABLE` fail-closed
- 升级强模型前会**重新做一次预算检查**（每一次 attempt 都是一次新的检查）
- 本地仿真 Adapter 额外自检：`worstCase > budget.maxUsdThisCall` → 直接失败，不产出任何结果

## 4. 输入 / 输出双向过滤

`apps/api/src/services/autonomy/rsi-adapter-safety.ts`（只回**发现码**，绝不回传命中的原文）：

`SECRET` / `PII_EMAIL` / `PII_PHONE` / `PII_PAYMENT_CARD`（Luhn 校验）/ `PII_GOV_ID` / `CUSTOMER_RECORD`

调用链（任一步失败 fail-closed）：

```
promptRef → resolve immutable prompt → promptDigest 校验 → 输入敏感扫描
  → 预算闸门 → provider attempt → 输出 schema 校验 → 输出敏感扫描
  → 规范化结果 → outputRef + outputDigest
```

原始 provider 响应不落日志 / artifact / DB；只回 `outputRef` + `outputDigest` + `usage` + 失败原因。

## 5. 本地仿真 Adapter

`apps/api/src/services/autonomy/rsi-local-sim-adapter.ts`：

- 零网络、零费用、不读环境密钥、不持有 provider 凭据
- 严格输出 schema：`{ kind: 'RSI_LOCAL_SIM', taskKind, summary }`（额外字段即 `OUTPUT_SCHEMA_INVALID`）
- 输出 token 受调用方 `maxOutputTokens` 约束，并再受适配器硬上限 `RSI_LOCAL_SIM_MAX_OUTPUT_TOKENS = 1024` 封顶
- 结果只回 `modelId` / `outputRef` / `outputDigest` / `usage` / `latencyMs`

`apps/api/src/services/autonomy/rsi-model-provider-composition.ts` 提供组合根：
Router + 低成本仿真 adapter（强模型仿真默认关闭）+ 台账；`SUCCESS` / `FAILED` / `REJECTED` 全部写入 append-only 台账。

## 6. 仍然 HOLD 的边界

```
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
REAL_PROVIDER_ADAPTER = OUT_OF_PROCESS_REQUIRED（sidecar / 本地代理，未实现）
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
```

本组合默认不进 `rsi:run` 运行时执行路径：规则级信号仍然是 LEVEL_0，不产生任何模型调用。

## 7. 下一个窄审计（真实 Provider 那一轮）

真实 Provider Adapter 上线前需要一次很窄的 `RSI REAL PROVIDER ADAPTER AUDIT`，最小材料：

1. sidecar 凭据隔离证据（RSI runtime env 不含 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`）
2. sidecar host allowlist（只允许指定模型 provider，不能成为任意 HTTP 代理）
3. 预算硬上限（`maxOutputTokens` 或等价 provider 参数）说明 + 证据
4. `SDK retry = 0` 证据
5. 输入 / 输出过滤在真实调用链上的证据
6. 一次受控的非生产小额调用证据（usage + outputDigest，不含任何原始响应）
