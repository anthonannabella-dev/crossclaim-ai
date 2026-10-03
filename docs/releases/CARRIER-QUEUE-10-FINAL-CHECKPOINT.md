# CARRIER QUEUE #10 FINAL — PERSISTENCE + ACTION GUARD + HTTP READ MODEL CHECKPOINT

状态：**READY_FOR_REVIEW**
前序：MSG-20261003-122 ⑤ 契约层 = PASS / CLOSED AS CONTRACT LAYER；⑥ overall = NOT CLOSED YET；⑦⑧ 授权 Queue #10 FINAL（PRISMA + POSTGRES + ACTION GUARD + HUMAN HTTP + READ MODEL）且 Schema Delta AUTHORIZED；㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝ 为具体约束。
IMPLEMENTATION_HEAD = dff7161（full dff71617363e7e5d657307fc740d92f913b1a52e）；CI = SUCCESS · RUN_ID = 37108323249
边界：**NO platform write · TRANSPORT=false · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · 无生产凭据**。

## 1. ⑳㉑㉒㉓㉔㉕ Schema Delta（migration `20261003040000_carrier_claim_response_fact`）

- Prisma 模型 `CarrierClaimResponseFact`：id / organizationId / packageId / submissionRecordId / provider / externalAccountId / trackingNumber / status / source / verificationLevel / providerReference? / observedAt / recordedAt / rawArtifactReference? / recordedByUserId / idempotencyKey / createdAt；**不存** recovered amount / success fee / payment truth / credential。
- DB CHECK 真值：`status` ∈ 8 态；`source` ∈ 5 态；`verificationLevel` ∈ 2 态；**`source = USER_REPORTED` → `verificationLevel = UNVERIFIED`（㉑ DB truth）**；显式冗余禁止 `(USER_REPORTED, PROVIDER_VERIFIED)` 组合（㉒）；provider 来源必须携带 `providerReference`。
- ㉓ append-only：`cc_append_only__CarrierClaimResponseFact`（BEFORE UPDATE OR DELETE 拒绝，状态变化必须新增 fact）。
- ㉔ tenant guard：沿用既有体系 `cc_tenant_carrierclaimresponsefact`（含 `submissionRecordId → CarrierManualSubmission` 跨表归属校验）+ `cc_tenant_immutable__CarrierClaimResponseFact`；未新造隔离机制。
- ㉕ DB 幂等：`UNIQUE(organizationId, packageId, idempotencyKey)` + 读模型索引 `(organizationId, packageId, observedAt)`。
- FK 为真实 lineage（organizationId / recordedByUserId / submissionRecordId），不伪造 package 外键。
- 两条清单同步：`required-triggers.json`（81 baseline）/ `append-only-triggers.json`（23）；模型计数 59（53 core + 6 join），README / DOMAIN_MODEL / architecture-contract 同步。

## 2. ㉖ Prisma store（append-only + 同事务审计）

- `createPrismaCarrierClaimResponseStore(prisma)`：只提供 `append` / `listByPackage`（**无** update / delete / upsert），`handlesAuditAtomically = true`。
- append 在同一事务内写 fact + business audit（复用 `prepareAuditInsert`）；重复 → P2002 → 按 `(org, package, idempotencyKey)` 回读 → `created=false`（service 映射 `ALREADY_RECORDED`），**不重复审计**。
- 真实 PostgreSQL 回归 `carrier-claim-response-db` **12/12**：未知枚举直写拒绝；`USER_REPORTED + PROVIDER_VERIFIED` 直写拒绝；provider 来源缺 reference 拒绝；append-only UPDATE / DELETE 拒绝；跨租户引用被租户触发器拒绝；tenant-scoped 读不串租户；**两个独立连接并发只产生一行 + 审计恰好一次**（RECORDED + ALREADY_RECORDED）；投影确定性（含乱序输入）；`APPROVED != PAID`；PAID 不产生 RecoveryPayout / FeeCalculation / Settlement（零行）；无网络。

## 3. ㉗㉘ Action Guard + RBAC

- 动作 `carrier.claim_response.record` 正式进入 catalog（`INTERNAL_WRITE`, `requires: []`）+ capability-source（`workflow` kill switch）+ `GUARD_ENFORCED_ACTIONS`；不启用 TRANSPORT。
- 权限矩阵 `recordCarrierClaimResponse`：OWNER / ADMIN / OPS = true；FINANCE / VIEWER / 未知 = false（fail closed）。
- capability 常量与 Action Guard action 字面量分离（`carrier.claim_package.claim_response.record` vs `carrier.claim_response.record`），沿用 #9B 命名约定。

## 4. ㉙㉛ HTTP 边界 + router 接线

- `POST /carrier-claim-packages/:packageId/responses`（人工补录）：**只允许 `source = USER_REPORTED`**；client body 出现 `source` / `verificationLevel` / 身份字段（organizationId / recordedByUserId / provider / externalAccountId / trackingNumber / idempotencyKey / factId）→ **400 `INVALID_REQUEST` + FIELD_NOT_ALLOWED:<field>**。
- `GET /carrier-claim-packages/:packageId/responses`（读模型）：返回 `currentStatus` / `currentVerificationLevel` / `currentFactId` / `history` / `factCount` / `hasProviderVerifiedFact`；tenant-scoped；**不返回** credential / raw provider secret。
- 状态映射：400 `INVALID_REQUEST`·`PROVIDER_REFERENCE_REQUIRED`·`INVALID_TIMESTAMP`·`FUTURE_TIMESTAMP`；403 `CAPABILITY_REQUIRED`；404 `SUBMISSION_NOT_FOUND`（anti-enumeration，未知与跨租户同形）；201 `RECORDED`；200 `ALREADY_RECORDED`（幂等重放非错误）。
- router 接线：`workflow/http-routes.ts` path 常量 + 路由集合守卫 + **方法闸门（GET/POST）** + server-derived session；`server.ts` 的 `WORKFLOW_PATH` 路径门禁加入 `/carrier-claim-packages/:id/(manual-submission|responses)`。
- server-side submission truth：新增 `carrier-claim-response-submissions.ts`，按 `(organizationId, packageId)` 读取 `CarrierManualSubmission`；不存在 → null → 404（不伪造 package）。缺省 store/submissions 均为真实 Prisma 实现。
- ㉚ 可信 provider ingestion（`recordTrustedCarrierResponse` 形态的独立内部 adapter）本批**未实现**：真实 provider API / webhook 属 `HOLD_EXTERNAL`，HTTP surface 不暴露 provider 来源选择权（㉙ 已强制）。

## 5. 真实 HTTP E2E 与回归

- `carrier-claim-response-http-e2e-db` **8/8**：未认证 401；VIEWER 403（零 fact）；未知 package 404（零 fact）；client 提交 provider source 400（零 fact）；OWNER 人工补录 201（DB row 恒 `USER_REPORTED` / `UNVERIFIED` + 审计恰好一次）；重复 POST 200 `ALREADY_RECORDED`（仍一行一审计）；GET 读模型 200（history 2 条 + `derivesRecoveredCash=false`，响应不含 credential / successFee / actualRecovered）；GET 404 + 未认证 401。
- 契约层 `carrier-claim-response` 23/23；HTTP 单测 `carrier-claim-response-http` 11/11；DB 12/12。
- 回归（carrier 全家族 + action-guard + architecture-contract + workflow + C15 契约层）**21 files / 468 tests PASS**；tsc api 0 error；tsc web 0 error；API contract `API_CONTRACT_OK`（implemented=86 / documented=73）。
- CI RUN = 37108323249（head dff7161）5 jobs 全绿。

## 6. ㉜ 投影语义（未擅自加隐藏优先级）

projection 仍只按 `(observedAt, recordedAt, factId)` 取最新事实，**没有**引入“provider verified 覆盖较新 user-reported”之类隐藏优先级；若未来需要 provider-truth precedence，须独立设计/version。

## 7. 边界

不提交 carrier claim、不访问 portal、无 browser automation、不调用 carrier write API、不产生 carrier confirmation、不改 recovered cash（RecoveryPayout / actualRecovered / Settlement）、无 successFee、无 payment collection、不改 Payment、无生产凭据；Schema 变更严格限于 `CarrierClaimResponseFact`。

## 8. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① ⑳–㉖ Schema / DB 真值 / append-only / tenant guard / DB 幂等 / 同事务审计是否符合；② ㉗㉘ Action Guard + 角色矩阵是否符合；③ ㉙㉛ HTTP（人工入口只产生 USER_REPORTED；读模型 tenant-scoped）是否符合；④ ㉜ 投影未引入隐藏优先级是否符合；⑤ 是否批准 **CARRIER QUEUE #10 FINAL = PASS/CLOSED**（即 CARRIER QUEUE #10 overall CLOSED）；⑥ 下一批优先级：**Commercial C10–C11（15% versioned fee model）** 与 **Customs Recovery C1+ / C15–C21 契约层** 并行推进是否确认（真实 filing / payment / credentials 继续冻结）。
