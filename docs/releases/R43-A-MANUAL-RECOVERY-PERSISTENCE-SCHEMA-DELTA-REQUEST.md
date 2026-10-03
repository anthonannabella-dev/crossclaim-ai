# R43-A — MANUAL RECOVERY PERSISTENCE — SCHEMA DELTA REQUEST

> 类型：**Schema Delta Request（仅请求批准；不含 migration、不含实现、不含 HTTP 入口）**
> PREVIOUS: **MSG-20261001-31 = PASS WITH REVISE**（四表批准；CHANGE A/B/C 已收口，见 §10）。原始送审依据：MSG-20261001-30 = PASS WITH REVISE（R43 Manual Recovery Handoff Design 方向批准；CHANGE A–D；NEXT = R43-A）
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01 · ROUND: **R43-A**
> 边界（冻结）：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · `PLATFORM_WRITE_TRANSPORT_ENABLED=false` · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD

---

## 0. 请求摘要

R43 Design（MSG-20261001-30）已批准人工提交闭环的方向，但**人工提交事实的持久化边界尚未获批**。本请求只申请批准新增持久化对象与约束：

| # | 新增对象 | 承载的事实 | 为什么必须持久化 |
| --- | --- | --- | --- |
| 1 | `RecoveryPackage` | 材料包身份（版本 + digest） | 审批与提交都要绑定同一个「服务端生成」的包，不能只靠客户端传来的 digest |
| 2 | `RecoveryPackageArtifact` | 导出产物（PDF / JSON manifest） | 导出是一次真实动作，需要可追溯；产物文件复用既有 `FileAsset` |
| 3 | `RecoveryManualSubmission` | ② **用户已提交**（业务事实） | 不能由 AuditLog 推导；需承载 `providerCaseRef / submittedAt / submittedBy` 与审批绑定 |
| 4 | `RecoveryManualSubmissionEvidence` | 提交时附带的证据引用 | 只引用既有 `EvidenceArtifact`，不复制证据仓库 |

**与 MSG-20261001-30 的逐项映射：**

| 裁决要求 | 本请求落点 |
| --- | --- |
| **CHANGE A**：`SUBMITTED_MANUAL` 走既有 `ClaimItem` 状态机；AuditLog 仅 append-only 证据 | §1、§2.2、§2.5（业务真值 = `ClaimItem.status` + submission record；AuditLog 永不作为状态真相源） |
| **CHANGE B**：动作名 `recovery.manual_submit`；审批绑定 `claimItemId + caseId + packageDigest`；原子消费；至多一次 | §3（含已获批动作名的注册落点与锁内重验顺序） |
| **CHANGE C**：第一版导出 = PDF + JSON manifest；artifact 默认 24 个月；时间桶不作提交链幂等依据 | §2.1、§2.6、§4 |
| **CHANGE D**：Reconciliation 与资金域继续分离 | §5（边界冻结，本轮不新增任何资金侧对象） |

本请求**只申请 Schema 变更批准**；获批后才另起一次提交实施迁移与代码接线，且仍不开启 transport、不接真实凭据。

---

## 1. 四事实与持久化载体（不可合并）

| 事实 | 载体（获批后） | 变化 |
| --- | --- | --- |
| ① 系统已生成提交材料 | `RecoveryPackage` + `RecoveryPackageArtifact` + 审计事件 `recovery.package_generated` / `recovery.package_exported` | **新增表** |
| ② 用户已提交 | `RecoveryManualSubmission` + `ClaimItem.status = SUBMITTED_MANUAL` + 审计事件 `recovery.submitted_manual` | **新增表** + 既有枚举（`ClaimItemStatus.SUBMITTED_MANUAL` 已存在） |
| ③ provider 已受理 | `RecoveryManualSubmission.providerCaseRef`（人工登记）或只读数据关联 | **新增字段** |
| ④ provider 已赔付 | 只读 reimbursement 事实 + `recovery.reimbursement_observed` / `recovery.reconciled` | 不新增表（留待后续 Reconciliation 批次） |

**硬规则复述**：① ≠ ② ≠ ③ ≠ ④。任何一步不得由前一步推导；`RecoveryPackage` 的状态词表中**不存在**任何形式的「已提交 / 已受理 / 已赔付」取值。

---

## 2. 八项持久化边界（逐项）

### 2.1 ① package artifact / manifest 如何保存

**`RecoveryPackage`**（材料包身份，逻辑对象）：

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | 否 | 主键 |
| `organizationId` | `String` | 否 | FK → Organization（Cascade）；租户隔离基准 |
| `claimItemId` | `String` | 否 | FK → ClaimItem（Cascade）；业务锚点 |
| `caseId` | `String?` | 是 | 冗余绑定（与 ClaimItem.caseId 一致；服务层校验，弱引用） |
| `packageVersion` | `String` | 否 | 内容结构版本，本轮恒为 `recovery-package/v1` |
| `digestVersion` | `String` | 否 | digest 算法版本，本轮恒为 `v1`（与 `fingerprintVersion` 同纪律） |
| `packageDigest` | `String` | 否 | 64 hex；见 §2.6 |
| `status` | `RecoveryPackageStatus @default(GENERATED)` | 否 | 仅 `GENERATED` / `EXPORTED` / `SUPERSEDED` / `WITHDRAWN` |
| `completenessSnapshot` | `Json?` | 是 | required/optional/missing 投影（白名单字段；无原始客户/凭据内容） |
| `generatedByUserId` | `String?` | 是 | 生成者（非 FK，与既有 actor 口径一致） |
| `generatedAt` | `DateTime @default(now())` | 否 | |
| `supersededByPackageId` | `String?` | 是 | 弱引用；新 digest 取代旧包 |
| `createdAt` / `updatedAt` | `DateTime` | 否 | |

**`RecoveryPackageArtifact`**（导出产物）：

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | 否 | |
| `organizationId` | `String` | 否 | FK → Organization（Cascade） |
| `packageId` | `String` | 否 | FK → RecoveryPackage（Cascade） |
| `artifactKind` | `RecoveryPackageArtifactKind` | 否 | `PDF` / `JSON_MANIFEST` |
| `fileAssetId` | `String` | 否 | FK → **既有 `FileAsset`**（不新建存储层） |
| `sha256` | `String` | 否 | 必须与 `FileAsset.sha256` 一致（服务层校验） |
| `exportedByUserId` | `String?` | 是 | 非 FK |
| `exportedAt` | `DateTime @default(now())` | 否 | |
| `createdAt` | `DateTime @default(now())` | 否 | |

**保存纪律**：

- 文件本体只存 `FileAsset`（既有 storageKey/sha256/kind 语义）；本表只保存**引用 + 身份**。
- JSON manifest 是**可再生**内容：其中包含字段、证据引用（`evidenceId` 列表）、`packageVersion`、`packageDigest`、Claim/Case 绑定、生成时间、导出者；**不含** credential / token / 客户敏感原文。
- 重复导出同内容 → 不新增第二份 artifact 身份（见 §2.7 幂等表）；可产生多条 `package_exported` 审计。

### 2.2 ② manual submission fact 如何保存

**`RecoveryManualSubmission`**（业务事实，非审计日志）：

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | 否 | |
| `organizationId` | `String` | 否 | FK → Organization（Cascade） |
| `claimItemId` | `String` | 否 | FK → ClaimItem（Cascade） |
| `caseId` | `String` | 否 | 与 ClaimItem.caseId 一致；跨案件绑定一律拒绝 |
| `packageId` | `String` | 否 | FK → RecoveryPackage |
| `packageDigest` | `String` | 否 | 必须等于 `RecoveryPackage.packageDigest`（同事务校验） |
| `approvalId` | `String?` | 是 | 审批事件 id（`recovery.review_approved`.id）；**非 FK**（与 PlatformWriteAttempt 同口径） |
| `approvalBasisReference` | `String` | 否 | 审批绑定串（§3.2） |
| `providerCaseRef` | `String?` | 是 | 平台侧受理引用（人工登记；允许为空，见开放问题 4） |
| `submittedAt` | `DateTime` | 否 | 人类确认的时间（服务端时钟） |
| `submittedByUserId` | `String` | 否 | 执行人工确认的用户（非 FK；执行时必须是当前 ACTIVE member） |
| `idempotencyKey` | `String` | 否 | `rms1-<claimItemId>`；见 §2.7 |
| `note` | `String?` | 是 | 限长短句；禁 payload / token / secret |
| `createdAt` | `DateTime @default(now())` | 否 | |

**关键纪律**：本表只承载「人已经提交」这一事实及其绑定，**不承载金额与赔付语义**（赔付属只读对账，§5）。

### 2.3 ③ `providerCaseRef` / `submittedAt` / `submittedBy` 的归属

| 字段 | 归属 | 明确不放在哪里 |
| --- | --- | --- |
| `providerCaseRef` | `RecoveryManualSubmission` | 不写入 `ClaimItem`（避免把人工提交语义污染通用 claim 模型）；不作为 `AuditLog.changes` 的真相源 |
| `submittedAt` | `RecoveryManualSubmission` | 不复用 `ClaimItem.updatedAt`（更新 ≠ 提交） |
| `submittedByUserId` | `RecoveryManualSubmission` | 不依赖 `AuditLog.actorUserId` 反查（审计是证据，不是业务字段） |
| 提交证据引用 | `RecoveryManualSubmissionEvidence`（§2.4） | 不复制证据元数据 |
| 「已提交」这一**状态** | `ClaimItem.status = SUBMITTED_MANUAL` | 不由 `RecoveryManualSubmission` 单独表达（两处必须同事务一致） |

### 2.4 ④ submission evidence 如何引用既有 `EvidenceArtifact`

**`RecoveryManualSubmissionEvidence`**（联结表）：

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `organizationId` | `String` | 否 | FK → Organization（Cascade） |
| `submissionId` | `String` | 否 | FK → RecoveryManualSubmission（Cascade） |
| `evidenceId` | `String` | 否 | FK → **既有 `EvidenceArtifact`**（Cascade） |
| `note` | `String?` | 是 | 限长短句 |
| `createdAt` | `DateTime @default(now())` | 否 | |

- 唯一约束：`@@unique([organizationId, submissionId, evidenceId])`。
- 证据本体（文件、外部 URL、可信度、`capturedAt`）**只有一份**，在 `EvidenceArtifact` / `FileAsset`；本表不复制任何证据字段。
- 同一证据可同时挂 `ClaimItemEvidence`（对账依据）与 `RecoveryManualSubmissionEvidence`（提交凭据），二者语义不同，不合并。

### 2.5 ⑤ `ClaimItem.SUBMITTED_MANUAL` 与 submission record 的一致性不变量

**状态跃迁（服务层唯一路径）**：

```text
READY_TO_APPEAL ──(recovery.manual_submit：审批消费 + 人工确认，同事务)──▶ SUBMITTED_MANUAL
SUBMITTED_MANUAL ──(结果事实，R43 阶段仅登记)──▶ RECOVERED | CLOSED(closedReason)
```

| # | 不变量 | 强制方式 |
| --- | --- | --- |
| I1 | `status = SUBMITTED_MANUAL` ⇒ 存在同租户、同 `claimItemId` 的 `RecoveryManualSubmission` | 唯一写入路径（同事务）+ 回归断言 |
| I2 | 存在 `RecoveryManualSubmission` ⇒ `status ∈ {SUBMITTED_MANUAL, RECOVERED, CLOSED}` | 同上（不允许回退到更早状态） |
| I3 | `submission.packageDigest = package.packageDigest = 审批绑定的 packageDigest` | 同事务三重校验 |
| I4 | 无 submission record ⇒ 永不出现 `SUBMITTED_MANUAL` | 无第二写入入口（HTTP 入口只经服务层） |
| I5 | 状态跃迁 + submission 落库 + 审计写入 + 审批消费 **同一事务**；任一步失败 → 全部回滚 | 与 `claim.submit` 同事务协议 |
| I6 | 同一 ClaimItem 至多一条逻辑提交链 | `@@unique([organizationId, claimItemId])`（§2.7） |

> 源状态（`READY_TO_APPEAL` 是否为唯一前置状态）列在开放问题 1，请架构方确认后再实现。

### 2.6 ⑥ package digest / version

- `packageVersion = recovery-package/v1`：内容结构版本（字段集合变化 → 升版本）。
- `digestVersion = v1`：digest 算法版本，**显式落库**（与 `ClaimItem.fingerprintVersion` 同纪律，便于历史可比）。
- `packageDigest = sha256(canonicalJson(manifest))`，规范化规则：
  1. 字段白名单 + 字典序排序；
  2. 金额一律字符串化（4 位小数）、币种为大写 ISO-4217；
  3. 时间一律 UTC ISO-8601 毫秒；
  4. 证据按 `evidenceId` 字典序排序，仅含 `evidenceId / evidenceType / capturedAt`；
  5. **不含**文件正文、凭据、token、客户原文。
- 相同输入 → 相同 digest（不产生第二份逻辑包）；内容变化 → 新 digest + 新 package（旧包置 `SUPERSEDED`，**不原地改写**）。
- 审批绑定使用服务端派生的复合串：`rmp1:<claimItemId>:<caseId>:<packageDigest>`（§3.2），避免仅用裸 digest 丢失 Claim/Case 关联语义。

### 2.7 ⑦ tenant triggers / unique constraints / idempotency

**租户保护触发器**（`tools/tenant-triggers/required-triggers.json` 必须同步，否则 CI 红）：

| 新表 | 必需触发器 |
| --- | --- |
| `RecoveryPackage` | `cc_tenant_recoverypackage`、`cc_tenant_recoverypackage_claimitemid`、`cc_tenant_immutable__RecoveryPackage` |
| `RecoveryPackageArtifact` | `cc_tenant_recoverypackageartifact`、`cc_tenant_recoverypackageartifact_packageid`、`cc_tenant_recoverypackageartifact_fileassetid`、`cc_tenant_immutable__RecoveryPackageArtifact` |
| `RecoveryManualSubmission` | `cc_tenant_recoverymanualsubmission`、`cc_tenant_recoverymanualsubmission_claimitemid`、`cc_tenant_immutable__RecoveryManualSubmission` |
| `RecoveryManualSubmissionEvidence` | `cc_tenant_recoverymanualsubmissionevidence_submissionid`、`cc_tenant_recoverymanualsubmissionevidence_evidenceid`、`cc_tenant_immutable__RecoveryManualSubmissionEvidence` |

> 规则来源：`tools/tenant-triggers/emit-check-sql.mjs` 第 3 条要求**每张含 `organizationId` 的表**都有 `cc_tenant_immutable__<表>`（BEFORE UPDATE，tgtype 19）；第 2 条要求运行库不得出现清单外启用触发器 → 迁移与清单必须同批提交。最终触发器名以实现批次取证为准。

**唯一约束与索引（请求批准项）**：

| # | 约束 | 目的 |
| --- | --- | --- |
| C1 | `RecoveryPackage @@unique([organizationId, claimItemId, packageVersion, packageDigest])` | 「同一输入的包只有一份」 |
| C2 | `RecoveryPackage @@unique([organizationId, id])` + `@@index([organizationId, claimItemId, status])` | 既有租户复合唯一口径 + 按 Claim 回看 |
| C3 | `RecoveryPackageArtifact @@unique([organizationId, packageId, artifactKind, sha256])` | 同内容重复导出不新增第二份 artifact |
| C4 | `RecoveryPackageArtifact @@unique([organizationId, id])` + `@@index([organizationId, packageId, exportedAt])` | 导出台账回看 |
| C5 | `RecoveryManualSubmission @@unique([organizationId, claimItemId])` | v1 单链：一个 ClaimItem 至多一条提交事实 |
| C6 | `RecoveryManualSubmission @@unique([organizationId, idempotencyKey])` | 重复确认 = 同一事实 |
| C7 | Postgres partial unique index：`(organizationId, providerCaseRef) WHERE providerCaseRef IS NOT NULL` | 同一租户同一 provider case 只登记一次（需迁移内 raw SQL） |
| C8 | `RecoveryManualSubmissionEvidence @@unique([organizationId, submissionId, evidenceId])` | 证据引用去重 |

**幂等键汇总**：

| 操作 | 幂等键 | 重复调用的结果 |
| --- | --- | --- |
| 生成材料包 | `(claimItemId, packageVersion, packageDigest)` | 返回同一 package；不新增、不改变已有包 |
| 导出 | `(packageId, artifactKind, sha256)` | 同内容不新增 artifact；**可**产生多条 `package_exported` 审计 |
| 人工确认提交 | `(organizationId, claimItemId)` + `idempotencyKey` | 至多一次成功；重复确认返回既有事实，不重复消费审批、不产生第二条 chain |
| 审批失效 | 不适用（包变化即失效） | `packageDigest` 变化 → 旧审批 `APPROVAL_PAYLOAD_MISMATCH` |

**明确否定**：时间桶（时间窗口）**不得**作为人工提交链的核心幂等依据；时间桶只允许用于导出审计的去噪（CHANGE C）。

### 2.8 ⑧ retention

| 对象 | 默认保留 | 说明 |
| --- | --- | --- |
| package artifact（PDF / JSON manifest 文件） | **24 个月** | 与 recovery audit horizon 对齐；组织策略更严格时**取更严格者** |
| package 元数据（`RecoveryPackage` 行） | 不早于 artifact 清理 | 保留 digest/version 以支撑历史可复核 |
| `RecoveryManualSubmission` 业务事实 | 与 Claim/Case 保留期一致（至少 24 个月） | 不得早于其审计证据删除 |
| 提交证据引用 | 随 `EvidenceArtifact` / `FileAsset` 既有策略 | 不新增第二套证据保留策略 |

- 到期清理只针对文件本体；**保留** digest / manifest 元数据行与提交事实行。
- 本轮不实现任何删除 API（无硬删除入口）。

---

## 3. 新受保护动作 `recovery.manual_submit`（CHANGE B；本轮不注册）

### 3.1 注册落点（实现批次修改；本轮仅登记）

| 文件 | 变更 |
| --- | --- |
| `apps/api/src/services/action-guard/action-guard.ts` | 注册 `'recovery.manual_submit'`（风险级别与 requires 见开放问题 2） |
| `apps/api/src/services/action-guard/approval-verifier.ts` | 新增单一来源常量 `RECOVERY_MANUAL_SUBMIT_ACTION`（与 `CLAIM_SUBMIT_ACTION` / `APPEAL_SUBMIT_ACTION` 并列，互不通用） |
| `apps/api/src/services/action-guard/capability-source.ts` | `'recovery.manual_submit': ['submission']` |
| `apps/api/src/services/action-guard/guard-enforcement.ts` | 纳入受保护动作清单 |

### 3.2 审批绑定（复合，不得只用裸 digest）

- 审批事件复用既有 `recovery.review_approved` 事件族（与 `claim.submit` / `appeal.submit` / `platform.write` 同构）。
- `boundPayload`：`{ amount: null, currency: null, basisReference: 'rmp1:<claimItemId>:<caseId>:<packageDigest>', evidenceArtifactId: null, fingerprintVersion: 'v1' }`。
- 复合绑定通过既有 `verifyApprovalBoundary(...).extra` 逐项比对实现（`approval-tx-verify.ts` 已支持 extra 指纹键）：`extra = { claimItemId, caseId, packageDigest }`。
- 结果：三键任一不匹配 → `APPROVAL_PAYLOAD_MISMATCH`；package 在批准后变化 → digest 不匹配 → 旧审批失效（无需额外状态）。

### 3.3 执行（锁内）重验顺序

1. 案件锁 `cc-recovery-case:${caseId}`（与 `claim.submit` / `submitRecoveryReview` 同协议）；
2. `ClaimItem` 行锁（`FOR UPDATE`）并确认租户 + 案件绑定 + 当前状态；
3. 从数据库读**当前** `Membership`（`isActive = true`）重验执行者角色/成员状态（禁止复用锁前结论与审批时角色）；
4. `verifyApprovalBoundary`（动作 / 目标 / 三键载荷 / 版本 / 有效期 / 撤销 / 消费）；
5. CAS 跃迁 `ClaimItem.status → SUBMITTED_MANUAL` + 写 `RecoveryManualSubmission`（含 evidence 引用）+ 写审计 `recovery.submitted_manual` + 消费审批 `recovery.approval_consumed`——**同一事务客户端**。

### 3.4 权限与并发要求（逐条对应 CHANGE B）

| 要求 | 落点 |
| --- | --- |
| 批准人 OWNER / ADMIN | Action Guard 审批校验（既有角色矩阵） |
| 执行者必须是**当前** ACTIVE member，且执行时重验 | §3.3 第 3 步（锁内读库） |
| 审批绑定 `claimItemId + caseId + packageDigest` | §3.2 |
| package 变化 → 旧审批失效 | §3.2（digest 参与比对） |
| 消费与成功确认原子 | §3.3 第 5 步（同事务） |
| 重复确认至多一次成功、不重复消费、不产生第二条 chain | C5/C6 + CAS + `APPROVAL_ALREADY_CONSUMED` |
| 拒绝留痕 | `recovery.manual_submit_rejected`（事务回滚后写入；写入失败不得覆盖原始拒绝，与 `claim.submit` 同口径） |

---

## 4. CHANGE C：export 形态与幂等边界

| 项 | 决定 |
| --- | --- |
| 第一版导出形态 | **PDF**（人读/提交）+ **machine-readable JSON manifest**（机器可校验） |
| manifest 必含 | 字段、证据引用列表、`packageVersion`、`packageDigest`、Claim/Case 绑定、生成时间、导出者 |
| 禁止 | credential / token / secret / 客户敏感原文 |
| 事实边界 | export / copy / instructions **不产生「已提交」事实**；`RecoveryPackage.status` 最多到 `EXPORTED` |
| 幂等 | artifact 身份按 `(packageId, artifactKind, sha256)`；重复下载可产生多条 export 审计，但**不得**产生多个 recovery submission |
| 保留期 | 见 §2.8（默认 24 个月，取更严格者） |

---

## 5. CHANGE D：Reconciliation 与资金域继续分离（边界冻结）

- R43 / R43-A **只**定义与承载：`reimbursement observed → matched | unmatched | ambiguous` 这一**只读**结论。
- **不得**：创建/修改 `Settlement`、生成 `BillingInvoice`、收取成功费、修改 `RecoveryLedgerEntry`、把 observed 自动解释为「已结算」。
- 本请求**不新增任何资金侧表/字段/枚举**；金额、币种、部分赔付、多笔赔付、重复 reimbursement、charge reversal 等留待后续单独提交 **Recovery Reconciliation → Settlement Boundary Design**。

---

## 6. 明确不包含（本轮不做）

- 不写 migration、不改任何既有表/列、不新增既有模型的字段；
- 不注册 `recovery.manual_submit`、不新增 HTTP 入口、不实现 PDF/manifest 生成；
- 不实现只读对账（Reconciliation）逻辑；
- 不接真实 Amazon credential、不做浏览器自动化、不恢复 Amazon write research；
- 不开启 `PLATFORM_WRITE_TRANSPORT_ENABLED`；
- 不改 Settlement / Billing / RecoveryLedger / Payment；
- 不新增依赖（无 `package.json` 变更、无许可证变更）。

---

## 7. 影响面、回滚与必须同步的清单

| 项 | 说明 |
| --- | --- |
| 新增表 | `RecoveryPackage`、`RecoveryPackageArtifact`、`RecoveryManualSubmission`、`RecoveryManualSubmissionEvidence` |
| 新增枚举 | `RecoveryPackageStatus`、`RecoveryPackageArtifactKind` |
| architecture-contract | 模型总数 **39（36 core + 3 join）→ 43（39 core + 4 join）**；`README` / `DOMAIN_MODEL` 表述同步 |
| tenant triggers | 新增 4 张表对应 baseline 触发器 + 4 个 `cc_tenant_immutable__*`；同步 `tools/tenant-triggers/required-triggers.json` |
| 迁移建议名 | `20261001090000_recovery_manual_submission_persistence`（+ 触发器迁移，与既有 `platform_write_attempt_*` 同批风格） |
| 回滚 | `DROP TABLE` × 4 + `DROP TYPE` × 2；无数据回填、无破坏性操作、对既有查询/索引零影响 |

---

## 8. 实现级验收要求（MSG-20261001-30 TEST 清单，逐条可断言）

进入实现批次的计划必须包含至少以下 11 条（建议编号 **M1–M11**）：

1. **M1** package 不完整（required 未齐）→ 不得 `READY`、不得生成可提交材料包；
2. **M2** `packageDigest` 变化 → 旧 approval 拒绝（`APPROVAL_PAYLOAD_MISMATCH`）；
3. **M3** 跨租户（Claim / Case / Evidence 任一不属于会话租户）→ 拒绝，零副作用；
4. **M4** approval 与错误 Claim/Case/package 绑定 → 拒绝；
5. **M5** approval 通过后执行人被降权 / 停用 → 锁内重验拒绝（`APPROVAL_ACTOR_MISMATCH` / `FORBIDDEN`）；
6. **M6** 同一 submission 并发确认 → 至多一次成功（另一路 `APPROVAL_ALREADY_CONSUMED` 或 CAS 冲突）；
7. **M7** 成功状态跃迁与 approval consumption 原子（任一步失败 → 全回滚，`RecoveryManualSubmission` 不残留）；
8. **M8** 审计写失败 → 状态不推进、approval 不消费；
9. **M9** export / re-export 不改变 `SUBMITTED_MANUAL`，且不新增第二条 submission chain；
10. **M10** `providerCaseRef` 出现 ≠ reimbursement（不触发任何赔付语义）；
11. **M11** `reimbursement observed` 不触发 Settlement / Billing / RecoveryLedger（零资金侧副作用）。

并继续保留永久安全基线：**PG1–PG10**（platform-write ledger）、**H1–H9**（Integration Boundary）、**D1–D4**（Golden Path）、transport=false 零副作用、HTTP→orchestrator 唯一入口、跨租户与缺审批 fail-closed；`platform-write-*` 与 `amazon-sp-*` 系列测试不得删除或弱化。

---

## 9. 待架构方裁决

1. **源状态**：`READY_TO_APPEAL` 是否为唯一允许进入 `recovery.manual_submit` 的 `ClaimItem` 状态？（建议：是；`DISCOVERED / VERIFIED / REVIEW_REQUIRED` 一律拒绝）
2. **动作要求集合**：`recovery.manual_submit` 的 `requires` 是否为 `['humanApproval']`（零平台外写，因此不含 `platformEnablement` / `productionGate`）？（建议：是）
3. **单链约束**：v1 是否接受 `@@unique([organizationId, claimItemId])`（一个 ClaimItem 至多一条提交事实）？（建议：是）
4. **`providerCaseRef` 可空**：是否允许人工确认时没有 platform case ref（例如平台只回邮件）？（建议：允许；非空时 C7 租户内唯一）
5. **package 表**：是否接受独立 `RecoveryPackage` 业务表（而非仅靠 digest + artifact 表达）？（建议：接受 —— 审批与提交都需要稳定的包身份与版本）
6. **提交证据**：是否接受新增联结表 `RecoveryManualSubmissionEvidence`（而非复用 `ClaimItemEvidence`）？（建议：接受 —— 提交凭据与对账依据语义不同）
7. **一致性检查**：是否要求把 I1/I2（状态 ⇔ submission record）实现为可重复执行的只读一致性检查并纳入 CI 回归基线？（建议：要求）
8. **append-only 程度**：是否接受 artifact / submission / submission-evidence 三表为 append-only（仅 `RecoveryPackage` 允许 `SUPERSEDED` / `WITHDRAWN` 状态更新）？（建议：接受）

> 获批后，下一批提交 **R43 Implementation Plan**（仍不实现）；实现批次将同步：Schema/Migration → tenant trigger 清单 → 服务层 `recovery.manual_submit` → M1–M11 + PG/H/D 回归 → CI 送审。

---

## 10. 修订记录：MSG-20261001-31 裁决（CHANGE A/B/C）—— 本节为准

> 来源：**MSG-20261001-31 = PASS WITH REVISE**（REVIEWED_HEAD `f2a20b9`；四表 + 2 枚举批准；8 项待裁决全部有结论）。
> 本节给出裁决后的**最终口径**；与前文冲突时以本节为准（前文保留作为送审时的原始设计记录）。

### 10.1 CHANGE A —— 区分「不可变事实」与「生命周期状态」

| 对象 | 最终口径 |
| --- | --- |
| `RecoveryPackageArtifact` / `RecoveryManualSubmission` / `RecoveryManualSubmissionEvidence` | **整行 append-only**：任何 UPDATE / DELETE 一律拒绝（`cc_append_only__<Table>` 触发器） |
| `RecoveryPackage` | **不是**整行不可变：核心字段（`organizationId` / `claimItemId` / `caseId` / `packageVersion` / `digestVersion` / `packageDigest` / `generatedAt`）不可变；`status` 只能经**受控 CAS 状态机**修改（`GENERATED → EXPORTED / SUPERSEDED / WITHDRAWN`，终态不可回退） |
| 变更白名单 | `status` / `supersededByPackageId` / `updatedAt`（+ 未来经裁决新增的字段）；实现前必须在 trigger 与 service 两处显式定义白名单 |
| 禁止 | 任何普通 `update` 修改 digest、Claim/Case 绑定、`packageVersion` |
| 审计 | `SUPERSEDED` / `WITHDRAWN` 必须携带 **reason + actor + audit 事件**（`recovery.package_superseded` / `recovery.package_withdrawn`） |
| 触发器命名 | 三张 append-only 表使用 `cc_append_only__<Table>`（**不得**以 `cc_tenant_` 前缀命名，避免与 `required-triggers.json` 反向校验冲突）；`RecoveryPackage` 使用 `cc_recoverypackage_controlled_mutation` |

### 10.2 CHANGE B —— `approvalId` 进入单链不变量

- `RecoveryManualSubmission.approvalId` **改为 required**（受保护动作下提交记录必然由审批消费产生；不再保留无审批提交路径）。
- 新增租户范围唯一约束：**`UNIQUE(organizationId, approvalId)`** —— 同一个 approval 不得授权两条 manual submission。
- 该约束与 `recovery.approval_consumed` 的写入**必须在同一事务内成立**（消费即事务事实）。
- 与既有 `UNIQUE(organizationId, claimItemId)`（v1 单链）叠加：一条审批 → 一个 ClaimItem → 一条提交链。

### 10.3 CHANGE C —— `providerCaseRef` 唯一性必须使用 canonical value

| 项 | 最终口径 |
| --- | --- |
| canonical 化 | `trim` → Unicode **NFKC** → 去零宽字符 → 折叠内部空白；**不做大小写折叠**（Amazon reference 大小写语义未获官方证明前不得擅自 lower-case） |
| 存储 | 同时保存 `providerCaseRefRaw`（原始输入，展示/审计）与 `providerCaseRefCanonical`（唯一性/幂等） |
| 唯一性 | partial unique 建在 **canonical** 列：`UNIQUE(organizationId, providerCaseRefCanonical) WHERE providerCaseRefCanonical IS NOT NULL` |
| 补录 | 独立受保护动作 `recovery.manual_submit_reference_recorded`（含 humanApproval 边界）+ append-only 审计 `recovery.manual_submission_reference_recorded` |
| 红线 | 补录**不得**被解释为 provider accepted；不改变 `submittedAt` / `submittedByUserId`；outcome 仍只能由事实证据驱动 |
| 冲突 | canonical 重复 → `PROVIDER_CASE_REF_CONFLICT`（409），零副作用 |

### 10.4 其余 8 问结论（要点）

| 问 | 结论 |
| --- | --- |
| ① 源状态 | `READY_TO_APPEAL` 为唯一前置；`DISCOVERED / VERIFIED / REVIEW_REQUIRED / RECOVERED / CLOSED` 不得直接进入 |
| ② requires | 仅 `[humanApproval]`，**但**必须继续经过普通 RBAC/action guard（ACTIVE user、ACTIVE membership、当前角色、tenant boundary、action permission） |
| ③ 单链 | `UNIQUE(organizationId, claimItemId)` 批准；再次申诉不得做成第二条 v1 submission（后续独立 round/appeal 建模） |
| ④ 可空 | `providerCaseRef` 允许为空；补录须按 §10.3 |
| ⑤ package 表 | 独立 `RecoveryPackage` 表批准 |
| ⑥ 证据联结表 | `RecoveryManualSubmissionEvidence` 批准（引用不复制） |
| ⑦ 一致性检查 | **要求**：transaction-time validation + 只读 checker + CI fixture/真实 PostgreSQL 漂移检测；checker **只报告、不自动修复生产数据** |
| ⑧ append-only | 原则批准，按 §10.1 收紧 |

### 10.5 风险与后续

- 主要风险从「平台外写」转为**业务状态与四张新表之间的漂移**（`ClaimItem = SUBMITTED_MANUAL` 无 submission，或有 submission 但状态仍为 `READY_TO_APPEAL`）→ 由只读一致性 checker 纳入长期 CI。
- 本请求获批后，**无需再提交一轮 Schema Request**；下一批直接提交 **R43-B — Manual Recovery Persistence Implementation Plan**（docs-only，经审后才编码）。
- HOLD 保持：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD。

---

## §R43-A-11. 修订记录：MSG-20261001-32（R43-B 裁决回填到 Schema 边界）—— 本节为准

> 来源：**MSG-20261001-32 = PASS WITH REVISE**（REVIEWED_HEAD `409dbd0`）。以下三项直接改变 R43-A 的持久化边界。

### 11.1 CHANGE A —— 新增第五张 append-only 表（provider reference 事实）

| 项 | 最终口径 |
| --- | --- |
| 新表 | **`RecoveryManualSubmissionReference`**（append-only） |
| 职责 | 保存人工提交**之后**补录的 provider case reference 事实（`providerCaseRefRaw` / `providerCaseRefCanonical` / `recordedAt` / `recordedByUserId` / `approvalId` / `note`） |
| 与 Submission 的关系 | `FK submissionId → RecoveryManualSubmission`；**Submission 本体保持完全 immutable** |
| 明确禁止 | 不得在 append-only 的 `RecoveryManualSubmission` 上直接 `UPDATE providerCaseRef`（不得为补录在 append-only 触发器上打洞） |
| 唯一性 | `UNIQUE(organizationId, providerCaseRefCanonical)`（partial：canonical 非空）迁移到**本表**；同一 submission 至多一条有效 reference（`UNIQUE(organizationId, submissionId)`，替换后由新行 + 状态表达时再单独裁决） |
| 语义红线 | 补录**不得**解释为 provider accepted；不改变 `submittedAt` / `submittedByUserId`；outcome 仍只能由事实证据驱动 |
| 影响 | 模型计数由 43 变为 **44（40 core + 4 join）**；`Submission.providerCaseRef*` 字段从 Submission 表移除 |

### 11.2 CHANGE B —— `RecoveryPackage.EXPORTED` 不是不可逆终态

- **终态仅 `SUPERSEDED` / `WITHDRAWN`**；`EXPORTED` 只表示「发生过导出」，**不得阻止**后续重复导出、审批或人工提交。
- 导出建议表达为 **append-only export event / artifact**（`RecoveryPackageArtifact` 已是 append-only，天然满足），package 本身保持可用。
- 状态机修正：`GENERATED → EXPORTED`（可多次导出，状态不变）、`GENERATED/EXPORTED → SUPERSEDED | WITHDRAWN`（终态）。
- 业务含义：**「下载过 PDF」不改变 package 是否仍可提交**。

### 11.3 CHANGE C —— approval basis 必须绑定 package/digest 版本

- basis 最终格式（至少）：`rmp1:<claimItemId>:<caseId>:<packageVersion>:<digestVersion>:<packageDigest>`。
- 审批**创建**与**执行**必须调用**同一个服务端 canonical builder**（禁止两处分别拼字符串）。
- 任一元数据版本变化（packageVersion / digestVersion / digest）→ 审批载荷不匹配 → 拒绝且零推进、零消费。

### 11.4 实施细节四问结论（回填）

| 问 | 结论 |
| --- | --- |
| risk class | **INTERNAL_WRITE** + `requires=[humanApproval]` 批准；humanApproval **不替代** authn → ACTIVE user → ACTIVE membership → 当前角色 → tenant boundary → action permission |
| append-only 命名 | `cc_append_only__<Table>` 不进 `required-triggers.json` **有条件批准**：必须新建**独立 append-only / controlled-mutation trigger checklist**，CI 显式验证（三张 append-only 表 + package controlled-mutation；fresh deploy 与 upgrade path 都验证） |
| checker | CI 中 inconsistency = **hard failure**；生产/运维 **detect + report + alert only**（不得自动改状态、补 submission、消费 approval、修 evidence linkage） |
| PDF/依赖 | S2 前先做现有依赖能力检查并优先复用；若需新增依赖单独提 dependency delta；**JSON manifest = 规范事实载体，PDF = human-readable derivative**，二者不得形成两个业务真值 |
