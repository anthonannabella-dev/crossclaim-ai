# R43-B — MANUAL RECOVERY PERSISTENCE — IMPLEMENTATION PLAN

> 类型：**Implementation Plan（仅计划；不写代码、不写 migration、不实现）**
> PREVIOUS: **MSG-20261001-31 = PASS WITH REVISE**（R43-A 四表 + 2 枚举批准；CHANGE A 受控 CAS / CHANGE B approvalId 单链唯一 / CHANGE C providerCaseRef canonical；NEXT = 完成 CHANGE A/B/C 后**不需再走一轮 Schema Request**，直接提交 R43-B）
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01 · ROUND: **R43-B**
> 边界（冻结）：不接真实 Amazon credential、不实现浏览器自动化、不恢复 Amazon write research、不开启 transport
> HOLD：AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · `PLATFORM_WRITE_TRANSPORT_ENABLED=false` · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · SETTLEMENT/BILLING LINKAGE HOLD

---

## 0. 计划摘要与交付边界

| 项 | 内容 |
| --- | --- |
| 目标 | 把 R43 设计（人工提交闭环）落到可实施的最小持久化 + 服务层动作，**不引入任何平台外写** |
| 范围 | 4 张新表 + 2 枚举 + 触发器（租户/不可变/受控变更）+ 服务层 `recovery.manual_submit` + 包 digest/CAS + providerCaseRef canonical 化 + 只读一致性检查 + 测试矩阵 |
| 不在范围内 | 真实凭据、platform write adapter、transport 开关、浏览器自动化、Settlement/Billing/RecoveryLedger 任何变更、PDF 排版引擎选型之外的 UI 工作 |
| 交付形态 | 代码 + 迁移 + 测试 + CI；每批次独立 commit/push，**不合并 main** |
| 关键纪律 | 业务真值 = `ClaimItem.status` + `RecoveryManualSubmission`；AuditLog 仅 append-only 证据；四事实不可合并 |

**批次划分（每批次独立可验证、失败可定位）**

| 批次 | 内容 | 出口条件 |
| --- | --- | --- |
| S1 | Schema / migration（4 表 + 2 枚举 + 触发器 + 清单同步） | `prisma validate` valid；`migrate deploy` 幂等；tenant-trigger checklist 通过 |
| S2 | package 生成 + canonical manifest + digest + CAS 状态机 | package 单测（digest 幂等 / 状态机非法跃迁拒绝 / 核心字段不可改） |
| S3 | `recovery.manual_submit` 注册 + 锁内重验 + 原子提交 | M2/M4/M5/M6/M7/M8 真库验收 |
| S4 | `providerCaseRef` canonical 化 + 补录动作 | C7/C9 与补录审计验收 |
| S5 | 只读一致性 checker + CI 接线 | checker 能发现人工制造的漂移，且**无写路径** |
| S6 | 全量回归（M1–M11 + MSG-31 新增 9 项 + PG/H/D 基线） | 全绿 |
| S7 | 送审（CI + 证据 + 唤醒） | READY_FOR_REVIEW |

---

## 1. Migration 顺序（NEXT ①）

| # | 迁移名（建议） | 内容 | 为什么单独一支 |
| --- | --- | --- | --- |
| M1 | `20261001090000_recovery_manual_persistence_tables` | 2 枚举（`RecoveryPackageStatus` / `RecoveryPackageArtifactKind`）+ 4 表 + FK/unique/index | 纯结构，无触发器；CI 失败可定位到 Prisma 定义 |
| M2 | `20261001090500_recovery_manual_persistence_tenant_triggers` | 4 表的 `cc_tenant_*` baseline + `cc_tenant_immutable__<Table>` | 与 `tools/tenant-triggers/required-triggers.json` 同批；否则 CI 反向校验红 |
| M3 | `20261001091000_recovery_package_controlled_mutation` | `RecoveryPackage` **受控变更**触发器（字段白名单） | 与 M2 分离：失败时能区分「漏挂租户触发器」与「白名单过严/过宽」 |
| M4 | `20261001091500_recovery_package_append_only` | `RecoveryPackageArtifact` / `RecoveryManualSubmission` / `RecoveryManualSubmissionEvidence` 整行 append-only 触发器 | 与 package 生命周期语义不同，必须分开表达 |
| M5 | `20261001092000_recovery_manual_submission_identities` | `UNIQUE(organizationId, approvalId)`（CHANGE B）+ canonical `providerCaseRef` partial unique（CHANGE C） | 唯一性收口；需 raw SQL partial index |

**顺序理由**：先结构 → 再租户触发器 → 再不可变语义 → 最后唯一性；任一步失败都不需要回滚前序结构，且每一步都能单独写验收断言。

**同批次必须同步的元数据**

- `tools/tenant-triggers/required-triggers.json`（新增 baseline 触发器条目）；
- `apps/api/src/__tests__/architecture-contract.test.ts` 的模型计数：**39（36 core + 3 join）→ 43（39 core + 4 join）**；
- `apps/api/prisma/DOMAIN_MODEL.md` / 根 `README.md` 的模型数与四事实描述。

---

## 2. 四表 FK / unique / index（NEXT ②）

### 2.1 `RecoveryPackage`

| 约束 | 作用 |
| --- | --- |
| `PK(id)` | — |
| `FK(organizationId) → Organization` (Cascade) | 租户归属 |
| `FK(claimItemId) → ClaimItem` (Cascade) | 业务锚点 |
| `UNIQUE(organizationId, id)` | 既有租户复合唯一口径（与全库一致） |
| `UNIQUE(organizationId, claimItemId, packageVersion, packageDigest)` | 同一输入的包只有一份 |
| `INDEX(organizationId, claimItemId, status)` | 按 Claim 回看包生命周期 |
| `INDEX(organizationId, createdAt)` | 审计对齐 |

`status` ∈ {`GENERATED`, `EXPORTED`, `SUPERSEDED`, `WITHDRAWN`}；**不存在**任何「已提交/已受理/已赔付」取值。

### 2.2 `RecoveryPackageArtifact`

| 约束 | 作用 |
| --- | --- |
| `FK(organizationId) → Organization` (Cascade) | 租户归属 |
| `FK(packageId) → RecoveryPackage` (Cascade) | 归属包 |
| `FK(fileAssetId) → FileAsset` | 只引用既有文件资产，不复制存储 |
| `UNIQUE(organizationId, packageId, artifactKind, sha256)` | 同内容重复导出不新增第二份 artifact |
| `UNIQUE(organizationId, id)` | 既有口径 |
| `INDEX(organizationId, packageId, exportedAt)` | 导出台账 |

### 2.3 `RecoveryManualSubmission`

| 约束 | 作用 |
| --- | --- |
| `FK(organizationId) → Organization` (Cascade) | 租户归属 |
| `FK(claimItemId) → ClaimItem` (Cascade) | 业务锚点 |
| `FK(packageId) → RecoveryPackage` | 绑定具体包 |
| `UNIQUE(organizationId, claimItemId)` | v1 单链（MSG-31 ③） |
| `UNIQUE(organizationId, approvalId)` | **CHANGE B**：同一审批不得授权两条提交 |
| `UNIQUE(organizationId, idempotencyKey)` | 重复确认 = 同一事实 |
| Postgres partial `UNIQUE(organizationId, providerCaseRefCanonical) WHERE providerCaseRefCanonical IS NOT NULL` | **CHANGE C**：canonical 值租户内唯一 |
| `INDEX(organizationId, submittedAt)` | 审计/对账回看 |

**`approvalId` 设为 `String`（required）**：`recovery.manual_submit` 是受保护动作，提交记录必然由审批消费产生；不再保留「无审批的提交」路径（MSG-31 CHANGE B「不要无理由 nullable」）。

### 2.4 `RecoveryManualSubmissionEvidence`

| 约束 | 作用 |
| --- | --- |
| `FK(organizationId) → Organization` (Cascade) | 租户归属 |
| `FK(submissionId) → RecoveryManualSubmission` (Cascade) | 归属提交事实 |
| `FK(evidenceId) → EvidenceArtifact` (Cascade) | 只引用证据，不复制 |
| `UNIQUE(organizationId, submissionId, evidenceId)` | 引用去重 |

---

## 3. 触发器：租户 / 不可变 / 受控变更（NEXT ③）

**每张新表需要三类互不替代的触发器**（命名刻意区分，避免与 CI 清单反向校验冲突）：

| 类别 | 命名 | 语义 | CI 关系 |
| --- | --- | --- | --- |
| 租户保护（baseline） | `cc_tenant_<table>` / `cc_tenant_<table>_<fk>` | 阻止跨租户引用 | **必须**写入 `required-triggers.json`（否则反向校验红） |
| 归属不可变 | `cc_tenant_immutable__<Table>` | 禁止改 `organizationId`（BEFORE UPDATE，tgtype 19） | **必须**存在（`emit-check-sql.mjs` 第 3 条逐表校验） |
| 行不可变 / 受控变更 | `cc_append_only__<Table>` / `cc_recoverypackage_controlled_mutation` | 整行 append-only 或字段白名单 | 命名**不得**以 `cc_tenant_` 开头；若未来要纳入清单再单独裁决 |

**各表触发语义**

| 表 | 触发器 | 语义 |
| --- | --- | --- |
| `RecoveryPackage` | `cc_recoverypackage_controlled_mutation`（BEFORE UPDATE） | 仅允许改 `status` / `supersededByPackageId` / `updatedAt`（+ 未来白名单字段）；**禁止**改 `organizationId` / `claimItemId` / `caseId` / `packageVersion` / `digestVersion` / `packageDigest` / `generatedAt` |
| `RecoveryPackageArtifact` | `cc_append_only__RecoveryPackageArtifact`（BEFORE UPDATE/DELETE） | 任何修改/删除一律 RAISE |
| `RecoveryManualSubmission` | `cc_append_only__RecoveryManualSubmission` + 补录例外 | 整行不可改；**唯一例外**：`providerCaseRefRaw` / `providerCaseRefCanonical` 的补录（见 §5），且必须伴随审计 |
| `RecoveryManualSubmissionEvidence` | `cc_append_only__RecoveryManualSubmissionEvidence` | 任何修改/删除一律 RAISE |

> `supersededByPackageId` 之外，`status` 变更必须走 §4 的 CAS 状态机；触发器只做「字段白名单」，业务合法性由服务层 CAS 保证（DB 不写进度状态机）。

---

## 4. Package CAS 状态机（NEXT ④）

```text
GENERATED ──(export 成功)──▶ EXPORTED
GENERATED ──(内容变化/新 digest)──▶ SUPERSEDED
GENERATED ──(撤回，需 reason)──▶ WITHDRAWN
EXPORTED  ──(新 digest 取代)──▶ SUPERSEDED
EXPORTED  ──(撤回，需 reason)──▶ WITHDRAWN
SUPERSEDED / WITHDRAWN = 终态（不得回到 GENERATED/EXPORTED）
```

| 规则 | 实现 |
| --- | --- |
| 所有跃迁走 CAS | `updateMany({ where: { id, organizationId, status: <expected> }, data: { status: <next> } })`；`count === 0` → `ILLEGAL_TRANSITION` |
| 请求来源 | `export` 动作 / 重新生成包（新 digest）/ 撤回动作（需 `reason`） |
| 必带审计 | `recovery.package_exported` / `recovery.package_superseded` / `recovery.package_withdrawn`（含 `from`/`to`/`reason`/`actorUserId`） |
| 禁止 | 任何路径直接 `update` 修改 `packageDigest` / `packageVersion` / `claimItemId` / `caseId`（触发器 + 服务层双重拒绝） |

---

## 5. `providerCaseRef` canonical 化与补录（NEXT ⑦，对应 CHANGE C）

| 步骤 | 规则 |
| --- | --- |
| canonical 化 | `trim` → Unicode **NFKC** → 去零宽字符 → 折叠内部空白 → **不进行大小写折叠**（Amazon 语义未证明前不得擅自 lower-case） |
| 保存 | 同时保存 `providerCaseRefRaw`（用户原始输入，展示/审计用）与 `providerCaseRefCanonical`（唯一性/幂等用） |
| 唯一性 | partial unique 建在 canonical 列（§2.3 C7） |
| 补录 | 独立受保护动作 `recovery.manual_submit_reference_recorded`（同 `humanApproval` 边界）；写 append-only 审计 `recovery.manual_submission_reference_recorded`（含 `from`/`to`/`actor`/`approvalId`） |
| 语义红线 | 补录 **不得**被解释为 provider accepted；`submittedAt` / `submittedByUserId` 不因补录改变；outcome 仍只能由事实证据驱动 |
| 冲突 | canonical 重复 → `PROVIDER_CASE_REF_CONFLICT`（409），零副作用 |

---

## 6. `recovery.manual_submit` Action Guard 接线（NEXT ⑤）

| 文件 | 变更 |
| --- | --- |
| `services/action-guard/action-guard.ts` | `'recovery.manual_submit': { risk: 'INTERNAL_WRITE', requires: ['humanApproval'] }`（无平台外写，故不含 platformEnablement/productionGate） |
| `services/action-guard/approval-verifier.ts` | 新增 `RECOVERY_MANUAL_SUBMIT_ACTION` / `RECOVERY_MANUAL_SUBMIT_REFERENCE_ACTION` 常量（与 claim.submit / appeal.submit 互不通用） |
| `services/action-guard/capability-source.ts` | `'recovery.manual_submit': ['submission']`（补录动作同源） |
| `services/action-guard/guard-enforcement.ts` | 纳入受保护动作清单（唯一执行入口 + 静态不可绕过检查） |
| `services/claims/manual-recovery-submission.ts`（新增） | 原子提交服务（§7） |
| `services/workflow/http-routes.ts` + `server.ts` | 内部路由（无平台调用）：材料包生成/导出、提交确认、providerCaseRef 补录、outcome 登记 |

**RBAC 附加要求（MSG-31 ②）**：`humanApproval` 是**附加**要求，不替代 ACTIVE user / ACTIVE membership / 当前角色 / tenant boundary / action permission。

---

## 7. 原子事务（NEXT ⑥，对应 CHANGE A/B）

顺序固定（与 `claim.submit` 同协议）：

1. 案件锁 `pg_advisory_xact_lock(hashtext('cc-recovery-case:' || caseId))`；
2. `ClaimItem` 行锁（`FOR UPDATE`）并确认租户 + 案件 + 当前状态 = `READY_TO_APPEAL`；
3. 读**当前** `Membership (isActive = true)` 重验执行者角色（禁止复用锁前结论）；
4. `verifyApprovalBoundary`：动作名 / 目标 Case / `extra = { claimItemId, caseId, packageDigest }` / 版本 / 有效期 / 撤销 / 消费；
5. 校验 `RecoveryPackage` 存在、`status ∈ {GENERATED, EXPORTED}`、`packageDigest` 与审批绑定一致；
6. CAS：`ClaimItem.status: READY_TO_APPEAL → SUBMITTED_MANUAL`；
7. `INSERT RecoveryManualSubmission`（`approvalId` required；含 canonical ref（可空）与 evidence 联结行）；
8. 审计 `recovery.submitted_manual` + 消费审计 `recovery.approval_consumed`；
9. 事务提交；失败 → 全部回滚（**submission 行不得残留**）。

拒绝留痕（事务外，与 `claim.submit` 同口径）：`recovery.manual_submit_rejected`（含 stage / reason），审计写失败不得覆盖原始错误。

**并发/重复语义**

| 场景 | 结果 |
| --- | --- |
| 同一 submission 并发确认 | 至多一次成功；另一路 `APPROVAL_ALREADY_CONSUMED` 或 CAS 失败 |
| 同一 approval 授权两个 ClaimItem | 至多一个成功（`UNIQUE(organizationId, approvalId)` + 事务内消费） |
| 已消费审批再次确认 | 结构化拒绝，不重复执行、不新增 submission |
| 包内容在批准后变化 | digest 不匹配 → `APPROVAL_PAYLOAD_MISMATCH`（旧审批自动失效） |

---

## 8. 只读一致性 checker（NEXT ⑧）

| 项 | 设计 |
| --- | --- |
| 位置 | `tools/consistency/check-recovery-manual-submission.mjs`（只读，无修复路径） |
| 检查项 | ① `ClaimItem.status ∈ {SUBMITTED_MANUAL, RECOVERED, CLOSED}` ⇔ 存在 submission（双向）② `submission.packageDigest === package.packageDigest` ③ submission 的 `caseId` 与 ClaimItem 一致 ④ 每 tenant 每 approval 至多一条 submission ⑤ canonical `providerCaseRef` 无重复 ⑥ evidence 引用均存在且同租户 |
| 输出 | JSON 报告（`checked` / `violations[]`）+ 退出码；CI 任务失败即视为回归失败 |
| 红线 | 生产数据**只报告、不自动修复**；不得写入任何行、不得删除任何行 |
| CI | 在 fixture/真实 PostgreSQL 上运行，并包含「人工制造漂移 → checker 必须报出」的反向用例 |

---

## 9. 验收矩阵（NEXT ⑨）

**基础矩阵（MSG-20261001-30 TEST，M1–M11）**：package 不完整不得 READY；digest 变化 → 旧审批拒绝；跨租户拒绝；错误绑定拒绝；执行人降权/停用拒绝；并发确认至多一次；状态跃迁与审批消费原子；审计写失败 → 状态不推进；export/re-export 不改变 `SUBMITTED_MANUAL`；provider case ref ≠ reimbursement；reimbursement observed 不触发 Settlement/Billing。

**MSG-20261001-31 新增（M12–M20）**：① ClaimItem 状态 ⇔ submission record 双向一致性 ② 同 approval 并发授权两个 ClaimItem → 至多一个成功 ③ package digest/binding 创建后不可修改 ④ package 状态只能合法 CAS ⑤ immutable 表直接 UPDATE 被拒 ⑥ canonical `providerCaseRef` 重复被拒 ⑦ `providerCaseRef` 为空仍可完成人工确认 ⑧ 补录 providerCaseRef 不改变「provider accepted」事实 ⑨ consistency checker 能发现人工制造的跨表不一致且不自动修复。

**永久基线**：PG1–PG10（platform-write ledger）、H1–H9（Integration Boundary）、D1–D4（Golden Path）、transport=false 零副作用、HTTP→orchestrator 唯一入口、跨租户与缺审批 fail-closed；`platform-write-*` 与 `amazon-sp-*` 测试系列不得删除或弱化。

---

## 10. Rollback（NEXT ⑩，仅设计，不执行）

| 层级 | 步骤 |
| --- | --- |
| 代码层 | 回退服务/路由/Action Guard 注册 → 动作不可用（fail-closed），已落库事实保留 |
| 表结构层 | 反序：M5（唯一约束）→ M4（append-only）→ M3（受控变更）→ M2（租户触发器）→ M1（表/枚举） |
| 数据层 | 本阶段**无生产数据**：测试库可直接删表；若未来生产已启用，必须先导出 `RecoveryManualSubmission` 事实再删表（本计划不执行） |
| 触发器清单 | 回滚时必须同步移除 `required-triggers.json` 中对应 baseline 条目，否则 CI 反向校验会报「清单要求存在但库中缺失」 |

---

## 11. 风险与开放问题

1. **再次申诉（二次/三次 appeal）**：v1 单链约束 **不放宽**；后续用独立 round/appeal 模型做 Schema Delta（MSG-31 ③）。
2. **审计日志膨胀**：审计仍为 append-only 证据；不得把业务真值搬到 AuditLog 以规避 Schema（MSG-30/31 RISKS）。
3. **内部路由的暴露面**：`recovery.manual_submit` 及其配套路由均属内部动作（零平台外写），但必须与既有受保护动作同等 fail-closed；是否需要额外的 production gate 由架构方在实现批次裁决（当前建议：仅 `humanApproval`）。
4. **PDF 生成**：本计划只定义 artifact 与 manifest 身份；排版引擎与文件生成方式属实现细节，在 S2 前单独说明（不引入新依赖前先向架构方报备）。
5. **checker 的长期成本**：作为长期 CI 基线保留；若未来数据量增大，可改为抽样 + 全量周检（需架构方同意）。
