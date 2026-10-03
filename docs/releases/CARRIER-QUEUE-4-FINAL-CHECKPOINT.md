# CARRIER QUEUE #4 FINAL — PROVIDER RESPONSE IDENTITY BINDING CHECKPOINT

状态：**READY_FOR_REVIEW**（read-only tracking plane 收口；真实凭据 / 真实 provider 调用继续 HOLD_EXTERNAL）
前序：MSG-20261003-108 ④ = **provider response identity binding = REVISE-MINOR**（Queue #4 其余 ① ② ③ 全 PASS）；⑥ 授权 QUEUE #4 FINAL。
IMPLEMENTATION_HEAD = df191a3
IMPLEMENTATION_HEAD_FULL = df191a38379507353105cd67c89e34d8be66de83
CI = SUCCESS · RUN_ID = 37073303640 · CI_VERIFIED_HEAD = df191a3
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. CHANGE A（⑰）— response 必须匹配请求 account

provider port 返回后、normalize 之前强制断言：

```text
raw.externalAccountId === requested externalAccountId   // 否则 ACCOUNT_MISMATCH
```

复用既有稳定 taxonomy（`ACCOUNT_MISMATCH`），未新造 `RESPONSE_ACCOUNT_MISMATCH`。

## 2. CHANGE B（⑱）— response 必须匹配请求 tracking number

```text
raw.trackingNumber === requested trackingNumber         // 否则 TRACKING_IDENTITY_MISMATCH
```

使用独立 code `TRACKING_IDENTITY_MISMATCH`（这不是普通 upstream availability error，不归类为 `PROVIDER_ERROR`）。

## 3. ⑲ 不得覆盖身份

实现为 **reject mismatch**：不一致直接返回失败 outcome（`{ ok: false, reason }`），**不会**用请求值覆盖 provider 返回值来制造“看起来一致”的 snapshot。失败 outcome 只含 reason code，**不回显** provider 返回的 raw identity。

## 4. ㉑ 顺手完成的事件字段白名单

`CarrierRawTrackingEvent` 增加 allowed-key 校验（`occurredAt` / `rawStatusCode` / `description` / `location` / `source`）；事件内部额外字段（尤其 credential-like key）→ fail-closed（归一化失败 → `RAW_PAYLOAD_INVALID`）。

## 5. 回归（⑳ 定点 + 既有全绿）

| 定点要求 | 结果 |
|---|---|
| requested account A / raw account B → reject | ✅ `ACCOUNT_MISMATCH` |
| mismatch account → no successful snapshot | ✅ outcome 无 snapshot 字段 |
| requested tracking A / raw tracking B → reject | ✅ `TRACKING_IDENTITY_MISMATCH` |
| mismatched response must not leak returned raw identity | ✅ raw account / raw tracking 均不出现在 outcome |
| correct account + correct tracking → 既有成功路径不变 | ✅ account / tracking / status 断言 |
| ㉑ event 额外字段 fail-closed | ✅ `RAW_PAYLOAD_INVALID`，token 值不回显 |
| provider mismatch guard 保持 green | ✅ `PROVIDER_ACCOUNT_MISMATCH` |
| cross-tenant guard 保持 green | ✅ `CROSS_TENANT_ACCOUNT` |
| raw status retention / event ordering·dedupe / failure taxonomy / read-only flags / no-live-request 保持 green | ✅ 既有 19 项全部保留 |
| tsc api/web 0 | ✅ tsc api 0 error |
| full CI SUCCESS | ✅ RUN_ID = 37073303640（head df191a3） |

本地套件：`carrier-tracking-read` **24/24**（原 19 + FINAL 5）；`carrier-auth-account-discovery` **41/41**；`carrier-connector-capability` **8/8**；`provider-readiness-http-db` **1/1**（合计 74/74）；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）。

## 6. 未重做（㉒）

verified account registry / tenant checks / provider adapters / status enum / event ordering / event dedupe key / failure taxonomy / rawReference model / read-only boundaries —— 全部保持不动（上一轮已 PASS）。

## 7. HOLD_EXTERNAL（㉖）

UPS/FedEx credentials · real verified accounts · real-data validation · TRANSPORT enablement —— 均不在本批。Queue #5 暂未授权（候选：Shipment/Invoice/POD Read Plane 或 SLA Evidence Preparation）。

## 8. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① response account binding 是否收口；② response tracking binding 是否收口；③ ㉑ 事件字段白名单是否接受；④ 是否批准 CARRIER QUEUE #4 = PASS/CLOSED；⑤ 下一内部单元。

边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
