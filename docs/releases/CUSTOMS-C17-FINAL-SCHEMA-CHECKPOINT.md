# C17 FINAL SCHEMA CHECKPOINT — CUSTOMS SUBMISSION LEDGER（root + append-only facts）

状态：**READY_FOR_REVIEW**
前序：MSG-20261003-124 ①③ 判定原 C17 Schema Delta = REVISE（append-only 状态历史与 attempt-level UNIQUE 冲突），要求拆为 **Attempt root（幂等身份）+ AttemptFact（append-only 状态）**；⑬ 明确重设计后**只需送本 CHECKPOINT**。
IMPLEMENTATION_HEAD = 60ad182
边界：**NO platform write · TRANSPORT=false · Payment = 0 · autopay = OFF · collection = OFF · R13 HOLD · 无生产凭据 · 真实 filing = HOLD_EXTERNAL / HOST APPROVAL REQUIRED**。

## 1. 模型（migration 20261003050000_customs_submission_attempt）

`CustomsSubmissionAttempt`（执行身份 / 幂等根，immutable）：

- 字段：id / organizationId / opportunityId / caseId? / claimItemId? / packageId / packageDigest / provider / operation / jurisdiction / remedyType / idempotencyKey / createdAt。
- UNIQUE(organizationId, provider, operation, idempotencyKey)（并发只允许一根）。
- CHECK packageDigest ~ ^[0-9a-f]{64}$；FK organizationId → Organization。
- opportunity/case/claimItem 仅作 safe snapshot lineage（不伪造不存在的 FK）。

`CustomsSubmissionAttemptFact`（append-only 状态事实）：

- 字段：id / organizationId / attemptId / status / providerSubmissionId? / source / verificationLevel / observedAt / recordedAt / providerReference? / errorCode? / reconciliationAttempt? / createdAt。
- CHECK status ∈ {ATTEMPTED, UNKNOWN_PROVIDER_RESPONSE, RECONCILING, SUBMITTED, FAILED_CONFIRMED, MANUAL_REVIEW}；CHECK source ∈ {PROVIDER_API, PROVIDER_WEBHOOK, PROVIDER_DOCUMENT, PROVIDER_PORTAL_ARTIFACT, MANUAL}；CHECK verificationLevel ∈ {UNVERIFIED, PROVIDER_VERIFIED}。
- **⑦ CHECK (status <> 'SUBMITTED' OR providerSubmissionId IS NOT NULL)**。
- FK attemptId → CustomsSubmissionAttempt；索引 (organizationId, attemptId, observedAt)。

## 2. 守卫与清单（⑪⑫）

- 租户：cc_tenant_customssubmissionattempt、cc_tenant_customssubmissionattemptfact（含 attemptId → CustomsSubmissionAttempt 跨租户归属校验）；归属不可变：cc_tenant_immutable__CustomsSubmissionAttempt / __CustomsSubmissionAttemptFact。
- append-only：cc_append_only__CustomsSubmissionAttemptFact（UPDATE/DELETE 拒绝）。
- 清单：83 baseline / 24 append-only；模型计数 61（55 core + 6 join），README/DOMAIN_MODEL/architecture-contract 同步。
- 不存 credential / token / raw payload / raw PII。

## 3. 服务与 store（③④⑤⑥⑦⑧⑨）

- root/fact id 由 immutable 输入确定性派生；open 校验必填与 digest 形状；recordFact 校验枚举、SUBMITTED→providerSubmissionId、providerSubmissionId 冲突（已有 PROVIDER_VERIFIED 不同 id → 拒绝）、observedAt 非未来（recordedAt 服务端时钟）。
- 退避对账 1/5/15/60 分钟，≥24h → MANUAL_REVIEW；**不提供任何重发 filing 的路径**（no-blind-retry）。
- Prisma store：createRoot/appendFact 以 P2002 回读既有记录；无 update/delete 入口。

## 4. 真实 PostgreSQL 验收（㊲）10/10

一 key 一根；双连接并发一根；ATTEMPTED→UNKNOWN_PROVIDER_RESPONSE→RECONCILING→SUBMITTED 逐条追加；SUBMITTED 缺 id 服务+DB 双拒；append-only UPDATE/DELETE 拒；跨租户 lineage 拒；digest 形状双拒；timeout 不建第二根；ambiguous 仅对账；24h → MANUAL_REVIEW；账本无 credential/raw payload/资金字段（边界常量自证 filingSubmitted=false / externalWritePerformed=false / storesCredential=false / storesRawPayload=false）。

## 5. 其它闸门

prisma validate valid；migrate deploy 成功；generate OK；tenant checklist 83/59/2 OK；append-only checklist 24 OK；architecture-contract 142/142；tsc api/web 0 error；API contract API_CONTRACT_OK（86/73）。

## 6. 请裁决（PASS / REVISE / BLOCK）

① root+fact 拆分是否符合 ③④⑤；② SUBMITTED→providerSubmissionId 与冲突 fail-closed 是否符合 ⑦；③ 退避对账 + no-blind-retry 是否符合 ⑧⑨；④ tenant/digest/credential 边界是否符合 ⑪⑫；⑤ 是否批准 C17 = PASS/CLOSED（此后按 ㉑ 实施 C21 HTTP，仍 filingSubmitted=false）。
