# CARRIER QUEUE #6 FINAL — EVIDENCE FACT / CONFLICT SEMANTICS CHECKPOINT

状态：**READY_FOR_REVIEW**（证据装配层只搬运与标记证据；不做 eligibility / 赔付 / claim 认定）
前序：MSG-20261003-112 = REVISE-MINOR（唯一剩余类别 = EVIDENCE CONFLICT / FACT FABRICATION SAFETY；⑫⑬⑮ 三项 CHANGE）。
IMPLEMENTATION_HEAD = 27d2a94（full 27d2a9429af5987ed5810e6be7b49cf1c97078b8）；CI = SUCCESS · RUN_ID = 37093211320
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. CHANGE A（⑫，BLOCKING）— promisedDeliveryAt 只绑定真实承诺/预计送达事实

- 旧行为：`slaCommitmentHours != null` 时优先取 `tracking.shipDate`，把「发货时间」当成「承诺送达时间」——制造新事实。
- 现行：`promisedDeliveryAt = tracking.estimatedDeliveryAt ?? null`。**不**用 shipDate 替代、**不**用 slaCommitmentHours 推算、**不**自行推导 deadline。
- `slaCommitmentHours` 继续作为独立 evidence input 保留（`slaInputs.slaCommitmentHours`），供后续 eligibility 层判断。

## 2. CHANGE B（⑬⑭）— 交付时间冲突不得静默择一

- 新增 `slaInputs.deliveryTimes { trackingDeliveredAt, podDeliveredAt }`：两类只读事实各自保留。
- `actualDeliveryAt` 仅在「只有一个来源有值」或「两个来源完全一致」时填值；两者冲突时 `actualDeliveryAt = null`。
- 冲突 → `evidenceConflicts: ['DELIVERY_TIME_CONFLICT']`（不默选 tracking、不在证据层裁定“谁更可信”）。

## 3. CHANGE C（⑮⑯）— service level 冲突不得静默覆盖

- 新增 `slaInputs.trackingServiceLevel` / `slaInputs.termsServiceLevel` 两个来源事实。
- 两边都有且相等 → 输出 canonical `serviceLevel`；不等 → `serviceLevel = null` 且 `evidenceConflicts: ['SERVICE_LEVEL_CONFLICT']`。

## 4. 冲突模型与 completeness（⑱⑲）

- 新增 `SHIPMENT_EVIDENCE_CONFLICTS = [DELIVERY_TIME_CONFLICT, SERVICE_LEVEL_CONFLICT]` 与 `bundle.evidenceConflicts[]`（本轮不扩 PROMISED_DELIVERY_CONFLICT）。
- `completeness` 与 `evidenceConflicts` **相互独立**：`COMPLETE + [SERVICE_LEVEL_CONFLICT]` 为合法状态；conflict 不会被塞进 `missingEvidence`。
- `bundleId` 保持 deterministic（相同证据输入 → 相同 bundleId；本轮不重设 hash scheme）。
- 保持不动（㉓）：ShipmentEvidenceBundle 主结构 / identity binding / billedTotals / safe references / missingEvidence / evidenceOnly / adjudicationPerformed / read-only flags。

## 5. 回归（㉒）

`carrier-evidence-bundle` **21/21**（原 8 + FINAL 13）：slaCommitmentHours≠null 时 shipDate 不得成为 promisedDeliveryAt；estimatedDeliveryAt 存在 → promisedDeliveryAt=estimatedDeliveryAt；estimatedDeliveryAt=null → promisedDeliveryAt=null（即使有 slaCommitmentHours）；仅 tracking deliveredAt → actualDeliveryAt=tracking；仅 POD deliveredAt → actualDeliveryAt=POD；两者相等 → 输出该值；两者冲突 → DELIVERY_TIME_CONFLICT 且 actualDeliveryAt=null 且不得静默择一；tracking/terms serviceLevel 相等 → canonical；冲突 → SERVICE_LEVEL_CONFLICT 且 serviceLevel=null 并暴露两来源；effectiveFrom/effectiveTo 不做适用性判断；conflict 状态下仍无 slaEligible/refundDue/claimValue/recoveryAmount/successFee；bundleId 仍确定性。

合计：evidence-bundle 21 + invoice-pod 18 + tracking 24 + carrier-auth-account-discovery 41 + connector 8 + provider-readiness DB 1 = **113/113**；tsc api 0 error；tsc web 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37093211320（head 27d2a94）5 jobs 全绿。

## 6. 边界确认

未自动认定赔付成立、未自动提交 claim、未自动退款、未调用 carrier write API、未自动产生 recovery amount；未 enable TRANSPORT；未使用真实凭据；无端口调用、无网络。真实 carrier read 仍 HOLD_EXTERNAL。

## 7. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① `promisedDeliveryAt` 是否已只绑定真实承诺/预计送达事实（⑫）；② `deliveryTimes` + `DELIVERY_TIME_CONFLICT` 是否收口（⑬⑭）；③ `serviceLevel` 冲突语义是否收口（⑮⑯）；④ `evidenceConflicts` 与 `completeness` 独立性是否接受（⑱⑲）；⑤ 是否批准 CARRIER QUEUE #6 = PASS/CLOSED；⑥ 下一内部单元（Queue #7？）。
