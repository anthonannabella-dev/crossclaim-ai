> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# Recovery SI P2-E — 持久化设计/实施边界送审请求（仅设计，零代码）

**REVIEWED_HEAD = 48e6e2a3**（branch `gate/7-commercial-validation`）。

- 前置：**MSG-20261005-21 = PASS / CLOSED**（P2-D v1 dry-run 关闭；`FINAL3_REQUIRED = NO`；架构方明确 `P2-D CLOSED 不会自动解锁任何后续阶段`）。
- 当前冻结：`P2_E = HOLD_SCHEMA_DELTA`、`P2_F = HOLD`、`P2_G = HOLD`；四类 FORBIDDEN 不变；`RUNTIME_WIRING = NONE`；`FINAL_ACCEPTANCE_HEAD = 0f7f7ac`。
- 本轮**零代码、零 Schema、零迁移、零运行时接线**；只请求裁定 P2-E v1 的范围与最小证据。

## 1. 目标与现状

P2-A/B/C/D 已形成完整只读链路：

```
state → prioritize → plan(canonical) → verify → Action Guard dry-run → ALLOW/DENY/REQUIRES_APPROVAL（STOP）
                                        ↘ PREPARE 预览（内存 manifest/digest/PDF，persisted=false）
```

唯一缺失环节是「把已生成的 recovery package 以可审计、幂等、可 supersede 的方式落库」。仓库已有对应底座，因此本阶段的关键不是新建模型，而是**决定复用边界与写入白名单**。

## 2. 待裁定分岔（请选一）

### Option A（建议）：复用既有 `RecoveryPackage` 语义 + 最小写入白名单

- 沿用既有唯一性：`organizationId + claimItemId + packageVersion + packageDigest`；
- 仅允许写入既有实体（`RecoveryPackage` / `RecoveryPackageArtifact` / `FileAsset` / `AuditLog`）且**只允许 append + 生命周期迁移**，禁止 update 业务字段、禁止 delete；
- 复用既有 pure functions（`buildRecoveryManifest` / `serializeCanonicalManifest` / `computePackageDigest` / `renderManifestPdf` / `sha256Hex`）产出的 manifest 与 digest 原样落库，不重新计算；
- 不新增表 / 不新增列：若实现中发现需要新列，则该部分自动并入 P2-E Schema Delta 二段审计，不在 v1 偷跑。

### Option B：新增 append-only 持久化实体专用于 SI 包

- 需要独立 Schema Delta（新表 + tenant 触发器 + 不可变触发器 + 唯一约束）；
- 需要定义与既有 `RecoveryPackage` 的关系（并存 / 迁移 / 双写），并说明为何不复用既有语义。

> 请裁定 v1 采用哪一项；若选 B，请给出最小写入白名单与幂等键定义。

## 3. 不变量（A/B 共用，只在全部满足时才允许落库）

```
入口门禁：只有 P2-D 已 ALLOW 且 basis 通过 canonical READY 对齐的 action 才可产生写入请求
（沿用 CHANGE D1：supplied READY == canonical planner READY）
tenant 四点绑定：plan.organizationId = state.organizationId = actorOrganizationId = 写入实体.organizationId
幂等：同 (organizationId, claimItemId, packageVersion, packageDigest) 重放 → 不产生第二份业务包（CAS/唯一约束）
并发：并发同键 → 唯一赢家；失败方为 no-op（不得部分写入、不得产生孤儿 artifact）
append-only：无 update 业务字段、无 delete；生命周期仅允许既有 CAS 迁移（SUPERSEDED / WITHDRAWN）
lineage：落库行必须可回溯到 RecoveryPlan / DecisionEvidence / planDigest（planDigest 作为追溯 basis，不取代 packageDigest 作为业务身份）
零外写：不创建 Claim submission / CustomsSubmissionAttempt / PlatformWriteAttempt / Payment / Settlement / RecoveryLedger / Billing
零 provider、零凭据读取、零网络（除 DB 本身）
不消费审批、不调用 executor；executionAuthorized / executorInvoked / submitted / approvalConsumed 语义不被本阶段改写
L5 永久拒绝：CUSTOMS_FILING 继续 HOLD；RECOVERY_GUARD_ACTION_MAP.CUSTOMS 保持 null
```

## 4. 请一并裁定（未决问题）

1. `claim.prepare` 的 DB mutation（创建/更新 Claim DRAFT）是否纳入 P2-E v1，还是继续独立后置？若纳入，请给出最小列白名单与 HITL 边界。
2. 幂等键是否就是 `(organizationId, claimItemId, packageVersion, packageDigest)`；是否需要额外 `(organizationId, approvalId)` 唯一约束（与 `PlatformWriteAttempt` 既有语义的关系）。
3. supersede / withdraw 由谁触发（owner action vs 系统 reconcile），是否需要与 `Action Guard` / 审批联动。
4. 是否需要 tenant-immutable 触发器清单同步（`tools/tenant-triggers/required-triggers.json`）与迁移清单同步方式。
5. 写入失败 / 部分失败的补偿语义：是否需要 `NEEDS_MANUAL` 终态（与 platform-write ledger 的 `UNKNOWN_PROVIDER_RESPONSE` 惯例对齐）。

## 5. 建议的最小证据集合（P2E-01..10，实施批提交）

| 编号 | 内容 |
| --- | --- |
| P2E-01 | 未通过 canonical READY 对齐 / 无 P2-D ALLOW → 零写入 |
| P2E-02 | tenant 四点任一不符 → 零写入、fail-closed |
| P2E-03 | 同键重放（顺序 2 次 + 并发 2 次）→ 单包 + 唯一赢家 + 无孤儿 artifact |
| P2E-04 | append-only 证明：无 update 业务字段、无 delete（源码 + DB 触发器双重证据） |
| P2E-05 | lineage：落库行 ← planDigest ← DecisionEvidence 可回溯（反查证据） |
| P2E-06 | 零外写：八类业务事实写入计数全 0（含静态扫描） |
| P2E-07 | 零网络 / 零凭据：network=0、credentialReads=0（含静态扫描） |
| P2E-08 | 生命周期：CAS 迁移合法路径 PASS、非法迁移拒绝；supersede/withdraw 只前进 |
| P2E-09 | 真实 PostgreSQL 迁移与回滚证据（既有迁移惯例：prisma validate + migrate deploy + 触发器清单） |
| P2E-10 | 失败语义：写入失败 → 明确的终态与补偿路径（不得静默成功、不得部分写入） |

## 6. 明确不在本阶段（继续 HOLD）

```
P2_F：模型辅助 / RSI_MODEL_NETWORK / RSI_PAID_MODEL_CALLS
P2_G：真实 executor / provider transport / external write / payment / filing
                        （真实执行必须另开 P2-G 独立架构审计）
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT / CUSTOMS_FILING = HOLD
```

## 7. 请求裁决

1. P2-E v1 采用 Option A 还是 B；若 A，本文件第 3 节不变量是否足够、第 4 节五问如何裁定；
2. P2E-01..10 是否足够（或需增减最小项）；
3. 是否要求 OWNER approval 前置；
4. 是否确认 P2-F / P2-G 仍需各自单独送审，且 P2-E 通过不得自动解锁；
5. 若需修订请只列最小集合。
