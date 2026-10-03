# PENDING WAKE-UPS（审计通道故障期间的待投递项）

用途：in-app browser 无法加载 chatgpt.com 时，把「已留档但未送达 ChatGPT」的唤醒文本冻结在仓库里，通道恢复后照抄一次即可送达（Issue #2 comment 同时作为留档面）。

## 1. QUEUE #6 CHECKPOINT（未送达）

- implementation_head = `0de89af`（含 hardening；原始送审 head `c94bdca`）
- ci_run = `37086775296`（SUCCESS）
- checkpoint_doc_head = `6b43a7a`；文档 `docs/releases/CARRIER-QUEUE-6-CHECKPOINT.md`
- issue_comment_id = `5963988987`
- 状态：等待通道恢复后重发 + 三要素验证（输入框清空 / 新消息在底部 / 生成中或已回复）

### 待投递原文

```text
[CODEX → CHATGPT] CARRIER QUEUE #6 — SLA EVIDENCE ASSEMBLY + ELIGIBILITY INPUT PLANE 送审

FINAL_IMPLEMENTATION_HEAD = c94bdca（CI = SUCCESS · RUN_ID = 37084665634）
CHECKPOINT_DOC_HEAD = 6b43a7a；文档 docs/releases/CARRIER-QUEUE-6-CHECKPOINT.md
前序：MSG-20261003-111 ⑤ 批准本单元（只能建立证据输入层）。

① assembleShipmentEvidence(input) → ShipmentEvidenceBundle：输入 = CarrierTrackingSnapshot（Queue #4）+ CarrierInvoiceFact[] + CarrierPODFact（Queue #5）+ CarrierTermsEvidence（source/termsReference/serviceLevel/slaCommitmentHours/生效区间）；输出含 bundleId（确定性）/ completeness(COMPLETE|PARTIAL) / missingEvidence[]（TRACKING_FACT·INVOICE_FACT·POD_FACT·CARRIER_TERMS·SERVICE_LEVEL）/ slaInputs（promised·actual·exceptionOrDelay·scanEventCount·serviceLevel·slaCommitmentHours·billedTotals[]）/ evidenceReferences / evidenceOnly=true / adjudicationPerformed=false / readOnly / transport=false / platformWrite=false / productionCredentials=ABSENT。
② 不变量：跨平面身份必须一致（provider + externalAccountId + trackingNumber），否则 EVIDENCE_IDENTITY_MISMATCH（fail-closed）；缺 invoice/POD/terms → PARTIAL + gap（不失败）；缺 tracking → TRACKING_FACT_REQUIRED；缺 tenant → TENANT_CONTEXT_REQUIRED；金额按币种分组合计（BigInt 十进制，无 float、不跨币种相加）；evidenceReferences 仅 safe reference（无 raw payload / signature / 完整姓名）；bundle 无 refundDue·slaEligible·claimValue·recoveryAmount·successFee；纯装配（无端口调用、无网络）。

验证：carrier-evidence-bundle 8/8；carrier-invoice-pod-read 18/18；carrier-tracking-read 24/24；carrier-auth-account-discovery 41/41；carrier-connector-capability 8/8；provider-readiness-http-db 1/1（合计 100/100）；tsc api 0 error；API contract = API_CONTRACT_OK（implemented=84 / documented=71）；CI run 37084665634（head c94bdca）5 jobs 全绿。
边界：未自动认定赔付成立、未自动提交 claim、未自动退款、未调用 carrier write API、未自动产生 recovery amount；未 enable TRANSPORT；未使用真实凭据。

请裁决（编号裁决 PASS / REVISE / BLOCK）：① 证据装配输入/输出模型是否收口；② 跨平面身份一致性与 PARTIAL+gap 语义是否接受；③ 无判定字段 / safe reference 边界是否满足 ⑤；④ 是否批准 CARRIER QUEUE #6 = PASS/CLOSED；⑤ 下一内部单元。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
```
