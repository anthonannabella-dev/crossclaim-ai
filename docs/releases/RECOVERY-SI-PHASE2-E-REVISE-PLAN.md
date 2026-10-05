# Recovery SI P2-E v1 — REVISE 修订方案（FINAL-DESIGN / 待实现）

> 依据：**MSG-20261005-22 = PASS WITH REVISE**（已逐字归档，`FULL_COPY_OK`，576/576 行，FNV `1b49a5a3`）。`REVIEWED_HEAD = 48e6e2a3`。
> 状态：设计层已定稿（四项必修全部来自归档正文）；**实现尚未开始**，完成后必须送 **P2-E Implementation Audit**；不得进入 P2-F / P2-G。

## 必修 1 — 入口门禁：`P2_E_GUARD_ACTION = claim.prepare`

不得以「P2-D `claim.submit` = ALLOW」作为写入前提（真实 Control Plane 下 `claim.submit + 无 approvalId → REQUIRE_APPROVAL` 是 P2-D 已验证的正确行为，用它作内部准备前提等于把 preparation 错绑到 external submission 门上）。

```
fresh state
→ canonical READY alignment（沿用 P2-D CHANGE D1：supplied READY == canonical planner READY）
→ verified P2-C package preview / deterministic facts（manifest 与 digest 原样落库，不重算）
→ trusted ProductionControlPlane.snapshotFor / evaluateWithoutAudit
→ evaluate claim.prepare → ALLOW
→ persistence transaction
P2_E_REQUIRES_P2D_ALLOW = NO
```

## 必修 2 — 事务原子性

`RecoveryPackage` / `RecoveryPackageArtifact` / `FileAsset` / `AuditLog` 的写入必须收进**同一个事务**：任一步失败 → 全部回滚，不得留下孤儿 artifact、孤儿文件资产或半条审计。

## 必修 3 — lineage 表述

落库行必须可回溯 `RecoveryPlan` / `DecisionEvidence` / `planDigest`；`planDigest` 只作为**追溯/verification basis**，不得取代 `packageDigest` 作为业务包身份（与既有 `UNIQUE (organizationId, claimItemId, packageVersion, packageDigest)` 一致）。

## 必修 4 — RecoveryPackage DB DELETE guard

补 `RecoveryPackage` 的数据库层 DELETE 防护（与既有 append-only artifact 触发器、controlled-mutation 触发器配套），确保删除路径在 DB 层即被拒绝，而不是只靠应用层约定。

## 实施顺序（建议，零 Schema 变更前提下）

1. 入口门禁：把写入入口从 `claim.submit` 判定改为 canonical READY + `claim.prepare` Guard（可信 Control Plane）。
2. 事务化：把 package/artifact/FileAsset/audit 四个写入点收进单一 `prisma.$transaction`（或既有事务端口），失败整体回滚。
3. DELETE guard：新增迁移 + 触发器，纳入 `tools/tenant-triggers/required-triggers.json` 清单（如适用），并跑触发器清单校验。
4. lineage：补 `planDigest` 写入与反查路径，明确其 basis 语义。

## 证据映射（P2E-01..10 调整）

| 证据 | 调整 |
| --- | --- |
| `P2E-01` | 断言 `claim.prepare` DENY/REQUIRE_APPROVAL → 零写入；ALLOW → 才进入事务 |
| `P2E-03` | 增加「事务内 CAS + 唯一约束」断言 |
| `P2E-04` | append-only 证据 **+ DB DELETE guard 证据**（直接对 DB 尝试 DELETE 必须失败） |
| `P2E-05` | 按必修 3 的 lineage 表述重写 |
| `P2E-09` | 真实 PostgreSQL 迁移 + 触发器清单（含 DELETE guard） |
| 其余 | 不变（零外写 / 零网络零凭据 / 生命周期 / 失败语义与补偿） |

## 边界（不变）

```
P2_E_V1_OPTION = A（AUTHORIZED_WITH_CONDITIONS）
P2_E_OPTION_B = NOT_AUTHORIZED
APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / BUSINESS_FACT_WRITE / EXTERNAL_ACTION = FORBIDDEN
P2_F = HOLD
P2_G = HOLD（真实执行必须另开 P2-G）
RUNTIME_WIRING = NONE
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
