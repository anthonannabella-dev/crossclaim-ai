# R44 — Manual Recovery HTTP/API Boundary（Implementation Checkpoint）

> 依据：**MSG-20261001-39**（R43 CLOSED；NEXT = R44，范围仅入口边界）。
> 策略：HOST DIRECTIVE 2026-10-01《冻结底座 + 加速交付》→ **增量风险审计**（只交本轮新增/变化的边界与证据）。
> 送审 HEAD：`577202f`

---

## 1. 本轮新增边界（只有一项）

**人工追回提交的 HTTP 入口**（此前 S3/S4 只有服务层与 Action Guard，无对外入口）。

> 口径（MSG-20261001-40 ②）：R44 交付的是 **Manual Recovery Execution HTTP Boundary**，**不是**完整用户可用 E2E ——
> 公共 API 尚不能创建 `recovery.manual_submit` 所需 approval，该 gap 由独立批次 **R44-A — Manual Recovery Approval Creation Boundary** 承接；本文档与 API 描述不得写成「manual recovery API 已完整可用」。

入口清单：

| 路由 | 受保护动作 | 说明 |
| --- | --- | --- |
| `POST /cases/:caseId/recovery/manual-submit` | `recovery.manual_submit`（INTERNAL_WRITE + humanApproval） | 人工确认提交；服务端解析 package 与 versioned basis，复用 R43 S3 服务 |
| `POST /cases/:caseId/recovery/manual-reference` | `recovery.manual_submit_reference_recorded`（INTERNAL_WRITE + humanApproval） | 提交后补录 provider case reference；canonical 由服务端计算，复用 R43 S4 服务 |

入口层不变量（与 platform.write 入口同口径）：

1. 身份 / 租户来自会话与路径；请求体不得自述 `organizationId`；
2. 目标必须在会话租户 + 案件内 → 跨租户 / 错案件一律 **404**（不泄露存在性）；
3. `packageDigest / approvalBasisReference / basisReference / packageVersion / digestVersion / providerCaseRefCanonical / status / submittedAt` 等**服务端事实字段**出现在请求体 → **400**（禁止自证）；
4. 幂等键由服务端派生（`rms1-<claimItemId>`）；客户端声明不一致 → **409**；
5. Action Guard 未注入 → **403**（fail closed）；缺审批 → **409 ACTION_GUARD_HUMAN_APPROVAL_REQUIRED**；
6. 业务执行 100% 复用 R43 S3/S4 服务（锁内重验主体与审批、同事务原子提交 / append-only 补录）；
7. 响应恒为 `platformWriteExecuted=false`（提交 `externalSubmission='NEEDS_MANUAL'`、补录 `providerAccepted=false`）。

## 2. 未变化的边界（明确声明：无需重复审计）

- **Schema / migration / 触发器清单**：未改（无新增表/列/索引/触发器）。
- **租户隔离**：沿用既有 tenant trigger 与租户内定位；未引入新的隔离语义。
- **权限模型**：沿用 `claimTrackingApprove`（OWNER/ADMIN 执行、锁后实时角色重验）；未新增角色。
- **审批 / HITL 语义**：复用既有 `verifyApprovalBoundary`（动作 / 目标 / 载荷 / 五元 extra / 有效期 / 撤销 / 消费）；**未放宽**任何校验。
- **幂等 / 事务 / 并发**：沿用 S3 CAS + 唯一约束 + 行锁；入口层**不持有事务**。
- **资金 / 结算 / 扣费**：零接触（测试断言 Settlement / BillingInvoice 为 0）。
- **真实外部写**：未开启（transport / adapter / 生产凭据继续 HOLD）。

## 3. 证据（真实 HTTP + 真实 PostgreSQL）

`apps/api/src/__tests__/recovery-manual-http-db.test.ts` —— **10 个测试用例**：

| 用例 | 断言 |
| --- | --- |
| R44-01 | 未认证 → 401，ClaimItem 仍 `READY_TO_APPEAL`、submission=0 |
| R44-02 | 客户端自证 `packageDigest` → 400 `CLIENT_ASSERTION_REJECTED`，零推进 |
| R44-03 | 他案件 package（同租户）→ 404，零推进 |
| R44-04 | 缺审批 → 409 `ACTION_GUARD_HUMAN_APPROVAL_REQUIRED`，零推进 |
| R44-05 | 幂等键不一致 → 409 `RECOVERY_MANUAL_IDEMPOTENCY_KEY_MISMATCH`，零推进 |
| R44-06 | 合法提交 → 200 / `SUBMITTED_MANUAL` / submission=1 / `recovery.manual_submitted`=1 / `approval_consumed`=1 / Settlement=0 / Billing=0；响应回显的 versioned basis 与审批绑定一致 |
| R44-07 | 重复提交 → 403/409 且 submission 仍为 1（无第二次副作用） |
| R44-08 | 补录 reference → 200，`  CASE-44  ` → canonical `CASE-44`（服务端计算），`providerAccepted=false` |
| R44-09 | 空 reference → 400；客户端自证 canonical → 400；零副作用 |
| R44-10 | 静态探针：入口层源码不含 `$transaction` / `FOR UPDATE` / `updateMany` / `pg_advisory`，且确实复用 S3/S4 服务与两个唯一 basis builder（handler 未复制事务逻辑） |
| R44-11 | **CHANGE A** manual-submit：跨租户案件路径 → 404，且 ClaimItem / Submission·Reference / approval consumption / 资金域计数全部不变 |
| R44-12 | **CHANGE A** manual-submit：同租户但路径案件与 ClaimItem 不符 → 404 且零副作用 |
| R44-13 | **CHANGE A** manual-reference：跨租户 submissionId → 404 且零副作用 |
| R44-14 | **CHANGE A** manual-reference：同租户但路径案件与该 submission 不符 → 404 且零副作用（防 confused-deputy 对象绑定） |

回归（受影响家族）：`recovery-manual-*` **69/69 PASS**；`action-guard` 家族 **62/62 PASS**；`tsc --noEmit` PASS；`api-contract` OK；`prisma validate` valid（未改 Schema）。

## 4. Known remaining gaps（不掩盖）

1. **`recovery.manual_submit` 审批的创建入口尚未暴露**（= 独立批次 **R44-A — Manual Recovery Approval Creation Boundary**）：现有 `submitRecoveryReview` 明确拒绝该 `boundAction`（`INVALID_INPUT: 审批动作不受支持`）。R44 只暴露**执行入口**并复用既有 HITL 校验；"谁可以创建审批 / 绑定哪个 Claim·Case·package·basis / approval lifecycle / 与执行入口对接" 需单独批次 + 审计后再开。
2. outcome tracking / reimbursement reconciliation（R45）、Settlement / Billing linkage（R46）：各自独立批次。
3. HOLD 全线继续保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD · Production Enablement HOLD。

## 5. 风险分类（HOST DIRECTIVE §10）

```
FOUNDATION_REUSED    = R43 S1–S6 持久化底座（package/basis builder、S3 原子提交服务、S4 补录服务、Action Guard / HITL 校验、审计与租户触发器）、platform.write 入口的边界范式（服务端重算 + 客户端自证拒绝 + fail-closed）
NEW_RISK_BOUNDARY    = YES —— 新增两个对外 HTTP 入口（人工追回提交 / 补录），属于"安全边界 / 入口边界"变化
ARCH_REVIEW_REQUIRED = YES（增量）—— 仅就新增入口边界、请求契约、错误映射与零副作用证据送审；Schema / 租户 / 权限模型 / 审批语义 / 事务与并发语义均未变化，不重复送审
```

## 6. 请裁决

1. 两个新入口的**边界与请求契约**是否认可（禁止自证、404 不泄露、幂等键服务端派生、fail-closed）？
2. `Known remaining gaps #1`（审批创建入口另开批次）是否认可为该边界之外？
3. 是否可将 R44 视为**入口边界收口**，并授权下一执行单元？
