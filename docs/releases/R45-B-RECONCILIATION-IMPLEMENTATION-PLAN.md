# R45-B — Outcome / Reimbursement Reconciliation · Implementation Plan

> 依据：**MSG-20261001-45 = PASS WITH REVISE**（R45-A Schema Delta 4 项裁决 + CHANGE A–D）。
> 状态：**docs-only 计划**——本文件不实施 Schema、不写 migration、不改代码；仅把裁决固化为最终模型与实施/事务/测试计划。
> 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write · TRANSPORT=false · NO production credentials。

---

## 1. 最终模型（七张表）

| 表 | 类别 | 关键点（含 MSG-45 裁决） |
| --- | --- | --- |
| `ProviderOutcomeFact` | Immutable | `kind = ACCEPTED \| ACCEPTANCE_REVOKED`；**人工录入为受保护路径**（Q④：humanApproval + ≥1 EvidenceArtifact + structured reason/sourceRef + actor + capturedAt + `sourceKind = MANUAL_WITH_EVIDENCE`）；禁止仅凭客户端布尔 `providerAccepted=true` |
| `ReimbursementFact` | Immutable | `kind = OBSERVED \| REIMBURSEMENT_REVERSED`；**`OBSERVED.amount > 0`**（CHECK）；`REVERSED` 必须引用 `reversesFactId`（CHANGE A） |
| `ExpectedRecoveryBasis` | Immutable（受控 supersede） | 版本化 `expectedRecoveryAmount / currency / basisKind / basisVersion / basisSource`；**`supersededAt IS NULL` + partial unique**（CHANGE C） |
| `ReconciliationOverrideDecision` | Immutable | 每笔 reimbursement 单独审批（Q⑤）；`approvalId` 必填 + structured reason |
| `ClaimReconciliationProjection` | Derived（materialized cache） | `status` + `basisId` + `netMatchedObservedAmount` + **实际使用的 `tolerancePolicyId/policyVersion`** + `inputDigest` + `projectionVersion` + `computedAt`；**删除后可由 facts 重建且结果一致** |
| `ClaimReconciliationProjectionFact` | Derived 关联（关系表，CHANGE D） | `projectionId ↔ reimbursementFactId`，带 FK 与同租户约束；**事实成员关系不得只存 JSON** |
| `ReconciliationTolerancePolicy` | Immutable（versioned） | v1 建表（Q②）；默认 `absoluteTolerance = 0` / `relativeTolerance = 0`（exact）；`provider? / operation?` 范围显式；append-only；policy 更新只影响重算并产生新 `inputDigest/projectionVersion` |

## 2. CHANGE A–D 落实细节

### CHANGE A — reversal 金额语义

- `OBSERVED.amount > 0`（CHECK `amount > 0`）。
- `REVERSED` 行**不携带独立金额语义**：金额由 `reversesFactId` 指向的事实取得（可选冗余列必须与原事实一致，用 CHECK/触发器保证）。
- 约束：不得 `reversesFactId = id`（自指）；只能指向**同 tenant / 同 provider / 同 currency** 且 `kind = OBSERVED` 的有效事实；同一原始事实**不得重复 full-reverse**（partial unique `(organizationId, reversesFactId)`）。
- **v1 仅支持 full reversal**；partial reversal 需单独设计（不在 v1 金额字段隐式表达）。

### CHANGE B — provider 事件身份双概念

- 保留 `providerEventId?`（provider 原生稳定 ID，经 server canonicalization 后参与 identity）。
- `providerEventFingerprint` = 版本化 server-side 指纹，输入至少包含：
  `provider + source/resource + providerEventId | canonical source identity + event kind`；
  带 `fingerprintVersion = 'v1'`；避免不同资源空间相同 ID 碰撞。
- ingest 幂等：`UNIQUE(organizationId, providerEventFingerprint)`；重复 ingest 复用既有事实（不新建、不双计）。

### CHANGE C — basis effective 的数据库可判定表达

- `ExpectedRecoveryBasis.supersededAt DateTime?`（null = effective）。
- partial unique：`UNIQUE(organizationId, claimItemId) WHERE supersededAt IS NULL`。
- supersede 事务顺序（固定）：
  1. `SELECT … FOR UPDATE` 锁定当前 effective basis（同 claim）；
  2. `INSERT` 新 basis（`supersededAt = null`）→ 若唯一索引先冲突，则改为
  3. `UPDATE` 旧 basis 设置 `supersededAt = now()` **与** `supersededByBasisId = new.id`；
  4. 提交。
  → 实现时必须实测「先 insert 后 update」与「先 update 后 insert」两种顺序，选择不会触发唯一索引冲突且无 ABA 的顺序，并写并发测试（两并发 supersede → 最终恰一个 effective）。
- 旧 basis **永久保留**，不得 UPDATE 其它字段（append-only + 受控 supersede 白名单）。

### CHANGE D — projection ↔ fact 关系化

- 新增 `ClaimReconciliationProjectionFact`：`(projectionId, reimbursementFactId)` 唯一；FK + 同租户校验；随 projection 重算整体替换（同一事务内 delete + insert 或版本化写入）。
- `matchedFactIds` 若保留，仅作**摘要缓存**；一致性以关系表为准（checker 校验两者一致）。

## 3. 受保护动作与权限（沿用既有 Action Guard / HITL）

| 动作（动作/命令式命名） | 风险 | 审批 | 说明 |
| --- | --- | --- | --- |
| `recovery.reconciliation_basis_set` | INTERNAL_WRITE | **humanApproval** | 首次建立 expected basis（Q③） |
| `recovery.reconciliation_basis_supersede` | INTERNAL_WRITE | **humanApproval** | 取代 basis（不得使用模糊的 `recovery.reconciliation_write`） |
| `recovery.reconciliation_override` | INTERNAL_WRITE | **humanApproval** | 每笔 reimbursement 单独审批（Q⑤） |
| `recovery.reconciliation_provider_outcome_record` | INTERNAL_WRITE | **humanApproval** | 人工录入 provider outcome（Q④；含 `ACCEPTANCE_REVOKED`） |

共同要求：tenant/path binding + 锁后实时 membership/role 重验 + structured reason + provenance + 审计事件；approval 绑定使用服务端计算的 basis/digest（沿用 R44-A/B 的 `boundExtra` 模式，客户端不得自证）。

## 4. Projector 规范（确定性）

`INPUT = immutable facts + effective basis + tolerance policy + override decisions`
`OUTPUT = projection rows + projection-fact relations`

- 纯函数式：同一 input → 同一 output；**不得从旧 projection 增量猜测**。
- 每次重算写入 `inputDigest`（输入摘要）与 `projectionVersion`；policy/basis 变化必须产生新的 digest/version。
- 只读 checker（沿用 `tools/consistency/` 模式，detect ≠ repair）验证：`stored projection == deterministic rebuild`、relation 与摘要一致、全部关系同租户。

## 5. 事务与并发要点

1. **ingest**：fingerprint 唯一冲突 → 复用既有事实（幂等返回）；事务内不产生其它副作用。
2. **basis supersede**：按 §2 CHANGE C 的固定顺序 + 并发测试。
3. **override**：approval 消费 + decision 事实 + 投影重算在同一事务；失败整体回滚。
4. **投影重算**：与 facts 读取同事务（或基于 `inputDigest` 的乐观校验），避免用陈旧 facts 覆盖新投影。
5. 全部沿用现有 advisory lock / FOR UPDATE / CAS 基础设施，不新建并发模型。

## 6. Migration 拆分（仍不实施）

| 迁移 | 内容 |
| --- | --- |
| M1 | 7 表 + 枚举（含 `ClaimReconciliationProjectionFact`、`ReconciliationTolerancePolicy`） |
| M2 | 租户触发器（`cc_tenant_*` / `cc_tenant_immutable__*`）与 projection 受控更新白名单 |
| M3 | append-only（`cc_append_only__*`）与受控 supersede 白名单（basis） |
| M4 | 唯一/partial unique（fingerprint、reimbursementFact override、effective basis、reversesFactId） |
| M5 | CHECK（`OBSERVED.amount > 0`、currency、fingerprint 64hex、fingerprintVersion、枚举、reasonCode） |
| M6 | 清单与计数同步（required-triggers / append-only-triggers / architecture-contract 模型计数 / DOMAIN_MODEL / README / `two-stage-upgrade.mjs` / CI fresh 路径） |

## 7. 测试计划（R45 永久验收）

新增（含 MSG-44/45 要求）：

1. 相同 `providerEventId` 重复 ingest → 单一 fact（不双计）
2. 相同 ID、不同 resource → 不误去重
3. fingerprint version mismatch → fail-closed
4. full reversal 一次成功；duplicate reversal 拒绝；cross-tenant reversal 拒绝
5. reversal 后 deterministic rebuild（FULL → PARTIAL/UNMATCHED）
6. 并发 basis supersede → 最终恰一个 effective；旧 basis 永久保留
7. policy exact 默认；policy version 改变后旧 projection 不被静默改写
8. projection 删除后 rebuild 结果一致；drift checker 能发现人工漂移
9. projection ↔ fact 关系全部同租户；relation 与摘要一致
10. manual provider outcome 缺 evidence/approval → 零写入
11. conflicting source facts → `CONFLICTING_EVIDENCE`，不自动 accepted/reconciled
12. amount outside tolerance → `AMBIGUOUS`；currency mismatch → fail-closed
13. 一笔 reimbursement 多候选 Claim → `AMBIGUOUS`
14. override 必须 approval；override 不改原 fact
15. expected basis 变更不得静默发生（必须有新 basis + 审批 + 审计）

回归：R43 / R44 / R44-A / R44-B 全量永久基线（含 S3 两条故障注入、R44 与 R44-A/B 入口测试、checker、fresh + two-stage upgrade、trigger inventories、tsc、prisma validate）**不得 skip、删除或弱化**。

## 8. 风险与缓解

| 风险 | 缓解（Schema/流程层） |
| --- | --- |
| 重复 ingest 双计 | `UNIQUE(org, providerEventFingerprint)` + 复用既有事实 |
| basis 并发双 effective | partial unique + 固定 supersede 顺序 + 并发测试 |
| reversal 负金额语义 | `OBSERVED.amount > 0` + `reversesFactId` 约束 |
| projection 漂移成真值 | projection 为 cache；`inputDigest/projectionVersion` + checker 强制 `stored == rebuild` |

## 9. 请裁决（3 问）

1. 上述**最终七表模型 + CHANGE A–D 落实方式**是否批准（尤其是 basis supersede 的事务顺序是否按 §2 CHANGE C 实现）？
2. 是否批准**进入 R45-B S1 实施**（先 Schema/migration + 触发器/清单，再 S2 ingest、S3 projector、S4 受保护动作、S5 checker/回归）？
3. 是否要求把 `ClaimReconciliationProjectionFact` 的重算策略定为「同事务整体替换」而非版本化追加（前者简单、后者可留历史）？
