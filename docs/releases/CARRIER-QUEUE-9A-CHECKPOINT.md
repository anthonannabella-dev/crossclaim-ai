# CARRIER QUEUE #9A — CLAIM PACKAGE GENERATION CHECKPOINT

状态：**READY_FOR_REVIEW**（生成人工审核用 claim package；不执行任何 carrier 提交）
前序：MSG-20261003-117 ⑰ CARRIER QUEUE #8 = PASS / CLOSED；⑱–㉜ 授权并约束本单元（建议拆分 9A / 9B）。
IMPLEMENTATION_HEAD = 1321801（full 1321801abe74342aa50eb9bc1552c7256d37c924）；CI = SUCCESS · RUN_ID = 37096814519
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 交付：`generateCarrierClaimPackage({ bundle, eligibility, estimation })` → `CarrierClaimPackage`

- 输入：`ShipmentEvidenceBundle`（Queue #6）+ `CarrierSlaEligibilityEvaluation`（Queue #7）+ `CarrierRecoveryEstimation`（Queue #8）。
- 输出字段：packageId / bundleId / organizationId / provider / externalAccountId / trackingNumber / `eligibilityReference`（bundleId + ruleSetId + ruleSetVersion + decision）/ `estimateRuleSetId`·`estimateRuleSetVersion` / `claimAmountsByCurrency[]` / `amountLabel: ESTIMATED_RECOVERABLE` / `evidenceManifest[]` / termsReference / trackingEvidenceReference / invoiceReferences[] / podReference / `submissionMode: MANUAL` / `submissionDestination` / `submissionInstructions[]` / `packageStatus` / `packageCompleteness` / blockers[] / generatedAt / `packageOnly: true` / `manualSubmissionRequired: true` / `claimSubmissionPerformed: false` / readOnly / transport=false / platformWrite=false / productionCredentials=ABSENT。

## 2. 生成闸门（⑳）与状态边界（㉙）

- 只有 `packageCompleteness = COMPLETE`（即 Queue #8 package COMPLETE 且本层 required evidence 齐备、且输入一致）→ `packageStatus = READY_FOR_MANUAL_SUBMISSION`；否则 `NEEDS_REVIEW` 并保留全部 blockers（claim-ready blockers + `MISSING_REQUIRED_EVIDENCE:<TYPE>` + 输入不一致 code）。
- 本单元**只能**产生 `NEEDS_REVIEW` / `READY_FOR_MANUAL_SUBMISSION` 两个状态；`MANUALLY_SUBMITTED` 只能由后续 human action / recording path 进入（建议 Queue #9B）。

## 3. 金额呈现与多币种（㉒㉓）

- `amountLabel = ESTIMATED_RECOVERABLE`（明确 estimated）；不出现 amountDue / refundApproved / guaranteedRecovery。
- `claimAmountsByCurrency[]` 每币种一行（含 estimateStatus / estimatedRecoverableAmount / estimateBasis），**不合成单一总额、不做 FX**。

## 4. evidence manifest（㉔）与规则溯源（㉑）

- `CarrierClaimEvidenceManifestItem { type, reference, required, present, source }`，类型覆盖 TRACKING / INVOICE / POD / TERMS / ELIGIBILITY_EVALUATION / RECOVERY_ESTIMATE。
- 只携带 safe reference（rawReference / termsReference / ruleSetId@version）；不含 raw credential / token / inline signature image / raw provider payload。
- required evidence 缺失 → `MISSING_REQUIRED_EVIDENCE:<TYPE>` → NEEDS_REVIEW。
- package 显式携带 eligibility 与 estimate 的 ruleSetId / ruleSetVersion 以及每币种 estimateBasis，金额不会脱离规则来源。

## 5. 人工流程与模板分离（㉕㉖㉗）

- `submissionMode = MANUAL`；`submissionInstructions` 为 manual workflow metadata（含 `PACKAGE_NOT_SUBMITTED_AUTOMATICALLY`、`RECORD_MANUAL_SUBMISSION_SEPARATELY_QUEUE_9B`），不打开任何 carrier 写接口。
- `submissionDestination { provider, channel, referenceUrl }`；`referenceUrl` 恒为 null（HOLD_EXTERNAL：本单元不验证也不访问真实提交入口）。
- provider-specific template：UPS → `PORTAL`、FEDEX → `SUPPORT_CASE`（独立 template 记录，不用 giant `if(provider)` 混装格式）。

## 6. 确定性（㉘）

- `packageId` 由 immutable refs / versions 派生：`carrier-claim-package|<bundleId>|<eligibilityRuleSetId>@ver|<estimateRuleSetId>@ver|<currency:status:amount:basis>...`；相同输入 → 相同 packageId 与相同 package 内容（非随机 UUID）。
- 输入不一致 fail-closed：`ESTIMATION_BUNDLE_MISMATCH`（bundleId 不一致）与 `ELIGIBILITY_ESTIMATION_MISMATCH`（资格规则 id/version/decision 与 estimate 不一致）→ NEEDS_REVIEW。

## 7. 回归（㉜）

`carrier-claim-package` **17/17**：COMPLETE → READY_FOR_MANUAL_SUBMISSION（blockers 为空）；PARTIAL → NEEDS_REVIEW 且 blockers 保留（`USD:UNKNOWN_CHARGE_ELIGIBILITY_EXCLUDED`）；eligibility/estimate refs 与 rule version 保留（含每币种 estimateBasis）；多币种分离无 FX；evidence manifest 稳定且六类齐全；缺 required evidence（POD）→ NEEDS_REVIEW + `MISSING_REQUIRED_EVIDENCE:POD`；无 raw payload/credential/token/inline signature；estimated 标签且无 amountDue·refundApproved·guaranteedRecovery；无 successFee·commission·collectionAmount·actualRecovered；零提交边界（manual only、referenceUrl null）；只产生两个状态（无 MANUALLY_SUBMITTED）；provider template 分离；deterministic packageId + generatedAt；两组输入不一致 → NEEDS_REVIEW；NOT_ELIGIBLE / INDETERMINATE → NEEDS_REVIEW；纯生成无网络。

合计：claim-package 17 + recovery-estimate 23 + sla-eligibility 35 + evidence-bundle 21 + invoice-pod 18 + tracking 24 + carrier-auth-account-discovery 41 + connector 8 + provider-readiness DB 1 = **188/188**；tsc api 0 error；tsc web 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37096814519（head 1321801）5 jobs 全绿。

## 8. External gate（㉟）

真实 carrier claim submission 仍依赖 UPS/FedEx claim APIs·portal rules、production authorization、real account permissions、submission eligibility、provider-specific claim forms、real contractual terms = `HOLD_EXTERNAL`（不阻塞本单元 package generation）。

## 9. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① package 结构（⑲）与生成闸门 READY_FOR_MANUAL_SUBMISSION / NEEDS_REVIEW（⑳㉙）是否符合；② amountLabel=ESTIMATED_RECOVERABLE 与 `claimAmountsByCurrency[]`（㉒㉓）是否符合；③ evidence manifest 与 rule provenance（㉑㉔）是否符合；④ manual-only 指令 / destination metadata / provider template 分离（㉕㉖㉗）是否符合；⑤ deterministic packageId 与输入一致性 fail-closed（㉘）是否符合；⑥ 是否批准 CARRIER QUEUE #9A = PASS/CLOSED，以及是否授权 CARRIER QUEUE #9B（MANUAL SUBMISSION RECORD + HUMAN ATTESTATION）。
