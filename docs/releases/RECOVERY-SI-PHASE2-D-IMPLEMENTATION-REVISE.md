> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# Recovery SI P2-D v1（Action Guard dry-run）Implementation Audit — 裁决记录

- **裁决消息**：MSG-20261005-20
- **VERDICT**：`REVISE`（窄范围；不需要重做 P2-D，也不需要重审设计）
- **REVIEWED_HEAD（实现）**：`5aaf7389`（`5aaf7389bc691ee17f49853c87d36100de9059ce`）
- **送审包 commit**：`24d11970`
- **设计裁决归档 commit**：`7c3efa11`
- **归档完整性**：AI-ARCHITECT-INBOX.md `### [MSG-20261005-20]`；FNV1A `72a9ceb3`（与浏览器抽取逐字一致）；compare = `FULL_COPY_OK`
- **本地证据口径**：61/61 + tsc exit 0 属本地归档证据；exact `5aaf7389` 的 hosted status/workflow 仍为空（未伪称 CI 已绿）。

## 1. 已通过部分

| 项目 | 裁定 |
| --- | --- |
| 必修 A 静态 Guard-action 映射（未复用 RSI policy action；未偷换 CUSTOMS → customs.recovery.start） | PASS |
| ACTION_GUARD_CATALOG = UNCHANGED（79618507 → 5aaf7389 未改 action-guard/action-guard.ts） | PASS |
| 必修 B 可信 Control Plane（capabilities 仅来自 ProductionControlPlane.snapshotFor / evaluateWithoutAudit；SI_SELF_SUPPLIED_CAPABILITIES = FORBIDDEN） | PASS |
| D2 / D3 / D5 / D6 / D8 / D9 / D10 | PASS |

## 2. 必修修订（最小集）

### CHANGE D1 — 伪造 READY_FOR_EXECUTION 仍可穿过 verifier

现状：`verifyRecoveryPlan()` 只在 `REQUEST_AUTHORIZATION` 时检查 authorization mismatch，不对 `READY_FOR_EXECUTION` 复核
`authorizationReady === true` / `riskClass !== HIGH` / `providerApproval === READY` / `evidenceComplete === true`。
因此「planner 原本 REQUEST_AUTHORIZATION 或 REQUEST_OWNER_APPROVAL，被篡改成 READY_FOR_EXECUTION」可能进入 Guard。

最小修法（不改进共享 verifier）：P2-D 内部重算 canonical plan

```
priority = prioritizeOpportunities(state)
canonicalPlan = planRecovery({ state, ranked: priority.ranked, registry, generatedAt: 稳定值 })
```

只有同时存在于 `canonicalPlan` 的 READY_FOR_EXECUTION **且** `verifyRecoveryPlan` verified READY_FOR_EXECUTION（execution-relevant 字段一致）才允许进入 Guard，即
`SUPPLIED_READY == CANONICAL_PLANNER_READY`。

### CHANGE D2 — outcome 合同缺两个冻结字段

所有 outcome 必须补 `submitted: false` / `persisted: false`（与 `executionAuthorized` / `executorInvoked` / `approvalConsumed` 并列）。无 Schema 变更。

### D4 证据补齐

除 Control Plane degraded → DENY 外，补 1 条真实 ProductionControlPlane + Action Guard 集成测试：`claim.submit`、非人工 gate 全满足、无 `approvalId` ⇒ `REQUIRE_APPROVAL`（绝不 ALLOW）。

## 3. 最小 FINAL-2 证据（4 条）

- `F2D-01` `authorizationReady=false` 的 planner 动作被篡改成 `READY_FOR_EXECUTION` → `zero Guard call`
- `F2D-02` `riskClass=HIGH` 的 `REQUEST_OWNER_APPROVAL` 被篡改成 `READY_FOR_EXECUTION` → `zero Guard call`
- `F2D-03` 真实 ProductionControlPlane + `claim.submit`、无 `approvalId` → `REQUIRE_APPROVAL`
- `F2D-04` 即使 Guard 返回 ALLOW：`executionAuthorized=false` / `executorInvoked=false` / `submitted=false` / `persisted=false` / `approvalConsumed=false`

## 4. 继续冻结的边界

```
P2_D_V1_IMPLEMENTATION = REVISE
P2_D_V1 = NOT_CLOSED
FINAL2_REQUIRED = YES
SCHEMA_DELTA_REQUIRED = NO
RUNTIME_WIRING = NONE
APPROVAL_CONSUMPTION = FORBIDDEN
EXECUTOR_INVOCATION = FORBIDDEN
BUSINESS_FACT_WRITE = FORBIDDEN
EXTERNAL_ACTION = FORBIDDEN
P2_E = HOLD_SCHEMA_DELTA
P2_F = HOLD
P2_G = HOLD
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```

P2-G（真实执行）必须另开审计：executor identity、真实 Guard action → executor 映射、actor membership/role、approvalId 真实性 / payload fingerprint / expiry / revocation / consumed、Action Guard approval verifier、审批消费原子性、idempotency / exactly-once、provider transport、external-write gate、production gate、kill switch、real credentials、reconciliation、rollback / NEEDS_MANUAL。
当前 `PLATFORM / CARRIER / INDEPENDENT_SITE → claim.submit` 仅被认可为 P2-D dry-run 的保守分类，**不得**直接当作 P2-G 的真实 executor identity。
