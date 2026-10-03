# CARRIER QUEUE #9B — MANUAL SUBMISSION RECORD + HUMAN ATTESTATION CHECKPOINT

状态：**READY_FOR_REVIEW**（**契约层**：纯服务 + 注入端口；无 Schema / DB / HTTP 绑定）
前序：MSG-20261003-118 ⑱ CARRIER QUEUE #9A = PASS / CLOSED；⑲–㊴ 授权并约束本单元。
IMPLEMENTATION_HEAD = f66c29d（full f66c29de09ecde079693055d9967cdadc8eaf848）；CI = SUCCESS · RUN_ID = 37097439551
边界：**NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 核心区分（⑳）

- 本单元**不提交 carrier claim**；只记录「用户声称自己已完成人工提交」这一事实。
- 只能形成 human attestation：`carrierConfirmationStatus = NOT_VERIFIED`；不产生 CARRIER_CONFIRMED / ACCEPTED / APPROVED / RECOVERED，也不产生 providerAccepted / providerConfirmed / claimApproved / refundApproved。

## 2. 交付：`recordCarrierManualSubmission(input, deps)`

- 输入：`{ packageId, request: CarrierManualSubmissionRequest, context: CarrierManualSubmissionContext }`。
- `CarrierManualSubmissionRequest` **只允许** `carrierReference?` / `reportedCarrierSubmissionAt?` / `note?`（client 无法注入身份或 package 事实）。
- `CarrierManualSubmissionContext`（`organizationId` / `actorUserId` / `actorCapabilities`）必须由调用方从**已认证会话**派生。
- 端口：`CarrierClaimPackageSource.load(organizationId, packageId)`（server-side package truth）、`CarrierManualSubmissionStore.find/create`（create 对 (organizationId, packageId) 原子）、`CarrierManualSubmissionAuditSink.emit`、`now`。
- 输出：`{ ok: true, status: RECORDED | ALREADY_RECORDED, record }` 或 `{ ok: false, reason: INVALID_REQUEST | CAPABILITY_REQUIRED | PACKAGE_NOT_FOUND | TENANT_MISMATCH | PACKAGE_NOT_READY }`。

## 3. record 结构（㉒㉓㉔㉘㉙）

`CarrierManualSubmissionRecord { submissionRecordId（deterministic：carrier-manual-submission|<org>|<packageId>）, packageId, bundleId, organizationId, provider, externalAccountId, trackingNumber, submittedByUserId（server-derived）, submittedAt（server timestamp）, recordedAt, submissionMode: MANUAL, channel（取自 package destination）, humanAttestation { submitted: true, carrierReference, carrierReferenceProvenance: USER_PROVIDED_UNVERIFIED|null, reportedCarrierSubmissionAt, note }, carrierConfirmationStatus: NOT_VERIFIED, packageSnapshotReference, eligibilityRuleSetId·Version, estimateRuleSetId·Version, humanRecorded: true, carrierWritePerformed: false, transportEnabled: false, platformWriteEnabled: false, productionCredentials: ABSENT }`。

- 能力校验：要求 capability `carrier.claim_package.manual_submission.record`（走既有 RBAC / Action Guard 模式）；VIEWER 等无该 capability → `CAPABILITY_REQUIRED`。
- `submittedAt` 用 server 时间；用户补录的过去提交时间只作为 `reportedCarrierSubmissionAt` 声明值（与 `recordedAt` 区分）。

## 4. 闸门 / 幂等 / 并发（㉑㉖㉚㉛㊲）

- 只有 `packageStatus = READY_FOR_MANUAL_SUBMISSION` + `packageCompleteness = COMPLETE` + `manualSubmissionRequired = true` + `claimSubmissionPerformed = false` 才允许记录；NEEDS_REVIEW → `PACKAGE_NOT_READY`。
- package 事实（provider / account / tracking / rule versions）来自 server-side package truth；`pkg.organizationId !== context.organizationId` → `TENANT_MISMATCH`；不存在 → `PACKAGE_NOT_FOUND`。
- 幂等：已存在 record → `ALREADY_RECORDED`（不产生第二条 submitted fact、不重复审计）；`store.create` 返回 `created=false`（并发竞争）同样收敛为 `ALREADY_RECORDED` 并返回既有 record。
- 核心事实创建后不可变；本文件不提供覆盖写（更正走 amendment / audit event，属后续单元）。

## 5. 审计（㉜）

- 事件：`carrier.manual_submission_recorded`（**不**使用 CLAIM_SUBMITTED_CONFIRMED）。
- 字段：event / organizationId / actorUserId / packageId / submissionRecordId / trackingNumber / recordedAt / result；不含 credential 或 raw claim payload；仅在真实创建时发出（恰好一次）。

## 6. 边界（㉞㉟）

- 不修改 RecoveryPayout / actualRecovered / Settlement recovered cash truth；不产生 successFee（submission ≠ recovery）。
- `carrierWritePerformed = false` / `transportEnabled = false` / `platformWriteEnabled = false`；不调用 UPS / FedEx API、不访问 portal、不做 browser automation。
- 纯契约层：无网络调用。

## 7. 回归（㊳）

`carrier-manual-submission` **15/15**：READY + authorized → RECORDED（human attestation 字段齐全、审计 1 条）；NEEDS_REVIEW（PARTIAL）→ PACKAGE_NOT_READY；package 不存在 → PACKAGE_NOT_FOUND；cross-tenant → TENANT_MISMATCH；VIEWER → CAPABILITY_REQUIRED；client 注入 organizationId·submittedByUserId·trackingNumber 被忽略（server-derived 生效，序列化中不含 evil）；submittedAt = server 时间且与 reportedCarrierSubmissionAt 分离；carrierReference 标 USER_PROVIDED_UNVERIFIED 且 confirmation NOT_VERIFIED；重复调用幂等（createCalls=1、audit=1）；并发调用最多一条 record（RECORDED + ALREADY_RECORDED，audit=1）；核心 lineage 与 rule versions 保留；审计事件结构正确且不含 credential；无 carrier write / 无 recovered-money 字段；submissionRecordId deterministic；空 packageId·org·actor → INVALID_REQUEST；无网络。

合计：manual-submission 15 + claim-package 17 + recovery-estimate 23 + sla-eligibility 35 + evidence-bundle 21 + invoice-pod 18 + tracking 24 + carrier-auth-account-discovery 41 + connector 8 + provider-readiness DB 1 = **203/203**；tsc api 0 error；tsc web 0 error；API contract = `API_CONTRACT_OK`（implemented=84 / documented=71，未新增路由）；CI RUN = 37097439551（head f66c29d）5 jobs 全绿。

## 8. 本批**未**包含（明确待审）

- **未**新增 Prisma 模型 / 迁移 / 索引 / tenant 触发器（`CarrierManualSubmissionRecord` 目前只是类型契约）。
- **未**新增 HTTP 路由（㊱ 建议的 `POST /carrier-claim-packages/:packageId/manual-submission` 属 Schema + Action Guard + 路由接线，须先经 Schema Delta 审核）。
- **未**接入 Action Guard capability 注册（capability 字符串已定义，接线属同一批 Schema/路由工作）。
- 说明：按项目既有规则，Schema 变更需架构方审核；本批先交付可独立验收的契约层与回归。

## 9. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① human attestation 与 carrier-confirmed 的区分（⑳㉗㉝）是否符合；② READY 闸门 + server-derived 身份 + package 绑定（㉑㉓㉕㉖）是否符合；③ 幂等 / 并发 / 不可变核心事实（㉚㉛㊲）是否符合；④ 审计事件与字段（㉜）是否符合；⑤ 无 carrier write / 无 recovered-money 污染（㉞㉟）是否符合；⑥ 是否批准 CARRIER QUEUE #9B 契约层 = PASS/CLOSED 并授权 **Schema Delta + HTTP 布线批次**（Prisma 模型/迁移/tenant guard + `POST /carrier-claim-packages/:packageId/manual-submission` + Action Guard capability 注册 + 真实 PostgreSQL 并发验收）。
