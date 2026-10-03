# CARRIER QUEUE #10 — CARRIER RESPONSE / STATUS READ MODEL（CONTRACT LAYER）CHECKPOINT

状态：**READY_FOR_REVIEW**
前序：MSG-20261003-121 ④ CARRIER QUEUE #9B FINAL-2 = PASS；⑤ CARRIER QUEUE #9B = PASS/CLOSED；⑥ 授权 CARRIER QUEUE #10（CARRIER RESPONSE / STATUS READ MODEL）。
IMPLEMENTATION_HEAD = e060a5f（full e060a5fe194236d76113ff4fab729250868ccc8c）；CI = SUCCESS · RUN_ID = 37106375647
边界：**NO platform write · TRANSPORT=false · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · 无生产凭据**。

## 1. 交付物（契约层，无 Schema / DB / HTTP 绑定）

- 新增 `apps/api/src/services/carriers/carrier-claim-response.ts`（纯服务 + 注入端口）。
- 新增 `apps/api/src/__tests__/carrier-claim-response.test.ts`（**23/23 PASS**）。
- 未改 Schema / 未新增 migration / 未接 HTTP：持久化与路由按既有纪律留待独立 Schema Delta 审核后实施（同 Queue #9A→#9B 的分层做法）。

## 2. ⑭ status 与 provenance 分离

- status 枚举：`PENDING / UNDER_REVIEW / DENIED / APPROVED / PARTIALLY_APPROVED / PAID / CLOSED / UNKNOWN`。
- source 枚举：`USER_REPORTED / PROVIDER_API / PROVIDER_WEBHOOK / PROVIDER_DOCUMENT / PROVIDER_PORTAL_ARTIFACT`。
- `verificationLevel ∈ {UNVERIFIED, PROVIDER_VERIFIED}` 由 **source + 已登记可信路径** 决定，**不**由 status 决定，也**不**由 carrierReference 推断。
- 测试：`status = APPROVED + source = USER_REPORTED`（即使带 providerReference）→ 仍为 `UNVERIFIED`。

## 3. ⑮⑱ provenance / trusted source path

- `verificationLevelForSource(source, trustedProviderSources)`：`USER_REPORTED` 恒 UNVERIFIED；provider 来源仅在**已登记可信路径**时 PROVIDER_VERIFIED。
- 默认 `trustedProviderSources = []` → provider 来源直接 **fail-closed 拒绝**（`PROVIDER_SOURCE_NOT_TRUSTED`），因为真实 provider API / webhook 集成仍属 `HOLD_EXTERNAL`。
- 已登记可信路径 + providerReference → `PROVIDER_VERIFIED`；缺 providerReference → `PROVIDER_REFERENCE_REQUIRED`。

## 4. ⑯ append-only facts + 投影

- `CarrierClaimResponseFact`：factId / organizationId / packageId / submissionRecordId / provider / externalAccountId / trackingNumber / status / source / verificationLevel / providerReference / observedAt / recordedAt / rawArtifactReference / recordedByUserId + 冻结标志（见 §6）。
- store 端口只有 `append` / `listByPackage`（**无 update / delete / upsert**）→ 覆盖写入口不存在；测试断言 store 键集合恰为 `[append, listByPackage]`。
- `projectCarrierClaimResponse` 由事实**derive** current status：按 `(observedAt, recordedAt, factId)` 确定性排序，保留完整 statusHistory；相同事实集合（含乱序输入）→ 完全相同投影。
- 幂等：同一 submission 上重复 `(status, source, providerReference)` → `ALREADY_RECORDED`，facts 仍只有 1 条。

## 5. ⑰⑲⑳ 人工补录 / APPROVED != PAID != recovered cash

- 人工补录 PENDING / UNDER_REVIEW / APPROVED / DENIED / PAID 一律允许，但 **verificationLevel = UNVERIFIED**，且不触碰资金真值。
- 投影**不推断状态跃迁**：只有 APPROVED 事实时 currentStatus = APPROVED，**永不**推导出 PAID；`derivesRecoveredCash = false`、`derivesSuccessFee = false`。
- 事实不携带 `actualRecovered` / `recoveryPayout` / `successFee` / `commission` / `collectionAmount` / `paymentId`（测试断言键集合）。
- PAID 事实同样**不**写入 recovered cash：资金真值仍由 settlement / carrier credit / bank-payment evidence 与既有 PC-05·R46 money truth 确认。

## 6. 边界自证（每一条事实携带 + 导出常量 CARRIER_CLAIM_RESPONSE_MONEY_BOUNDARY）

`recoveredCashUpdated=false` · `successFeeCalculated=false` · `paymentCollectionPerformed=false` · `externalWritePerformed=false` · `transportEnabled=false` · `platformWriteEnabled=false` · `productionCredentials=ABSENT`；记录路径**无任何网络调用**（fetch spy 断言未被调用）。

## 7. 输入校验 / 授权

- capability `carrier.claim_response.record` 缺失 → `CAPABILITY_REQUIRED`（fail closed，零事实）。
- package truth 由 server 侧 `submissions.load(organizationId, packageId)` 加载：跨租户 / 未知 package → `SUBMISSION_NOT_FOUND`（零事实）。
- actor / organization 全部 server-derived：client 注入 `organizationId` / `recordedByUserId` / `verificationLevel` 被忽略（测试断言仍取服务端值）。
- 形状校验：未知 status / source、非法或未来 `observedAt`、note > 500 或含控制字符、providerReference > 128 或含控制字符 → 稳定失败码；`recordedAt` 只能取服务端时钟。

## 8. 回归与闸门

- `carrier-claim-response` **23/23**；`tsc --noEmit`(api) 0 error；`tsc --noEmit`(web) 0 error；API contract = `API_CONTRACT_OK`（implemented=85 / documented=72）；audit coverage OK；autopilot rules OK。
- 本批未改 Schema / 未改既有 carrier 模块，货架既有 402 测试不受影响（下一次送审批次会跑全量货架回归）。
- 本地 `migration-checksum` 报告的 `20260930100000_tenant_ownership_immutability` 差异为本地 CRLF 检出 artifact（LF 归一化 sha256 = pinned），CI 以 LF 检出不受影响。
- CI RUN = 37106375647（head e060a5f）5 jobs 全绿。

## 9. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① ⑭ status 与 provenance 分离是否满足；② ⑮⑱ trusted source path（默认 fail-closed）是否满足；③ ⑯ append-only facts + 投影 derive 是否符合；④ ⑰⑲⑳ APPROVED != PAID != recovered cash 是否符合；⑤ 是否批准 CARRIER QUEUE #10 契约层 = PASS/CLOSED AS CONTRACT LAYER；⑥ 是否授权下一批（Queue #10 FINAL：Prisma append-only persistence + tenant guard + Action Guard capability + HTTP 读模型 / 或先做 15% 商业模型 C10–C11 / Customs C1+，按架构方优先级）。
