# R45 — Implementation S1 · Schema / Migration / Trigger / Inventory · Implementation Checkpoint

> 依据：**MSG-20261001-46 = PASS WITH REVISE**（七表模型 + CHANGE A–C 批准；basis supersede 事务顺序修正；
> 授权进入 R45 S1；S1 完成后**先提交 Implementation Checkpoint** 再进入 S2）。
> 范围：**S1 只实施数据结构与数据库不变量** —— 不含 ingest / projector / 受保护动作 HTTP·service /
> provider API / Settlement · Billing · Fee / RecoveryLedger 改写 / 平台外写 / 生产凭据。
> 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false。

---

## 1. 交付物

| 类别 | 内容 |
| --- | --- |
| Schema | `apps/api/prisma/schema.prisma`：**七表 + 七枚举**（模型总数 44 → **51** = 46 core + 5 join） |
| M1 | `20261001141638_reconciliation_facts_tables`：7 表 + 7 枚举（`prisma migrate dev --create-only` 生成，SQL 原样落库） |
| M2 | `20261001142000_reconciliation_tenant_triggers`：7 张表的租户保护 + 归属不可变触发器；projection 受控更新 |
| M3 | `20261001142500_reconciliation_append_only`：3 张事实表 append-only；`ExpectedRecoveryBasis` 受控 supersede |
| M4 | `20261001143000_reconciliation_unique_constraints`：partial unique（effective basis / full reversal / policy scope）+ 显式系统 exact policy |
| M5 | `20261001143500_reconciliation_integrity_checks`：CHECK 约束 + reversal 同源性守卫 + projection generation 立即校验 |
| 测试 | `apps/api/src/__tests__/reconciliation-schema-s1-db.test.ts`（26 项数据库级验收） |
| 清单 | `tools/tenant-triggers/required-triggers.json`（56）+ `append-only-triggers.json`（12）同批更新 |
| 文档 | `README.md` / `DOMAIN_MODEL.md` / `apps/api/src/__tests__/architecture-contract.test.ts` 计数与条目同步 |

### 七表

`ProviderOutcomeFact` · `ReimbursementFact` · `ExpectedRecoveryBasis` · `ReconciliationOverrideDecision` ·
`ClaimReconciliationProjection`（derived cache）· `ClaimReconciliationProjectionFact`（联结）· `ReconciliationTolerancePolicy`

---

## 2. 数据库不变量（S1 = 数据结构与不变量，无业务逻辑）

| 不变量 | 实现 | 证据 |
| --- | --- | --- |
| 租户隔离（跨租户引用拒绝） | 七表 `cc_tenant_*`（baseline + FK 对）| 清单 56；测试「跨租户成员关系被拒绝」 |
| 归属不可变 | 七表 `cc_tenant_immutable__*`（tgtype 19） | 清单 49 immutable |
| 事实 append-only | `cc_append_only__ProviderOutcomeFact` / `__ReimbursementFact` / `__ReconciliationOverrideDecision`（tgtype 27） | 测试 UPDATE / DELETE 双拒绝 |
| basis 受控 supersede | `cc_expectedrecoverybasis_controlled_supersede`：白名单仅 `supersededAt` / `supersededByBasisId`；一次单向；DELETE 拒绝 | 测试白名单外变更 / DELETE / 二次 supersede 全拒 |
| basis effective 唯一 | partial unique `UNIQUE(organizationId, claimItemId) WHERE supersededAt IS NULL`（**仅最终防线**） | 测试「至多一个 effective」+ 事务/并发 supersede |
| 冲正语义（CHANGE A） | CHECK：`OBSERVED.amount > 0`；`REIMBURSEMENT_REVERSED` → `amount IS NULL`；不得自指；kind 与 `reversesFactId` 一致 | 测试金额语义 3 例 + 自指拒绝 |
| 冲正同源性（CHANGE B） | `cc_reimbursementfact_reversal_guard`：目标必须存在、为 `OBSERVED`、同租户 / 同 provider / 同 currency；partial unique 保证同一 OBSERVED 至多一个 full reversal | 测试 provider / currency / 跨租户 / 目标类型 / 重复冲正 |
| provider 事件身份（CHANGE B） | 两表 `UNIQUE(organizationId, providerEventFingerprint)` + `fingerprintVersion = 'v1'` + 64 hex CHECK | 测试重复 ingest、同 ID 不同 resource 不冲突 |
| 人工录入受保护（Q④） | CHECK：`MANUAL_WITH_EVIDENCE` 必须 `cardinality(evidenceArtifactIds) >= 1` 且 `reasonCode` 非空 | 测试无证据拒绝 / 带证据通过 |
| override 单笔审批（Q⑤） | `UNIQUE(organizationId, reimbursementFactId)` + `UNIQUE(organizationId, approvalId)` + reason 非空 | 测试三例 |
| projection 受控更新 | `cc_reconciliationprojection_controlled_mutation`：identity 不可变；`projectionVersion` 单调 +1（CAS） | 测试 identity / 版本步长 |
| projection generation 一致（CHANGE A） | `cc_reconciliationprojectionfact_version_match`（BEFORE INSERT）+ **立即** generation 校验（见 §3） | 测试旧版本写入拒绝 / 未清理上一代即提升版本拒绝 / 合法同事务整体替换通过 |
| policy scope（CHANGE C） | partial unique `(COALESCE(org,'*'), COALESCE(provider,'*'), COALESCE(operation,'*'), policyVersion) WHERE supersededAt IS NULL`；显式系统 exact policy 记录 | 测试同 scope 冲突 / 不同 provider 共存 / 系统 scope 不重复 |

---

## 3. 必须回报架构方的偏差（1 项）：generation 一致性改为**立即判定**

**背景**：MSG-20261001-46 Q3 给出的重算顺序为
`CAS projection version/inputDigest → DELETE 当前 membership → INSERT 新 membership`。

**实测发现（本机 PostgreSQL 16 + Prisma 5.22.0 客户端）**：
用 `DEFERRABLE INITIALLY DEFERRED` 约束触发器在 COMMIT 阶段拦截「提升版本但未清理旧 generation」时，
**Prisma 交互事务会静默回滚**：调用方既收不到异常，也没有任何可观测错误（`$transaction` resolve，
随后读取发现版本仍是旧值）。已用两个独立探针复现（`work/scripts/probe-generation-guard.mjs` /
`probe-deferred-commit-error.mjs`，psql 直连对照确认触发器本身在 COMMIT 阶段正确抛错）。

**处置（S1 已实施）**：
1. **不使用** DEFERRABLE 约束触发器（本域 0 个 deferrable 触发器，测试显式断言 `tgdeferrable = false`）；
2. generation 一致性改为在同一事务内**立即判定**，且把不可逆的半成品状态挡在提交之前：
   `DELETE 上一代 membership → CAS projectionVersion/inputDigest → INSERT 新一代 membership → commit`；
   - 未清理上一代就提升版本 → 立即 `PROJECTION_MEMBERSHIP_STALE_GENERATION`（触发器在 projection UPDATE 上）；
   - 写入非当前 generation 的 membership → 立即 `PROJECTION_FACT_STALE_GENERATION`（BEFORE INSERT）。

**请裁决**：是否批准把 Q3 的事务内顺序调整为 `DELETE → CAS → INSERT`（语义不变：仍是「同事务整体替换」，
但使失败可观测）。若架构方坚持原顺序，则必须接受「违规时静默回滚」或改由服务层显式预校验。

---

## 4. 其他实现口径（供审阅确认，均未越出 MSG-45/46 裁决）

1. `ReimbursementFact.amount` 可空：`OBSERVED` 必填且 `> 0`；`REIMBURSEMENT_REVERSED` 必须为 `NULL`
   （落实 CHANGE A「冲正行不携带独立金额语义」）。
2. 新增 `provider` 列（两表必填）：`reversesFactId` 的「同 provider」约束与指纹身份都需要显式 provider，
   R45-A §2.1/§2.2 未单列该列，如需改名可另开 Schema 变更。
3. `evidenceArtifactIds` 使用 `text[]`：R45-A 明确七表模型不新增证据联结表，故不建第 8 张表；
   元素级 FK 无法在数组上表达，元素存在性由 S4 受保护动作在服务层校验（CHECK 已强制人工路径 ≥1 条）。
4. 系统 exact policy 为**迁移播种的常量记录**（`cc0f0000-0000-4000-8000-000000000001`，provider/operation 为空、0/0）。
   注意：测试夹具普遍 `TRUNCATE` 全库，因此该常量在测试运行结束后可能不存在；S3 projector 必须在受控路径上
   「取用或显式创建」，不得依赖代码隐式 fallback（CHANGE C）。
5. `ClaimReconciliationProjection.basisId` / `tolerancePolicyId` 为弱引用（不建 FK），与既有 approvalId 同口径。

---

## 5. 验收证据（本地实测，2026-10-01）

| 项 | 结果 |
| --- | --- |
| `npx prisma validate` | **valid** |
| `npx tsc --noEmit` | **PASS（0 error）** |
| 新增 S1 DB 测试 | **26/26 PASS** |
| architecture-contract | **119/119 PASS**（模型 51 = 46 + 5） |
| 全量 API 套件 | **1648 tests**（见本次提交 CI；本地全量已跑通） |
| 租户触发器清单（fresh） | `OK: required tenant triggers=56 baseline, 49 immutable, 2 scoped` |
| append-only / 受控变更清单（fresh） | `OK: append-only/controlled-mutation triggers=12` |
| two-stage upgrade（保数据） | `TWO_STAGE_UPGRADE_OK`（pre-B2 33 → 应用到 repo 全量迁移；数据/归属/引用完整；升级路径两套清单 + checker 通过） |
| 本地重建路径 | drop 七表/枚举/函数 → `prisma migrate deploy` 全量重放 **无残留、无冲突** |

CI 侧：`api` job 的 fresh `prisma migrate deploy` + 两套清单校验 + 全量测试 + two-stage upgrade 覆盖同一组不变量。

---

## 6. 风险分类与边界

- `FOUNDATION_REUSED` = 租户隔离（`crossclaim_assert_tenant_integrity` / `cc_forbid_tenant_reassignment`）、
  append-only 清单机制、受控变更清单机制、跨租户 FK 触发器对、既有 migration/CI/upgrade 通道。
- `NEW_RISK_BOUNDARY` = **YES**（Schema 实质变化 + 一致性边界：effective basis 唯一、provider 事件身份、
  冲正语义、projection generation）。
- `ARCH_REVIEW_REQUIRED` = **YES**（Schema 变更 + 一致性/并发不变量 + §3 的顺序偏差）。
- 仍然 HOLD：Settlement · Billing · Fee · RecoveryLedger 改写 · 平台外写 · transport · 生产凭据。

## 7. 下一步（等待裁决）

- **PASS** → 进入 **R45 S2（ingest：provider outcome / reimbursement 事实写入 + 指纹幂等复用）**；
- **REVISE** → 按 CHANGE 逐项修订后重送；
- **BLOCK** → 停止该方向，不绕道。

## 附录 · MSG-20261001-47 裁决结果

> 裁决：**PASS WITH REVISE — MSG-20261001-47**（REVIEWED_HEAD `8129998`；归档 `AI-ARCHITECT-INBOX.md` FULL_COPY_OK）。

| 裁决 | 结果 |
| --- | --- |
| ① S1 是否满足授权范围 | **YES** —— 可关闭 S1 主体实现。保留两点（不 BLOCK）：`projection.basisId / tolerancePolicyId` 弱引用与 `evidenceArtifactIds text[]` 必须在服务/checker 阶段补强验证 |
| ② Generation 顺序调整 | **批准** `DELETE → CAS → INSERT`（立即判定），不要求 DEFERRABLE trigger；新增永久验收「DELETE 后 CAS/INSERT 人为失败 → 回滚后旧 generation + 旧 membership 逐行保持」 |
| ③ 下一执行单元 | **批准进入 R45 S2（ingest only）**：ProviderOutcomeFact / ReimbursementFact + server-side identity/fingerprint + replay 幂等 + reversal ingest；不含 projector、不含人工 outcome 受保护 HTTP |

### 落实动作（本批次）

- 新增永久验收测试：`reconciliation-schema-s1-db.test.ts` 增加「重算事务中途失败 → 回滚后旧 projection generation 与旧 membership 逐行保持」
  （场景 1：DELETE 后 CAS 非法 → 回滚；场景 2：DELETE + CAS 成功后 INSERT 失败（FK）→ 回滚），专项 **27/27 PASS**。

### 预登记约束（S2–S5 永久验收，逐条在对应阶段落地）

1. **CHANGE A**：`basisId` / `tolerancePolicyId` 弱引用 —— S3 读取时强校验（存在 / 同租户 / 期望 ClaimItem·provider·scope / effective·version）；S5 checker 将 dangling basisId、cross-tenant basisId、dangling tolerancePolicyId、scope/version 不匹配判为 inconsistency；能建 FK 时优先 FK。
2. **CHANGE B**：`evidenceArtifactIds text[]` 仅为 v1 有条件方案 —— 人工 outcome 写路径逐条验证（存在 / 同租户 / 类型·状态允许 / 不重复 / 不得由客户端构造不存在 ID）；checker 检测 dangling·cross-tenant evidence；未来升级为关系表。
3. **CHANGE C**：system exact policy 不得依赖 migration seed 永久存在 —— S3 必须「确定性查询 → 受控幂等创建 → unique scope 收敛 → Projection 持久化真实 `tolerancePolicyId + version`」；禁止 `if missing => assume 0/0`。

### S2 预登记验收

same external event → same existing fact（不是 duplicate → error/new fact）· same `providerEventId` + different resource identity → distinct facts · same reversal replay → existing reversal · different reversal event → same OBSERVED already fully reversed → fail-closed。
