# CARRIER QUEUE #8 — RECOVERY AMOUNT ESTIMATION + CLAIM-READY PACKAGE INPUT CHECKPOINT

状态：**READY_FOR_REVIEW**（estimate only；不提交索赔、不算成功费、不做 FX）
前序：MSG-20261003-115 ⑮ CARRIER QUEUE #7 = PASS / CLOSED；⑯–㉝ 授权并约束本单元。
IMPLEMENTATION_HEAD = 6ec468e（full 6ec468e009d6a1ac3fb507a393d29cc608e9f89e）；CI = SUCCESS · RUN_ID = 37095429586
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 交付：`estimateCarrierRecovery({ bundle, eligibility })` → `CarrierRecoveryEstimation`

- 输入：`ShipmentEvidenceBundle`（Queue #6）+ `CarrierSlaEligibilityEvaluation`（Queue #7）。
- 输出：bundleId / organizationId / provider / externalAccountId / trackingNumber / `eligibilityRuleSetId` / `eligibilityRuleSetVersion` / `eligibilityDecision` / `estimateRuleSetId`（`carrier-recovery-estimate`）/ `estimateRuleSetVersion`（`1.0.0`）/ `estimatesByCurrency[]` / `claimReadyPackageInput` / `estimateOnly: true` / `claimSubmissionPerformed: false` / readOnly / transport=false / platformWrite=false / productionCredentials=ABSENT。
- bundle 与 eligibility 的 bundleId 不一致 → **fail-closed**（不产生任何 estimate，package blockers 含 `ELIGIBILITY_BUNDLE_MISMATCH`）。

## 2. decision → estimate status（⑰⑱⑲）

- 只有 `decision = ELIGIBLE` 才可能产生金额。
- `INDETERMINATE` → `status = BLOCKED_INDETERMINATE`、`estimatedRecoverableAmount = null`、`blockers` 含 `ELIGIBILITY_INDETERMINATE` + eligibility.blockers（**不猜金额**）。
- `NOT_ELIGIBLE` → `status = NOT_ELIGIBLE`、`estimatedRecoverableAmount = null`（**不用 0.00 冒充「已计算为零」**）。
- 无 explicit eligible charge basis（无 charge 记录或全部为 UNKNOWN/EXCLUDED）→ `status = MISSING_AMOUNT_BASIS`、amount = null。

## 3. 金额来源与 charge eligibility（⑳㉑㉓）

- 金额**只**来自 explicit eligible charge basis：逐条 charge 判定 `included? / eligibility / reasonCode / amount / currency`，`estimatedRecoverableAmount = Σ(included charges)`（复用既有 BigInt 十进制加总，无 float）。**不取 invoice.totalCharge。**
- 保守 v1 规则（明确标注、非 provider production formula）：`BASE` → INCLUDED（`BASE_CHARGE_INCLUDED_V1`）；`DUTY_TAX` → EXCLUDED_FROM_CARRIER_SLA_ESTIMATE（`DUTY_TAX_EXCLUDED_FROM_SLA_ESTIMATE`）；其余（FUEL / RESIDENTIAL / REMOTE_AREA / ADDRESS_CORRECTION / DIMENSIONAL / OVERSIZE / OTHER）→ **UNKNOWN**（`PROVIDER_RULE_DEPENDENT_UNKNOWN`，保守排除，绝不猜）。
- `estimateBasis`（㉙ deterministic，非 LLM confidence）：含 UNKNOWN → `PARTIAL_PROVIDER_RULE_BASIS`；全部可判定 → `COMPLETE_RULE_BASIS`；无金额 → null。
- `includedCharges[]` / `excludedCharges[]` / `calculationBasis[]` 显式列出；UNKNOWN 会进入 estimate.blockers（`UNKNOWN_CHARGE_ELIGIBILITY_EXCLUDED`）。

## 4. 多币种（㉒）

- 每个 currency 一个 estimate（`estimatesByCurrency[]`，顺序按币种字典序确定）；**不跨币种合并、不做 FX guessing**。

## 5. claim-ready package input（㉕㉖）

- `CarrierClaimReadyPackageInput`：provider / externalAccountId / trackingNumber / eligibility evaluation reference（bundleId + ruleSetId + version + decision）/ amountEstimateReferences[] / eligibleChargeReferences[] / evidenceReferences[] / termsReference / trackingEvidenceReference / invoiceEvidenceReferences[] / podReference / blockers[] / packageCompleteness（COMPLETE|PARTIAL）/ `packageOnly: true` / claimSubmissionPerformed=false / transportEnabled=false / platformWriteEnabled=false。
- 明确**不是**最终提交 payload；package 不含 credential / raw payload / signature image / 完整收件人姓名。

## 6. 边界（㉗㉘㉛）

- 不计算 successFee / commission / collectionAmount（商业收费与 carrier recoverable amount 分离）；不输出 actualRecovered（estimate ≠ 已收回现金；不污染 PC-05 recovered-money truth）。
- 不 submit carrier claim / auto refund / auto recovery / payout / payment collection / carrier mutation / FX conversion；不假设全部 invoice charges 可追回；不把 INDETERMINATE 当作已估算。
- 纯函数：无端口调用、无网络。

## 7. 回归（㉚）

`carrier-recovery-estimate` **15/15**：ELIGIBLE + single USD invoice → ESTIMATED 35.00（仅 BASE；FUEL UNKNOWN、DUTY_TAX EXCLUDED）；same input twice → identical estimate；NOT_ELIGIBLE → null（序列化中不含 0.00）；INDETERMINATE → BLOCKED_INDETERMINATE + null + blockers；missing invoice → 无 estimate + `INVOICE_EVIDENCE_MISSING` + PARTIAL package；多币种 → 分离 estimates（EUR 20.00 / USD 35.00）不合并；included/excluded 显式；无 UNKNOWN 时 COMPLETE_RULE_BASIS；无 charge 记录 → MISSING_AMOUNT_BASIS（null）；estimate/eligibility rule version 均携带；package 引用 estimate+evaluation 且 evidence refs 保留；package 无 credential/raw payload/signature；无 successFee/commission/collectionAmount/actualRecovered；estimateOnly=true 且零提交；bundle/eligibility 不匹配 → fail-closed；无网络。

合计：recovery-estimate 15 + sla-eligibility 35 + evidence-bundle 21 + invoice-pod 18 + tracking 24 + carrier-auth-account-discovery 41 + connector 8 + provider-readiness DB 1 = **163/163**；tsc api 0 error；tsc web 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37095429586（head 6ec468e）5 jobs 全绿。

## 8. External gate（㉝）

真实 recovery formula 仍需要 UPS/FedEx contractual refund rules、service guarantee exclusions、eligible charge definitions、real invoice samples、real adjudicated claims = `HOLD_EXTERNAL`。本版规则为**明确、保守、versioned** 估算规则，不伪装成 provider production recovery formula。

## 9. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① ELIGIBLE-only 与 INDETERMINATE/NOT_ELIGIBLE → null（不用 0.00）是否符合 ⑰⑱⑲；② amount 只来自 explicit eligible charge basis（不取 totalCharge）+ 保守 charge eligibility 是否符合 ⑳㉑㉓；③ 多币种分离不合并是否符合 ㉒；④ claim-ready package 字段与「不是提交 payload / 零提交标志」是否符合 ㉕㉖；⑤ 无 successFee / commission / actualRecovered + deterministic estimateBasis + estimate rule versioning 是否符合 ㉔㉗㉘㉙；⑥ 是否批准 CARRIER QUEUE #8 = PASS/CLOSED，以及下一内部单元（Queue #9 CLAIM PACKAGE GENERATION / MANUAL-SUBMISSION WORKFLOW？）。
