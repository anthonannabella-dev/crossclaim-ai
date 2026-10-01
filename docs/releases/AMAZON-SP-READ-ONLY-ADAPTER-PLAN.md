# Amazon SP-API READ-ONLY Adapter —— Implementation Plan（R40）

> 依据：**MSG-20261001-25 = PASS WITH REVISE**（REVIEWED_HEAD 79a7d36）
> · CHANGE A：下一批实现只读 adapter boundary（descriptor → auth/credential port → read fetch contract → pagination/rate-limit → normalization boundary → 既有 Connector Runner）
> · CHANGE B：只读能力必须 fail-closed 到 **operation/resource 级**，RDT 独立边界
> · CHANGE C：六项写回前置冻结为 transport 门槛（provider + operation + evidence）
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01 · 本批次**不接真实凭据、不访问真实 seller 数据、不申请/扩大 write scope、不实现写操作**

## 1. 目标链路与边界

```text
Amazon read contract (descriptor, operation/resource 级)
  → credential port abstraction（LWA / RDT；本阶段注入 mock，未配置实现 fail-closed）
  → read fetch contract（GET-only；分页 NextToken；429 退避）
  → normalization boundary（稳定指纹；未知/畸形 → quarantine）
  → 只读落点端口（既有 Connector Runner / ingest 实现；本模块不写库）
```

**不做**：submit/写操作、写 scope 申请、真实 seller 数据访问、真实凭据、provider 级粗粒度 `readOnly=true` 布尔。

## 2. operation/resource 级 descriptor（CHANGE B）

每条登记项显式声明：`operation` / `resource` / `kind` / `method` / `requiredRoles` / `requiresRestrictedDataToken` / `pagination` / `rateLimit` / `path`。

| operation | resource | kind | requires RDT | pagination | 说明 |
| --- | --- | --- | --- | --- | --- |
| `getOrders` | `orders` | READ | 否 | NEXT_TOKEN | 只读样板（订单列表） |
| `getOrderItems` | `orders` | READ | 否 | NEXT_TOKEN | 只读样板（订单行） |
| `getRestrictedOrderAddress` | `orders` | READ | **是** | NONE | 受限数据：无 RDT 能力即拒绝 |
| `createReport` | `reports` | **WRITE** | — | NONE | 登记但**永远拒绝**（证明写操作不是靠“未登记”拒绝） |

判定规则（`authorizeAmazonReadOperation`，fail-closed）：

1. 未登记 operation → `OPERATION_NOT_REGISTERED`
2. resource 与 descriptor 不符 → `RESOURCE_MISMATCH`
3. `kind !== 'READ'` → `WRITE_OPERATION_FORBIDDEN`
4. `method !== 'GET'` → `READ_METHOD_VIOLATION`
5. 需 RDT 但调用方无 RDT 能力 → `RDT_CAPABILITY_REQUIRED`（受限数据是独立能力边界）

## 3. 凭据与传输端口

- `AmazonCredentialPort`：`getLwaAccessToken()`（+ 可选 `getRestrictedDataToken()`）。
  `createUnconfiguredAmazonCredentialPort()` 一律抛 `CREDENTIAL_PORT_UNCONFIGURED` —— 本阶段**不接真实凭据**（HOLD）。
- `AmazonReadTransport`：只有 `get()`（GET-only 契约，结构上不存在写方法）。

## 4. fetch / 分页 / 限流

- 分页：`pagination === 'NEXT_TOKEN'` 时把上一页 `NextToken` 作为查询参数传给下一页；最多 50 页（防失控）。
- 限流：`429` 视为可重试（官方口径），退避长度由 descriptor 的恢复速率推导，上限 2000ms；重试次数耗尽 → `AMAZON_READ_THROTTLED`。
- `5xx` / 非 200 → 立即失败（不做部分提交；由调用方决定重试），不产生任何业务记录副作用。

## 5. 规范化与幂等

- 每 operation 固定标识提取器（如 `getOrders → AmazonOrderId`）。
- 指纹：`amazon-sp::<resource>::<operation>::<identifier>`（与既有 `sourceFingerprint` 口径一致：**不含金额**）。
- 畸形/缺标识记录 → `quarantine`（`MALFORMED_RECORD`）；未登记 operation 的记录 → `UNKNOWN_SHAPE`；**绝不静默丢弃**。
- 落点端口 `AmazonReadOnlySink.upsertFact` 由既有 Connector Runner / ingest 实现（以 fingerprint 幂等）；本模块不写库。

## 6. 验收矩阵（MSG-20261001-25 TEST 十项）

| # | 断言 | 实现/证据 |
| --- | --- | --- |
| 1 | 未登记 resource/operation → fail-closed | `authorizeAmazonReadOperation` + 测试 01 |
| 2 | write operation → 永远拒绝 | `kind=WRITE` 登记项 + 测试 02 |
| 3 | RDT-required operation 无 RDT capability → 拒绝 | 测试 03 |
| 4 | pagination cursor/token 正确传递 | 测试 05（断言第二页 query 携带 NextToken） |
| 5 | 429 不产生重复业务记录 | 测试 06（429→200，factsCreated=1） |
| 6 | retry 不绕过 sourceFingerprint 幂等 | 测试 07（重复标识/重复同步均不新增） |
| 7 | malformed/unknown shape → quarantine 不静默丢弃 | 测试 08 |
| 8 | adapter 不得取得 platform-write sink | 测试 09（源码禁词 + GET-only 传输端口） |
| 9 | `PLATFORM_WRITE_TRANSPORT_ENABLED=true` 时 Amazon 仍 `ADAPTER_NOT_ELIGIBLE` | 测试 10 |
| 10 | PG1–PG10 / H1–H9 / D1–D4 永久基线继续通过 | 本批次随全量 CI 运行（见 checkpoint 回归证据） |

## 7. 六项写回前置（CHANGE C，冻结为 transport 门槛）

`provider + operation + capability evidence`（不是 provider 全局布尔），六项全部 PROVEN 才可进入真实 write adapter：

1. write endpoint/operation 与所需授权明确
2. idempotency/replay 语义明确
3. provider operation/request identifier 明确
4. write 后可查询最终状态（或等价可靠确认机制）
5. timeout / connection reset / 5xx 的 ambiguous response 有不重复写的恢复策略
6. sandbox/test evidence + CrossClaim PG/H/D 安全基线通过

任一 NOT_PROVEN → 不得自动 write（保持 NEEDS_MANUAL）。

## 8. 本批次未越界声明

未接真实凭据、未访问真实 seller 数据、未申请/扩大任何 role 或 scope、未实现任何写操作、未新增 Schema/migration/依赖、`PLATFORM_WRITE_TRANSPORT_ENABLED=false` 保持、未合并 main。测试全部使用 fixture 与 mocked transport（无网络调用）。
