# CARRIER QUEUE #9B FINAL — PERSISTENCE + HTTP + ACTION GUARD INTEGRATION CHECKPOINT

状态：**READY_FOR_REVIEW**
前序：MSG-20261003-119 ⑯ 契约层 = PASS / CLOSED AS CONTRACT LAYER；⑰ Queue #9B overall = NOT CLOSED；⑱ 授权本批（Prisma + Postgres store + DB constraints + tenant isolation + Action Guard + HTTP route + real PG concurrency + full CI）。
IMPLEMENTATION_HEAD = 2be24ce（full 2be24ce2be24ce01e23c681bfc3eeb4df9d99ae4f7ae9d1）；CI = SUCCESS · RUN_ID = 37104403722
边界：**NO platform write · TRANSPORT=false · Payment = 0 · autopay = OFF · collection = OFF · R13 HOLD · 无生产凭据**。

## 1. Schema（㊲ 授权范围内）

- 新增 Prisma 模型 `CarrierManualSubmission`（migration `20261003020000_carrier_manual_submission`）：公共字段与 ⑲ 一致；**不存** credential / access token / raw claim payload / raw package payload / carrier secret。
- ⑳ `UNIQUE(organizationId, packageId)` 由数据库强制（并发收敛核心）；另有 `(organizationId, submittedAt)` / `(organizationId, trackingNumber)` 索引。
- ㉒ 租户：`cc_tenant_carriermanualsubmission`（BEFORE INSERT/UPDATE → `crossclaim_assert_tenant_integrity()`）+ `cc_tenant_immutable__CarrierManualSubmission`（归属不可变）；已登记 `tools/tenant-triggers/required-triggers.json`。
- ㉜ 不可变：`cc_append_only__CarrierManualSubmission`（BEFORE UPDATE OR DELETE 拒绝）；已登记 `tools/tenant-triggers/append-only-triggers.json`。
- 模型计数同步：architecture-contract 58（52 core + 6 join）；`DOMAIN_MODEL.md` / `README.md` 同步。
- ㉓ 未伪造 FK 到不存在的 package row：仅保存 packageId / bundleId / provider / account / tracking / rule versions 作为 immutable snapshot lineage（未扩大到完整 claim package persistence）。

## 2. PostgreSQL store（⑳㉚㉛）

- `createPrismaCarrierManualSubmissionStore(prisma)`：`find` 强制 organizationId；`create` 在同一事务内写入 row + **business audit**（复用既有 `prepareAuditInsert` + `tx.auditLog.create`），`handlesAuditAtomically = true` → service 不再单独 emit，消除「row 已建但 audit 永久缺失」窗口（㉚）。
- 唯一约束冲突（P2002）→ `created=false` → service 收敛为 `ALREADY_RECORDED`；`submissionRecordId` 改为确定性哈希（可作 audit entityId），逻辑幂等 identity 仍是 (organizationId, packageId)（㉑）。
- 真实 PostgreSQL 验收（`carrier-manual-submission-db`）：**两个独立连接并发只产生一行**、结果 = RECORDED + ALREADY_RECORDED、**audit 恰好一次**；append-only UPDATE/DELETE 被 DB 拒绝；租户/身份 server-derived；无网络（㉙㊱）。

## 3. Action Guard 与授权（㉗㉘）

- 注册动作 `carrier.manual_submission.record`：catalog（`INTERNAL_WRITE`, requires 空）+ `ACTION_SCOPE_MAP`（workflow kill switch）+ `GUARD_ENFORCED_ACTIONS`；不开启 TRANSPORT（不是 carrier external write）。
- 权限矩阵 `recordCarrierManualSubmission`：OWNER / ADMIN / OPS 允许；FINANCE / VIEWER / 未知角色拒绝（fail closed）。

## 4. HTTP route（㉔㉕㉖）

- `POST /carrier-claim-packages/:packageId/manual-submission` 已接入真实 router 与 `createServer` 路径门禁；client 只能提交 `carrierReference?` / `reportedCarrierSubmissionAt?` / `note?`，packageId 来自 route param（server 重新加载 package truth）。
- 稳定映射：400 `INVALID_REQUEST` / 403 `CAPABILITY_REQUIRED` / 404 `PACKAGE_NOT_FOUND`·`TENANT_MISMATCH`（anti-enumeration，不区分存在性）/ 409 `PACKAGE_NOT_READY` / 201 `RECORDED` / 200 `ALREADY_RECORDED`（幂等重放不视为错误）；错误体仅含稳定 code。
- API.md 已记录该路由（API contract 85 implemented / 72 documented = OK）。

## 5. 回归（㊱）

- `carrier-manual-submission-http-e2e-db` **6/6 真实 HTTP**：未认证 401；VIEWER 403（`CAPABILITY_REQUIRED`，零 row）；未知 package 404（零 row）；NEEDS_REVIEW 409（零 row）；READY + OWNER 201（DB row + `carrier.manual_submission_recorded` 审计恰好一次）；重复 POST 200 `ALREADY_RECORDED`（仍一行、审计仍一次）。
- 其余：carrier-manual-submission-http 9/9；carrier-manual-submission-db 10/10（含真实 PG 并发）；carrier-manual-submission 15/15；carrier-claim-package 17/17；carrier-recovery-estimate 23/23；carrier-sla-eligibility 35/35；carrier-evidence-bundle 21/21；carrier-invoice-pod-read 18/18；carrier-tracking-read 24/24；carrier-auth-account-discovery 41/41；carrier-connector-capability 8/8；action-guard-enforcement 7/7；architecture-contract 140/140；workflow 12/12。
- 回归合计 **386/386**；tsc api 0 error；tsc web 0 error；API contract `API_CONTRACT_OK`（85/72）；CI RUN = 37104403722（head 2be24ce）5 jobs 全绿。

## 6. 未做（边界）

不提交 carrier claim、不访问 portal、无 browser automation、不调用 carrier write API、不标记 MANUALLY_SUBMITTED、不产生 carrier confirmation（`carrierConfirmationStatus = NOT_VERIFIED`）、不改 RecoveryPayout/actualRecovered/Settlement cash truth、无 successFee、不改 Payment、无生产凭据。Schema 变更严格限于 Carrier Manual Submission persistence（㊲）。

## 7. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① Schema（UNIQUE(orgId, packageId) + tenant guard + append-only + 模型计数）是否符合 ⑲⑳㉒㉜；② Postgres store 同事务 row+audit 与真实并发验收是否符合 ㉙㉚㉛；③ Action Guard 注册 + 权限矩阵是否符合 ㉗㉘；④ HTTP route 与状态映射是否符合 ㉔㉕㉖；⑤ 是否批准 **CARRIER QUEUE #9B = PASS/CLOSED**；⑥ 下一内部单元（建议 Queue #10 Carrier Response / Status Read Model），以及是否按已登记方向放行 15% 商业模型（Queue C10–C11）与 Customs Recovery C1+。
