# SI-RSI-R4-WRITE-DOMAIN-MAP

> 授权：`PHASE3_A_U2_PRECONDITION_R4_READ_ONLY_EVIDENCE_CLOSURE`（R4-03 交付物；**只读**勘验 + 文档）。
> 基线：`7485f1bd`；审计依据 `MSG-20261009-49 = PASS WITH REVISE`；U1 封板 `9ee36837`。
> 映射目标：`WRITE_DOMAIN → ENTRY_POINT → SERVICE → TRANSACTION → DATABASE_OBJECT → FENCE_PROTECTION`。
> 说明：本表覆盖**仓库内可读到的写入路径**；**仓库外**（DBA 手工、外部脚本、复制、运维作业）一律标 `WAITING_ON_HOST_EVIDENCE`。

---

## 1. RSI / Autonomy 域（F-01 关注域）

| 写入域 | 入口（仓库证据） | 服务/模块 | 事务 | 数据库对象 | 现有保护（fence） |
| --- | --- | --- | --- | --- | --- |
| **任务领取（claim）** | `rsi-run` → `claimNextSafeTask()` | `apps/api/src/runtime/rsi-durable-task-source.ts:234-276` | **`$transaction`（同一事务：任务状态 + 租约）** | `AutonomyTask`（`updateMany` CAS：`status:'READY'→'IN_PROGRESS'`）、`AutonomyLease`（`upsert`：`ownerRef/acquiredAt/renewedAt/expiresAt/status='ACTIVE'`） | **已有**：`cas.count !== 1 ⇒ 已被其它 worker 领取`；注释写明「要么任务 IN_PROGRESS + 租约 ACTIVE 同时成立，要么整体回滚」 |
| **授权前置拒绝** | 同上（`authorizeOnClaim`） | 同上 `:231-239` | 单独 `updateMany`（非事务） | `AutonomyTask`（`status:'READY'→'BLOCKED'` + `lastErrorCode`） | **无 fence**：以状态为前置条件的 CAS |
| **到期租约回收（reclaimExpired）** | `rsi-run` 循环 | 同上 `:295-321` | **`$transaction`（两步 CAS）** | `AutonomyLease`（CAS：`ACTIVE + expiresAt<=now → EXPIRED`）、`AutonomyTask`（CAS：`IN_PROGRESS → READY`） | **已有**：两步均以状态/时间为前置条件，注释写明「幂等、并发安全、无需重启进程」 |
| **结果结算与租约释放（settle）** | `rsi-run` → `settle()` | 同上 `:328-392+` | **`$transaction`** | `AutonomyLease`（CAS：`status:'ACTIVE' AND ownerRef=:me AND expiresAt>now → 'RELEASED'`）、`AutonomyTask`（CAS：`IN_PROGRESS → PROMOTED/BLOCKED`） | **已有（C2 fencing）**：`LEASE_NOT_ACTIVE` / `FENCED_OWNER_MISMATCH` / `FENCED_LEASE_EXPIRED` / `FENCED_LEASE_RACE`；注释写明「旧 worker 被接管后提交会被拒绝，从而不会覆盖新 owner 的结果，也不会产生重复副作用」 |
| **终局事实门禁** | `settle()` 内 | 同上 `:346-376`（+ `recovery-terminal-evidence`） | 同一 `$transaction` | 只读 `AutonomyTask`（`dedupeKey/incidentId`） | 门禁（非 fence）：来源注册 + `verifiedBy` + 权威租户 + lineage 强绑定 |
| **U2 候选写入（计划中）** | **尚不存在** | 设计 §26–§29（R21/R20/R19…） | 设计：`$transaction` + `FENCE_CONTRACT` | `AutonomyCandidate`（`INSERT ... ON CONFLICT (dedupeKey) DO NOTHING`） | **`NOT_IMPLEMENTED`**：产品代码中**无任何** `AutonomyCandidate` 写入；`flock` 在仓库内**不存在** |
| **U2 意图记录（计划中）** | **尚不存在** | 设计 §27.4/§28 | 设计：事务外 + `fsync` | 文件系统（非数据库） | **`NOT_IMPLEMENTED`** |

**结论（本轮）**：RSI 域的现有保护是 **`AutonomyLease` 上的 CAS + 同一 `$transaction`**，其语义是
**「ownerRef + status + expiresAt + 受影响行数」**；**没有** `fenceGeneration` 之类的**单调版本号**。

---

## 2. 其他业务写入域（用于 E-02「全部潜在写入者」清点）

| 写入域 | 代表模块（仓库证据） | 主要数据库对象 | 现有保护 |
| --- | --- | --- | --- |
| Claims | `services/claims/claim-preparation.ts:193,210`、`claim-submission.ts:188` | `Claim`、`AuditLog` | 状态 CAS（`claim.updateMany`）+ 事务 |
| Claim items | `services/claim/claim-items.ts:271,427,628` | `ClaimItem`、`ClaimItemEvidence`、`AuditLog` | 状态 CAS + 事务 |
| Billing | `services/billing/invoice-issue.ts:233,255,291`、`billing-draft.ts:98,255` | `BillingInvoice`、`AuditLog` | 状态 CAS + 事务 |
| Appeals | `services/appeals/appeal-submission.ts:88,203,306` | `Appeal`、`AuditLog` | 状态 CAS + 事务 |
| Commercial / policy | `services/commercial/policy-acceptance.ts:134`、`recovery-qualification-store.ts:77` | `PolicyAcceptance`、`RecoveryQualificationAssessmentRecord` | 唯一约束/摘要 |
| Acquisition | `services/acquisition/prisma-ports.ts:31,38` | `SourceConnection` | 端口层封装 |
| Audit（横切） | `services/audit/prisma-sink.ts:14`、`runtime/recovery-domain-outcome-recorder.ts:123`、`recovery-verdict-settlement.ts:251,367`、`services/action-guard/runtime-guard-composition.ts:36` | `AuditLog` | 只 INSERT（约定） |
| **仓库外写入者** | 不可从仓库确认 | — | **`WAITING_ON_HOST_EVIDENCE`**（E-02/E-12） |

**事实**：①产品代码中**不存在**对 `AutonomyCandidate` 的写入（仅测试存在 `.create`）；
②**不存在**原始 SQL 写语句（`$executeRaw` / `INSERT INTO` / `UPDATE "` / `DELETE FROM`）于 `apps/api/src`；
③所有写入均通过 Prisma Client API，且 RSI 域内的关键路径使用 **CAS + `$transaction`**。

---

## 3. 保护入口映射（保护覆盖现状）

| 保护对象 | 现有保护入口 | 未覆盖/未实现的入口 |
| --- | --- | --- |
| RSI 任务状态（`AutonomyTask`） | claim / reclaimExpired / settle（3 处 CAS） | 任何仓库外 UPDATE |
| RSI 租约（`AutonomyLease`） | claim upsert / reclaim CAS / settle CAS | 任何仓库外 UPDATE/DELETE |
| RSI 候选（`AutonomyCandidate`） | **无** | **U2 计划中的写入（未实现）** |
| 证据类（`AutonomyMetricResult` 等） | 迁移中的 `cc_append_only__*` 触发器（INSERT only） | 特权角色停用触发器（E-12） |

```text
COVERAGE_STATUS:
  RSI_TASK_LEASE_ENTRYPOINTS = PRESENT（仓库内 3 条路径均带 CAS；仓库外未知）
  U2_CANDIDATE_ENTRYPOINTS   = NOT_IMPLEMENTED
  OUT_OF_REPO_WRITERS        = WAITING_ON_HOST_EVIDENCE
```

---

## 4. 边界与免责

本文档为**只读勘验结果**：未连接任何数据库、未执行任何查询、未验证目标环境实际生效状态。
下表一律 `WAITING_ON_HOST_EVIDENCE`：实例数量、实际运行 role、仓库外写入者、实际触发器状态、复制/切换语义、权限闭环。
