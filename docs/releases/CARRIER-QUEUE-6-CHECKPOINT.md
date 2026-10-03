# CARRIER QUEUE #6 — SLA EVIDENCE ASSEMBLY + ELIGIBILITY INPUT PLANE CHECKPOINT

状态：**READY_FOR_REVIEW**（只做证据装配；不做 eligibility / 赔付 / claim 认定）
前序：MSG-20261003-111 ⑤ 批准本单元（边界：只能建立证据输入层）。
IMPLEMENTATION_HEAD = c94bdca（full c94bdca328257710ffa590f799cea66b2952bec2）；CI = SUCCESS · RUN_ID = 37084665634
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 交付：`assembleShipmentEvidence()` → `ShipmentEvidenceBundle`

- 输入（全部为既有只读事实）：`CarrierTrackingSnapshot`（Queue #4）+ `CarrierInvoiceFact[]` + `CarrierPODFact`（Queue #5）+ `CarrierTermsEvidence`（SLA 条款证据：source / termsReference / serviceLevel / slaCommitmentHours / 生效区间）+ service level（来自 terms 或 tracking fact）。
- 输出 bundle：bundleId（确定性）/ organizationId / provider / externalAccountId / trackingNumber / `completeness ∈ {COMPLETE, PARTIAL}` / `missingEvidence[]`（TRACKING_FACT · INVOICE_FACT · POD_FACT · CARRIER_TERMS · SERVICE_LEVEL）/ tracking / invoices / pod / terms / `slaInputs`（promisedDeliveryAt · actualDeliveryAt · exceptionOrDelayObserved · scanEventCount · serviceLevel · slaCommitmentHours · billedTotals[]）/ evidenceReferences（仅 safe reference）/ observedAt / **evidenceOnly: true** / **adjudicationPerformed: false** / readOnly / transport=false / platformWrite=false / productionCredentials=ABSENT。

## 2. 不变量

- **跨平面身份一致**：所有 invoice / POD / terms 必须与 tracking fact 的 provider + externalAccountId（及 trackingNumber）一致，否则 `EVIDENCE_IDENTITY_MISMATCH`（fail-closed）。
- **缺证据不失败**：invoice / POD / terms 缺失 → `PARTIAL` + 对应 gap（供后续 NEEDS_MORE_DATA 语义使用）；tracking fact 缺失 → `TRACKING_FACT_REQUIRED`；缺 tenant → `TENANT_CONTEXT_REQUIRED`。
- **金额不跨币种相加**：`billedTotals` 按 currency 分组，使用既有 BigInt 十进制加总（无 float）。
- **只带 safe reference**：evidenceReferences 仅含 rawReference / documentReference / termsReference；不携带 raw payload / signature / 完整收件人姓名（POD 只带 masked 姓名）。
- **无判定字段**：bundle 中不存在 refundDue / slaEligible / claimValue / recoveryAmount / successFee；不调用任何端口、不发真实请求。

## 3. 回归

`carrier-evidence-bundle` **8/8**：完整证据 → COMPLETE（evidenceOnly / adjudicationPerformed=false / read-only 三恒值）；缺 POD·INVOICE·TERMS → PARTIAL + gap；缺 tracking / tenant → fail-closed；跨平面 account·tracking·provider 不一致 → EVIDENCE_IDENTITY_MISMATCH；slaInputs 事实字段断言；金额按币种分组（51.50 / 2 张）；bundleId 确定性 + safe reference + 无判定字段 + 无完整姓名；纯装配无网络。

合计：evidence-bundle 8 + invoice-pod 18 + tracking 24 + carrier-auth-account-discovery 41 + connector 8 + provider-readiness DB 1 = **100/100**；tsc api 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37084665634（head c94bdca）5 jobs 全绿。

## 4. 边界确认（MSG-111 ⑤）

未自动认定赔付成立、未自动提交 claim、未自动退款、未调用 carrier write API、未自动产生 recovery amount；未 enable TRANSPORT；未使用真实凭据。真实 carrier read 仍 HOLD_EXTERNAL。

## 5. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① 证据装配输入/输出模型是否收口；② 跨平面身份一致性与 PARTIAL+gap 语义是否接受；③ 无判定字段 / safe reference 边界是否满足 ⑤；④ 是否批准 CARRIER QUEUE #6 = PASS/CLOSED；⑤ 下一内部单元。
