# CARRIER QUEUE #7 — SLA ELIGIBILITY EVALUATION CONTRACT CHECKPOINT

状态：**READY_FOR_REVIEW**（只回答「证据支持什么结论」；不计算追回金额、不提交索赔）
前序：MSG-20261003-113 ⑰ CARRIER QUEUE #6 = PASS / CLOSED；⑱–㉞ 授权并约束本单元。
IMPLEMENTATION_HEAD = cda3d30（full cda3d30561e4f183b2eeb582c6a77a0f30190369）；CI = SUCCESS · RUN_ID = 37093979530
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 交付：`evaluateCarrierSlaEligibility(bundle)` → `CarrierSlaEligibilityEvaluation`

- 输入：`ShipmentEvidenceBundle`（Queue #6，纯既有只读事实）。
- 输出：`bundleId` / organizationId / provider / externalAccountId / trackingNumber / `ruleSetId` / `ruleSetVersion` / `evaluatedAt` / `decision` / `ruleResults[]` / `blockers[]` / `evaluationBasis` / `evidenceReferences[]` / `evaluationOnly: true` / `claimSubmissionPerformed: false` / `readOnly` / `transportEnabled=false` / `platformWriteEnabled=false` / `productionCredentials=ABSENT`。
- `ruleSetId = carrier-sla-eligibility`、`ruleSetVersion = 1.0.0`（㉛ rule versioning）。

## 2. 三值 decision（⑳㉗）

- `decision ∈ { ELIGIBLE, NOT_ELIGIBLE, INDETERMINATE }`，由 rule results **确定性**推导：任一 FAIL → NOT_ELIGIBLE；否则任一 UNKNOWN → INDETERMINATE；全部 PASS → ELIGIBLE。
- **UNKNOWN ≠ FAIL**；**PARTIAL ≠ NOT_ELIGIBLE**：缺证据与证据冲突只产生 UNKNOWN，因此 PARTIAL bundle 落在 INDETERMINATE（除非存在明确 FAIL 规则）。
- `blockers[]` = 所有非 PASS 规则的 `ruleId:reasonCode`（顺序 = 规则声明顺序，确定）。

## 3. 规则集（㉑㉒）

八条规则，每条返回 `{ ruleId, status: PASS | FAIL | UNKNOWN, reasonCode, evidenceReferences[] }`：

- `EVIDENCE_COMPLETENESS`：COMPLETE → PASS；PARTIAL → UNKNOWN（`EVIDENCE_INCOMPLETE`，并列出 missingEvidence gaps）。
- `EVIDENCE_CONFLICTS`：无冲突 → PASS；有冲突 → UNKNOWN（`EVIDENCE_CONFLICT_PRESENT`，列出冲突枚举）。
- `TERMS_EVIDENCE_PRESENT`：有 terms → PASS；缺 → UNKNOWN（`TERMS_EVIDENCE_MISSING`）。
- `TERMS_EFFECTIVE_RANGE`（㉓）：缺 terms → UNKNOWN；relevant date 缺失 → UNKNOWN（`RELEVANT_DATE_UNAVAILABLE`）；range 两端都缺 → UNKNOWN（`TERMS_RANGE_UNAVAILABLE`）；`relevantDate < effectiveFrom` 或 `> effectiveTo` → FAIL（`TERMS_NOT_EFFECTIVE`）；否则 PASS。relevant date source **显式声明**为 `TRACKING_SHIP_DATE`（`evaluationBasis.relevantDateSource`），比较为**闭区间**（inclusive）。
- `SERVICE_LEVEL_MATCH`：`SERVICE_LEVEL_CONFLICT` → UNKNOWN；canonical serviceLevel 为 null → UNKNOWN（`SERVICE_LEVEL_UNAVAILABLE`）；否则 PASS（`SERVICE_LEVEL_CONSISTENT`，含仅一方有值的情形，见 MSG-113 ⑧）。
- `DELIVERY_TIMING`（㉔）：`DELIVERY_TIME_CONFLICT` → UNKNOWN；promised 缺失 → UNKNOWN（`PROMISED_DELIVERY_UNAVAILABLE`）；actual 缺失 → UNKNOWN（`ACTUAL_DELIVERY_UNAVAILABLE`）；`actual > promised` → PASS（`LATE_DELIVERY_OBSERVED`）；否则 FAIL（`ON_TIME_OR_EARLY`）。lateObserved **不等于**可退款 —— 只是 rule result。
- `EXCEPTION_OR_DELAY_OBSERVED`：evidence 事件含 EXCEPTION/DELAYED → PASS；否则 FAIL（`EXCEPTION_DELAY_NOT_OBSERVED`）—— observation，不是 slaEligible。
- `BILLED_INVOICE_PRESENT`：有 invoice → PASS；缺 → UNKNOWN（`INVOICE_EVIDENCE_MISSING`）。

注（㉕）：本单元**未**使用 `slaCommitmentHours` 推算 deadline（start timestamp source / 时区 / business-hour / exclusions 未定义前不做）。

## 4. 硬边界（㉘㉙㉚㉞）

- 输出**不含** recoveryAmount / claimValue / refundDue / successFee / billedTotals / totalCharge（本层不算钱）。
- 不 submit claim / create dispute / file refund / carrier API mutation / payout / payment·collection（`claimSubmissionPerformed = false`）。
- deterministic：同一 bundle → 相同 rule results / decision / bundleId；无 LLM judgment、无概率评分、无随机决策。
- 纯函数：无端口调用、无网络。

## 5. 回归（㉝）

`carrier-sla-eligibility` **24/24**：COMPLETE clean bundle → ELIGIBLE（8/8 PASS）；same bundle twice → identical rule results（deterministic）；PARTIAL → INDETERMINATE 且无 FAIL；`DELIVERY_TIME_CONFLICT` → `DELIVERY_TIMING` UNKNOWN + INDETERMINATE；`SERVICE_LEVEL_CONFLICT` → `SERVICE_LEVEL_MATCH` UNKNOWN + INDETERMINATE；actual 晚于 promised → PASS（late observed）；actual 早于/等于 → FAIL → NOT_ELIGIBLE；promised 缺失 → UNKNOWN（不使用 slaCommitmentHours 推算）；actual 缺失 → UNKNOWN；terms 缺失 → terms 规则 UNKNOWN；range 覆盖 relevant date → PASS；range 排除 → FAIL → NOT_ELIGIBLE；relevant date 缺失 → UNKNOWN（不假设「有 terms 就适用」）；range 两端缺失 → UNKNOWN；invoice 缺失 → UNKNOWN；无金额字段；无提交 / 外写标志；ruleSet/version/evaluatedAt/bundleId 存在；UNKNOWN 不当 FAIL；PARTIAL 不当 NOT_ELIGIBLE；conflict 不被静默消解（blockers 明确列出）；仅一方 service level 亦可用；exception/delay 仅作观察；纯评估无网络。

合计：sla-eligibility 24 + evidence-bundle 21 + invoice-pod 18 + tracking 24 + carrier-auth-account-discovery 41 + connector 8 + provider-readiness DB 1 = **137/137**；tsc api 0 error；tsc web 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37093979530（head cda3d30）5 jobs 全绿。

## 6. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① 三值 decision 语义（ELIGIBLE / NOT_ELIGIBLE / INDETERMINATE）与 FAIL/UNKNOWN→decision 映射是否接受（⑳㉗）；② 八条规则维度与 reasonCode 命名是否收口（㉑㉒）；③ `TERMS_EFFECTIVE_RANGE` 的显式 relevant date source（TRACKING_SHIP_DATE）+ 闭区间语义是否接受（㉓）；④ conflict → 依赖规则 UNKNOWN 且不静默消解是否满足 ㉖；⑤ 无金额 / 无提交 / deterministic / rule versioning 是否满足 ㉘㉙㉚㉛；⑥ 是否批准 CARRIER QUEUE #7 = PASS/CLOSED，以及下一内部单元。
