# CARRIER QUEUE #4 — TRACKING READ ADAPTER CHECKPOINT

状态：**READY_FOR_REVIEW**（read-only normalized tracking plane；真实凭据 / 真实 provider 调用继续 HOLD_EXTERNAL）
前序：MSG-20261003-107 ④ `CARRIER QUEUE #3 = PASS / CLOSED`；⑤ 正式授权本单元；⑥ real carrier credentials / calls = HOLD_EXTERNAL。
IMPLEMENTATION_HEAD = cfb327e
IMPLEMENTATION_HEAD_FULL = cfb327e0a6236a2e4368d3bd16364b99afddf0c6
CI = SUCCESS · RUN_ID = 37072044352 · CI_VERIFIED_HEAD = cfb327e
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 交付内容（`apps/api/src/services/carriers/carrier-tracking-read.ts`）

### 1.1 CarrierTrackingReadPort（㉑）

```text
CarrierTrackingReadPort.getTracking({ provider, credentialRef, externalAccountId, trackingNumber, organizationId })
  -> Promise<CarrierRawTrackingRecord>   // 受控 raw record（不含完整 provider payload）
```

### 1.2 account lineage 归属（㉑㉒㉘）

读取前必须证明 `credentialRef + externalAccountId → provider-verified binding`：`CarrierVerifiedAccountRegistry.resolve({ credentialRef, externalAccountId })` → `{ provider, organizationId, identitySource }`；随后逐项校验：

- 未登记 → `UNVERIFIED_ACCOUNT_LINEAGE`（**trackingNumber 单独出现不能建立归属**）；
- binding provider ≠ 请求 provider → `PROVIDER_ACCOUNT_MISMATCH`；
- binding organization ≠ 请求 organization → `CROSS_TENANT_ACCOUNT`；
- 以上任一失败都**不会调用 provider 端口**（fail-closed，端口 spy 断言）。

### 1.3 normalized CarrierTrackingSnapshot（㉓㉔㉛）

`provider` / `externalAccountId` / `trackingNumber` / `shipmentStatus` / `carrierStatusCode`（raw 保留）/ `statusText` / `origin` / `destination` / `shipDate` / `estimatedDeliveryAt` / `deliveredAt` / `lastEventAt` / `lastEventLocation` / `serviceLevel` / `events[]` / `rawReference` / `observedAt`。

- 状态枚举：`UNKNOWN / LABEL_CREATED / PICKED_UP / IN_TRANSIT / OUT_FOR_DELIVERY / DELIVERED / EXCEPTION / DELAYED / RETURNED / LOST`；provider raw status（总状态码 + 每条事件 rawStatusCode）**单独保存**。
- SLA forward-compat（㉛）：promised/estimated delivery、actual delivery、scan chronology、exception/delay、service level、origin/destination、tracking lineage 均已在 snapshot 中；本批**不做** SLA refund calculation。

### 1.4 事件归一化（㉕）

`occurredAt / status / rawStatusCode / description / location / source`；排序 = occurredAt → rawStatusCode → eventKey（deterministic）；去重键 = `provider|trackingNumber|occurredAt|rawStatusCode|location`（重复 ingest 不复制事件事实）。

### 1.5 失败原因分类（㉗）

`NOT_FOUND` / `NOT_AUTHORIZED` / `ACCOUNT_MISMATCH` / `TEMPORARILY_UNAVAILABLE` / `RATE_LIMITED` / `PROVIDER_ERROR` 全部单独返回（不压成 TRACKING_FAILED）；端口抛出的未知异常 → `PROVIDER_ERROR` 且不回显上游消息。

### 1.6 read-only discipline + raw boundary（㉖㉚）

- 只提供 getTracking 读取；无 shipment mutation / reroute / intercept / claim / pickup / refund 路径；outcome 恒 `readOnly: true` / `transportEnabled: false` / `platformWriteEnabled: false` / `productionCredentials: ABSENT`。
- 完整 provider raw JSON 不外泄：raw record 只接受受控字段，未声明字段（含 payload / access token 等）→ `RAW_PAYLOAD_INVALID`；snapshot 仅保留 safe `rawReference`（审计 / 后续 SLA evidence）。
- 输入形状校验：未声明字段拒绝，凭据类字段 → `PLAINTEXT_CREDENTIAL_NOT_SUPPORTED`。

### 1.7 provider adapter 分离（㉙）

`CarrierTrackingAdapter { provider, parseStatus, mapEvent }` + 每 provider 独立 status map（UPS / FedEx）；未登记 raw code → `UNKNOWN`（不猜）；核心归一化**不含**巨型 if(provider) 分支。真实 provider 码表在 sandbox / real-data validation 阶段核对（HOLD_EXTERNAL）。

## 2. 回归（㉜）

| 必需项 | 结果 |
|---|---|
| unknown carrier fail-closed | ✅ `UNKNOWN_CARRIER`，端口未调用 |
| missing credentialRef rejected | ✅ `CREDENTIAL_REF_REQUIRED` |
| unverified account lineage rejected | ✅ `UNVERIFIED_ACCOUNT_LINEAGE` |
| cross-tenant account rejected | ✅ `CROSS_TENANT_ACCOUNT` |
| provider/account mismatch rejected | ✅ `PROVIDER_ACCOUNT_MISMATCH` |
| UPS raw → normalized snapshot | ✅ DELIVERED / `D` / 2 events / serviceLevel/ETA/delivered |
| FedEx raw → normalized snapshot | ✅ IN_TRANSIT / `IT` / PICKED_UP→IN_TRANSIT |
| raw provider status preserved | ✅ carrierStatusCode + 每条事件 rawStatusCode |
| normalized status deterministic | ✅ 未登记码 → UNKNOWN；同一输入两次一致 |
| events deterministic ordering | ✅ 乱序输入 → 时间序；重复归一化 JSON 一致 |
| duplicate events deduplicated | ✅ 3 条 raw（含重复）→ 2 条事件 |
| tracking number alone cannot establish tenant/account | ✅ 缺 externalAccountId / 换 org 均 fail-closed |
| NOT_FOUND / NOT_AUTHORIZED / RATE_LIMITED / provider error stable | ✅ 六类错误分别断言 |
| no plaintext credential | ✅ 输入凭据字段 → `PLAINTEXT_CREDENTIAL_NOT_SUPPORTED`，值不回显 |
| no customer-facing raw token / provider secret | ✅ 未声明 raw 字段 → `RAW_PAYLOAD_INVALID`；snapshot 只带 rawReference |
| no live request | ✅ stub fetch（UPS + FedEx 两条路径） |
| platform write false / TRANSPORT=false / production credentials ABSENT | ✅ outcome 恒定值 |
| tsc api/web 0 | ✅ tsc api 0 error |
| full CI success | ✅ RUN_ID = 37072044352（head cfb327e） |

本地套件：`carrier-tracking-read` **19/19**；`carrier-auth-account-discovery` **41/41**；`carrier-connector-capability` **8/8**；`provider-readiness-http-db` **1/1**（合计 69/69）；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）。

## 3. 明确未做（㉝㉞）

未 call live UPS / FedEx；未 enable transport；未 create shipment mutations / reroute / intercept；未 submit carrier claim；未 calculate payout；未 make SLA eligibility decision；未 enable production credential；未创建第二套 account / connection 事实源。真实 carrier read activation 仍 HOLD_EXTERNAL（UPS/FedEx production·sandbox credentials、real verified carrier accounts、real-data tracking validation）。

## 4. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① tracking read 端口与 account lineage 归属边界是否收口；② normalized snapshot / 状态与事件归一化是否满足 ㉓–㉕；③ 失败分类与 read-only / raw 边界是否满足 ㉖㉗㉚；④ 是否批准 CARRIER QUEUE #4 = PASS/CLOSED；⑤ 下一内部单元（Carrier Queue #5，或架构方指定的内部单元）。

边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
