# Recovery SI Phase 2 剩余阶段 —— 设计边界预登记（P2-E / P2-F / P2-G）

- 依据裁决：**MSG-20261005-21 = PASS / CLOSED**（P2-D v1 dry-run 已关闭；`FINAL3_REQUIRED = NO`）。
- 结论性约束（架构方原文）：`P2-D CLOSED 不会自动解锁任何后续阶段`；真实执行**必须**另开 P2-G 独立架构审计。
- 本文件只做**登记与边界预告**，不构成实现授权；三个阶段的任何实现都必须先各自单独送审设计/实施边界。

## P2-E — 持久化（当前 HOLD_SCHEMA_DELTA）

必须一起审的既有资产与问题（来自 MSG-18/MSG-19/MSG-21 的累积要求）：

```
RecoveryPackage / RecoveryPackageArtifact / FileAsset / AuditLog
package uniqueness（organizationId + claimItemId + packageVersion + packageDigest）
idempotency key 定义（若启用 Option B：organizationId + opportunityRef + actionKind + planDigest 仅作追溯）
CAS / lifecycle（SUPERSEDED / WITHDRAWN）
RecoveryPlan / DecisionEvidence lineage
append-only 与 update/delete 禁令的边界
write whitelist（最小写入白名单）+ 并发唯一赢家 + exactly-once 证据
tenant isolation（租户触发器清单同步）
```

未决问题（需架构裁决）：

1. Option B 是否采用现有 `RecoveryPackage` 表语义，还是新增 append-only 实体；
2. `claim.prepare` DB mutation 是否纳入同一批（当前 P2-C 明确禁止）；
3. 幂等键与唯一约束的最终定义，以及 `planDigest` 作为追溯 basis 而非业务身份的边界；
4. Schema Delta 的迁移与 tenant-trigger checklist 同步方式。

## P2-F — 模型辅助（当前 HOLD）

```
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
模型不得生成 action 名称 / 不得成为权限依据
支出上限、调用台账（RSI-COST-*）与 kill switch 关系
```

## P2-G — 真实执行（当前 HOLD；必须独立审计）

至少重新审（MSG-20261005-21 ⑤ 原文枚举）：

```
真实 executor identity
domain → provider operation 映射（claim.submit 只是 dry-run 保守分类，不得当作 executor identity）
actor membership / RBAC
approvalId 真实性 / action·tenant·target binding / payload fingerprint
approval expiry / revocation / consumed state
approval consumption 原子性
idempotency / exactly-once
provider credential boundary / provider transport
external-write enablement / production gate / kill switch
reconciliation / provider response truth / failure / retry / NEEDS_MANUAL
CUSTOMS：RECOVERY_GUARD_ACTION_MAP.CUSTOMS = null，CUSTOMS_FILING = HOLD（不得用 customs.recovery.start 代替真实 filing）
```

## 当前冻结边界（不变）

```
P2_E = HOLD_SCHEMA_DELTA
P2_F = HOLD
P2_G = HOLD
APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / BUSINESS_FACT_WRITE / EXTERNAL_ACTION = FORBIDDEN
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT / CUSTOMS_FILING = HOLD
SCHEMA_DELTA_REQUIRED = NO（当前 P2-D）
RUNTIME_WIRING = NONE
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```

下一步（需架构裁决后再动）：选择 P2-E / P2-F / P2-G 之一，先写独立设计边界送审包（零代码），取得裁决后才允许实现。
